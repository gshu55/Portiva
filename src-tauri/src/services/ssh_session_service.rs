use std::collections::HashMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::agent::AgentIdentity;
use russh::keys::{load_secret_key, ssh_key, PrivateKeyWithHashAlg};
use russh::{client, ChannelMsg, ChannelReadHalf, ChannelWriteHalf, Disconnect, Pty};
use russh_sftp::client::SftpSession;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex as AsyncMutex;

use crate::domain::connection::SshHostOverview;
use crate::domain::file_transfer::{RemoteEntry, RemoteEntryKind};
use crate::domain::profile::ConnectionProfile;
use crate::domain::terminal::{TerminalRenderPolicy, TerminalSessionStatus, TerminalSize};
use crate::protocol::ssh::SSH_CONNECT_TIMEOUT_SECS;
use crate::security::fingerprint::display_fingerprint;
use crate::services::known_hosts_store::{KnownHostDecision, KnownHostsStore};
use crate::services::terminal_service::{
    drain_utf8_terminal_output, terminal_disconnect_notice, TerminalService,
};
use crate::utils::remote_path::{join_remote_path, normalize_remote_path};

const TERMINAL_SNAPSHOT_EVENT: &str = "portiva://terminal-snapshot";
const SFTP_REQUEST_TIMEOUT_SECS: u64 = 60;
const SSH_KEEPALIVE_INTERVAL_SECS: u64 = 15;
const SSH_KEEPALIVE_MAX_MISSES: usize = 2;
const SSH_HOST_OVERVIEW_TIMEOUT_SECS: u64 = 8;
const SSH_COMMAND_OUTPUT_MAX_BYTES: usize = 64 * 1024;
const TERMINAL_OUTPUT_FLUSH_INTERVAL: Duration = Duration::from_millis(16);
const TERMINAL_OUTPUT_MAX_CHUNK_BYTES: usize = 32 * 1024;
static TRANSFER_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputEvent {
    terminal_id: String,
    status: TerminalSessionStatus,
    buffered_bytes: usize,
    buffer_preview: String,
    render_policy: TerminalRenderPolicy,
    output_chunk: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshAuthOutcome {
    pub enable_sftp: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SftpTransferOutcome {
    pub total_bytes: Option<u64>,
    pub transferred_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SftpTransferDirective {
    Continue,
    Pause,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshConnectedTransport {
    pub host: String,
    pub port: u16,
    pub host_key_fingerprint: String,
}

#[derive(Default, Clone)]
pub struct SshSessionService {
    sessions: Arc<Mutex<HashMap<String, SshRuntimeSession>>>,
}

struct SshRuntimeSession {
    handle: Arc<AsyncMutex<client::Handle<SshRuntimeHandler>>>,
    host: String,
    port: u16,
    username: String,
    enable_sftp: bool,
    sftp: Option<Arc<AsyncMutex<SftpSession>>>,
    ptys: HashMap<String, SshPtySession>,
}

struct SshPtySession {
    write_half: Arc<AsyncMutex<ChannelWriteHalf<client::Msg>>>,
}

struct SshCommandOutput {
    exit_status: Option<u32>,
    stderr: String,
    stdout: String,
}

const HOST_OVERVIEW_COMMAND: &str = r#"LC_ALL=C
load_1=""
cpu_count=""
memory_total_kb=""
memory_available_kb=""
memory_free_kb=""
memory_buffers_kb=""
memory_cached_kb=""
uptime_seconds=""

if [ -r /proc/loadavg ]; then
  read load_1 _ < /proc/loadavg
fi

if command -v getconf >/dev/null 2>&1; then
  cpu_count=$(getconf _NPROCESSORS_ONLN 2>/dev/null)
fi
if [ -z "$cpu_count" ] && command -v nproc >/dev/null 2>&1; then
  cpu_count=$(nproc 2>/dev/null)
fi

if [ -r /proc/meminfo ]; then
  while read key value unit; do
    case "$key" in
      MemTotal:) memory_total_kb=$value ;;
      MemAvailable:) memory_available_kb=$value ;;
      MemFree:) memory_free_kb=$value ;;
      Buffers:) memory_buffers_kb=$value ;;
      Cached:) memory_cached_kb=$value ;;
    esac
  done < /proc/meminfo
fi
if [ -z "$memory_available_kb" ] && [ -n "$memory_free_kb" ]; then
  memory_available_kb=$((memory_free_kb + memory_buffers_kb + memory_cached_kb))
fi

if [ -r /proc/uptime ]; then
  read uptime_seconds _ < /proc/uptime
  uptime_seconds=${uptime_seconds%%.*}
fi

if [ -r /etc/os-release ]; then
  . /etc/os-release
  operating_system=${PRETTY_NAME:-${NAME:-Linux}}
else
  operating_system=$(uname -s 2>/dev/null)
fi
hostname_value=$(hostname 2>/dev/null)
kernel_version=$(uname -r 2>/dev/null)

printf 'portivaOverviewVersion\t1\n'
printf 'hostname\t%s\n' "$hostname_value"
printf 'operatingSystem\t%s\n' "$operating_system"
printf 'kernelVersion\t%s\n' "$kernel_version"
printf 'cpuLoad1\t%s\n' "$load_1"
printf 'cpuCount\t%s\n' "$cpu_count"
printf 'memoryTotalKb\t%s\n' "$memory_total_kb"
printf 'memoryAvailableKb\t%s\n' "$memory_available_kb"
printf 'uptimeSeconds\t%s\n' "$uptime_seconds"
"#;

