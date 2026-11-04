use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use ring::rand::{SecureRandom, SystemRandom};
use russh::{client, Channel};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::sync::{watch, Mutex as AsyncMutex, Semaphore};

const AUTH_PROTOCOL: &[u8] = b"MIT-MAGIC-COOKIE-1";
const SETUP_TIMEOUT: Duration = Duration::from_secs(5);

/// Unix desktops require an existing authenticated display. Windows starts its
/// managed display only when the user enables forwarding.
pub async fn is_available() -> bool {
    #[cfg(windows)]
    {
        true
    }
    #[cfg(not(windows))]
    {
        matches!(
            tokio::time::timeout(SETUP_TIMEOUT, LocalDisplay::open()).await,
            Ok(Ok(_))
        )
    }
}

trait X11Socket: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> X11Socket for T {}

#[derive(Debug, PartialEq, Eq)]
enum DisplayEndpoint {
    Tcp(String, u16),
    #[cfg(unix)]
    Unix(PathBuf),
}

struct LocalDisplay {
    endpoint: DisplayEndpoint,
    screen: u32,
    cookie: Vec<u8>,
    #[cfg(windows)]
    _server: Option<OwnedXServer>,
}

struct ForwardedSession {
    display: Arc<LocalDisplay>,
    cancelled: watch::Receiver<bool>,
}

/// A registration belongs to one PTY. Dropping it revokes its cookie and streams.
pub struct X11Registration {
    session: Arc<ForwardedSession>,
    cookie: [u8; 16],
    cancel: watch::Sender<bool>,
}

impl X11Registration {
    pub fn cookie_hex(&self) -> String {
        encode_cookie(&self.cookie)
    }

    pub fn screen(&self) -> u32 {
        self.session.display.screen
    }
}

impl Drop for X11Registration {
    fn drop(&mut self) {
        self.cancel.send_replace(true);
    }
}

pub struct X11Forwarding {
    sessions: Mutex<HashMap<[u8; 16], Weak<ForwardedSession>>>,
    display: AsyncMutex<Weak<LocalDisplay>>,
    connections: Arc<Semaphore>,
}

impl Default for X11Forwarding {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            display: AsyncMutex::new(Weak::new()),
            connections: Arc::new(Semaphore::new(64)),
        }
    }
}

impl X11Forwarding {
    pub async fn prepare(&self) -> Result<X11Registration, String> {
        let mut cached_display = self.display.lock().await;
        let display = match cached_display.upgrade() {
            Some(display) => {
                display.verify().await?;
                display
            }
            None => {
                let display = Arc::new(LocalDisplay::open().await?);
                *cached_display = Arc::downgrade(&display);
                display
            }
        };
        let cookie = random_cookie()?;
        let (cancel, cancelled) = watch::channel(false);
        let session = Arc::new(ForwardedSession { display, cancelled });
        let mut sessions = self.sessions.lock().map_err(|_| "X11 状态锁不可用")?;
        sessions.retain(|_, entry| entry.strong_count() > 0);
        sessions.insert(cookie, Arc::downgrade(&session));
        Ok(X11Registration {
            session,
            cookie,
            cancel,
        })
    }

    pub fn forward(self: &Arc<Self>, channel: Channel<client::Msg>) {
        let forwarding = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            forwarding.forward_stream(channel.into_stream()).await;
        });
    }

    async fn forward_stream(&self, mut remote: impl AsyncRead + AsyncWrite + Unpin) {
        // Bound unauthenticated setup attempts as well as established streams.
        let Ok(_permit) = Arc::clone(&self.connections).try_acquire_owned() else {
            return;
        };
        let setup = tokio::time::timeout(SETUP_TIMEOUT, read_setup(&mut remote)).await;
        let Ok(Ok(setup)) = setup else { return };
        if setup.protocol != AUTH_PROTOCOL || setup.cookie.len() != 16 {
            return;
        }
        let session = self.sessions.lock().ok().and_then(|sessions| {
            let cookie: &[u8; 16] = setup.cookie.as_slice().try_into().ok()?;
            sessions.get(cookie)?.upgrade()
        });
        let Some(session) = session else { return };
        let mut cancelled = session.cancelled.clone();
        if *cancelled.borrow() {
            return;
        }
        tokio::select! {
            _ = cancelled.changed() => {}
            _ = async {
                let connection = tokio::time::timeout(SETUP_TIMEOUT, session.display.connect()).await;
                let Ok(Ok(mut local)) = connection else { return };
                let setup = make_setup(setup.little_endian, &session.display.cookie);
                if !matches!(tokio::time::timeout(SETUP_TIMEOUT, local.write_all(&setup)).await, Ok(Ok(()))) {
                    return;
                }
                let _ = tokio::io::copy_bidirectional(&mut remote, &mut local).await;
            } => {}
        }
    }
}

