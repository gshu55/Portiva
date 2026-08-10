use std::env;
use std::fmt;
use std::process::Command;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::domain::secret::SecretPurpose;
use crate::domain::settings::{NetworkProxyMode, NetworkProxySettings};
use crate::services::secret_store::SecretStore;

const MAX_PROXY_RESPONSE_BYTES: usize = 8 * 1024;
pub const PROXY_SECRET_PROFILE_ID: &str = "portiva-network-proxy";

#[derive(Clone, PartialEq, Eq)]
pub struct ResolvedProxy {
    pub scheme: String,
    pub host: String,
    pub port: u16,
    username: Option<String>,
    password: Option<String>,
}

impl ResolvedProxy {
    pub fn url(&self) -> String {
        format!(
            "{}://{}:{}",
            self.scheme,
            format_url_host(&self.host),
            self.port
        )
    }

    pub fn authenticated_url(&self) -> Result<String, String> {
        let mut url =
            reqwest::Url::parse(&self.url()).map_err(|error| format!("代理地址无效：{error}"))?;
        if let Some((username, password)) = self.credentials() {
            url.set_username(username)
                .map_err(|_| "代理用户名无法写入代理地址".to_string())?;
            url.set_password(Some(password))
                .map_err(|_| "代理密码无法写入代理地址".to_string())?;
        }
        Ok(url.to_string())
    }

    fn reqwest_proxy(&self) -> Result<reqwest::Proxy, String> {
        let proxy =
            reqwest::Proxy::all(self.url()).map_err(|error| format!("代理地址无效：{error}"))?;
        Ok(match (&self.username, &self.password) {
            (Some(username), Some(password)) => proxy.basic_auth(username, password),
            _ => proxy,
        })
    }

    fn credentials(&self) -> Option<(&str, &str)> {
        Some((self.username.as_deref()?, self.password.as_deref()?))
    }
}

impl fmt::Debug for ResolvedProxy {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedProxy")
            .field("scheme", &self.scheme)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("authenticated", &self.credentials().is_some())
            .finish()
    }
}

pub fn configure_http_client(
    builder: reqwest::ClientBuilder,
    settings: &NetworkProxySettings,
    target_scheme: &str,
    password: Option<&str>,
) -> Result<reqwest::ClientBuilder, String> {
    let Some(proxy) = resolve_proxy(settings, target_scheme, password)? else {
        return Ok(builder.no_proxy());
    };
    Ok(builder.proxy(proxy.reqwest_proxy()?))
}

pub fn resolve_proxy(
    settings: &NetworkProxySettings,
    target_scheme: &str,
    password: Option<&str>,
) -> Result<Option<ResolvedProxy>, String> {
    match settings.mode {
        NetworkProxyMode::None => Ok(None),
        NetworkProxyMode::Http => Ok(Some(custom_proxy("http", settings, password)?)),
        NetworkProxyMode::Socks5 => Ok(Some(custom_proxy("socks5h", settings, password)?)),
        NetworkProxyMode::Browser => resolve_browser_proxy(target_scheme)?
            .map(|proxy| apply_credentials(proxy, settings, password))
            .transpose(),
    }
}

pub async fn load_proxy_password(
    settings: &NetworkProxySettings,
    secrets: SecretStore,
) -> Result<Option<String>, String> {
    if matches!(settings.mode, NetworkProxyMode::None) || !settings.authentication_enabled {
        return Ok(None);
    }
    if settings.username.trim().is_empty() {
        return Err("已启用代理认证，请填写用户名".to_string());
    }
    let password = tauri::async_runtime::spawn_blocking(move || {
        secrets.get_secret(PROXY_SECRET_PROFILE_ID, SecretPurpose::ProxyPassword)
    })
    .await
    .map_err(|error| format!("读取代理凭据任务失败：{error}"))??;
    password
        .filter(|value| !value.is_empty())
        .map(Some)
        .ok_or_else(|| "已启用代理认证，请先保存代理密码".to_string())
}

