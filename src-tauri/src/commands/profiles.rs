use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::keys::ssh_key;
use russh::{client, Disconnect};
use serde::Serialize;
use tauri::State;

use crate::domain::logging::LogLevel;
use crate::domain::profile::{ConnectionProfile, ConnectionType, ProfileGroup, RecentConnection};
use crate::domain::secret::SecretPurpose;
use crate::domain::settings::NetworkProxySettings;
use crate::protocol::ssh::{probe::probe_ssh_endpoint, SSH_CONNECT_TIMEOUT_SECS};
use crate::security::fingerprint::{display_fingerprint, fingerprint_matches};
use crate::services::known_hosts_store::{KnownHostDecision, KnownHostsStore};
use crate::services::log_service::LogService;
use crate::services::network_proxy_service::{connect_tcp, load_proxy_password};
use crate::services::profile_store::ProfileStore;
use crate::services::secret_store::SecretStore;
use crate::services::serial_service::SerialService;
use crate::services::settings_store::SettingsStore;
use crate::services::tcp_terminal_service::TcpTerminalService;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSaveResult {
    pub profile_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionResult {
    pub ok: bool,
    pub message: String,
    pub requires_fingerprint_confirmation: bool,
    pub host_key_changed: bool,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub fingerprint: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostTrustResult {
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
}

#[tauri::command]
pub fn profile_list(store: State<'_, ProfileStore>) -> Result<Vec<ConnectionProfile>, String> {
    store.list()
}

#[tauri::command]
pub fn profile_groups(store: State<'_, ProfileStore>) -> Result<Vec<ProfileGroup>, String> {
    store.groups()
}

#[tauri::command]
pub fn profile_recent(store: State<'_, ProfileStore>) -> Result<Vec<RecentConnection>, String> {
    store.recent()
}

#[tauri::command]
pub fn profile_mark_recent(
    profile_id: String,
    store: State<'_, ProfileStore>,
) -> Result<RecentConnection, String> {
    store.mark_recent(&profile_id)
}

#[tauri::command]
pub fn profile_create(
    profile: ConnectionProfile,
    store: State<'_, ProfileStore>,
    logs: State<'_, LogService>,
) -> Result<ProfileSaveResult, String> {
    let profile_id = store.upsert(profile)?;
    let _ = logs.record(LogLevel::Info, "profile", format!("saved {profile_id}"));

    Ok(ProfileSaveResult { profile_id })
}

#[tauri::command]
pub async fn profile_update(
    profile_id: String,
    profile: ConnectionProfile,
    store: State<'_, ProfileStore>,
    secrets: State<'_, SecretStore>,
    logs: State<'_, LogService>,
) -> Result<ProfileSaveResult, String> {
    if profile.id != profile_id {
        return Err("profile id mismatch".to_string());
    }
    store.validate(&profile)?;

    let previous = store
        .get(&profile_id)?
        .ok_or_else(|| format!("profile not found: {profile_id}"))?;
    if should_clear_saved_password(&previous, &profile) {
        let secret_store = secrets.inner().clone();
        let secret_profile_id = profile_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            secret_store.delete_for_profile_purpose(&secret_profile_id, SecretPurpose::Password)
        })
        .await
        .map_err(|error| format!("系统凭据清理任务执行失败：{error}"))??;
    }

    profile_create(profile, store, logs)
}

#[tauri::command]
pub async fn profile_delete(
    profile_id: String,
    store: State<'_, ProfileStore>,
    secrets: State<'_, SecretStore>,
    logs: State<'_, LogService>,
) -> Result<(), String> {
    let secret_store = secrets.inner().clone();
    let secret_profile_id = profile_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        secret_store.delete_for_profile(&secret_profile_id)
    })
    .await
    .map_err(|error| format!("系统凭据清理任务执行失败：{error}"))??;

    store.delete(&profile_id)?;
    let _ = logs.record(LogLevel::Info, "profile", format!("deleted {profile_id}"));
    Ok(())
}