impl SshSessionService {
    pub fn ensure_matches_profile(
        &self,
        connection_id: &str,
        profile: &ConnectionProfile,
    ) -> Result<(), String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "SSH session service lock poisoned".to_string())?;
        let session = sessions
            .get(connection_id)
            .ok_or_else(|| format!("SSH runtime session not found: {connection_id}"))?;
        let expected_host = profile.host.as_deref().unwrap_or_default().trim();
        let expected_username = profile.username.as_deref().unwrap_or_default().trim();
        let expected_port = profile.port.unwrap_or(22);

        if !session.host.eq_ignore_ascii_case(expected_host)
            || session.port != expected_port
            || session.username != expected_username
        {
            return Err("当前 SSH 会话与保存密码所属的连接配置不一致".to_string());
        }

        Ok(())
    }

    pub async fn connect_trusted(
        &self,
        connection_id: &str,
        profile: &ConnectionProfile,
        known_hosts: &KnownHostsStore,
    ) -> Result<SshConnectedTransport, String> {
        let opened = open_ssh_handle(profile.clone()).await?;

        match known_hosts.verify_host_key(&opened.host, opened.port, &opened.fingerprint)? {
            KnownHostDecision::Trusted => {}
            KnownHostDecision::Unknown => {
                let _ = opened
                    .handle
                    .disconnect(
                        Disconnect::HostKeyNotVerifiable,
                        "host key not trusted",
                        "en",
                    )
                    .await;
                return Err(format!(
                    "SSH host key is not trusted for {}. Confirm the fingerprint first ({})",
                    opened.host,
                    display_fingerprint(&opened.fingerprint),
                ));
            }
            KnownHostDecision::Changed => {
                let _ = opened
                    .handle
                    .disconnect(Disconnect::HostKeyNotVerifiable, "host key changed", "en")
                    .await;
                return Err(format!(
                    "SSH host key changed for {}; connection blocked",
                    opened.host
                ));
            }
        }

        self.sessions
            .lock()
            .map_err(|_| "SSH session service lock poisoned".to_string())?
            .insert(
                connection_id.to_string(),
                SshRuntimeSession {
                    handle: Arc::new(AsyncMutex::new(opened.handle)),
                    host: opened.host.clone(),
                    port: opened.port,
                    username: opened.username,
                    enable_sftp: true,
                    sftp: None,
                    ptys: HashMap::new(),
                },
            );

        Ok(SshConnectedTransport {
            host: opened.host,
            port: opened.port,
            host_key_fingerprint: opened.fingerprint,
        })
    }

    pub async fn connect_trusted_owned(
        self,
        connection_id: String,
        profile: ConnectionProfile,
        known_hosts: KnownHostsStore,
    ) -> Result<SshConnectedTransport, String> {
        let opened = open_ssh_handle(profile).await?;

        match known_hosts.verify_host_key(&opened.host, opened.port, &opened.fingerprint)? {
            KnownHostDecision::Trusted => {}
            KnownHostDecision::Unknown => {
                let _ = opened
                    .handle
                    .disconnect(
                        Disconnect::HostKeyNotVerifiable,
                        "host key not trusted",
                        "en",
                    )
                    .await;
                return Err(format!(
                    "SSH host key is not trusted for {}. Confirm the fingerprint first ({})",
                    opened.host,
                    display_fingerprint(&opened.fingerprint),
                ));
            }
            KnownHostDecision::Changed => {
                let _ = opened
                    .handle
                    .disconnect(Disconnect::HostKeyNotVerifiable, "host key changed", "en")
                    .await;
                return Err(format!(
                    "SSH host key changed for {}; connection blocked",
                    opened.host
                ));
            }
        }

        self.sessions
            .lock()
            .map_err(|_| "SSH session service lock poisoned".to_string())?
            .insert(
                connection_id,
                SshRuntimeSession {
                    handle: Arc::new(AsyncMutex::new(opened.handle)),
                    host: opened.host.clone(),
                    port: opened.port,
                    username: opened.username,
                    enable_sftp: true,
                    sftp: None,
                    ptys: HashMap::new(),
                },
            );

        Ok(SshConnectedTransport {
            host: opened.host,
            port: opened.port,
            host_key_fingerprint: opened.fingerprint,
        })
    }

    pub async fn authenticate_password(
        &self,
        connection_id: &str,
        password: String,
    ) -> Result<SshAuthOutcome, String> {
        if password.is_empty() {
            return Err("SSH password is required".to_string());
        }

        let session = self.take_session(connection_id)?;
        let result = async {
            let mut handle = session.handle.lock().await;
            let auth_result = handle
                .authenticate_password(session.username.clone(), password)
                .await
                .map_err(|error| format!("SSH password authentication failed: {error}"))?;

            if !auth_result.success() {
                return Err("SSH password authentication rejected by server".to_string());
            }

            Ok(SshAuthOutcome {
                enable_sftp: session.enable_sftp,
            })
        }
        .await;

        self.put_session(connection_id, session)?;
        result
    }

    pub async fn authenticate_password_owned(
        self,
        connection_id: String,
        password: String,
    ) -> Result<SshAuthOutcome, String> {
        if password.is_empty() {
            return Err("SSH password is required".to_string());
        }

        let session = self.take_session(&connection_id)?;
        let result = async {
            let mut handle = session.handle.lock().await;
            let auth_result = handle
                .authenticate_password(session.username.clone(), password)
                .await
                .map_err(|error| format!("SSH password authentication failed: {error}"))?;

            if !auth_result.success() {
                return Err("SSH password authentication rejected by server".to_string());
            }

            Ok(SshAuthOutcome {
                enable_sftp: session.enable_sftp,
            })
        }
        .await;

        self.put_session(&connection_id, session)?;
        result
    }

    pub async fn authenticate_private_key(
        &self,
        connection_id: &str,
        private_key_path: String,
        passphrase: Option<String>,
    ) -> Result<SshAuthOutcome, String> {
        let private_key_path = private_key_path.trim();
        if private_key_path.is_empty() {
            return Err("SSH private key path is required".to_string());
        }

        let session = self.take_session(connection_id)?;
        let result = async {
            let passphrase = passphrase
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let key_pair = load_secret_key(private_key_path, passphrase)
                .map_err(|error| format!("failed to load SSH private key: {error}"))?;
            let mut handle = session.handle.lock().await;
            let hash_alg = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|error| format!("failed to negotiate SSH key algorithm: {error}"))?
                .flatten();
            let auth_result = handle
                .authenticate_publickey(
                    session.username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(key_pair), hash_alg),
                )
                .await
                .map_err(|error| format!("SSH private key authentication failed: {error}"))?;

            if !auth_result.success() {
                return Err("SSH private key authentication rejected by server".to_string());
            }

            Ok(SshAuthOutcome {
                enable_sftp: session.enable_sftp,
            })
        }
        .await;

        self.put_session(connection_id, session)?;
        result
    }

    pub async fn authenticate_private_key_owned(
        self,
        connection_id: String,
        private_key_path: String,
        passphrase: Option<String>,
    ) -> Result<SshAuthOutcome, String> {
        if private_key_path.trim().is_empty() {
            return Err("SSH private key path is required".to_string());
        }

        let session = self.take_session(&connection_id)?;
        let result = async {
            let passphrase = passphrase
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let key_pair = load_secret_key(&private_key_path, passphrase)
                .map_err(|error| format!("failed to load SSH private key: {error}"))?;
            let mut handle = session.handle.lock().await;
            let hash_alg = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|error| format!("failed to negotiate SSH key algorithm: {error}"))?
                .flatten();
            let auth_result = handle
                .authenticate_publickey(
                    session.username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(key_pair), hash_alg),
                )
                .await
                .map_err(|error| format!("SSH private key authentication failed: {error}"))?;

            if !auth_result.success() {
                return Err("SSH private key authentication rejected by server".to_string());
            }

            Ok(SshAuthOutcome {
                enable_sftp: session.enable_sftp,
            })
        }
        .await;

        self.put_session(&connection_id, session)?;
        result
    }

    pub async fn authenticate_agent(&self, connection_id: &str) -> Result<SshAuthOutcome, String> {
        let mut session = self.take_session(connection_id)?;
        let result = authenticate_with_agent(&mut session).await;

        match result {
            Ok(outcome) => {
                self.put_session(connection_id, session)?;
                Ok(outcome)
            }
            Err(error) => {
                self.put_session(connection_id, session)?;
                Err(error)
            }
        }
    }

    pub async fn open_sftp(&self, connection_id: &str) -> Result<(), String> {
        let handle = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "SSH session service lock poisoned".to_string())?;
            let session = sessions
                .get(connection_id)
                .ok_or_else(|| format!("SSH runtime session not found: {connection_id}"))?;

            if !session.enable_sftp {
                return Err("SFTP is disabled for this SSH profile".to_string());
            }

            if session.sftp.is_some() {
                return Ok(());
            }

            Arc::clone(&session.handle)
        };

        let sftp = open_sftp_session_from_handle(handle).await?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "SSH session service lock poisoned".to_string())?;
        let session = sessions
            .get_mut(connection_id)
            .ok_or_else(|| format!("SSH runtime session not found: {connection_id}"))?;
        if session.sftp.is_none() {
            session.sftp = Some(Arc::new(AsyncMutex::new(sftp)));
        }
        Ok(())
    }

    pub async fn collect_host_overview(
        self,
        connection_id: String,
    ) -> Result<SshHostOverview, String> {
        let started_at = Instant::now();
        let output = self
            .execute_command(
                connection_id,
                HOST_OVERVIEW_COMMAND.to_string(),
                Duration::from_secs(SSH_HOST_OVERVIEW_TIMEOUT_SECS),
            )
            .await?;

        if output.exit_status.is_some_and(|status| status != 0) {
            let detail = output.stderr.trim();
            return Err(if detail.is_empty() {
                format!(
                    "SSH host overview command failed with exit status {:?}",
                    output.exit_status
                )
            } else {
                format!("SSH host overview command failed: {detail}")
            });
        }

        parse_host_overview(&output.stdout, started_at.elapsed())
    }

    async fn execute_command(
        self,
        connection_id: String,
        command: String,
        timeout: Duration,
    ) -> Result<SshCommandOutput, String> {
        let handle = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "SSH session service lock poisoned".to_string())?;
            Arc::clone(
                &sessions
                    .get(&connection_id)
                    .ok_or_else(|| format!("SSH runtime session not found: {connection_id}"))?
                    .handle,
            )
        };

        tokio::time::timeout(timeout, execute_command_with_handle(handle, command))
            .await
            .map_err(|_| {
                format!(
                    "SSH host overview timed out after {} seconds",
                    timeout.as_secs()
                )
            })?
    }

    pub fn has_sftp(&self, connection_id: &str) -> Result<bool, String> {
        Ok(self
            .sessions
            .lock()
            .map_err(|_| "SSH session service lock poisoned".to_string())?
            .get(connection_id)
            .map(|session| session.sftp.is_some())
            .unwrap_or(false))
    }

    pub async fn list_dir(
        &self,
        connection_id: &str,
        remote_path: &str,
    ) -> Result<Vec<RemoteEntry>, String> {
        let sftp = self.sftp_handle(connection_id)?;
        let sftp = sftp.lock().await;
        let result = list_dir_with_sftp(&sftp, remote_path).await;
        drop(sftp);

        if !is_sftp_session_closed_result(&result) {
            return result;
        }

        self.reopen_sftp(connection_id).await?;
        let sftp = self.sftp_handle(connection_id)?;
        let sftp = sftp.lock().await;
        list_dir_with_sftp(&sftp, remote_path).await
    }

    pub async fn entry_kind(
        &self,
        connection_id: &str,
        remote_path: &str,
    ) -> Result<Option<RemoteEntryKind>, String> {
        let sftp = self.sftp_handle(connection_id)?;
        let sftp = sftp.lock().await;
        let result = remote_entry_kind_with_sftp(&sftp, remote_path).await;
        drop(sftp);

        if !is_sftp_session_closed_result(&result) {
            return result;
        }

        self.reopen_sftp(connection_id).await?;
        let sftp = self.sftp_handle(connection_id)?;
        let sftp = sftp.lock().await;
        remote_entry_kind_with_sftp(&sftp, remote_path).await
    }

    pub async fn mkdir(&self, connection_id: &str, remote_path: &str) -> Result<(), String> {
        let sftp = self.sftp_handle(connection_id)?;
        let sftp = sftp.lock().await;
        let result = sftp
            .create_dir(normalize_remote_path(remote_path))
            .await
            .map_err(|error| format!("failed to create remote directory: {error}"));
        drop(sftp);

        if !is_sftp_session_closed_result(&result) {
            return result;
        }

        self.reopen_sftp(connection_id).await?;
        let sftp = self.sftp_handle(connection_id)?;
        let sftp = sftp.lock().await;
        sftp.create_dir(normalize_remote_path(remote_path))
            .await
            .map_err(|error| format!("failed to create remote directory: {error}"))
    }

    pub async fn remove(&self, connection_id: &str, remote_path: &str) -> Result<(), String> {
        let path = normalize_remote_path(remote_path);
        if path == "/" || path == "." {
            return Err(format!("refusing to remove remote root {path}"));
        }

        let sftp = self.sftp_handle(connection_id)?;
        let sftp = sftp.lock().await;
        let result = remove_remote_entry_with_sftp(&sftp, &path).await;
        drop(sftp);

        if !is_sftp_session_closed_result(&result) {
            return result;
        }

        self.reopen_sftp(connection_id).await?;
        let sftp = self.sftp_handle(connection_id)?;
        let sftp = sftp.lock().await;
        remove_remote_entry_with_sftp(&sftp, &path).await
    }

    pub async fn rename(&self, connection_id: &str, from: &str, to: &str) -> Result<(), String> {
        let sftp = self.sftp_handle(connection_id)?;
        let sftp = sftp.lock().await;
        let from = normalize_remote_path(from);
        let to = normalize_remote_path(to);
        let result = sftp
            .rename(from.clone(), to.clone())
            .await
            .map_err(|error| format!("failed to rename remote entry: {error}"));
        drop(sftp);

        if !is_sftp_session_closed_result(&result) {
            return result;
        }

        self.reopen_sftp(connection_id).await?;
        let sftp = self.sftp_handle(connection_id)?;
        let sftp = sftp.lock().await;
        sftp.rename(from, to)
            .await
            .map_err(|error| format!("failed to rename remote entry: {error}"))
    }

    pub async fn download_file_with_progress<F>(
        &self,
        connection_id: &str,
        remote_path: &str,
        local_path: &str,
        mut progress: F,
    ) -> Result<SftpTransferOutcome, String>
    where
        F: FnMut(u64, Option<u64>) -> Result<SftpTransferDirective, String> + Send,
    {
        let sftp = self.sftp_handle(connection_id)?;
        let sftp = sftp.lock().await;
        let result = download_file_with_sftp(&sftp, remote_path, local_path, &mut progress).await;
        drop(sftp);

        if !is_sftp_session_closed_result(&result) {
            return result;
        }

        self.reopen_sftp(connection_id).await?;
        let sftp = self.sftp_handle(connection_id)?;
        let sftp = sftp.lock().await;
        download_file_with_sftp(&sftp, remote_path, local_path, &mut progress).await
    }

    pub async fn upload_file_with_progress<F>(
        &self,
        connection_id: &str,
        local_path: &str,
        remote_path: &str,
        mut progress: F,
    ) -> Result<SftpTransferOutcome, String>
    where
        F: FnMut(u64, Option<u64>) -> Result<SftpTransferDirective, String> + Send,
    {
        let sftp = self.sftp_handle(connection_id)?;
        let sftp = sftp.lock().await;
        let result = upload_file_with_sftp(&sftp, local_path, remote_path, &mut progress).await;
        drop(sftp);

        if !is_sftp_session_closed_result(&result) {
            return result;
        }

        self.reopen_sftp(connection_id).await?;
        let sftp = self.sftp_handle(connection_id)?;
        let sftp = sftp.lock().await;
        upload_file_with_sftp(&sftp, local_path, remote_path, &mut progress).await
    }

    pub async fn open_pty(
        &self,
        connection_id: &str,
        terminal_id: &str,
        size: &TerminalSize,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        let mut session = self.take_session(connection_id)?;
        let result = open_pty_with_session(&mut session, terminal_id, size, app_handle).await;
        self.put_session(connection_id, session)?;
        result
    }

    pub async fn write_pty(
        &self,
        connection_id: &str,
        terminal_id: &str,
        data: &str,
    ) -> Result<(), String> {
        let write_half = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "SSH session service lock poisoned".to_string())?;
            sessions
                .get(connection_id)
                .and_then(|session| session.ptys.get(terminal_id))
                .map(|pty| Arc::clone(&pty.write_half))
                .ok_or_else(|| format!("SSH PTY not found: {terminal_id}"))?
        };

        let write_half = write_half.lock().await;
        write_half
            .data(Cursor::new(data.as_bytes().to_vec()))
            .await
            .map_err(|error| format!("failed to write SSH PTY data: {error}"))
    }

    pub async fn resize_pty(
        &self,
        connection_id: &str,
        terminal_id: &str,
        size: &TerminalSize,
    ) -> Result<(), String> {
        let write_half = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "SSH session service lock poisoned".to_string())?;
            sessions
                .get(connection_id)
                .and_then(|session| session.ptys.get(terminal_id))
                .map(|pty| Arc::clone(&pty.write_half))
                .ok_or_else(|| format!("SSH PTY not found: {terminal_id}"))?
        };

        let write_half = write_half.lock().await;
        write_half
            .window_change(
                size.cols as u32,
                size.rows as u32,
                size.width_px as u32,
                size.height_px as u32,
            )
            .await
            .map_err(|error| format!("failed to resize SSH PTY: {error}"))
    }

    pub async fn close_pty(&self, connection_id: &str, terminal_id: &str) -> Result<bool, String> {
        let mut session = self.take_session(connection_id)?;
        let pty = session.ptys.remove(terminal_id);
        let result = match pty {
            Some(pty) => {
                let write_half = Arc::clone(&pty.write_half);
                let write_half = write_half.lock().await;
                let _ = write_half.close().await;
                Ok(true)
            }
            None => Ok(false),
        };
        self.put_session(connection_id, session)?;
        result
    }

    pub async fn close_ptys_by_connection(&self, connection_id: &str) -> Result<usize, String> {
        let mut session = match self.take_session(connection_id) {
            Ok(session) => session,
            Err(_) => return Ok(0),
        };
        let ptys = std::mem::take(&mut session.ptys);
        let count = ptys.len();
        for (_, pty) in ptys {
            let write_half = Arc::clone(&pty.write_half);
            let write_half = write_half.lock().await;
            let _ = write_half.close().await;
        }
        self.put_session(connection_id, session)?;
        Ok(count)
    }

    pub async fn close_pty_by_terminal(&self, terminal_id: &str) -> Result<bool, String> {
        let pty = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "SSH session service lock poisoned".to_string())?;
            let mut removed = None;

            for session in sessions.values_mut() {
                if let Some(pty) = session.ptys.remove(terminal_id) {
                    removed = Some(pty);
                    break;
                }
            }

            removed
        };

        let Some(pty) = pty else {
            return Ok(false);
        };

        let write_half = Arc::clone(&pty.write_half);
        let write_half = write_half.lock().await;
        let _ = write_half.close().await;
        Ok(true)
    }

    pub async fn drain_pty_output(
        &self,
        connection_id: &str,
        terminal_id: &str,
    ) -> Result<String, String> {
        if !self.has_pty(connection_id, terminal_id)? {
            return Err(format!("SSH PTY not found: {terminal_id}"));
        }

        Ok(String::new())
    }

    pub fn has_pty(&self, connection_id: &str, terminal_id: &str) -> Result<bool, String> {
        Ok(self
            .sessions
            .lock()
            .map_err(|_| "SSH session service lock poisoned".to_string())?
            .get(connection_id)
            .map(|session| session.ptys.contains_key(terminal_id))
            .unwrap_or(false))
    }

    pub async fn close(&self, connection_id: &str) -> Result<bool, String> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "SSH session service lock poisoned".to_string())?
            .remove(connection_id);

        let Some(session) = session else {
            return Ok(false);
        };

        let handle = session.handle.lock().await;
        let _ = handle
            .disconnect(Disconnect::ByApplication, "connection closed", "en")
            .await;
        Ok(true)
    }

    pub async fn close_owned(self, connection_id: String) -> Result<bool, String> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "SSH session service lock poisoned".to_string())?
            .remove(&connection_id);

        let Some(session) = session else {
            return Ok(false);
        };

        let handle = session.handle.lock().await;
        let _ = handle
            .disconnect(Disconnect::ByApplication, "connection closed", "en")
            .await;
        Ok(true)
    }

    pub fn describe(&self, connection_id: &str) -> Result<Option<String>, String> {
        Ok(self
            .sessions
            .lock()
            .map_err(|_| "SSH session service lock poisoned".to_string())?
            .get(connection_id)
            .map(|session| {
                format!(
                    "{}@{}:{} sftp={}",
                    session.username, session.host, session.port, session.enable_sftp
                )
            }))
    }

    fn take_session(&self, connection_id: &str) -> Result<SshRuntimeSession, String> {
        self.sessions
            .lock()
            .map_err(|_| "SSH session service lock poisoned".to_string())?
            .remove(connection_id)
            .ok_or_else(|| format!("SSH runtime session not found: {connection_id}"))
    }

    fn put_session(&self, connection_id: &str, session: SshRuntimeSession) -> Result<(), String> {
        self.sessions
            .lock()
            .map_err(|_| "SSH session service lock poisoned".to_string())?
            .insert(connection_id.to_string(), session);
        Ok(())
    }

    fn sftp_handle(&self, connection_id: &str) -> Result<Arc<AsyncMutex<SftpSession>>, String> {
        self.sessions
            .lock()
            .map_err(|_| "SSH session service lock poisoned".to_string())?
            .get(connection_id)
            .and_then(|session| session.sftp.clone())
            .ok_or_else(|| "SFTP subsystem is not open for this connection".to_string())
    }

    async fn reopen_sftp(&self, connection_id: &str) -> Result<(), String> {
        let handle = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "SSH session service lock poisoned".to_string())?;
            let session = sessions
                .get_mut(connection_id)
                .ok_or_else(|| format!("SSH runtime session not found: {connection_id}"))?;
            session.sftp = None;
            Arc::clone(&session.handle)
        };

        let sftp = open_sftp_session_from_handle(handle)
            .await
            .map_err(|error| {
                format!(
                    "SFTP session was closed and automatic reopen failed; reconnect SSH/SFTP and retry: {error}",
                )
            })?;

        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "SSH session service lock poisoned".to_string())?;
        let session = sessions
            .get_mut(connection_id)
            .ok_or_else(|| format!("SSH runtime session not found: {connection_id}"))?;
        session.sftp = Some(Arc::new(AsyncMutex::new(sftp)));
        Ok(())
    }
}

