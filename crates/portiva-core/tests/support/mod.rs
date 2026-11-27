//! Loopback-only SSH/SFTP fixture. It serves only its generated temporary directory.
#![allow(dead_code)]
use anyhow::Result;
use russh::{
    Channel, ChannelId,
    keys::{Algorithm, PrivateKey},
    server::{self, Auth, Msg, Server as _, Session},
};
use russh_sftp::protocol::*;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

pub struct TestServer {
    pub port: u16,
    pub fingerprint: String,
    pub key: PrivateKey,
    pub root: tempfile::TempDir,
    pub input: Arc<Mutex<Vec<u8>>>,
    pub shells: Arc<Mutex<Vec<ShellRecord>>>,
    pub resource_requests: Arc<AtomicUsize>,
    handle: server::RunningServerHandle,
    task: tokio::task::JoinHandle<()>,
}
#[derive(Default)]
pub struct ShellRecord {
    pub input: Vec<u8>,
    pub size: (u32, u32),
    pub closed: bool,
}
impl TestServer {
    pub async fn start(latency: Duration) -> Result<Self> {
        let root = tempfile::tempdir()?;
        tokio::fs::create_dir(root.path().join("documents")).await?;
        tokio::fs::write(
            root.path().join("readme.txt"),
            "Portiva 2 loopback fixture\n你好，SSH / SFTP。\n",
        )
        .await?;
        tokio::fs::write(
            root.path().join("documents/notes.md"),
            "# Temporary test data\n",
        )
        .await?;
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)?;
        let fingerprint = key
            .public_key()
            .fingerprint(russh::keys::HashAlg::Sha256)
            .to_string();
        let config = Arc::new(server::Config {
            keys: vec![key.clone()],
            auth_rejection_time: Duration::from_millis(1),
            auth_rejection_time_initial: Some(Duration::ZERO),
            ..Default::default()
        });
        let socket = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = socket.local_addr()?.port();
        let input = Arc::new(Mutex::new(Vec::new()));
        let shells = Arc::new(Mutex::new(Vec::new()));
        let resource_requests = Arc::new(AtomicUsize::new(0));
        let mut server = Fixture {
            root: Arc::new(root.path().into()),
            latency,
            channels: HashMap::new(),
            shells: HashMap::new(),
            sizes: HashMap::new(),
            shell_records: shells.clone(),
            resource_requests: resource_requests.clone(),
            input: input.clone(),
        };
        let (send, receive) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let future = server.run_on_socket(config, &socket);
            let _ = send.send(future.handle());
            let _ = future.await;
        });
        let handle = receive.await?;
        Ok(Self {
            port,
            fingerprint,
            key,
            root,
            input,
            shells,
            resource_requests,
            handle,
            task,
        })
    }
}
impl Drop for TestServer {
    fn drop(&mut self) {
        self.handle.shutdown("fixture done".into());
        self.task.abort();
    }
}
struct Fixture {
    root: Arc<PathBuf>,
    latency: Duration,
    channels: HashMap<ChannelId, Channel<Msg>>,
    shells: HashMap<ChannelId, usize>,
    sizes: HashMap<ChannelId, (u32, u32)>,
    shell_records: Arc<Mutex<Vec<ShellRecord>>>,
    resource_requests: Arc<AtomicUsize>,
    input: Arc<Mutex<Vec<u8>>>,
}
impl server::Server for Fixture {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        Self {
            root: self.root.clone(),
            latency: self.latency,
            channels: HashMap::new(),
            shells: HashMap::new(),
            sizes: HashMap::new(),
            shell_records: self.shell_records.clone(),
            resource_requests: self.resource_requests.clone(),
            input: self.input.clone(),
        }
    }
}
impl server::Handler for Fixture {
    type Error = anyhow::Error;
    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth> {
        Ok(if user == "demo" && password == "portiva-test" {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }
    async fn auth_publickey(&mut self, user: &str, _: &russh::keys::PublicKey) -> Result<Auth> {
        Ok(if user == "demo" {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        _: &mut Session,
    ) -> Result<bool> {
        self.channels.insert(channel.id(), channel);
        Ok(true)
    }
    async fn pty_request(
        &mut self,
        id: ChannelId,
        _: &str,
        columns: u32,
        rows: u32,
        _: u32,
        _: u32,
        _: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<()> {
        self.sizes.insert(id, (columns, rows));
        session.channel_success(id)?;
        Ok(())
    }
    async fn window_change_request(
        &mut self,
        id: ChannelId,
        columns: u32,
        rows: u32,
        _: u32,
        _: u32,
        _: &mut Session,
    ) -> Result<()> {
        self.sizes.insert(id, (columns, rows));
        if let Some(index) = self.shells.get(&id) {
            self.shell_records.lock().unwrap()[*index].size = (columns, rows);
        }
        Ok(())
    }
    async fn shell_request(&mut self, id: ChannelId, session: &mut Session) -> Result<()> {
        let mut records = self.shell_records.lock().unwrap();
        let index = records.len();
        records.push(ShellRecord {
            size: self.sizes.get(&id).copied().unwrap_or_default(),
            ..Default::default()
        });
        drop(records);
        self.shells.insert(id, index);
        session.channel_success(id)?;
        session.data(id,"\x1b[38;2;121;203;184mPortiva 2 · loopback SSH\x1b[0m\r\n中文终端 / 256 colors / SFTP\r\nThis fixture echoes input; it does not execute commands.\r\n\r\ndemo@localhost:~$ ")?;
        Ok(())
    }
    async fn data(&mut self, id: ChannelId, data: &[u8], session: &mut Session) -> Result<()> {
        if let Some(index) = self.shells.get(&id) {
            self.input.lock().unwrap().extend_from_slice(data);
            self.shell_records.lock().unwrap()[*index]
                .input
                .extend_from_slice(data);
            session.data(id, data.to_vec())?;
        }
        Ok(())
    }
    async fn exec_request(
        &mut self,
        id: ChannelId,
        command: &[u8],
        session: &mut Session,
    ) -> Result<()> {
        // No command is executed. Return synthetic counters only for the resource probe.
        if !command
            .windows(b"PORTIVA_RESOURCES_V1".len())
            .any(|part| part == b"PORTIVA_RESOURCES_V1")
        {
            session.channel_failure(id)?;
            return Ok(());
        }
        let sample = self.resource_requests.fetch_add(1, Ordering::SeqCst) as u64;
        session.channel_success(id)?;
        session.data(id, format!("PORTIVA_RESOURCES_V1\ncpu {} 0 50 {} 0 0 0 0\n__MEMORY__\nMemTotal: 8388608 kB\nMemAvailable: 5242880 kB\n__DISK__\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/fixture 104857600 26214400 78643200 25% /\n", 100 + sample * 25, 850 + sample * 75))?;
        session.exit_status_request(id, 0)?;
        session.eof(id)?;
        session.close(id)?;
        Ok(())
    }
    async fn channel_close(&mut self, id: ChannelId, _: &mut Session) -> Result<()> {
        if let Some(index) = self.shells.remove(&id) {
            self.shell_records.lock().unwrap()[index].closed = true;
        }
        self.channels.remove(&id);
        self.sizes.remove(&id);
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<()> {
        if name == "sftp" {
            let channel = self
                .channels
                .remove(&id)
                .ok_or_else(|| anyhow::anyhow!("missing channel"))?;
            session.channel_success(id)?;
            let sftp = FileSystem {
                root: self.root.clone(),
                latency: self.latency,
                files: HashMap::new(),
                dirs: HashMap::new(),
                read_dirs: HashSet::new(),
                next: 0,
            };
            tokio::spawn(async move {
                russh_sftp::server::run(channel.into_stream(), sftp).await;
            });
        } else {
            session.channel_failure(id)?;
        }
        Ok(())
    }
    async fn channel_eof(&mut self, id: ChannelId, session: &mut Session) -> Result<()> {
        session.close(id)?;
        Ok(())
    }
}

struct FileSystem {
    root: Arc<PathBuf>,
    latency: Duration,
    files: HashMap<String, tokio::fs::File>,
    dirs: HashMap<String, PathBuf>,
    read_dirs: HashSet<String>,
    next: u64,
}
impl FileSystem {
    fn path(&self, remote: &str) -> std::result::Result<PathBuf, StatusCode> {
        let mut path = self.root.as_ref().clone();
        for part in remote.split('/') {
            if part.is_empty() || part == "." {
                continue;
            }
            if part == ".." || part.contains(['\\', ':']) {
                return Err(StatusCode::PermissionDenied);
            }
            path.push(part);
        }
        Ok(path)
    }
    fn handle(&mut self) -> String {
        self.next += 1;
        self.next.to_string()
    }
    async fn attrs(&self, path: &str) -> std::result::Result<FileAttributes, StatusCode> {
        let metadata = tokio::fs::symlink_metadata(self.path(path)?)
            .await
            .map_err(code)?;
        Ok(attributes(&metadata))
    }
}
fn attributes(m: &std::fs::Metadata) -> FileAttributes {
    FileAttributes {
        size: Some(m.len()),
        permissions: Some(if m.is_dir() { 0o040755 } else { 0o100644 }),
        mtime: Some(1700000000),
        atime: Some(1700000000),
        ..Default::default()
    }
}
fn code(e: std::io::Error) -> StatusCode {
    match e.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NoSuchFile,
        std::io::ErrorKind::PermissionDenied => StatusCode::PermissionDenied,
        _ => StatusCode::Failure,
    }
}
fn ok(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: "en".into(),
    }
}
impl russh_sftp::server::Handler for FileSystem {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn realpath(&mut self, id: u32, path: String) -> std::result::Result<Name, StatusCode> {
        self.attrs(&path).await?;
        Ok(Name {
            id,
            files: vec![File::dummy(if path == "." {
                "/".into()
            } else {
                format!("/{}", path.trim_matches('/'))
            })],
        })
    }
    async fn lstat(&mut self, id: u32, path: String) -> std::result::Result<Attrs, StatusCode> {
        Ok(Attrs {
            id,
            attrs: self.attrs(&path).await?,
        })
    }
    async fn stat(&mut self, id: u32, path: String) -> std::result::Result<Attrs, StatusCode> {
        self.lstat(id, path).await
    }
    async fn fstat(&mut self, id: u32, handle: String) -> std::result::Result<Attrs, StatusCode> {
        let m = self
            .files
            .get(&handle)
            .ok_or(StatusCode::Failure)?
            .metadata()
            .await
            .map_err(code)?;
        Ok(Attrs {
            id,
            attrs: attributes(&m),
        })
    }
    async fn open(
        &mut self,
        id: u32,
        path: String,
        flags: OpenFlags,
        _: FileAttributes,
    ) -> std::result::Result<Handle, StatusCode> {
        let path = self.path(&path)?;
        let mut opts = tokio::fs::OpenOptions::new();
        opts.read(flags.contains(OpenFlags::READ))
            .write(flags.contains(OpenFlags::WRITE));
        if flags.contains(OpenFlags::EXCLUDE) {
            opts.create_new(true);
        } else {
            opts.create(flags.contains(OpenFlags::CREATE))
                .truncate(flags.contains(OpenFlags::TRUNCATE));
        }
        let file = opts.open(path).await.map_err(code)?;
        let handle = self.handle();
        self.files.insert(handle.clone(), file);
        Ok(Handle { id, handle })
    }
    async fn close(&mut self, id: u32, handle: String) -> std::result::Result<Status, StatusCode> {
        self.files.remove(&handle);
        self.dirs.remove(&handle);
        self.read_dirs.remove(&handle);
        Ok(ok(id))
    }
    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> std::result::Result<Data, StatusCode> {
        tokio::time::sleep(self.latency).await;
        let file = self.files.get_mut(&handle).ok_or(StatusCode::Failure)?;
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(code)?;
        let mut data = vec![0; len.min(32768) as usize];
        let count = file.read(&mut data).await.map_err(code)?;
        if count == 0 {
            return Err(StatusCode::Eof);
        }
        data.truncate(count);
        Ok(Data { id, data })
    }
    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> std::result::Result<Status, StatusCode> {
        tokio::time::sleep(self.latency).await;
        let file = self.files.get_mut(&handle).ok_or(StatusCode::Failure)?;
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(code)?;
        file.write_all(&data).await.map_err(code)?;
        Ok(ok(id))
    }
    async fn opendir(&mut self, id: u32, path: String) -> std::result::Result<Handle, StatusCode> {
        let path = self.path(&path)?;
        let _ = tokio::fs::read_dir(&path).await.map_err(code)?;
        let handle = self.handle();
        self.dirs.insert(handle.clone(), path);
        Ok(Handle { id, handle })
    }
    async fn readdir(&mut self, id: u32, handle: String) -> std::result::Result<Name, StatusCode> {
        if !self.read_dirs.insert(handle.clone()) {
            return Err(StatusCode::Eof);
        }
        let mut dir = tokio::fs::read_dir(self.dirs.get(&handle).ok_or(StatusCode::Failure)?)
            .await
            .map_err(code)?;
        let mut files = Vec::new();
        while let Some(entry) = dir.next_entry().await.map_err(code)? {
            let m = entry.metadata().await.map_err(code)?;
            files.push(File::new(
                entry.file_name().to_string_lossy().into_owned(),
                attributes(&m),
            ));
        }
        Ok(Name { id, files })
    }
    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _: FileAttributes,
    ) -> std::result::Result<Status, StatusCode> {
        tokio::fs::create_dir(self.path(&path)?)
            .await
            .map_err(code)?;
        Ok(ok(id))
    }
    async fn rmdir(&mut self, id: u32, path: String) -> std::result::Result<Status, StatusCode> {
        tokio::fs::remove_dir(self.path(&path)?)
            .await
            .map_err(code)?;
        Ok(ok(id))
    }
    async fn remove(&mut self, id: u32, path: String) -> std::result::Result<Status, StatusCode> {
        tokio::fs::remove_file(self.path(&path)?)
            .await
            .map_err(code)?;
        Ok(ok(id))
    }
    async fn rename(
        &mut self,
        id: u32,
        from: String,
        to: String,
    ) -> std::result::Result<Status, StatusCode> {
        let to = self.path(&to)?;
        if Path::new(&to).exists() {
            return Err(StatusCode::Failure);
        }
        tokio::fs::rename(self.path(&from)?, to)
            .await
            .map_err(code)?;
        Ok(ok(id))
    }
}
