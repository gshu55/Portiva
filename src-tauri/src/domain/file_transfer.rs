use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub kind: RemoteEntryKind,
    pub size: u64,
    pub modified_at: Option<String>,
    pub permissions: Option<String>,
    pub owner: Option<String>,
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteEntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTransferSession {
    pub id: String,
    pub connection_id: String,
    pub protocol: TransferProtocol,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferTask {
    pub id: String,
    pub connection_id: String,
    pub direction: TransferDirection,
    pub protocol: TransferProtocol,
    pub item_kind: TransferTaskItemKind,
    pub local_path: String,
    pub remote_path: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub batch_items: Vec<TransferUploadItem>,
    pub status: TransferStatus,
    pub conflict_policy: TransferConflictPolicy,
    pub conflict_path: Option<String>,
    pub retry_count: u8,
    pub total_bytes: Option<u64>,
    pub transferred_bytes: u64,
    pub total_items: Option<u64>,
    pub completed_items: u64,
    pub skipped_items: u64,
    pub failed_items: u64,
    pub speed_bytes_per_second: Option<u64>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferUploadItem {
    pub local_path: String,
    pub remote_path: String,
    pub item_kind: TransferTaskItemKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransferTaskItemKind {
    File,
    Directory,
    Batch,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransferProtocol {
    Sftp,
    Scp,
    Ftp,
    Webdav,
    S3,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransferStatus {
    Pending,
    Running,
    Paused,
    WaitingConflict,
    Cancelled,
    Failed,
    Partial,
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransferConflictPolicy {
    Ask,
    Overwrite,
    OverwriteAll,
    Rename,
    Skip,
    SkipAll,
}