impl LocalDisplay {
    async fn open() -> Result<Self, String> {
        let display = std::env::var("DISPLAY").unwrap_or_default();
        #[cfg(windows)]
        if display.trim().is_empty() {
            return start_windows_server().await;
        }
        #[cfg(target_os = "macos")]
        let display = if display.trim().is_empty() {
            let output = Command::new("/bin/launchctl")
                .args(["getenv", "DISPLAY"])
                .kill_on_drop(true)
                .output();
            match tokio::time::timeout(SETUP_TIMEOUT, output).await {
                Ok(Ok(output)) => String::from_utf8_lossy(&output.stdout).trim().to_string(),
                _ => String::new(),
            }
        } else {
            display
        };
        let (endpoint, screen) = parse_display(display.trim())?;
        let cookie = read_local_cookie(display.trim()).await;
        let display = Self {
            endpoint,
            screen,
            cookie,
            #[cfg(windows)]
            _server: None,
        };
        display.verify().await?;
        Ok(display)
    }

    async fn connect(&self) -> std::io::Result<Box<dyn X11Socket>> {
        match &self.endpoint {
            DisplayEndpoint::Tcp(host, port) => {
                Ok(Box::new(TcpStream::connect((host.as_str(), *port)).await?))
            }
            #[cfg(unix)]
            DisplayEndpoint::Unix(path) => {
                Ok(Box::new(tokio::net::UnixStream::connect(path).await?))
            }
        }
    }

    async fn verify(&self) -> Result<(), String> {
        let verify = async {
            let mut socket = self.connect().await.map_err(|error| {
                format!("无法连接本机 X Server，请启动 X Server 并检查 DISPLAY：{error}")
            })?;
            socket
                .write_all(&make_setup(true, &self.cookie))
                .await
                .map_err(|error| format!("发送 X11 认证失败：{error}"))?;
            let mut reply = [0; 8];
            socket
                .read_exact(&mut reply)
                .await
                .map_err(|error| format!("读取 X Server 认证结果失败：{error}"))?;
            if reply[0] != 1 {
                return Err("本机 X Server 拒绝认证，请检查 xauth 和 XAUTHORITY 配置。".to_string());
            }
            Ok(())
        };
        tokio::time::timeout(SETUP_TIMEOUT, verify)
            .await
            .map_err(|_| "连接本机 X Server 超时，请检查显示服务。".to_string())?
    }
}

fn parse_display(display: &str) -> Result<(DisplayEndpoint, u32), String> {
    let (host, number) = display.rsplit_once(':').ok_or_else(|| {
        "未找到本机 DISPLAY，请先启动 X Server（macOS 使用 XQuartz）。".to_string()
    })?;
    let (number, screen) = number.split_once('.').unwrap_or((number, "0"));
    let number: u16 = number.parse().map_err(|_| "DISPLAY 显示编号无效")?;
    let screen: u32 = screen.parse().map_err(|_| "DISPLAY 屏幕编号无效")?;
    #[cfg(unix)]
    {
        if host.starts_with('/') {
            let socket = display
                .rsplit_once('.')
                .filter(|(_, suffix)| suffix.parse::<u32>().is_ok())
                .map(|(path, _)| path)
                .unwrap_or(display);
            return Ok((DisplayEndpoint::Unix(PathBuf::from(socket)), screen));
        }
        if host.is_empty() || host == "unix" || host.ends_with("/unix") {
            return Ok((
                DisplayEndpoint::Unix(PathBuf::from(format!("/tmp/.X11-unix/X{number}"))),
                screen,
            ));
        }
    }
    let host = host
        .strip_prefix("tcp/")
        .unwrap_or(host)
        .trim_matches(['[', ']']);
    let host = if host.is_empty() { "127.0.0.1" } else { host };
    let port = 6000u16.checked_add(number).ok_or("DISPLAY 端口超出范围")?;
    Ok((DisplayEndpoint::Tcp(host.to_string(), port), screen))
}