struct OpenedSshHandle {
    fingerprint: String,
    handle: client::Handle<SshRuntimeHandler>,
    host: String,
    port: u16,
    username: String,
}

async fn open_ssh_handle(profile: ConnectionProfile) -> Result<OpenedSshHandle, String> {
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
    let handler = SshRuntimeHandler {
        fingerprint: Arc::clone(&fingerprint),
    };
    let config = Arc::new(ssh_client_config());

    let handle = tokio::time::timeout(
        timeout,
        client::connect(config, (host.clone(), port), handler),
    )
    .await
    .map_err(|_| format!("timed out opening SSH session {host}:{port}"))?
    .map_err(|error| format!("failed to open SSH session {host}:{port}: {error}"))?;
    let fingerprint = fingerprint
        .lock()
        .map_err(|_| "SSH session state lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "SSH server did not provide a host key fingerprint".to_string())?;

    Ok(OpenedSshHandle {
        fingerprint,
        handle,
        host,
        port,
        username,
    })
}

async fn execute_command_with_handle(
    handle: Arc<AsyncMutex<client::Handle<SshRuntimeHandler>>>,
    command: String,
) -> Result<SshCommandOutput, String> {
    let handle = handle.lock().await;
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("failed to open SSH command channel: {error}"))?;
    drop(handle);

    channel
        .exec(true, command.into_bytes())
        .await
        .map_err(|error| format!("failed to execute SSH host overview command: {error}"))?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_status = None;

    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => {
                append_bounded_command_output(&mut stdout, &data)?;
            }
            ChannelMsg::ExtendedData { data, .. } => {
                append_bounded_command_output(&mut stderr, &data)?;
            }
            ChannelMsg::ExitStatus {
                exit_status: status,
            } => {
                exit_status = Some(status);
            }
            _ => {}
        }
    }

    Ok(SshCommandOutput {
        exit_status,
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
    })
}