pub async fn connect_tcp(
    settings: &NetworkProxySettings,
    password: Option<&str>,
    host: &str,
    port: u16,
    timeout: Duration,
) -> Result<TcpStream, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("目标主机不能为空".to_string());
    }

    tokio::time::timeout(timeout, connect_tcp_inner(settings, password, host, port))
        .await
        .map_err(|_| format!("连接 {host}:{port} 超时"))?
}

async fn connect_tcp_inner(
    settings: &NetworkProxySettings,
    password: Option<&str>,
    host: &str,
    port: u16,
) -> Result<TcpStream, String> {
    let Some(proxy) = resolve_proxy(settings, "https", password)? else {
        return TcpStream::connect((host, port))
            .await
            .map_err(|error| format!("无法连接 {host}:{port}：{error}"));
    };

    let mut stream = TcpStream::connect((proxy.host.as_str(), proxy.port))
        .await
        .map_err(|error| format!("无法连接代理 {}:{}：{error}", proxy.host, proxy.port))?;

    match proxy.scheme.as_str() {
        "http" => establish_http_connect(&mut stream, host, port, proxy.credentials()).await?,
        "socks5" | "socks5h" => {
            establish_socks5_connect(&mut stream, host, port, proxy.credentials()).await?
        }
        "https" => return Err("当前 SSH/TCP 连接暂不支持 TLS 类型的 HTTP 代理".to_string()),
        scheme => return Err(format!("不支持的代理协议：{scheme}")),
    }

    Ok(stream)
}