#[tauri::command]
pub async fn profile_test_connection(
    profile: ConnectionProfile,
    secret: Option<String>,
    known_hosts: State<'_, KnownHostsStore>,
    serial_service: State<'_, SerialService>,
    tcp_terminals: State<'_, TcpTerminalService>,
    settings: State<'_, SettingsStore>,
    secrets: State<'_, SecretStore>,
) -> Result<TestConnectionResult, String> {
    let _declared_capabilities = profile.capabilities();
    let proxy = settings.get()?.network.proxy;
    let proxy_password = if matches!(
        profile.r#type,
        ConnectionType::Ssh
            | ConnectionType::Sftp
            | ConnectionType::Telnet
            | ConnectionType::RawTcp
    ) {
        load_proxy_password(&proxy, secrets.inner().clone()).await?
    } else {
        None
    };

    if matches!(profile.r#type, ConnectionType::Ssh | ConnectionType::Sftp) {
        let probe = probe_ssh_endpoint(&profile, &proxy, proxy_password.as_deref()).await?;
        let host = probe.transport.host.as_str();
        let fingerprint = probe.host_key_fingerprint.as_str();
        let port = probe.transport.port;
        let decision = known_hosts.verify_host_key(host, port, fingerprint)?;
        let (requires_fingerprint_confirmation, host_key_changed) =
            host_key_confirmation_state(&decision);

        return Ok(match decision {
            KnownHostDecision::Trusted => {
                if profile.auth_type.as_deref() == Some("password") && secret.is_some() {
                    match test_ssh_password_auth(
                        &profile,
                        fingerprint,
                        secret,
                        &proxy,
                        proxy_password.as_deref(),
                    )
                    .await
                    {
                        Ok(()) => TestConnectionResult {
                            ok: true,
                            message: format!(
                                "SSH transport and password authentication verified at {}:{} ({})",
                                probe.transport.host,
                                probe.transport.port,
                                probe.transport.server_identification
                            ),
                            requires_fingerprint_confirmation,
                            host_key_changed,
                            host: Some(host.to_string()),
                            port: Some(port),
                            fingerprint: Some(display_fingerprint(fingerprint)),
                        },
                        Err(error) => TestConnectionResult {
                            ok: false,
                            message: format!("SSH 密码认证失败：{error}"),
                            requires_fingerprint_confirmation,
                            host_key_changed,
                            host: Some(host.to_string()),
                            port: Some(port),
                            fingerprint: Some(display_fingerprint(fingerprint)),
                        },
                    }
                } else {
                    TestConnectionResult {
                        ok: true,
                        message: format!(
                            "SSH transport verified at {}:{} ({})",
                            probe.transport.host,
                            probe.transport.port,
                            probe.transport.server_identification
                        ),
                        requires_fingerprint_confirmation,
                        host_key_changed,
                        host: Some(host.to_string()),
                        port: Some(port),
                        fingerprint: Some(display_fingerprint(fingerprint)),
                    }
                }
            }
            KnownHostDecision::Unknown => TestConnectionResult {
                ok: false,
                message: format!(
                    "SSH transport verified at {}:{} ({}). Confirm host key before connecting ({})",
                    probe.transport.host,
                    probe.transport.port,
                    probe.transport.server_identification,
                    display_fingerprint(fingerprint)
                ),
                requires_fingerprint_confirmation,
                host_key_changed,
                host: Some(host.to_string()),
                port: Some(port),
                fingerprint: Some(display_fingerprint(fingerprint)),
            },
            KnownHostDecision::Changed => TestConnectionResult {
                ok: false,
                message: "SSH 主机密钥已更改。请确认该 IP 对应的设备确实已更换；确认后将替换旧指纹并允许重新连接。".to_string(),
                requires_fingerprint_confirmation,
                host_key_changed,
                host: Some(host.to_string()),
                port: Some(port),
                fingerprint: Some(display_fingerprint(fingerprint)),
            },
        });
    }

    if matches!(profile.r#type, ConnectionType::Serial) {
        return match serial_service.test_profile(&profile) {
            Ok(()) => Ok(TestConnectionResult {
                ok: true,
                message: format!(
                    "串口 {} 可以打开。",
                    profile.port_name.as_deref().unwrap_or("unconfigured-port")
                ),
                requires_fingerprint_confirmation: false,
                host_key_changed: false,
                host: None,
                port: None,
                fingerprint: None,
            }),
            Err(error) => Ok(TestConnectionResult {
                ok: false,
                message: error,
                requires_fingerprint_confirmation: false,
                host_key_changed: false,
                host: None,
                port: None,
                fingerprint: None,
            }),
        };
    }

    if matches!(
        profile.r#type,
        ConnectionType::Telnet | ConnectionType::RawTcp
    ) {
        return match tcp_terminals
            .test_profile(&profile, &proxy, proxy_password.as_deref())
            .await
        {
            Ok(()) => Ok(TestConnectionResult {
                ok: true,
                message: format!(
                    "TCP 端点 {}:{} 可以连接。",
                    profile.host.as_deref().unwrap_or("unconfigured-host"),
                    profile.port.unwrap_or_default()
                ),
                requires_fingerprint_confirmation: false,
                host_key_changed: false,
                host: profile.host.clone(),
                port: profile.port,
                fingerprint: None,
            }),
            Err(error) => Ok(TestConnectionResult {
                ok: false,
                message: error,
                requires_fingerprint_confirmation: false,
                host_key_changed: false,
                host: profile.host.clone(),
                port: profile.port,
                fingerprint: None,
            }),
        };
    }

    Ok(TestConnectionResult {
        ok: false,
        message: "当前连接类型不支持连通性测试。".to_string(),
        requires_fingerprint_confirmation: false,
        host_key_changed: false,
        host: None,
        port: None,
        fingerprint: None,
    })
}