fn append_bounded_command_output(target: &mut Vec<u8>, data: &[u8]) -> Result<(), String> {
    if target.len().saturating_add(data.len()) > SSH_COMMAND_OUTPUT_MAX_BYTES {
        return Err(format!(
            "SSH host overview output exceeded {} bytes",
            SSH_COMMAND_OUTPUT_MAX_BYTES
        ));
    }

    target.extend_from_slice(data);
    Ok(())
}

fn parse_host_overview(output: &str, elapsed: Duration) -> Result<SshHostOverview, String> {
    let values = output
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .collect::<HashMap<_, _>>();

    if values.get("portivaOverviewVersion") != Some(&"1") {
        return Err("SSH host overview returned an unsupported response".to_string());
    }

    let memory_total_kb = parse_optional_number::<u64>(&values, "memoryTotalKb");
    let memory_available_kb = parse_optional_number::<u64>(&values, "memoryAvailableKb");
    let memory_total_bytes = memory_total_kb.map(|value| value.saturating_mul(1024));
    let memory_used_bytes = memory_total_kb
        .zip(memory_available_kb)
        .map(|(total, available)| total.saturating_sub(available).saturating_mul(1024));
    let cpu_load_1 = parse_optional_number::<f64>(&values, "cpuLoad1")
        .filter(|value| value.is_finite() && *value >= 0.0);
    let cpu_count = parse_optional_number::<u32>(&values, "cpuCount").filter(|value| *value > 0);

    Ok(SshHostOverview {
        hostname: value_or_fallback(&values, "hostname", "未知主机"),
        operating_system: value_or_fallback(&values, "operatingSystem", "未知系统"),
        kernel_version: value_or_fallback(&values, "kernelVersion", "未知内核"),
        cpu_load_1,
        cpu_count,
        memory_used_bytes,
        memory_total_bytes,
        uptime_seconds: parse_optional_number::<u64>(&values, "uptimeSeconds"),
        latency_ms: elapsed.as_millis().clamp(1, u64::MAX as u128) as u64,
    })
}

