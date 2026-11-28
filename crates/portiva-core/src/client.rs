use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Context, Result, bail};
use async_channel::{Receiver, Sender};
use russh::{
    ChannelMsg, Disconnect, client,
    keys::{self, PrivateKeyWithHashAlg, agent::AgentIdentity},
};
use russh_sftp::client::SftpSession;
use tokio::sync::{Mutex as AsyncMutex, OnceCell, Semaphore, mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::transfer::TransferControl;
use crate::x11::{X11Displays, X11Forwarding};
use crate::{
    files::{self, remote_join, sort_entries},
    store::HostTrust,
    *,
};

#[derive(Clone)]
pub struct Client {
    pub(crate) inner: Arc<Inner>,
}

pub(crate) struct Inner {
    pub store: Arc<Store>,
    pub events: Sender<CoreEvent>,
    pub sessions: Mutex<HashMap<SessionId, Arc<Session>>>,
    pub local_terminals: Mutex<HashMap<TerminalId, (SessionId, CancellationToken)>>,
    connections: Mutex<HashMap<SessionId, CancellationToken>>,
    pub transfers: Mutex<HashMap<TransferId, Arc<TransferControl>>>,
    pub transfer_slots: Arc<Semaphore>,
    x11_displays: Arc<X11Displays>,
}

pub(crate) struct Session {
    pub handle: AsyncMutex<client::Handle<SshHandler>>,
    pub browser: OnceCell<Arc<SftpSession>>,
    pub cancelled: CancellationToken,
    x11: Option<Arc<X11Forwarding>>,
}

#[derive(Clone)]
pub struct TerminalHandle {
    pub id: TerminalId,
    pub session_id: SessionId,
    pub(crate) sender: mpsc::Sender<TerminalCommand>,
    pub(crate) closed: CancellationToken,
}

pub(crate) enum TerminalCommand {
    Activate,
    Write(Vec<u8>),
    Resize(TerminalSize),
    Close,
}

impl TerminalHandle {
    /// Begin output delivery after the consumer has registered this terminal's ID.
    pub fn activate(&self) -> Result<()> {
        anyhow::ensure!(!self.closed.is_cancelled(), "终端通道已关闭");
        self.sender
            .try_send(TerminalCommand::Activate)
            .context("终端通道已关闭")
    }
    /// A single FIFO preserves key ordering. Queue overflow is returned, never silently dropped.
    pub fn write(&self, bytes: impl Into<Vec<u8>>) -> Result<()> {
        anyhow::ensure!(!self.closed.is_cancelled(), "终端通道已关闭");
        self.sender
            .try_send(TerminalCommand::Write(bytes.into()))
            .context("终端输入队列已满或会话已关闭")
    }
    pub fn resize(&self, size: TerminalSize) -> Result<()> {
        anyhow::ensure!(!self.closed.is_cancelled(), "终端通道已关闭");
        self.sender
            .try_send(TerminalCommand::Resize(size))
            .context("终端无法调整尺寸")
    }
    pub fn close(&self) {
        self.closed.cancel();
    }
}

impl Client {
    pub fn new(store: Store) -> (Self, Receiver<CoreEvent>) {
        let (events, receiver) = async_channel::bounded(256);
        (
            Self {
                inner: Arc::new(Inner {
                    store: Arc::new(store),
                    events,
                    sessions: Mutex::new(HashMap::new()),
                    local_terminals: Mutex::new(HashMap::new()),
                    transfers: Mutex::new(HashMap::new()),
                    connections: Mutex::new(HashMap::new()),
                    transfer_slots: Arc::new(Semaphore::new(3)),
                    x11_displays: Arc::new(X11Displays::default()),
                }),
            },
            receiver,
        )
    }

    pub fn store(&self) -> &Arc<Store> {
        &self.inner.store
    }

    pub async fn connect(
        &self,
        id: SessionId,
        profile: Profile,
        credentials: Credentials,
    ) -> Result<SessionInfo> {
        profile.validate()?;
        let cancelled = CancellationToken::new();
        {
            let mut connections = self
                .inner
                .connections
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            anyhow::ensure!(!connections.contains_key(&id), "连接 ID 已存在");
            connections.insert(id, cancelled.clone());
        }
        self.connection_event(id, ConnectionState::Connecting, "正在连接…")
            .await;
        let result = tokio::select! {
            result=self.connect_inner(id, &profile, credentials, cancelled.clone())=>result,
            _=cancelled.cancelled()=>Err(anyhow::anyhow!("连接已取消")),
        };
        if let Err(error) = &result {
            {
                let mut connections = self
                    .inner
                    .connections
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                if connections.get(&id) == Some(&cancelled) {
                    connections.remove(&id);
                }
            }
            self.connection_event(id, ConnectionState::Disconnected, &format!("{error:#}"))
                .await;
        }
        result.map(|()| SessionInfo { id, profile })
    }

    async fn connect_inner(
        &self,
        id: SessionId,
        profile: &Profile,
        credentials: Credentials,
        cancelled: CancellationToken,
    ) -> Result<()> {
        let store = self.inner.store.clone();
        let credential_profile = profile.clone();
        let credentials = tokio::task::spawn_blocking(move || {
            store.resolve_credentials(&credential_profile, credentials)
        })
        .await
        .context("读取凭据任务失败")??;
        let stream = tokio::time::timeout(
            Duration::from_secs(20),
            tokio::net::TcpStream::connect((profile.host.trim(), profile.port)),
        )
        .await
        .context("连接服务器超时")?
        .context("无法连接服务器")?;
        stream.set_nodelay(true)?;
        let config = Arc::new(client::Config {
            inactivity_timeout: None,
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 3,
            ..Default::default()
        });
        let x11 = profile.x11.enabled.then(|| {
            Arc::new(X11Forwarding::new(
                profile.x11.display.trim().to_owned(),
                self.inner.x11_displays.clone(),
                cancelled.clone(),
            ))
        });
        let handler = SshHandler {
            id,
            host: profile.host.clone(),
            port: profile.port,
            store: self.inner.store.clone(),
            events: self.inner.events.clone(),
            owner: Arc::downgrade(&self.inner),
            cancelled: cancelled.clone(),
            x11: x11.clone(),
        };
        let mut handle: client::Handle<SshHandler> = tokio::time::timeout(
            Duration::from_secs(150),
            client::connect_stream(config, stream, handler),
        )
        .await
        .context("SSH 握手或主机指纹确认超时")?
        .context("SSH 握手失败")?;
        self.connection_event(id, ConnectionState::Authenticating, "正在认证…")
            .await;
        tokio::time::timeout(
            Duration::from_secs(30),
            authenticate_credentials(&mut handle, profile.clone(), credentials),
        )
        .await
        .context("SSH 认证超时")??;
        {
            let _connections = self
                .inner
                .connections
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            anyhow::ensure!(!cancelled.is_cancelled(), "连接已取消");
            anyhow::ensure!(!handle.is_closed(), "服务器在认证后关闭了连接");
            self.inner
                .sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(
                    id,
                    Arc::new(Session {
                        handle: AsyncMutex::new(handle),
                        browser: OnceCell::new(),
                        cancelled,
                        x11,
                    }),
                );
        }
        self.connection_event(id, ConnectionState::Ready, "已连接")
            .await;
        Ok(())
    }

    fn connection_event(
        &self,
        id: SessionId,
        state: ConnectionState,
        message: &str,
    ) -> impl std::future::Future<Output = ()> + Send + 'static {
        let events = self.inner.events.clone();
        let message = message.to_owned();
        async move {
            let _ = events
                .send(CoreEvent::Connection {
                    session_id: id,
                    state,
                    message,
                })
                .await;
        }
    }

    pub(crate) fn session(&self, id: SessionId) -> Result<Arc<Session>> {
        self.inner
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .cloned()
            .context("连接已关闭，请重新连接")
    }

    pub async fn disconnect(&self, id: SessionId) -> Result<()> {
        for (session_id, token) in self
            .inner
            .local_terminals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            if *session_id == id {
                token.cancel();
            }
        }
        let session = {
            let mut connections = self
                .inner
                .connections
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(token) = connections.remove(&id) {
                token.cancel();
            }
            self.inner
                .sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id)
        };
        if let Some(session) = session {
            session.cancelled.cancel();
            let _ = session
                .handle
                .lock()
                .await
                .disconnect(Disconnect::ByApplication, "disconnected by user", "en")
                .await;
        }
        self.connection_event(id, ConnectionState::Disconnected, "已断开")
            .await;
        Ok(())
    }

    /// Let active transfers remove their temporary files before closing their SSH transports.
    pub async fn shutdown(&self) {
        for (_, token) in self
            .inner
            .local_terminals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            token.cancel();
        }
        for control in self
            .inner
            .transfers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            control.cancel();
        }
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            while self.transfers().iter().any(|t| !t.status.finished())
                || !self
                    .inner
                    .local_terminals
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .is_empty()
            {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        let ids: Vec<_> = self
            .inner
            .connections
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .copied()
            .collect();
        for id in ids {
            let _ = self.disconnect(id).await;
        }
    }

    pub async fn open_terminal(
        &self,
        session_id: SessionId,
        size: TerminalSize,
    ) -> Result<TerminalHandle> {
        let session = self.session(session_id)?;
        let registration = if let Some(x11) = &session.x11 {
            Some(tokio::select! {
                _ = session.cancelled.cancelled() => bail!("连接已关闭"),
                result = tokio::time::timeout(Duration::from_secs(20), x11.prepare()) => {
                    result.context("准备本机 X11 显示服务超时")?.map_err(anyhow::Error::msg)?
                }
            })
        } else {
            None
        };
        let mut channel = session.handle.lock().await.channel_open_session().await?;
        let mut initial_output = std::collections::VecDeque::new();
        let mut buffered_bytes = 0usize;
        enum Request {
            Pty,
            X11,
            Shell,
        }
        for request in [Request::Pty, Request::X11, Request::Shell] {
            let failure = match request {
                Request::Pty => {
                    channel
                        .request_pty(
                            true,
                            "xterm-256color",
                            size.columns.max(2).into(),
                            size.rows.max(1).into(),
                            0,
                            0,
                            &[],
                        )
                        .await?;
                    "服务器拒绝分配 PTY"
                }
                Request::X11 => {
                    let Some(registration) = &registration else {
                        continue;
                    };
                    channel
                        .request_x11(
                            true,
                            false,
                            "MIT-MAGIC-COOKIE-1",
                            registration.cookie_hex(),
                            registration.screen(),
                        )
                        .await?;
                    "服务器拒绝 X11 转发，请检查 sshd 的 X11Forwarding 和 xauth 配置"
                }
                Request::Shell => {
                    channel.request_shell(true).await?;
                    "服务器拒绝启动 shell"
                }
            };
            let acknowledgement = async {
                loop {
                    match channel.wait().await {
                        Some(ChannelMsg::Success) => return Ok(()),
                        Some(ChannelMsg::Failure) => bail!("{failure}"),
                        Some(ChannelMsg::Data { data })
                        | Some(ChannelMsg::ExtendedData { data, .. }) => {
                            buffered_bytes += data.len();
                            anyhow::ensure!(
                                buffered_bytes <= 2 * 1024 * 1024,
                                "服务器在通道确认前发送了过多数据"
                            );
                            initial_output.push_back(data.to_vec());
                        }
                        Some(ChannelMsg::Close | ChannelMsg::Eof) | None => {
                            bail!("服务器在终端初始化时关闭了通道")
                        }
                        _ => {}
                    }
                }
            };
            tokio::select! {
                _=session.cancelled.cancelled()=>bail!("连接已关闭"),
                result=tokio::time::timeout(Duration::from_secs(10),acknowledgement)=>result.context("终端初始化超时")??,
            }
        }
        let (mut reader, writer) = channel.split();
        let id = Uuid::new_v4();
        let (sender, mut commands) = mpsc::channel(1024);
        let events = self.inner.events.clone();
        let closed = CancellationToken::new();
        let reader_closed = closed.clone();
        tokio::spawn(async move {
            // Revoke this PTY's cookie and all of its X11 streams on every exit path.
            let x11 = registration;
            let mut activated = false;
            let result = async {
                loop {
                    if activated && let Some(data)=initial_output.pop_front(){
                        tokio::select!{
                            _=session.cancelled.cancelled()=>break,
                            _=reader_closed.cancelled()=>break,
                            result=events.send(CoreEvent::TerminalOutput{terminal_id:id,data})=>if result.is_err(){break;},
                        }
                        continue;
                    }
                    tokio::select! {
                        _ = session.cancelled.cancelled() => break,
                        _ = reader_closed.cancelled() => {let _=writer.close().await;break;},
                        command = commands.recv() => match command {
                            Some(TerminalCommand::Activate) => activated = true,
                            Some(TerminalCommand::Write(bytes)) => tokio::select! {
                                _=session.cancelled.cancelled()=>break,
                                _=reader_closed.cancelled()=>break,
                                result=writer.data(&bytes[..])=>result?,
                            },
                            Some(TerminalCommand::Resize(size)) => writer.window_change(size.columns.max(2).into(), size.rows.max(1).into(), 0, 0).await?,
                            Some(TerminalCommand::Close) => break,
                            None => { let _ = writer.close().await; break; }
                        },
                        message = reader.wait(), if activated => match message {
                            Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                                tokio::select! {
                                    _=session.cancelled.cancelled()=>break,
                                    _=reader_closed.cancelled()=>break,
                                    result=events.send(CoreEvent::TerminalOutput { terminal_id: id, data: data.to_vec() })=>if result.is_err(){break;},
                                }
                            }
                            Some(ChannelMsg::Eof | ChannelMsg::Close) | None => break,
                            _ => {}
                        }
                    }
                }
                Ok::<_, anyhow::Error>(())
            }.await;
            let _ = writer.close().await;
            drop(x11);
            reader_closed.cancel();
            let message = result
                .err()
                .map(|e| format!("终端已断开：{e:#}"))
                .unwrap_or_else(|| "终端通道已关闭".into());
            let _ = events
                .send(CoreEvent::TerminalClosed {
                    terminal_id: id,
                    message,
                })
                .await;
        });
        Ok(TerminalHandle {
            id,
            session_id,
            sender,
            closed,
        })
    }

    pub(crate) async fn new_sftp(&self, id: SessionId) -> Result<Arc<SftpSession>> {
        let session = self.session(id)?;
        let channel = session
            .handle
            .lock()
            .await
            .channel_open_session()
            .await
            .context("无法打开 SFTP 通道")?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .context("服务器未启用 SFTP")?;
        let sftp = SftpSession::new(channel.into_stream()).await?;
        sftp.set_timeout(30);
        Ok(Arc::new(sftp))
    }

    async fn browser(&self, id: SessionId) -> Result<Arc<SftpSession>> {
        let session = self.session(id)?;
        session
            .browser
            .get_or_try_init(|| self.new_sftp(id))
            .await
            .cloned()
    }

    pub async fn list_remote(&self, id: SessionId, path: &str) -> Result<DirectoryListing> {
        let sftp = self.browser(id).await?;
        let path = sftp
            .canonicalize(if path.trim().is_empty() { "." } else { path })
            .await?;
        let mut entries = remote_entries(&sftp, &path).await?;
        sort_entries(&mut entries);
        Ok(DirectoryListing { path, entries })
    }

    pub async fn list_local(&self, path: impl AsRef<Path>) -> Result<DirectoryListing> {
        files::local_listing(path.as_ref()).await
    }

    pub async fn create_remote_directory(
        &self,
        id: SessionId,
        parent: &str,
        name: &str,
    ) -> Result<()> {
        files::validate_name(name)?;
        self.browser(id)
            .await?
            .create_dir(remote_join(parent, name))
            .await?;
        Ok(())
    }

    pub async fn rename_remote(&self, id: SessionId, path: &str, name: &str) -> Result<()> {
        files::validate_name(name)?;
        files::protect_remote_root(path)?;
        let parent = path
            .rsplit_once('/')
            .map(|(p, _)| if p.is_empty() { "/" } else { p })
            .context("远程路径必须是绝对路径")?;
        self.browser(id)
            .await?
            .rename(path, remote_join(parent, name))
            .await?;
        Ok(())
    }

    pub async fn remove_remote(&self, id: SessionId, path: &str) -> Result<()> {
        files::protect_remote_root(path)?;
        let sftp = self.browser(id).await?;
        if !sftp.symlink_metadata(path).await?.is_dir() {
            sftp.remove_file(path).await?;
            return Ok(());
        }
        let canonical = sftp.canonicalize(path).await?;
        files::protect_remote_root(&canonical)?;
        let mut pending = vec![canonical];
        let mut directories = Vec::new();
        while let Some(path) = pending.pop() {
            for entry in remote_entries(&sftp, &path).await? {
                if entry.kind == FileKind::Directory {
                    pending.push(entry.path);
                } else {
                    sftp.remove_file(entry.path).await?;
                }
            }
            directories.push(path);
        }
        for path in directories.into_iter().rev() {
            sftp.remove_dir(path).await?;
        }
        Ok(())
    }
}