fn host_key_confirmation_state(decision: &KnownHostDecision) -> (bool, bool) {
    match decision {
        KnownHostDecision::Trusted => (false, false),
        KnownHostDecision::Unknown => (true, false),
        KnownHostDecision::Changed => (true, true),
    }
}

#[tauri::command]
pub fn known_host_trust_placeholder(
    host: String,
    port: u16,
    fingerprint: String,
    known_hosts: State<'_, KnownHostsStore>,
) -> Result<KnownHostTrustResult, String> {
    known_hosts.trust_host_key(&host, port, &fingerprint)?;

    Ok(KnownHostTrustResult {
        host,
        port,
        fingerprint: display_fingerprint(&fingerprint),
    })
}

fn should_clear_saved_password(previous: &ConnectionProfile, updated: &ConnectionProfile) -> bool {
    ssh_password_scope(previous) != ssh_password_scope(updated)
}

fn ssh_password_scope(profile: &ConnectionProfile) -> Option<(String, u16, String)> {
    if !matches!(profile.r#type, ConnectionType::Ssh | ConnectionType::Sftp)
        || profile.auth_type.as_deref() != Some("password")
    {
        return None;
    }

    Some((
        profile
            .host
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase(),
        profile.port.unwrap_or(22),
        profile
            .username
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_string(),
    ))
}

async fn test_ssh_password_auth(
    profile: &ConnectionProfile,
    expected_fingerprint: &str,
    secret: Option<String>,
    proxy: &NetworkProxySettings,
    proxy_password: Option<&str>,
) -> Result<(), String> {
    let password = secret
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "需要输入当前 SSH 密码".to_string())?
        .to_string();
    let host = profile
        .host
        .as_deref()
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .ok_or_else(|| "SSH host is required".to_string())?
        .to_string();
    let port = profile.port.unwrap_or(22);
    let username = profile
        .username
        .as_deref()
        .map(str::trim)
        .filter(|username| !username.is_empty())
        .ok_or_else(|| "SSH username is required".to_string())?
        .to_string();
    let timeout = Duration::from_secs(SSH_CONNECT_TIMEOUT_SECS);
    let fingerprint = Arc::new(Mutex::new(None));
    let handler = TestSshAuthHandler {
        fingerprint: Arc::clone(&fingerprint),
    };
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(timeout),
        nodelay: true,
        ..Default::default()
    });

    let stream = connect_tcp(proxy, proxy_password, &host, port, timeout).await?;
    let mut handle = tokio::time::timeout(timeout, client::connect_stream(config, stream, handler))
        .await
        .map_err(|_| format!("timed out opening SSH session {host}:{port}"))?
        .map_err(|error| format!("failed to open SSH session {host}:{port}: {error}"))?;
    let actual_fingerprint = fingerprint
        .lock()
        .map_err(|_| "SSH auth test state lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "SSH server did not provide a host key fingerprint".to_string())?;

    if !fingerprint_matches(expected_fingerprint, &actual_fingerprint) {
        let _ = handle
            .disconnect(Disconnect::HostKeyNotVerifiable, "host key mismatch", "en")
            .await;
        return Err(format!(
            "SSH host key changed for {host}; connection blocked"
        ));
    }

    let auth_result = handle
        .authenticate_password(username, password)
        .await
        .map_err(|error| format!("{error}"))?;
    let _ = handle
        .disconnect(Disconnect::ByApplication, "test completed", "en")
        .await;

    if !auth_result.success() {
        return Err("当前密码被服务器拒绝".to_string());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{host_key_confirmation_state, should_clear_saved_password};
    use crate::domain::profile::ConnectionType;
    use crate::services::known_hosts_store::KnownHostDecision;
    use crate::services::profile_store::ProfileStore;

    #[test]
    fn changed_host_key_requires_explicit_replacement_confirmation() {
        assert_eq!(
            host_key_confirmation_state(&KnownHostDecision::Changed),
            (true, true)
        );
        assert_eq!(
            host_key_confirmation_state(&KnownHostDecision::Unknown),
            (true, false)
        );
        assert_eq!(
            host_key_confirmation_state(&KnownHostDecision::Trusted),
            (false, false)
        );
    }

    #[test]
    fn keeps_saved_password_when_only_profile_name_changes() {
        let store = ProfileStore::in_memory();
        let profile = store.get("prod-ssh").unwrap().unwrap();
        let mut updated = profile.clone();
        updated.name = "Renamed".to_string();

        assert!(!should_clear_saved_password(&profile, &updated));
    }

    #[test]
    fn clears_saved_password_when_ssh_identity_or_auth_changes() {
        let store = ProfileStore::in_memory();
        let profile = store.get("prod-ssh").unwrap().unwrap();

        let mut changed_host = profile.clone();
        changed_host.host = Some("other.example.com".to_string());
        assert!(should_clear_saved_password(&profile, &changed_host));

        let mut changed_username = profile.clone();
        changed_username.username = Some("other-user".to_string());
        assert!(should_clear_saved_password(&profile, &changed_username));

        let mut changed_auth = profile.clone();
        changed_auth.auth_type = Some("agent".to_string());
        assert!(should_clear_saved_password(&profile, &changed_auth));

        let mut sftp = profile.clone();
        sftp.r#type = ConnectionType::Sftp;
        assert!(!should_clear_saved_password(&profile, &sftp));
    }
}

struct TestSshAuthHandler {
    fingerprint: Arc<Mutex<Option<String>>>,
}

impl client::Handler for TestSshAuthHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key
            .fingerprint(ssh_key::HashAlg::Sha256)
            .to_string();
        if let Ok(mut state) = self.fingerprint.lock() {
            *state = Some(fingerprint);
        }

        Ok(true)
    }
}