fn parse_optional_number<T>(values: &HashMap<&str, &str>, key: &str) -> Option<T>
where
    T: std::str::FromStr,
{
    values.get(key)?.trim().parse().ok()
}

fn value_or_fallback(values: &HashMap<&str, &str>, key: &str, fallback: &str) -> String {
    values
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

type DynamicAgentClient = AgentClient<Box<dyn AgentStream + Send + Unpin + 'static>>;

async fn open_sftp_session_from_handle(
    handle: Arc<AsyncMutex<client::Handle<SshRuntimeHandler>>>,
) -> Result<SftpSession, String> {
    let handle = handle.lock().await;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("failed to open SSH session channel: {error}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|error| format!("failed to request SFTP subsystem: {error}"))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|error| format!("failed to initialize SFTP session: {error}"))?;
    sftp.set_timeout(SFTP_REQUEST_TIMEOUT_SECS);
    Ok(sftp)
}

async fn connect_agent_client() -> Result<DynamicAgentClient, String> {
    #[cfg(unix)]
    {
        AgentClient::connect_env()
            .await
            .map(AgentClient::dynamic)
            .map_err(|error| format!("failed to connect SSH agent via SSH_AUTH_SOCK: {error}"))
    }

    #[cfg(windows)]
    {
        match AgentClient::connect_pageant().await {
            Ok(client) => Ok(client.dynamic()),
            Err(pageant_error) => AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")
                .await
                .map(AgentClient::dynamic)
                .map_err(|pipe_error| {
                    format!(
                        "failed to connect SSH agent (Pageant: {pageant_error}; OpenSSH agent pipe: {pipe_error})"
                    )
                }),
        }
    }

    #[cfg(not(any(unix, windows)))]
    {
        Err("SSH agent authentication is not supported on this platform yet".to_string())
    }
}

async fn authenticate_with_agent(
    session: &mut SshRuntimeSession,
) -> Result<SshAuthOutcome, String> {
    let mut agent = connect_agent_client().await?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|error| format!("failed to read SSH agent identities: {error}"))?;

    if identities.is_empty() {
        return Err("SSH agent has no identities loaded".to_string());
    }

    let mut handle = session.handle.lock().await;
    let hash_alg = handle
        .best_supported_rsa_hash()
        .await
        .map_err(|error| format!("failed to negotiate SSH key algorithm: {error}"))?
        .flatten();

    let mut attempted = 0usize;
    let mut last_error = None;
    for identity in identities {
        let auth_result = match identity {
            AgentIdentity::PublicKey { key, comment } => {
                attempted += 1;
                handle
                    .authenticate_publickey_with(
                        session.username.clone(),
                        key,
                        hash_alg,
                        &mut agent,
                    )
                    .await
                    .map_err(|error| {
                        format!("SSH agent public key authentication failed for {comment}: {error}")
                    })
            }
            AgentIdentity::Certificate {
                certificate,
                comment,
            } => {
                attempted += 1;
                handle
                    .authenticate_certificate_with(
                        session.username.clone(),
                        certificate,
                        hash_alg,
                        &mut agent,
                    )
                    .await
                    .map_err(|error| {
                        format!(
                            "SSH agent certificate authentication failed for {comment}: {error}"
                        )
                    })
            }
        };

        match auth_result {
            Ok(result) if result.success() => {
                return Ok(SshAuthOutcome {
                    enable_sftp: session.enable_sftp,
                });
            }
            Ok(_) => {
                last_error = Some("SSH agent identity was rejected by server".to_string());
            }
            Err(error) => last_error = Some(error),
        }
    }

    Err(last_error.unwrap_or_else(|| {
        format!("SSH agent authentication rejected by server after {attempted} identities")
    }))
}

struct SshRuntimeHandler {
    fingerprint: Arc<Mutex<Option<String>>>,
}

impl client::Handler for SshRuntimeHandler {
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

async fn list_dir_with_sftp(
    sftp: &SftpSession,
    remote_path: &str,
) -> Result<Vec<RemoteEntry>, String> {
    let remote_path = normalize_remote_path(remote_path);
    let mut entries = sftp
        .read_dir(remote_path.clone())
        .await
        .map_err(|error| format!("failed to list remote directory: {error}"))?
        .filter_map(|entry| {
            let metadata = entry.metadata();
            let raw_name = entry.file_name();
            let name = remote_entry_name(&raw_name);

            if name.is_empty() || name == "." || name == ".." {
                return None;
            }

            Some(RemoteEntry {
                path: join_remote_path(&remote_path, &name),
                name,
                kind: if metadata.is_dir() {
                    RemoteEntryKind::Directory
                } else if metadata.is_regular() {
                    RemoteEntryKind::File
                } else if metadata.is_symlink() {
                    RemoteEntryKind::Symlink
                } else {
                    RemoteEntryKind::Other
                },
                size: metadata.len(),
                modified_at: metadata.mtime.map(|mtime| format!("unix:{mtime}")),
                permissions: metadata
                    .permissions
                    .map(|permissions| format!("{permissions:o}")),
                owner: metadata.user,
                group: metadata.group,
            })
        })
        .collect::<Vec<_>>();

    entries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(entries)
}

async fn remote_entry_kind_with_sftp(
    sftp: &SftpSession,
    remote_path: &str,
) -> Result<Option<RemoteEntryKind>, String> {
    let path = normalize_remote_path(remote_path);
    if !sftp
        .try_exists(path.clone())
        .await
        .map_err(|error| format!("failed to inspect remote entry: {error}"))?
    {
        return Ok(None);
    }

    let metadata = sftp
        .symlink_metadata(path)
        .await
        .map_err(|error| format!("failed to inspect remote entry: {error}"))?;
    let kind = if metadata.is_dir() {
        RemoteEntryKind::Directory
    } else if metadata.is_regular() {
        RemoteEntryKind::File
    } else if metadata.is_symlink() {
        RemoteEntryKind::Symlink
    } else {
        RemoteEntryKind::Other
    };

    Ok(Some(kind))
}

async fn remove_remote_directory_tree(sftp: &SftpSession, remote_path: &str) -> Result<(), String> {
    let mut directories = vec![normalize_remote_path(remote_path)];
    let mut files = Vec::new();
    let mut index = 0;

    while index < directories.len() {
        let directory = directories[index].clone();
        index += 1;

        for entry in list_dir_with_sftp(sftp, &directory).await? {
            if matches!(entry.kind, RemoteEntryKind::Directory) {
                directories.push(entry.path);
            } else {
                files.push(entry.path);
            }
        }
    }

    for file in files {
        sftp.remove_file(file.clone())
            .await
            .map_err(|error| format!("failed to remove remote file {file}: {error}"))?;
    }

    for directory in directories.into_iter().rev() {
        sftp.remove_dir(directory.clone())
            .await
            .map_err(|error| format!("failed to remove remote directory {directory}: {error}"))?;
    }

    Ok(())
}

async fn remove_remote_entry_with_sftp(sftp: &SftpSession, path: &str) -> Result<(), String> {
    match sftp.symlink_metadata(path.to_string()).await {
        Ok(metadata) if metadata.is_dir() => remove_remote_directory_tree(sftp, path).await,
        Ok(_) => sftp
            .remove_file(path.to_string())
            .await
            .map_err(|error| format!("failed to remove remote file: {error}")),
        Err(error) => Err(format!("failed to inspect remote entry: {error}")),
    }
}

fn remote_entry_name(raw_name: &str) -> String {
    raw_name
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(raw_name)
        .to_string()
}

fn is_sftp_session_closed_result<T>(result: &Result<T, String>) -> bool {
    matches!(result, Err(error) if is_sftp_session_closed_error(error))
}

fn is_sftp_session_closed_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("session closed")
        || normalized.contains("channel closed")
        || normalized.contains("connection closed")
}

async fn open_pty_with_session(
    session: &mut SshRuntimeSession,
    terminal_id: &str,
    size: &TerminalSize,
    app_handle: AppHandle,
) -> Result<(), String> {
    if session.ptys.contains_key(terminal_id) {
        return Ok(());
    }

    let handle = session.handle.lock().await;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("failed to open SSH PTY channel: {error}"))?;
    let terminal_modes = [
        (Pty::VINTR, 3),
        (Pty::VQUIT, 28),
        (Pty::VERASE, 127),
        (Pty::VKILL, 21),
        (Pty::VEOF, 4),
        (Pty::VEOL, 0),
        (Pty::VEOL2, 0),
        (Pty::VSTART, 17),
        (Pty::VSTOP, 19),
        (Pty::VSUSP, 26),
        (Pty::ICRNL, 1),
        (Pty::IXON, 1),
        (Pty::ISIG, 1),
        (Pty::ICANON, 1),
        (Pty::ECHO, 1),
        (Pty::ECHOE, 1),
        (Pty::ECHOK, 1),
        (Pty::ECHOCTL, 1),
        (Pty::ECHOKE, 1),
        (Pty::OPOST, 1),
        (Pty::ONLCR, 1),
        (Pty::CS8, 1),
        (Pty::TTY_OP_ISPEED, 38_400),
        (Pty::TTY_OP_OSPEED, 38_400),
    ];

    channel
        .request_pty(
            true,
            "xterm-256color",
            size.cols as u32,
            size.rows as u32,
            size.width_px as u32,
            size.height_px as u32,
            &terminal_modes,
        )
        .await
        .map_err(|error| format!("failed to request SSH PTY: {error}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|error| format!("failed to start SSH shell: {error}"))?;

    let (read_half, write_half) = channel.split();
    spawn_pty_output_reader(app_handle, terminal_id.to_string(), read_half);
    session.ptys.insert(
        terminal_id.to_string(),
        SshPtySession {
            write_half: Arc::new(AsyncMutex::new(write_half)),
        },
    );
    Ok(())
}

fn spawn_pty_output_reader(
    app_handle: AppHandle,
    terminal_id: String,
    mut read_half: ChannelReadHalf,
) {
    tauri::async_runtime::spawn(async move {
        let mut pending_bytes = Vec::new();
        let mut last_flush = Instant::now();
        let mut disconnect_reason = "SSH 终端通道已关闭".to_string();

        loop {
            tokio::select! {
                message = read_half.wait() => {
                    let Some(message) = message else {
                        break;
                    };

                    match message {
                        ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                            pending_bytes.extend_from_slice(&data);
                            if pending_bytes.len() >= TERMINAL_OUTPUT_MAX_CHUNK_BYTES
                                || last_flush.elapsed() >= TERMINAL_OUTPUT_FLUSH_INTERVAL
                            {
                                flush_terminal_output(
                                    &app_handle,
                                    &terminal_id,
                                    &mut pending_bytes,
                                    &mut last_flush,
                                    false,
                                );
                            }
                        }
                        ChannelMsg::Close => {
                            disconnect_reason = "远端主机已关闭 SSH 终端通道".to_string();
                            break;
                        }
                        ChannelMsg::Eof => {
                            disconnect_reason = "SSH 终端通道已到达 EOF".to_string();
                            break;
                        }
                        _ => {}
                    }
                }
                _ = tokio::time::sleep(TERMINAL_OUTPUT_FLUSH_INTERVAL), if !pending_bytes.is_empty() => {
                    flush_terminal_output(
                        &app_handle,
                        &terminal_id,
                        &mut pending_bytes,
                        &mut last_flush,
                        false,
                    );
                }
            }
        }

        flush_terminal_output(
            &app_handle,
            &terminal_id,
            &mut pending_bytes,
            &mut last_flush,
            true,
        );
        emit_terminal_disconnected(&app_handle, &terminal_id, &disconnect_reason);
        let ssh_sessions = app_handle.state::<SshSessionService>();
        let _ = ssh_sessions.close_pty_by_terminal(&terminal_id).await;
    });
}

fn flush_terminal_output(
    app_handle: &AppHandle,
    terminal_id: &str,
    pending_bytes: &mut Vec<u8>,
    last_flush: &mut Instant,
    force: bool,
) {
    if pending_bytes.is_empty() {
        return;
    }

    let output = drain_utf8_terminal_output(pending_bytes, force);
    if output.is_empty() {
        return;
    }

    *last_flush = Instant::now();
    emit_terminal_snapshot(app_handle, terminal_id, &output);
}

fn emit_terminal_snapshot(app_handle: &AppHandle, terminal_id: &str, output: &str) {
    if output.is_empty() {
        return;
    }

    let terminal_service = app_handle.state::<TerminalService>();
    if let Ok(metadata) = terminal_service.append_output_metadata(terminal_id, output) {
        let _ = app_handle.emit(
            TERMINAL_SNAPSHOT_EVENT,
            TerminalOutputEvent {
                terminal_id: terminal_id.to_string(),
                status: metadata.status,
                buffered_bytes: metadata.buffered_bytes,
                buffer_preview: String::new(),
                render_policy: metadata.render_policy,
                output_chunk: output.to_string(),
            },
        );
    }
}

fn emit_terminal_disconnected(app_handle: &AppHandle, terminal_id: &str, reason: &str) {
    let terminal_service = app_handle.state::<TerminalService>();
    if terminal_service
        .append_disconnect_notice(terminal_id, reason)
        .is_err()
    {
        return;
    }

    if let Ok(snapshot) = terminal_service.snapshot(terminal_id) {
        let output = terminal_disconnect_notice(reason);
        let _ = app_handle.emit(
            TERMINAL_SNAPSHOT_EVENT,
            TerminalOutputEvent {
                terminal_id: snapshot.terminal_id,
                status: snapshot.status,
                buffered_bytes: snapshot.buffered_bytes,
                buffer_preview: snapshot.buffer_preview,
                render_policy: snapshot.render_policy,
                output_chunk: output,
            },
        );
    }
}

fn ssh_client_config() -> client::Config {
    client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(SSH_KEEPALIVE_INTERVAL_SECS)),
        keepalive_max: SSH_KEEPALIVE_MAX_MISSES,
        nodelay: true,
        ..Default::default()
    }
}