pub(crate) async fn remote_entries(sftp: &SftpSession, parent: &str) -> Result<Vec<FileEntry>> {
    let mut entries = Vec::new();
    for entry in sftp.read_dir(parent).await? {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        files::validate_name(&name)?;
        let metadata = entry.metadata();
        let kind = if metadata.is_symlink() {
            FileKind::Symlink
        } else if metadata.is_dir() {
            FileKind::Directory
        } else if metadata.is_regular() {
            FileKind::File
        } else {
            FileKind::Other
        };
        entries.push(FileEntry {
            path: remote_join(parent, &name),
            name,
            kind,
            size: metadata.size.unwrap_or(0),
            modified: metadata.mtime.map(u64::from),
            permissions: metadata.permissions,
        });
    }
    Ok(entries)
}

pub(crate) struct SshHandler {
    id: SessionId,
    host: String,
    port: u16,
    store: Arc<Store>,
    events: Sender<CoreEvent>,
    owner: std::sync::Weak<Inner>,
    cancelled: CancellationToken,
    x11: Option<Arc<X11Forwarding>>,
}

impl client::Handler for SshHandler {
    type Error = anyhow::Error;

    async fn server_channel_open_x11(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _: &str,
        _: u32,
        _: &mut client::Session,
    ) -> Result<()> {
        if let Some(x11) = &self.x11 {
            x11.forward(channel);
        } else {
            channel.close().await?;
        }
        Ok(())
    }