async fn read_local_cookie(display: &str) -> Vec<u8> {
    #[cfg(target_os = "macos")]
    let executable = PathBuf::from("/opt/X11/bin/xauth");
    #[cfg(windows)]
    let executable = find_vcxsrv()
        .map(|path| path.with_file_name("xauth.exe"))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("xauth.exe"));
    #[cfg(not(any(windows, target_os = "macos")))]
    let executable = PathBuf::from("xauth");
    let mut command = Command::new(executable);
    command.args(["list", display]).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let output = tokio::time::timeout(SETUP_TIMEOUT, command.output()).await;
    if let Ok(Ok(output)) = output {
        if output.status.success() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                let fields: Vec<_> = line.split_whitespace().collect();
                if fields.len() == 3 && fields[1].as_bytes() == AUTH_PROTOCOL {
                    if let Some(cookie) = decode_cookie(fields[2]) {
                        return cookie.to_vec();
                    }
                }
            }
        }
    }
    Vec::new()
}

struct SetupRequest {
    little_endian: bool,
    protocol: Vec<u8>,
    cookie: Vec<u8>,
}

async fn read_setup(reader: &mut (impl AsyncRead + Unpin)) -> std::io::Result<SetupRequest> {
    let mut header = [0; 12];
    reader.read_exact(&mut header).await?;
    let little_endian = match header[0] {
        b'l' => true,
        b'B' => false,
        _ => return Err(std::io::ErrorKind::InvalidData.into()),
    };
    let word = |offset| {
        let bytes = [header[offset], header[offset + 1]];
        if little_endian {
            u16::from_le_bytes(bytes)
        } else {
            u16::from_be_bytes(bytes)
        }
    };
    let protocol_length = usize::from(word(6));
    let cookie_length = usize::from(word(8));
    if word(2) != 11 || word(4) != 0 || protocol_length > 256 || cookie_length > 256 {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    let padded_protocol_length = (protocol_length + 3) & !3;
    let mut auth = vec![0; padded_protocol_length + ((cookie_length + 3) & !3)];
    reader.read_exact(&mut auth).await?;
    Ok(SetupRequest {
        little_endian,
        protocol: auth[..protocol_length].to_vec(),
        cookie: auth[padded_protocol_length..padded_protocol_length + cookie_length].to_vec(),
    })
}

fn make_setup(little_endian: bool, cookie: &[u8]) -> Vec<u8> {
    let protocol = if cookie.is_empty() {
        &[][..]
    } else {
        AUTH_PROTOCOL
    };
    let mut setup = vec![if little_endian { b'l' } else { b'B' }, 0];
    for word in [11, 0, protocol.len() as u16, cookie.len() as u16, 0] {
        let bytes = if little_endian {
            word.to_le_bytes()
        } else {
            word.to_be_bytes()
        };
        setup.extend_from_slice(&bytes);
    }
    setup.extend_from_slice(protocol);
    setup.resize((setup.len() + 3) & !3, 0);
    setup.extend_from_slice(cookie);
    setup.resize((setup.len() + 3) & !3, 0);
    setup
}

fn random_cookie() -> Result<[u8; 16], String> {
    let mut cookie = [0; 16];
    SystemRandom::new()
        .fill(&mut cookie)
        .map_err(|_| "生成 X11 认证凭据失败")?;
    Ok(cookie)
}

fn encode_cookie(cookie: &[u8]) -> String {
    cookie.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_cookie(value: &str) -> Option<[u8; 16]> {
    if value.len() != 32 || !value.is_ascii() {
        return None;
    }
    let mut cookie = [0; 16];
    for (index, byte) in cookie.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(cookie)
}

#[cfg(windows)]
struct OwnedXServer {
    child: tokio::process::Child,
    authority: PathBuf,
    _job: std::os::windows::io::OwnedHandle,
}

#[cfg(windows)]
fn bind_server_lifetime(
    child: &tokio::process::Child,
) -> std::io::Result<std::os::windows::io::OwnedHandle> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    // The unnamed job is owned solely by this process and uses default security attributes.
    let raw_job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if raw_job.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    // CreateJobObjectW returned a fresh handle whose ownership transfers to OwnedHandle.
    let job = unsafe { OwnedHandle::from_raw_handle(raw_job) };
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // The structure and its size match the requested information class.
    let configured = unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
        )
    };
    if configured == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let process = child
        .raw_handle()
        .ok_or_else(|| std::io::Error::other("X Server 已退出"))?;
    // Both handles remain live for this call. Closing the job also covers abrupt app exits.
    if unsafe { AssignProcessToJobObject(job.as_raw_handle(), process) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(job)
}