async fn download_file_with_sftp<F>(
    sftp: &SftpSession,
    remote_path: &str,
    local_path: &str,
    progress: &mut F,
) -> Result<SftpTransferOutcome, String>
where
    F: FnMut(u64, Option<u64>) -> Result<SftpTransferDirective, String> + Send,
{
    let remote_path = normalize_remote_path(remote_path);
    let local_target = Path::new(local_path);
    if tokio::fs::try_exists(local_target)
        .await
        .map_err(|error| format!("failed to inspect local download target: {error}"))?
    {
        return Err(format!(
            "download target already exists; choose a conflict action before retrying: {}",
            local_target.display()
        ));
    }

    if let Some(parent) = local_target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        let parent_metadata = tokio::fs::metadata(parent).await.map_err(|error| {
            format!(
                "download target directory does not exist or cannot be opened {}: {error}",
                parent.display()
            )
        })?;

        if !parent_metadata.is_dir() {
            return Err(format!(
                "download target parent is not a directory: {}",
                parent.display()
            ));
        }
    }

    let metadata = sftp
        .metadata(remote_path.clone())
        .await
        .map_err(|error| format!("failed to stat remote file: {error}"))?;

    if metadata.is_dir() {
        return Err(
            "remote path is a directory; recursive download is not implemented yet".to_string(),
        );
    }

    let mut remote_file = sftp
        .open(remote_path)
        .await
        .map_err(|error| format!("failed to open remote file: {error}"))?;
    let temporary_path = local_transfer_temp_path(local_target);
    let mut local_file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary_path)
        .await
        .map_err(|error| format!("failed to create local file: {error}"))?;
    let copy_result = copy_with_progress(
        &mut remote_file,
        &mut local_file,
        metadata.size,
        progress,
        "download remote file",
    )
    .await;

    let finalize_result = async {
        let transferred_bytes =
            copy_result.map_err(|error| format!("failed to download remote file: {error}"))?;
        local_file
            .flush()
            .await
            .map_err(|error| format!("failed to flush local file: {error}"))?;
        local_file
            .sync_all()
            .await
            .map_err(|error| format!("failed to sync local file: {error}"))?;
        drop(local_file);

        if tokio::fs::try_exists(local_target)
            .await
            .map_err(|error| format!("failed to recheck local download target: {error}"))?
        {
            return Err(format!(
                "download target appeared during transfer; temporary data was discarded: {}",
                local_target.display()
            ));
        }

        tokio::fs::rename(&temporary_path, local_target)
            .await
            .map_err(|error| format!("failed to finalize local download: {error}"))?;

        Ok(transferred_bytes)
    }
    .await;

    let transferred_bytes = match finalize_result {
        Ok(transferred_bytes) => transferred_bytes,
        Err(error) => {
            let _ = tokio::fs::remove_file(&temporary_path).await;
            return Err(error);
        }
    };

    Ok(SftpTransferOutcome {
        total_bytes: metadata.size,
        transferred_bytes,
    })
}

