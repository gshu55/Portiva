use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;
use uuid::Uuid;
use zeroize::Zeroizing;

pub type SessionId = Uuid;
pub type TerminalId = Uuid;
pub type TransferId = Uuid;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Protocol {
    #[default]
    Ssh,
    Sftp,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuthMethod {
    #[default]
    Password,
    PrivateKey,
    Agent,
}

/// Connection metadata only. Secrets deliberately cannot be serialized with a profile.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    #[serde(rename = "type", default)]
    pub protocol: Protocol,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(rename = "authType", default)]
    pub auth: AuthMethod,
    pub private_key_path: Option<PathBuf>,
    #[serde(default)]
    pub remember_secret: bool,
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name: String::new(),
            protocol: Protocol::Ssh,
            host: String::new(),
            port: 22,
            username: "root".into(),
            auth: AuthMethod::Password,
            private_key_path: None,
            remember_secret: false,
        }
    }
}

impl Profile {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(!self.host.trim().is_empty(), "请填写主机地址");
        anyhow::ensure!(
            !self.host.chars().any(char::is_control),
            "主机地址包含控制字符"
        );
        anyhow::ensure!(self.port != 0, "端口必须为 1–65535");
        anyhow::ensure!(!self.username.trim().is_empty(), "请填写用户名");
        if self.auth == AuthMethod::PrivateKey {
            anyhow::ensure!(self.private_key_path.is_some(), "请选择私钥文件");
        }
        Ok(())
    }

    pub fn title(&self) -> String {
        if self.name.trim().is_empty() {
            format!("{}@{}", self.username, self.host)
        } else {
            self.name.clone()
        }
    }
}

/// Kept in memory for one authentication attempt and zeroed on drop.
#[derive(Default)]
pub struct Credentials {
    pub password: Zeroizing<String>,
    pub passphrase: Zeroizing<String>,
}

impl Credentials {
    pub fn password(value: String) -> Self {
        Self {
            password: Zeroizing::new(value),
            ..Self::default()
        }
    }

    pub fn passphrase(value: String) -> Self {
        Self {
            passphrase: Zeroizing::new(value),
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug)]
pub struct SessionInfo {
    pub id: SessionId,
    pub profile: Profile,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionState {
    Connecting,
    Authenticating,
    Ready,
    Disconnected,
}

pub struct HostKeyChallenge {
    pub session_id: SessionId,
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
    pub response: oneshot::Sender<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileKind {
    Directory,
    File,
    Symlink,
    Other,
}

#[derive(Clone, Debug)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: FileKind,
    pub size: u64,
    pub modified: Option<u64>,
    pub permissions: Option<u32>,
}

#[derive(Clone, Debug)]
pub struct DirectoryListing {
    pub path: String,
    pub entries: Vec<FileEntry>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransferStatus {
    Queued,
    Running,
    Paused,
    WaitingConflict,
    Completed,
    Cancelled,
    Failed,
}

impl TransferStatus {
    pub fn finished(self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled | Self::Failed)
    }
}

#[derive(Clone, Debug)]
pub struct TransferSnapshot {
    pub id: TransferId,
    pub session_id: SessionId,
    pub direction: TransferDirection,
    pub name: String,
    pub source: String,
    pub destination: String,
    pub status: TransferStatus,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub completed_files: u64,
    pub skipped_files: u64,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConflictDecision {
    Overwrite,
    Skip,
    Cancel,
}

pub enum CoreEvent {
    HostKey(HostKeyChallenge),
    Connection {
        session_id: SessionId,
        state: ConnectionState,
        message: String,
    },
    TerminalOutput {
        terminal_id: TerminalId,
        data: Vec<u8>,
    },
    TerminalClosed {
        terminal_id: TerminalId,
        message: String,
    },
    Transfer(TransferSnapshot),
    TransferConflict {
        transfer_id: TransferId,
        path: String,
        response: oneshot::Sender<ConflictDecision>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalSize {
    pub columns: u16,
    pub rows: u16,
}

impl Default for TerminalSize {
    fn default() -> Self {
        Self {
            columns: 100,
            rows: 30,
        }
    }
}