async fn establish_http_connect(
    stream: &mut TcpStream,
    host: &str,
    port: u16,
    credentials: Option<(&str, &str)>,
) -> Result<(), String> {
    let authority = format_authority(host, port);
    let authorization = credentials
        .map(|(username, password)| {
            let encoded = BASE64_STANDARD.encode(format!("{username}:{password}"));
            format!("Proxy-Authorization: Basic {encoded}\r\n")
        })
        .unwrap_or_default();
    let request = format!(
        "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\nProxy-Connection: Keep-Alive\r\n{authorization}\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|error| format!("HTTP 代理握手发送失败：{error}"))?;

    let mut response = Vec::with_capacity(512);
    let mut byte = [0_u8; 1];
    while response.len() < MAX_PROXY_RESPONSE_BYTES {
        stream
            .read_exact(&mut byte)
            .await
            .map_err(|error| format!("HTTP 代理握手响应失败：{error}"))?;
        response.push(byte[0]);
        if response.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    if !response.ends_with(b"\r\n\r\n") {
        return Err("HTTP 代理响应头过大或不完整".to_string());
    }

    let status_line = String::from_utf8_lossy(&response)
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(format!("HTTP 代理拒绝连接：{status_line}"));
    }
    Ok(())
}

async fn establish_socks5_connect(
    stream: &mut TcpStream,
    host: &str,
    port: u16,
    credentials: Option<(&str, &str)>,
) -> Result<(), String> {
    let methods: &[u8] = if credentials.is_some() {
        &[0x05, 0x02, 0x00, 0x02]
    } else {
        &[0x05, 0x01, 0x00]
    };
    stream
        .write_all(methods)
        .await
        .map_err(|error| format!("SOCKS5 协商发送失败：{error}"))?;
    let mut greeting = [0_u8; 2];
    stream
        .read_exact(&mut greeting)
        .await
        .map_err(|error| format!("SOCKS5 协商响应失败：{error}"))?;
    if greeting[0] != 0x05 {
        return Err("SOCKS5 代理返回了无效的协议版本".to_string());
    }
    match greeting[1] {
        0x00 => {}
        0x02 => authenticate_socks5(stream, credentials).await?,
        0xFF => return Err("SOCKS5 代理不接受当前认证方式".to_string()),
        method => return Err(format!("SOCKS5 代理返回未知认证方式 0x{method:02X}")),
    }

    let host_bytes = host.trim_matches(['[', ']']).as_bytes();
    if host_bytes.is_empty() || host_bytes.len() > u8::MAX as usize {
        return Err("SOCKS5 目标主机长度无效".to_string());
    }
    let mut request = Vec::with_capacity(host_bytes.len() + 7);
    request.extend_from_slice(&[0x05, 0x01, 0x00, 0x03, host_bytes.len() as u8]);
    request.extend_from_slice(host_bytes);
    request.extend_from_slice(&port.to_be_bytes());
    stream
        .write_all(&request)
        .await
        .map_err(|error| format!("SOCKS5 连接请求发送失败：{error}"))?;

    let mut header = [0_u8; 4];
    stream
        .read_exact(&mut header)
        .await
        .map_err(|error| format!("SOCKS5 连接响应失败：{error}"))?;
    if header[0] != 0x05 || header[1] != 0x00 {
        return Err(format!("SOCKS5 代理拒绝连接，错误码 0x{:02X}", header[1]));
    }

    let address_length = match header[3] {
        0x01 => 4,
        0x04 => 16,
        0x03 => {
            let mut length = [0_u8; 1];
            stream
                .read_exact(&mut length)
                .await
                .map_err(|error| format!("SOCKS5 地址响应失败：{error}"))?;
            length[0] as usize
        }
        value => return Err(format!("SOCKS5 返回未知地址类型 0x{value:02X}")),
    };
    let mut remainder = vec![0_u8; address_length + 2];
    stream
        .read_exact(&mut remainder)
        .await
        .map_err(|error| format!("SOCKS5 地址响应不完整：{error}"))?;
    Ok(())
}

async fn authenticate_socks5(
    stream: &mut TcpStream,
    credentials: Option<(&str, &str)>,
) -> Result<(), String> {
    let (username, password) =
        credentials.ok_or_else(|| "SOCKS5 代理要求用户名和密码".to_string())?;
    let username = username.as_bytes();
    let password = password.as_bytes();
    if username.is_empty() || username.len() > u8::MAX as usize || password.len() > u8::MAX as usize
    {
        return Err("SOCKS5 用户名或密码长度无效".to_string());
    }
    let mut request = Vec::with_capacity(username.len() + password.len() + 3);
    request.extend_from_slice(&[0x01, username.len() as u8]);
    request.extend_from_slice(username);
    request.push(password.len() as u8);
    request.extend_from_slice(password);
    stream
        .write_all(&request)
        .await
        .map_err(|error| format!("SOCKS5 认证发送失败：{error}"))?;
    let mut response = [0_u8; 2];
    stream
        .read_exact(&mut response)
        .await
        .map_err(|error| format!("SOCKS5 认证响应失败：{error}"))?;
    if response != [0x01, 0x00] {
        return Err("SOCKS5 代理认证失败，请检查用户名和密码".to_string());
    }
    Ok(())
}

fn custom_proxy(
    scheme: &str,
    settings: &NetworkProxySettings,
    password: Option<&str>,
) -> Result<ResolvedProxy, String> {
    let host = settings.host.trim();
    if host.is_empty() {
        return Err("代理主机不能为空".to_string());
    }
    if settings.port == 0 {
        return Err("代理端口必须在 1 到 65535 之间".to_string());
    }
    let credentials = proxy_credentials(settings, password)?;
    Ok(ResolvedProxy {
        scheme: scheme.to_string(),
        host: host.trim_matches(['[', ']']).to_string(),
        port: settings.port,
        username: credentials.0,
        password: credentials.1,
    })
}

fn apply_credentials(
    mut proxy: ResolvedProxy,
    settings: &NetworkProxySettings,
    password: Option<&str>,
) -> Result<ResolvedProxy, String> {
    let credentials = proxy_credentials(settings, password)?;
    proxy.username = credentials.0;
    proxy.password = credentials.1;
    Ok(proxy)
}

fn proxy_credentials(
    settings: &NetworkProxySettings,
    password: Option<&str>,
) -> Result<(Option<String>, Option<String>), String> {
    if settings.authentication_enabled {
        let username = settings.username.trim();
        if username.is_empty() {
            return Err("已启用代理认证，请填写用户名".to_string());
        }
        let password = password
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "已启用代理认证，请先保存代理密码".to_string())?;
        Ok((Some(username.to_string()), Some(password.to_string())))
    } else {
        Ok((None, None))
    }
}