async fn upload_file_with_sftp<F>(
    sftp: &SftpSession,
    local_path: &str,
    remote_path: &str,
    progress: &mut F,
) -> Result<SftpTransferOutcome, String>
where
    F: FnMut(u64, Option<u64>) -> Result<SftpTransferDirective, String> + Send,
{
    let remote_path = normalize_remote_path(remote_path);
    let metadata = tokio::fs::metadata(local_path)
        .await
        .map_err(|error| format!("failed to stat local file: {error}"))?;

    if metadata.is_dir() {
        return Err(
            "local path is a directory; recursive upload is not implemented yet".to_string(),
        );
    }

    if sftp
        .try_exists(remote_path.clone())
        .await
        .map_err(|error| format!("failed to inspect remote upload target: {error}"))?
    {
        return Err(format!(
            "upload target already exists; choose a conflict action before retrying: {remote_path}"
        ));
    }

    let mut local_file = tokio::fs::File::open(local_path)
        .await
        .map_err(|error| format!("failed to open local file: {error}"))?;
    let temporary_path = remote_transfer_temp_path(&remote_path);
    let mut remote_file = sftp
        .create(temporary_path.clone())
        .await
        .map_err(|error| format!("failed to create remote file: {error}"))?;
    let copy_result = copy_with_progress(
        &mut local_file,
        &mut remote_file,
        Some(metadata.len()),
        progress,
        "upload local file",
    )
    .await;

    let finalize_result = async {
        let transferred_bytes =
            copy_result.map_err(|error| format!("failed to upload local file: {error}"))?;
        remote_file
            .flush()
            .await
            .map_err(|error| format!("failed to flush remote file: {error}"))?;
        remote_file
            .shutdown()
            .await
            .map_err(|error| format!("failed to close remote file: {error}"))?;
        drop(remote_file);

        if sftp
            .try_exists(remote_path.clone())
            .await
            .map_err(|error| format!("failed to recheck remote upload target: {error}"))?
        {
            return Err(format!(
                "upload target appeared during transfer; temporary data was discarded: {remote_path}"
            ));
        }

        sftp.rename(temporary_path.clone(), remote_path.clone())
            .await
            .map_err(|error| format!("failed to finalize remote upload: {error}"))?;

        Ok(transferred_bytes)
    }
    .await;

    let transferred_bytes = match finalize_result {
        Ok(transferred_bytes) => transferred_bytes,
        Err(error) => {
            let _ = sftp.remove_file(temporary_path).await;
            return Err(error);
        }
    };

    Ok(SftpTransferOutcome {
        total_bytes: Some(metadata.len()),
        transferred_bytes,
    })
}