#[cfg(windows)]
impl Drop for OwnedXServer {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
        let _ = std::fs::remove_file(&self.authority);
    }
}

#[cfg(windows)]
fn find_vcxsrv() -> Option<PathBuf> {
    let installed = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
        .into_iter()
        .filter_map(std::env::var_os)
        .flat_map(|root| {
            [
                PathBuf::from(&root).join("VcXsrv/vcxsrv.exe"),
                PathBuf::from(root).join("Programs/VcXsrv/vcxsrv.exe"),
            ]
        });
    let path = std::env::var_os("PATH").unwrap_or_default();
    installed
        .chain(std::env::split_paths(&path).map(|path| path.join("vcxsrv.exe")))
        .find(|path| path.is_file())
}

#[cfg(windows)]
async fn start_windows_server() -> Result<LocalDisplay, String> {
    use std::io::Write;
    use std::process::Stdio;

    let executable = find_vcxsrv().ok_or(
        "未找到本机 X Server，请安装 VcXsrv 后重试；已有 X Server 时可通过 DISPLAY 指定。",
    )?;
    let cookie = random_cookie()?;
    let start = 100 + u16::from(cookie[0]) % 100;
    let number = (start..start + 100)
        .find(|number| {
            std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 6000 + number)).is_ok()
        })
        .ok_or("没有可用的本机 X11 显示端口")?;
    let authority = std::env::temp_dir().join(format!(
        "portiva-x11-{}.auth",
        encode_cookie(&random_cookie()?)
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&authority)
        .map_err(|error| format!("创建 X11 认证文件失败：{error}"))?;
    // Xauthority records use network byte order, independently of X11 setup byte order.
    let mut record = vec![0xff, 0xff]; // FamilyWild
    for field in [
        &[][..],
        number.to_string().as_bytes(),
        AUTH_PROTOCOL,
        &cookie,
    ] {
        record.extend_from_slice(&(field.len() as u16).to_be_bytes());
        record.extend_from_slice(field);
    }
    if let Err(error) = file.write_all(&record) {
        drop(file);
        let _ = std::fs::remove_file(&authority);
        return Err(format!("写入 X11 认证文件失败：{error}"));
    }
    drop(file);
    let child = Command::new(executable)
        .arg(format!(":{number}"))
        .args([
            "-multiwindow",
            "-clipboard",
            "-noreset",
            "-listen",
            "tcp",
            "-auth",
        ])
        .arg(&authority)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000)
        .kill_on_drop(true)
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(error) => {
            let _ = std::fs::remove_file(&authority);
            return Err(format!("启动 VcXsrv 失败：{error}"));
        }
    };
    let job = match bind_server_lifetime(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill().await;
            let _ = std::fs::remove_file(&authority);
            return Err(format!("配置 X Server 进程生命周期失败：{error}"));
        }
    };
    let mut display = LocalDisplay {
        endpoint: DisplayEndpoint::Tcp("127.0.0.1".to_string(), 6000 + number),
        screen: 0,
        cookie: cookie.to_vec(),
        _server: Some(OwnedXServer {
            child,
            authority,
            _job: job,
        }),
    };
    let startup = async {
        loop {
            if let Some(server) = display._server.as_mut() {
                if let Some(status) = server.child.try_wait().map_err(|error| error.to_string())? {
                    return Err(format!(
                        "VcXsrv 启动后退出（{status}），请检查安装和显示端口。"
                    ));
                }
            }
            if display.verify().await.is_ok() {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(10), startup)
        .await
        .map_err(|_| "启动 VcXsrv 超时，请检查本机 X Server 安装。".to_string())??;
    Ok(display)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn managed_server_process_ends_when_its_job_handle_closes() {
        tauri::async_runtime::block_on(async {
            let mut child = Command::new("ping.exe")
                .args(["-t", "127.0.0.1"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .creation_flags(0x0800_0000)
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            assert!(child.try_wait().unwrap().is_none());
            let job = bind_server_lifetime(&child).unwrap();
            drop(job);
            tokio::time::timeout(SETUP_TIMEOUT, child.wait())
                .await
                .unwrap()
                .unwrap();
        });
    }

    fn register_test_display(forwarding: &X11Forwarding, port: u16) -> X11Registration {
        let display = Arc::new(LocalDisplay {
            endpoint: DisplayEndpoint::Tcp("127.0.0.1".to_string(), port),
            screen: 0,
            cookie: vec![0x23; 16],
            #[cfg(windows)]
            _server: None,
        });
        let (cancel, cancelled) = watch::channel(false);
        let session = Arc::new(ForwardedSession { display, cancelled });
        let cookie = random_cookie().unwrap();
        forwarding
            .sessions
            .lock()
            .unwrap()
            .insert(cookie, Arc::downgrade(&session));
        X11Registration {
            session,
            cookie,
            cancel,
        }
    }

    #[test]
    fn availability_probe_requires_successful_display_authentication() {
        tauri::async_runtime::block_on(async {
            for accepted in [true, false] {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let forwarding = X11Forwarding::default();
                let registration =
                    register_test_display(&forwarding, listener.local_addr().unwrap().port());
                let server = tokio::spawn(async move {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let setup = read_setup(&mut socket).await.unwrap();
                    assert_eq!(setup.cookie, vec![0x23; 16]);
                    let mut reply = [0; 8];
                    reply[0] = u8::from(accepted);
                    socket.write_all(&reply).await.unwrap();
                });
                assert_eq!(
                    registration.session.display.verify().await.is_ok(),
                    accepted
                );
                server.await.unwrap();
            }
        });
    }

    #[test]
    fn availability_probe_rejects_an_unreachable_display() {
        tauri::async_runtime::block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let forwarding = X11Forwarding::default();
            let registration =
                register_test_display(&forwarding, listener.local_addr().unwrap().port());
            drop(listener);
            assert!(registration.session.display.verify().await.is_err());
        });
    }

    #[test]
    fn forwards_fragmented_setup_replaces_cookie_and_cancels_both_directions() {
        tauri::async_runtime::block_on(async {
            for little_endian in [true, false] {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let forwarding = Arc::new(X11Forwarding::default());
                let registration =
                    register_test_display(&forwarding, listener.local_addr().unwrap().port());
                let (mut client, remote) = tokio::io::duplex(128);
                let task_forwarding = Arc::clone(&forwarding);
                let task =
                    tokio::spawn(async move { task_forwarding.forward_stream(remote).await });
                let packet = make_setup(little_endian, &registration.cookie);
                client.write_all(&packet[..5]).await.unwrap();
                tokio::task::yield_now().await;
                client.write_all(&packet[5..]).await.unwrap();
                client.write_all(b"request").await.unwrap();

                let (mut local, _) = tokio::time::timeout(SETUP_TIMEOUT, listener.accept())
                    .await
                    .unwrap()
                    .unwrap();
                let setup = read_setup(&mut local).await.unwrap();
                assert_eq!(setup.little_endian, little_endian);
                assert_eq!(setup.cookie, vec![0x23; 16]);
                let mut received = [0; 7];
                local.read_exact(&mut received).await.unwrap();
                assert_eq!(&received, b"request");
                local.write_all(b"response").await.unwrap();
                let mut response = [0; 8];
                client.read_exact(&mut response).await.unwrap();
                assert_eq!(&response, b"response");

                drop(registration);
                tokio::time::timeout(SETUP_TIMEOUT, task)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(client.read(&mut response).await.unwrap(), 0);
                match local.read(&mut response).await {
                    Ok(length) => assert_eq!(length, 0),
                    Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset),
                }
            }
        });
    }

    #[test]
    fn rejects_unknown_and_revoked_cookies_before_connecting_to_local_display() {
        tauri::async_runtime::block_on(async {
            for revoked in [false, true] {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let forwarding = Arc::new(X11Forwarding::default());
                let registration =
                    register_test_display(&forwarding, listener.local_addr().unwrap().port());
                let cookie = if revoked {
                    registration.cookie
                } else {
                    [0x77; 16]
                };
                let _active_registration = if revoked {
                    drop(registration);
                    None
                } else {
                    Some(registration)
                };
                let (mut client, remote) = tokio::io::duplex(128);
                let task = tokio::spawn(async move { forwarding.forward_stream(remote).await });
                client.write_all(&make_setup(true, &cookie)).await.unwrap();
                tokio::time::timeout(SETUP_TIMEOUT, task)
                    .await
                    .unwrap()
                    .unwrap();
                assert!(
                    tokio::time::timeout(Duration::from_millis(20), listener.accept())
                        .await
                        .is_err()
                );
            }
        });
    }

    #[test]
    fn revoking_one_terminal_keeps_other_registrations_active() {
        let forwarding = X11Forwarding::default();
        let first = register_test_display(&forwarding, 6000);
        let second = register_test_display(&forwarding, 6001);
        assert_ne!(first.cookie, second.cookie);
        let cancelled = first.session.cancelled.clone();
        drop(first);
        assert!(*cancelled.borrow());
        assert!(!*second.session.cancelled.borrow());
    }

    #[test]
    fn parses_tcp_displays_and_rejects_invalid_ports() {
        assert_eq!(
            parse_display("localhost:10.2").unwrap(),
            (DisplayEndpoint::Tcp("localhost".into(), 6010), 2)
        );
        assert_eq!(
            parse_display("[::1]:0").unwrap(),
            (DisplayEndpoint::Tcp("::1".into(), 6000), 0)
        );
        for value in [
            "",
            "localhost",
            "localhost:-1",
            "localhost:60000",
            "localhost:0.bad",
        ] {
            assert!(parse_display(value).is_err(), "{value}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn parses_unix_and_xquartz_displays() {
        assert_eq!(
            parse_display(":1").unwrap().0,
            DisplayEndpoint::Unix("/tmp/.X11-unix/X1".into())
        );
        assert_eq!(
            parse_display("/private/tmp/launchd.example/org.xquartz:0")
                .unwrap()
                .0,
            DisplayEndpoint::Unix("/private/tmp/launchd.example/org.xquartz:0".into())
        );
    }

    #[test]
    fn cookies_round_trip_without_accepting_malformed_values() {
        let cookie = random_cookie().unwrap();
        assert_eq!(decode_cookie(&encode_cookie(&cookie)), Some(cookie));
        for value in [
            "",
            "0123",
            "gggggggggggggggggggggggggggggggg",
            "中文中文中文中文中文中文中文中文",
        ] {
            assert_eq!(decode_cookie(value), None);
        }
    }

    #[test]
    fn setup_handles_both_byte_orders_and_empty_local_authentication() {
        tauri::async_runtime::block_on(async {
            for little_endian in [true, false] {
                for cookie in [&[][..], &[0x42; 16][..]] {
                    let packet = make_setup(little_endian, cookie);
                    let decoded = read_setup(&mut packet.as_slice()).await.unwrap();
                    assert_eq!(decoded.little_endian, little_endian);
                    assert_eq!(decoded.cookie, cookie);
                    assert_eq!(
                        decoded.protocol,
                        if cookie.is_empty() {
                            &[][..]
                        } else {
                            AUTH_PROTOCOL
                        }
                    );
                }
            }
        });
    }

    #[test]
    fn rejects_invalid_setup_and_excessive_authentication_lengths() {
        tauri::async_runtime::block_on(async {
            for (offset, value) in [(0, b'x'), (2, 12), (7, 2), (9, 2)] {
                let mut packet = make_setup(true, &[0; 16]);
                packet[offset] = value;
                assert!(read_setup(&mut packet.as_slice()).await.is_err());
            }
            assert!(read_setup(&mut &b"l\0"[..]).await.is_err());
        });
    }

    #[test]
    fn forwarding_is_disabled_until_a_terminal_registers() {
        let forwarding = X11Forwarding::default();
        assert!(forwarding.sessions.lock().unwrap().is_empty());
        assert!(forwarding.display.try_lock().unwrap().upgrade().is_none());
    }
}