    async fn disconnected(&mut self, reason: client::DisconnectReason<Self::Error>) -> Result<()> {
        if let Some(owner) = self.owner.upgrade() {
            let session = {
                let mut connections = owner.connections.lock().unwrap_or_else(|e| e.into_inner());
                let mut sessions = owner.sessions.lock().unwrap_or_else(|e| e.into_inner());
                let session = if sessions
                    .get(&self.id)
                    .is_some_and(|s| s.cancelled == self.cancelled)
                {
                    sessions.remove(&self.id)
                } else {
                    None
                };
                if session.is_some() {
                    connections.remove(&self.id);
                }
                session
            };
            if let Some(session) = session {
                session.cancelled.cancel();
                let message = match &reason {
                    client::DisconnectReason::ReceivedDisconnect(info) => {
                        format!("服务器已断开：{}", info.message)
                    }
                    client::DisconnectReason::Error(error) => format!("SSH 连接已断开：{error:#}"),
                };
                let _ = self
                    .events
                    .send(CoreEvent::Connection {
                        session_id: self.id,
                        state: ConnectionState::Disconnected,
                        message,
                    })
                    .await;
            }
        }
        match reason {
            client::DisconnectReason::Error(error) => Err(error),
            _ => Ok(()),
        }
    }

    #[allow(refining_impl_trait)]
    fn check_server_key(
        &mut self,
        key: &keys::ssh_key::PublicKey,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<bool>> + Send + 'static>> {
        let fingerprint = key.fingerprint(keys::ssh_key::HashAlg::Sha256).to_string();
        let store = self.store.clone();
        let host = self.host.clone();
        let port = self.port;
        let id = self.id;
        let events = self.events.clone();
        let cancelled = self.cancelled.clone();
        Box::pin(async move {
            match store.check_host(&host, port, &fingerprint)? {
                HostTrust::Trusted => Ok(true),
                HostTrust::Changed(previous) => bail!(
                    "SSH 主机指纹已改变，连接已阻止。原指纹：{previous}；当前指纹：{fingerprint}"
                ),
                HostTrust::Unknown => {
                    let (response, answer) = oneshot::channel();
                    events
                        .send(CoreEvent::HostKey(HostKeyChallenge {
                            session_id: id,
                            host: host.clone(),
                            port,
                            fingerprint: fingerprint.clone(),
                            response,
                        }))
                        .await?;
                    let accepted = tokio::select! {
                        _=cancelled.cancelled()=>false,
                        answer=tokio::time::timeout(Duration::from_secs(120), answer)=>answer
                        .ok()
                        .and_then(Result::ok)
                        .unwrap_or(false),
                    };
                    if accepted {
                        store.trust_host(&host, port, &fingerprint)?;
                    }
                    Ok(accepted)
                }
            }
        })
    }
}