fn next_transfer_temp_suffix() -> String {
    let sequence = TRANSFER_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1;
    format!("portiva-part-{}-{sequence}", std::process::id())
}

fn local_transfer_temp_path(target: &Path) -> PathBuf {
    let suffix = next_transfer_temp_suffix();
    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    target.with_file_name(format!(".{file_name}.{suffix}"))
}

fn remote_transfer_temp_path(target: &str) -> String {
    let suffix = next_transfer_temp_suffix();
    match target.rsplit_once('/') {
        Some((parent, name)) if !parent.is_empty() => format!("{parent}/.{name}.{suffix}"),
        Some((_, name)) => format!("/.{name}.{suffix}"),
        None => format!(".{target}.{suffix}"),
    }
}

async fn copy_with_progress<R, W, F>(
    reader: &mut R,
    writer: &mut W,
    total_bytes: Option<u64>,
    progress: &mut F,
    operation: &str,
) -> Result<u64, String>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    F: FnMut(u64, Option<u64>) -> Result<SftpTransferDirective, String> + Send,
{
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut transferred_bytes = 0_u64;
    wait_for_transfer_resume(progress, transferred_bytes, total_bytes).await?;

    loop {
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|error| format!("{operation} read failed: {error}"))?;
        if read == 0 {
            break;
        }

        writer
            .write_all(&buffer[..read])
            .await
            .map_err(|error| format!("{operation} write failed: {error}"))?;
        transferred_bytes = transferred_bytes.saturating_add(read as u64);
        wait_for_transfer_resume(progress, transferred_bytes, total_bytes).await?;
    }

    Ok(transferred_bytes)
}

async fn wait_for_transfer_resume<F>(
    progress: &mut F,
    transferred_bytes: u64,
    total_bytes: Option<u64>,
) -> Result<(), String>
where
    F: FnMut(u64, Option<u64>) -> Result<SftpTransferDirective, String> + Send,
{
    loop {
        match progress(transferred_bytes, total_bytes)? {
            SftpTransferDirective::Continue => return Ok(()),
            SftpTransferDirective::Pause => tokio::time::sleep(Duration::from_millis(200)).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::time::Duration;

    use super::{
        is_sftp_session_closed_result, local_transfer_temp_path, parse_host_overview,
        remote_entry_name, remote_transfer_temp_path, ssh_client_config, SshSessionService,
        SSH_KEEPALIVE_INTERVAL_SECS, SSH_KEEPALIVE_MAX_MISSES,
    };

    #[test]
    fn reports_missing_session() {
        let service = SshSessionService::default();

        assert!(service.describe("missing").unwrap().is_none());
    }

    #[test]
    fn host_overview_future_is_send() {
        fn assert_send<T: Send>(_: T) {}
        let service = SshSessionService::default();
        assert_send(service.collect_host_overview("missing".to_string()));
    }

    #[test]
    fn remote_entry_name_uses_last_path_segment() {
        assert_eq!(remote_entry_name("logs"), "logs");
        assert_eq!(remote_entry_name("/var/www/logs"), "logs");
        assert_eq!(remote_entry_name("var/www/logs/"), "logs");
        assert_eq!(remote_entry_name(r"C:\var\www\logs"), "logs");
        assert_eq!(remote_entry_name(r"C:\var\www\logs\"), "logs");
    }

    #[test]
    fn transfer_temp_paths_stay_next_to_their_targets_and_are_unique() {
        let local_target = Path::new("/tmp/archive.zip");
        let first_local = local_transfer_temp_path(local_target);
        let second_local = local_transfer_temp_path(local_target);
        let remote = remote_transfer_temp_path("/var/tmp/archive.zip");

        assert_eq!(first_local.parent(), local_target.parent());
        assert_ne!(first_local, second_local);
        assert!(remote.starts_with("/var/tmp/.archive.zip.portiva-part-"));
    }

    #[test]
    fn detects_retryable_sftp_session_closed_errors() {
        assert!(is_sftp_session_closed_result(&Result::<(), String>::Err(
            "channel closed".to_string()
        )));
        assert!(is_sftp_session_closed_result(&Result::<(), String>::Err(
            "session closed".to_string()
        )));
        assert!(is_sftp_session_closed_result(&Result::<(), String>::Err(
            "connection closed".to_string()
        )));
        assert!(!is_sftp_session_closed_result(&Result::<(), String>::Err(
            "permission denied".to_string()
        )));
    }

    #[test]
    fn ssh_client_config_keeps_idle_sessions_and_enables_keepalive_detection() {
        let config = ssh_client_config();

        assert_eq!(config.inactivity_timeout, None);
        assert_eq!(
            config.keepalive_interval,
            Some(Duration::from_secs(SSH_KEEPALIVE_INTERVAL_SECS))
        );
        assert_eq!(config.keepalive_max, SSH_KEEPALIVE_MAX_MISSES);
        assert!(config.nodelay);
    }

    #[test]
    fn parses_linux_host_overview_output() {
        let overview = parse_host_overview(
            "portivaOverviewVersion\t1\nhostname\tworker-01\noperatingSystem\tUbuntu 24.04.4 LTS\nkernelVersion\t6.8.0-63-generic\ncpuLoad1\t1.30\ncpuCount\t4\nmemoryTotalKb\t16384000\nmemoryAvailableKb\t8355840\nuptimeSeconds\t421200\n",
            Duration::from_millis(62),
        )
        .unwrap();

        assert_eq!(overview.hostname, "worker-01");
        assert_eq!(overview.cpu_load_1, Some(1.3));
        assert_eq!(overview.cpu_count, Some(4));
        assert_eq!(overview.memory_total_bytes, Some(16_777_216_000));
        assert_eq!(overview.memory_used_bytes, Some(8_220_835_840));
        assert_eq!(overview.uptime_seconds, Some(421_200));
        assert_eq!(overview.latency_ms, 62);
    }
}