fn resolve_browser_proxy(target_scheme: &str) -> Result<Option<ResolvedProxy>, String> {
    if let Some(value) = proxy_from_environment(target_scheme) {
        return parse_proxy_value(&value).map(Some);
    }

    #[cfg(target_os = "windows")]
    {
        return windows_browser_proxy();
    }

    #[cfg(target_os = "macos")]
    {
        return macos_browser_proxy(target_scheme);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return linux_browser_proxy(target_scheme);
    }

    #[allow(unreachable_code)]
    Ok(None)
}

fn proxy_from_environment(target_scheme: &str) -> Option<String> {
    let names: &[&str] = if target_scheme.eq_ignore_ascii_case("http") {
        &["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]
    } else {
        &[
            "HTTPS_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
            "HTTP_PROXY",
            "http_proxy",
        ]
    };
    names.iter().find_map(|name| {
        env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn parse_proxy_value(value: &str) -> Result<ResolvedProxy, String> {
    let candidate = if value.contains("://") {
        value.to_string()
    } else {
        format!("http://{value}")
    };
    let url =
        reqwest::Url::parse(&candidate).map_err(|error| format!("系统代理地址无效：{error}"))?;
    let scheme = url.scheme().to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https" | "socks5" | "socks5h") {
        return Err(format!("不支持的系统代理协议：{scheme}"));
    }
    let host = url
        .host_str()
        .filter(|host| !host.trim().is_empty())
        .ok_or_else(|| "系统代理缺少主机地址".to_string())?
        .to_string();
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "系统代理缺少端口".to_string())?;
    Ok(ResolvedProxy {
        scheme,
        host,
        port,
        username: None,
        password: None,
    })
}

#[cfg(target_os = "windows")]
fn windows_browser_proxy() -> Result<Option<ResolvedProxy>, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = Command::new("reg.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyEnable",
        ])
        .output()
        .map_err(|error| format!("读取浏览器代理状态失败：{error}"))?;
    if !output.status.success() || !String::from_utf8_lossy(&output.stdout).contains("0x1") {
        return Ok(None);
    }
    let output = Command::new("reg.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyServer",
        ])
        .output()
        .map_err(|error| format!("读取浏览器代理地址失败：{error}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let value = raw
        .lines()
        .find(|line| line.contains("ProxyServer"))
        .and_then(|line| line.split("REG_SZ").nth(1))
        .map(str::trim)
        .filter(|value| !value.is_empty());
    value.map(parse_windows_proxy_value).transpose()
}

#[cfg(target_os = "windows")]
fn parse_windows_proxy_value(value: &str) -> Result<ResolvedProxy, String> {
    if !value.contains(';') && !value.contains('=') {
        return parse_proxy_value(value);
    }
    for key in ["https", "http", "socks"] {
        if let Some(endpoint) = value.split(';').find_map(|entry| {
            let (name, endpoint) = entry.split_once('=')?;
            name.trim()
                .eq_ignore_ascii_case(key)
                .then_some(endpoint.trim())
        }) {
            let scheme = if key == "socks" { "socks5h" } else { "http" };
            return parse_proxy_value(&format!("{scheme}://{endpoint}"));
        }
    }
    Err("系统代理地址为空".to_string())
}

#[cfg(target_os = "macos")]
fn macos_browser_proxy(target_scheme: &str) -> Result<Option<ResolvedProxy>, String> {
    let output = Command::new("/usr/sbin/scutil")
        .arg("--proxy")
        .output()
        .map_err(|error| format!("读取浏览器代理失败：{error}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    parse_scutil_proxy(&String::from_utf8_lossy(&output.stdout), target_scheme)
}

#[cfg(target_os = "macos")]
fn parse_scutil_proxy(output: &str, target_scheme: &str) -> Result<Option<ResolvedProxy>, String> {
    let prefix = if target_scheme.eq_ignore_ascii_case("http") {
        "HTTP"
    } else {
        "HTTPS"
    };
    let value = |key: &str| {
        output.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            (name.trim() == key).then_some(value.trim())
        })
    };
    if value(&format!("{prefix}Enable")) != Some("1") {
        return Ok(None);
    }
    let host = value(&format!("{prefix}Proxy")).unwrap_or_default();
    let port = value(&format!("{prefix}Port")).unwrap_or_default();
    parse_proxy_value(&format!("http://{host}:{port}")).map(Some)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn linux_browser_proxy(target_scheme: &str) -> Result<Option<ResolvedProxy>, String> {
    let mode = gsettings_value(&["get", "org.gnome.system.proxy", "mode"]);
    if mode.as_deref().map(trim_gsettings_string) != Some("manual") {
        return Ok(None);
    }
    let section = if target_scheme.eq_ignore_ascii_case("http") {
        "org.gnome.system.proxy.http"
    } else {
        "org.gnome.system.proxy.https"
    };
    let host = gsettings_value(&["get", section, "host"])
        .map(|value| trim_gsettings_string(&value).to_string())
        .unwrap_or_default();
    let port = gsettings_value(&["get", section, "port"])
        .and_then(|value| value.trim().parse::<u16>().ok())
        .unwrap_or_default();
    if host.is_empty() || port == 0 {
        return Ok(None);
    }
    Ok(Some(ResolvedProxy {
        scheme: "http".to_string(),
        host,
        port,
        username: None,
        password: None,
    }))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn gsettings_value(args: &[&str]) -> Option<String> {
    let output = Command::new("gsettings").args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn trim_gsettings_string(value: &str) -> &str {
    value.trim().trim_matches('\'').trim_matches('"')
}

fn format_authority(host: &str, port: u16) -> String {
    format!("{}:{port}", format_url_host(host))
}

fn format_url_host(host: &str) -> String {
    let host = host.trim_matches(['[', ']']);
    if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_proxy_value, resolve_proxy};
    use crate::domain::settings::{NetworkProxyMode, NetworkProxySettings};

    #[test]
    fn default_mode_resolves_to_direct_connection() {
        let settings = NetworkProxySettings::default();
        assert!(resolve_proxy(&settings, "https", None).unwrap().is_none());
    }

    #[test]
    fn custom_socks_proxy_uses_remote_dns_scheme() {
        let settings = NetworkProxySettings {
            mode: NetworkProxyMode::Socks5,
            host: "127.0.0.1".to_string(),
            port: 1080,
            ..NetworkProxySettings::default()
        };
        assert_eq!(
            resolve_proxy(&settings, "https", None)
                .unwrap()
                .unwrap()
                .url(),
            "socks5h://127.0.0.1:1080"
        );
    }

    #[test]
    fn custom_proxy_credentials_are_redacted_from_debug_output() {
        let settings = NetworkProxySettings {
            mode: NetworkProxyMode::Http,
            authentication_enabled: true,
            username: "proxy-user".to_string(),
            ..NetworkProxySettings::default()
        };
        let proxy = resolve_proxy(&settings, "https", Some("very-secret"))
            .unwrap()
            .unwrap();
        let debug = format!("{proxy:?}");
        assert!(debug.contains("authenticated: true"));
        assert!(!debug.contains("proxy-user"));
        assert!(!debug.contains("very-secret"));
    }

    #[test]
    fn authenticated_proxy_requires_a_saved_password() {
        let settings = NetworkProxySettings {
            mode: NetworkProxyMode::Http,
            authentication_enabled: true,
            username: "proxy-user".to_string(),
            ..NetworkProxySettings::default()
        };

        assert_eq!(
            resolve_proxy(&settings, "https", None).unwrap_err(),
            "已启用代理认证，请先保存代理密码"
        );
    }

    #[test]
    fn updater_proxy_url_percent_encodes_credentials() {
        let settings = NetworkProxySettings {
            mode: NetworkProxyMode::Http,
            authentication_enabled: true,
            username: "name@example.com".to_string(),
            ..NetworkProxySettings::default()
        };
        let proxy = resolve_proxy(&settings, "https", Some("p@ss word"))
            .unwrap()
            .unwrap();
        let url = proxy.authenticated_url().unwrap();

        assert_eq!(
            url,
            "http://name%40example.com:p%40ss%20word@127.0.0.1:7890/"
        );
    }

    #[test]
    fn parses_system_proxy_without_explicit_scheme() {
        let proxy = parse_proxy_value("127.0.0.1:7890").unwrap();
        assert_eq!(proxy.url(), "http://127.0.0.1:7890");
    }
}