fn authenticate_agent<'a>(
    handle: &'a mut client::Handle<SshHandler>,
    username: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<bool>> + Send + 'a>> {
    Box::pin(async move {
        use keys::agent::client::AgentClient;
        #[cfg(unix)]
        let mut agent = AgentClient::connect_env().await?.dynamic();
        #[cfg(windows)]
        let mut agent = match AgentClient::connect_pageant().await {
            Ok(agent) => agent.dynamic(),
            Err(_) => AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")
                .await
                .context("无法连接 Pageant 或 Windows OpenSSH agent")?
                .dynamic(),
        };
        let hash = handle.best_supported_rsa_hash().await?.flatten();
        let identities = agent.request_identities().await?;
        let mut agent = AgentSigner(agent);
        for identity in identities {
            let result = match identity {
                AgentIdentity::PublicKey { key, .. } => {
                    handle
                        .authenticate_publickey_with(username.to_owned(), key, hash, &mut agent)
                        .await?
                }
                AgentIdentity::Certificate { certificate, .. } => {
                    handle
                        .authenticate_certificate_with(
                            username.to_owned(),
                            certificate,
                            hash,
                            &mut agent,
                        )
                        .await?
                }
            };
            if result.success() {
                return Ok(true);
            }
        }
        Ok(false)
    })
}

// Give the agent signer an explicitly boxed future. This avoids a russh RPIT lifetime
// inference limitation when authenticating from a multithreaded Tokio task.
struct AgentSigner(
    keys::agent::client::AgentClient<Box<dyn keys::agent::client::AgentStream + Send + Unpin>>,
);
impl russh::Signer for AgentSigner {
    type Error = russh::AgentAuthError;
    #[allow(refining_impl_trait)]
    fn auth_sign(
        &mut self,
        key: &AgentIdentity,
        hash: Option<keys::ssh_key::HashAlg>,
        bytes: Vec<u8>,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = std::result::Result<Vec<u8>, Self::Error>> + Send + '_,
        >,
    > {
        let key = key.clone();
        Box::pin(async move {
            self.0
                .sign_request(&key, hash, bytes)
                .await
                .map_err(Into::into)
        })
    }
}

fn authenticate_credentials(
    handle: &mut client::Handle<SshHandler>,
    profile: Profile,
    credentials: Credentials,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + '_>> {
    Box::pin(async move {
        let accepted = match profile.auth {
            AuthMethod::Password => handle
                .authenticate_password(profile.username.clone(), credentials.password.to_string())
                .await?
                .success(),
            AuthMethod::PrivateKey => {
                let path = profile.private_key_path.clone().context("未选择私钥")?;
                let passphrase = credentials.passphrase;
                let key = tokio::task::spawn_blocking(move || {
                    keys::load_secret_key(
                        path,
                        (!passphrase.is_empty()).then_some(passphrase.as_str()),
                    )
                })
                .await
                .context("无法加载私钥")??;
                let hash = handle.best_supported_rsa_hash().await?.flatten();
                handle
                    .authenticate_publickey(
                        profile.username.clone(),
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                    )
                    .await?
                    .success()
            }
            AuthMethod::Agent => authenticate_agent(handle, &profile.username).await?,
        };
        anyhow::ensure!(accepted, "SSH 认证被服务器拒绝，请检查用户名和凭据");
        Ok::<_, anyhow::Error>(())
    })
}
