use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
use std::{env, fs};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::domain::file_transfer::{
    FileTransferSession, RemoteEntry, RemoteEntryKind, TransferDirection, TransferStatus,
    TransferTask,
};
use crate::domain::logging::LogLevel;
use crate::services::connection_manager::ConnectionManager;
use crate::services::file_transfer_service::FileTransferService;
use crate::services::log_service::LogService;
use crate::services::ssh_session_service::{SftpTransferDirective, SshSessionService};
use crate::services::transfer_service::TransferService;
use crate::utils::remote_path::normalize_remote_path;

const TRANSFER_CANCELLED: &str = "transfer cancelled";
const SFTP_MAX_RUNNING_TRANSFERS_PER_CONNECTION: usize = 1;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileListResult {
    pub path: String,
    pub entries: Vec<RemoteEntry>,
}

const LOCAL_ROOTS_PATH: &str = "portiva://local-roots";

#[tauri::command]
pub fn local_download_directory() -> Result<String, String> {
    let home = home_dir().ok_or_else(|| "failed to resolve user home directory".to_string())?;
    let downloads = PathBuf::from(home).join("Downloads");

    if downloads.is_dir() {
        return Ok(downloads.display().to_string());
    }

    Err(format!(
        "downloads directory does not exist: {}",
        downloads.display()
    ))
}

#[tauri::command]
pub fn local_file_list(path: String) -> Result<LocalFileListResult, String> {
    if is_local_roots_path(&path) {
        return list_local_roots();
    }

    let target = resolve_local_path(&path)?;
    let mut entries = Vec::new();

    for entry in fs::read_dir(&target).map_err(|error| {
        format!(
            "failed to list local directory {}: {error}",
            target.display()
        )
    })? {
        let entry =
            entry.map_err(|error| format!("failed to read local directory entry: {error}"))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            format!("failed to inspect local entry {}: {error}", path.display())
        })?;
        entries.push(local_entry_from_metadata(&path, metadata)?);
    }

    entries.sort_by(|left, right| {
        local_entry_kind_rank(&left.kind)
            .cmp(&local_entry_kind_rank(&right.kind))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    Ok(LocalFileListResult {
        path: target.display().to_string(),
        entries,
    })
}

fn home_dir() -> Option<String> {
    #[cfg(windows)]
    {
        let profile = env::var("USERPROFILE")
            .ok()
            .filter(|value| !value.trim().is_empty());

        profile.or_else(|| {
            let drive = env::var("HOMEDRIVE").ok()?;
            let path = env::var("HOMEPATH").ok()?;
            let home = format!("{drive}{path}");

            (!home.trim().is_empty()).then_some(home)
        })
    }

    #[cfg(not(windows))]
    {
        env::var("HOME")
            .ok()
            .filter(|value| !value.trim().is_empty())
    }
}

#[tauri::command]
pub fn local_file_mkdir(path: String) -> Result<(), String> {
    let target = resolve_local_path(&path)?;
    fs::create_dir(&target).map_err(|error| {
        format!(
            "failed to create local directory {}: {error}",
            target.display()
        )
    })
}

#[tauri::command]
pub fn local_file_remove(path: String) -> Result<(), String> {
    let target = resolve_local_path(&path)?;
    if is_filesystem_root(&target) {
        return Err(format!(
            "refusing to remove filesystem root {}",
            target.display()
        ));
    }

    let metadata = fs::symlink_metadata(&target).map_err(|error| {
        format!(
            "failed to inspect local entry {}: {error}",
            target.display()
        )
    })?;

    if metadata.is_dir() {
        fs::remove_dir_all(&target).map_err(|error| {
            format!(
                "failed to remove local directory tree {}: {error}",
                target.display()
            )
        })
    } else {
        fs::remove_file(&target)
            .map_err(|error| format!("failed to remove local file {}: {error}", target.display()))
    }
}

#[tauri::command]
pub fn local_file_rename(from: String, to: String) -> Result<(), String> {
    let from = resolve_local_path(&from)?;
    let to = resolve_local_path(&to)?;
    fs::rename(&from, &to).map_err(|error| {
        format!(
            "failed to rename local entry {} to {}: {error}",
            from.display(),
            to.display()
        )
    })
}

#[tauri::command]
pub fn local_reveal_item_in_directory(app_handle: AppHandle, path: String) -> Result<(), String> {
    let target = resolve_local_path(&path)?;

    if !target.exists() {
        return Err(format!("local path does not exist: {}", target.display()));
    }

    app_handle
        .opener()
        .reveal_item_in_dir(&target)
        .map_err(|error| {
            format!(
                "failed to open containing folder {}: {error}",
                target.display()
            )
        })
}

#[tauri::command]
pub async fn file_transfer_open(
    connection_id: String,
    connection_manager: State<'_, ConnectionManager>,
    file_transfer_service: State<'_, FileTransferService>,
    ssh_sessions: State<'_, SshSessionService>,
    logs: State<'_, LogService>,
) -> Result<FileTransferSession, String> {
    let session = connection_manager
        .get(&connection_id)?
        .ok_or_else(|| format!("connection not found: {connection_id}"))?;

    if !session.capabilities.file_transfer {
        return Err("connection does not support file transfer".to_string());
    }

    if session.is_file_transfer_ready() {
        return file_transfer_service.open(connection_id);
    }

    if !session.is_authenticated() {
        return Err("SSH must be authenticated before opening SFTP".to_string());
    }

    ssh_sessions.open_sftp(&connection_id).await?;
    let session = file_transfer_service.open(connection_id.clone())?;
    let _ = connection_manager.mark_sftp_ready(&connection_id)?;
    let _ = logs.record(
        LogLevel::Info,
        "transfer",
        format!("opened SFTP subsystem for {connection_id}"),
    );

    Ok(session)
}

#[tauri::command]
pub fn file_transfer_session(
    session_id: String,
    file_transfer_service: State<'_, FileTransferService>,
) -> Result<FileTransferSession, String> {
    file_transfer_service.session(&session_id)
}

#[tauri::command]
pub fn file_transfer_close(
    session_id: String,
    file_transfer_service: State<'_, FileTransferService>,
) -> Result<bool, String> {
    file_transfer_service.close(&session_id)
}

#[tauri::command]
pub async fn file_transfer_list(
    session_id: String,
    remote_path: String,
    file_transfer_service: State<'_, FileTransferService>,
    ssh_sessions: State<'_, SshSessionService>,
) -> Result<Vec<RemoteEntry>, String> {
    let session = file_transfer_service.session(&session_id)?;
    let remote_path = normalize_remote_list_path(&remote_path);

    if ssh_sessions.has_sftp(&session.connection_id)? {
        return ssh_sessions
            .list_dir(&session.connection_id, &remote_path)
            .await;
    }

    file_transfer_service.list_dir(&session_id, &remote_path)
}

#[tauri::command]
pub async fn file_transfer_upload(
    session_id: String,
    local_path: String,
    remote_path: String,
    app_handle: AppHandle,
    file_transfer_service: State<'_, FileTransferService>,
    ssh_sessions: State<'_, SshSessionService>,
    transfer_service: State<'_, TransferService>,
    logs: State<'_, LogService>,
) -> Result<TransferTask, String> {
    let session = file_transfer_service.session(&session_id)?;
    let connection_id = session.connection_id.clone();
    let task = transfer_service.upload(connection_id.clone(), local_path.clone(), remote_path)?;
    let _ = logs.record(
        LogLevel::Info,
        "transfer",
        format!("queued upload {}", task.remote_path),
    );

    if ssh_sessions.has_sftp(&connection_id)? {
        start_queued_sftp_transfers(app_handle, connection_id)?;
        return transfer_service.get(&task.id);
    }

    Ok(task)
}

#[tauri::command]
pub async fn file_transfer_download(
    session_id: String,
    remote_path: String,
    local_path: String,
    app_handle: AppHandle,
    file_transfer_service: State<'_, FileTransferService>,
    ssh_sessions: State<'_, SshSessionService>,
    transfer_service: State<'_, TransferService>,
    logs: State<'_, LogService>,
) -> Result<TransferTask, String> {
    let session = file_transfer_service.session(&session_id)?;
    let connection_id = session.connection_id.clone();
    let task = transfer_service.download(connection_id, remote_path, local_path)?;
    let _ = logs.record(
        LogLevel::Info,
        "transfer",
        format!("queued download {}", task.remote_path),
    );

    if ssh_sessions.has_sftp(&session.connection_id)? {
        start_queued_sftp_transfers(app_handle, session.connection_id)?;
        return transfer_service.get(&task.id);
    }

    Ok(task)
}

fn spawn_sftp_upload(app_handle: AppHandle, connection_id: String, task: TransferTask) {
    tauri::async_runtime::spawn(async move {
        let task_id = task.id.clone();
        let transfer_service = app_handle.state::<TransferService>();
        let ssh_sessions = app_handle.state::<SshSessionService>();

        let result = ssh_sessions
            .upload_file_with_progress(
                &connection_id,
                &task.local_path,
                &task.remote_path,
                |transferred_bytes, total_bytes| {
                    transfer_progress_directive(
                        &transfer_service,
                        &task_id,
                        transferred_bytes,
                        total_bytes,
                    )
                },
            )
            .await;

        finish_background_transfer(app_handle, connection_id, task_id, result);
    });
}

fn spawn_sftp_download(app_handle: AppHandle, connection_id: String, task: TransferTask) {
    tauri::async_runtime::spawn(async move {
        let task_id = task.id.clone();
        let transfer_service = app_handle.state::<TransferService>();
        let ssh_sessions = app_handle.state::<SshSessionService>();

        let result = ssh_sessions
            .download_file_with_progress(
                &connection_id,
                &task.remote_path,
                &task.local_path,
                |transferred_bytes, total_bytes| {
                    transfer_progress_directive(
                        &transfer_service,
                        &task_id,
                        transferred_bytes,
                        total_bytes,
                    )
                },
            )
            .await;

        finish_background_transfer(app_handle, connection_id, task_id, result);
    });
}

fn start_queued_sftp_transfers(
    app_handle: AppHandle,
    connection_id: String,
) -> Result<Vec<TransferTask>, String> {
    let transfer_service = app_handle.state::<TransferService>();
    let ssh_sessions = app_handle.state::<SshSessionService>();

    if !ssh_sessions.has_sftp(&connection_id)? {
        return Ok(Vec::new());
    }

    let mut started = Vec::new();
    loop {
        let Some(task) = transfer_service.start_next_pending_for_connection(&connection_id)? else {
            break;
        };

        let running_task = match task.direction.clone() {
            TransferDirection::Upload => {
                let total_bytes = std::fs::metadata(&task.local_path)
                    .ok()
                    .filter(|metadata| metadata.is_file())
                    .map(|metadata| metadata.len());
                let running_task = transfer_service.mark_running(&task.id, total_bytes)?;
                spawn_sftp_upload(
                    app_handle.clone(),
                    connection_id.clone(),
                    running_task.clone(),
                );
                running_task
            }
            TransferDirection::Download => {
                let running_task = transfer_service.mark_running(&task.id, None)?;
                spawn_sftp_download(
                    app_handle.clone(),
                    connection_id.clone(),
                    running_task.clone(),
                );
                running_task
            }
        };

        started.push(running_task);
        if started.len() >= SFTP_MAX_RUNNING_TRANSFERS_PER_CONNECTION {
            break;
        }
    }

    Ok(started)
}

fn finish_background_transfer(
    app_handle: AppHandle,
    connection_id: String,
    task_id: String,
    result: Result<crate::services::ssh_session_service::SftpTransferOutcome, String>,
) {
    let transfer_service = app_handle.state::<TransferService>();
    let logs = app_handle.state::<LogService>();

    match result {
        Ok(outcome) => {
            let _ = transfer_service.mark_completed(
                &task_id,
                outcome.transferred_bytes,
                outcome.total_bytes,
            );
            let _ = logs.record(
                LogLevel::Info,
                "transfer",
                format!("completed transfer {task_id}"),
            );
        }
        Err(error) if error == TRANSFER_CANCELLED => {
            let _ = logs.record(
                LogLevel::Info,
                "transfer",
                format!("cancelled transfer {task_id}"),
            );
        }
        Err(error) => {
            let _ = transfer_service.mark_failed(&task_id, error.clone());
            let _ = logs.record(
                LogLevel::Error,
                "transfer",
                format!("failed transfer {task_id}: {error}"),
            );
        }
    }

    let _ = start_queued_sftp_transfers(app_handle, connection_id);
}

fn transfer_progress_directive(
    transfer_service: &TransferService,
    task_id: &str,
    transferred_bytes: u64,
    total_bytes: Option<u64>,
) -> Result<SftpTransferDirective, String> {
    match transfer_service.status(task_id)? {
        TransferStatus::Cancelled => Err(TRANSFER_CANCELLED.to_string()),
        TransferStatus::Paused => Ok(SftpTransferDirective::Pause),
        _ => {
            transfer_service.mark_progress(task_id, transferred_bytes, total_bytes)?;
            Ok(SftpTransferDirective::Continue)
        }
    }
}

#[tauri::command]
pub async fn file_transfer_mkdir(
    session_id: String,
    remote_path: String,
    file_transfer_service: State<'_, FileTransferService>,
    ssh_sessions: State<'_, SshSessionService>,
) -> Result<(), String> {
    let session = file_transfer_service.session(&session_id)?;
    if ssh_sessions.has_sftp(&session.connection_id)? {
        return ssh_sessions
            .mkdir(&session.connection_id, &remote_path)
            .await;
    }

    file_transfer_service.mkdir(&session_id, &remote_path)
}

#[tauri::command]
pub async fn file_transfer_remove(
    session_id: String,
    remote_path: String,
    file_transfer_service: State<'_, FileTransferService>,
    ssh_sessions: State<'_, SshSessionService>,
) -> Result<(), String> {
    let session = file_transfer_service.session(&session_id)?;
    if ssh_sessions.has_sftp(&session.connection_id)? {
        return ssh_sessions
            .remove(&session.connection_id, &remote_path)
            .await;
    }

    file_transfer_service.remove(&session_id, &remote_path)
}

#[tauri::command]
pub async fn file_transfer_rename(
    session_id: String,
    from: String,
    to: String,
    file_transfer_service: State<'_, FileTransferService>,
    ssh_sessions: State<'_, SshSessionService>,
) -> Result<(), String> {
    let session = file_transfer_service.session(&session_id)?;
    if ssh_sessions.has_sftp(&session.connection_id)? {
        return ssh_sessions
            .rename(&session.connection_id, &from, &to)
            .await;
    }

    file_transfer_service.rename(&session_id, &from, &to)
}

#[tauri::command]
pub fn file_transfer_cancel(
    transfer_id: String,
    transfer_service: State<'_, TransferService>,
) -> Result<TransferTask, String> {
    transfer_service.cancel(&transfer_id)
}

#[tauri::command]
pub fn file_transfer_pause(
    transfer_id: String,
    transfer_service: State<'_, TransferService>,
) -> Result<TransferTask, String> {
    transfer_service.pause(&transfer_id)
}

#[tauri::command]
pub fn file_transfer_resume(
    transfer_id: String,
    transfer_service: State<'_, TransferService>,
) -> Result<TransferTask, String> {
    transfer_service.resume(&transfer_id)
}

#[tauri::command]
pub fn file_transfer_retry(
    transfer_id: String,
    app_handle: AppHandle,
    ssh_sessions: State<'_, SshSessionService>,
    transfer_service: State<'_, TransferService>,
) -> Result<TransferTask, String> {
    let task = transfer_service.retry(&transfer_id)?;

    if !ssh_sessions.has_sftp(&task.connection_id)? {
        return Ok(task);
    }

    let _ = start_queued_sftp_transfers(app_handle, task.connection_id.clone())?;

    transfer_service.get(&task.id)
}

#[tauri::command]
pub fn file_transfer_delete(
    transfer_id: String,
    transfer_service: State<'_, TransferService>,
) -> Result<TransferTask, String> {
    transfer_service.delete(&transfer_id)
}

#[tauri::command]
pub fn transfer_list(
    transfer_service: State<'_, TransferService>,
) -> Result<Vec<TransferTask>, String> {
    transfer_service.list()
}

fn resolve_local_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    let path = if trimmed.is_empty() || trimmed == "." {
        std::env::current_dir()
            .map_err(|error| format!("failed to read current directory: {error}"))?
    } else {
        PathBuf::from(trimmed)
    };

    let absolute = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .map_err(|error| format!("failed to read current directory: {error}"))?
            .join(path)
    };

    Ok(normalize_local_path(absolute))
}

fn normalize_local_path(path: PathBuf) -> PathBuf {
    let mut normalized = PathBuf::new();

    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }

    normalized
}

fn is_local_roots_path(path: &str) -> bool {
    path.trim().eq_ignore_ascii_case(LOCAL_ROOTS_PATH)
}

fn is_filesystem_root(path: &Path) -> bool {
    path.parent().is_none()
}

fn normalize_remote_list_path(path: &str) -> String {
    let normalized = normalize_remote_path(path);

    if normalized == "." {
        "/".to_string()
    } else {
        normalized
    }
}

fn list_local_roots() -> Result<LocalFileListResult, String> {
    #[cfg(windows)]
    {
        let mut entries = Vec::new();

        for drive in b'A'..=b'Z' {
            let root = format!("{}:\\", drive as char);
            let path = PathBuf::from(&root);

            if !path.exists() {
                continue;
            }

            if let Ok(metadata) = fs::symlink_metadata(&path) {
                entries.push(local_entry_from_metadata(&path, metadata)?);
            }
        }

        return Ok(LocalFileListResult {
            path: LOCAL_ROOTS_PATH.to_string(),
            entries,
        });
    }

    #[cfg(not(windows))]
    {
        let root = PathBuf::from("/");
        let entries = fs::read_dir(&root)
            .map_err(|error| format!("failed to list local root /: {error}"))?
            .map(|entry| {
                let entry =
                    entry.map_err(|error| format!("failed to read local root entry: {error}"))?;
                let path = entry.path();
                let metadata = fs::symlink_metadata(&path).map_err(|error| {
                    format!("failed to inspect local entry {}: {error}", path.display())
                })?;
                local_entry_from_metadata(&path, metadata)
            })
            .collect::<Result<Vec<_>, _>>()?;

        return Ok(LocalFileListResult {
            path: LOCAL_ROOTS_PATH.to_string(),
            entries,
        });
    }
}

fn local_entry_from_metadata(path: &Path, metadata: fs::Metadata) -> Result<RemoteEntry, String> {
    let file_type = metadata.file_type();
    let kind = if file_type.is_dir() {
        RemoteEntryKind::Directory
    } else if file_type.is_file() {
        RemoteEntryKind::File
    } else if file_type.is_symlink() {
        RemoteEntryKind::Symlink
    } else {
        RemoteEntryKind::Other
    };
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| format!("unix:{}", duration.as_secs()));
    let permissions = if metadata.permissions().readonly() {
        Some("readonly".to_string())
    } else {
        Some("rw".to_string())
    };
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| path.display().to_string());

    Ok(RemoteEntry {
        name,
        path: path.display().to_string(),
        kind,
        size: metadata.len(),
        modified_at,
        permissions,
        owner: None,
        group: None,
    })
}

#[cfg(test)]
mod tests {
    use super::{normalize_remote_list_path, resolve_local_path};

    #[test]
    fn remote_list_root_is_absolute_slash() {
        assert_eq!(normalize_remote_list_path(""), "/");
        assert_eq!(normalize_remote_list_path("."), "/");
        assert_eq!(normalize_remote_list_path("/"), "/");
    }

    #[test]
    fn local_paths_are_resolved_to_absolute_paths() {
        let current_dir = std::env::current_dir().unwrap();

        assert_eq!(resolve_local_path("").unwrap(), current_dir);
        assert!(resolve_local_path(".").unwrap().is_absolute());
        assert!(resolve_local_path("src").unwrap().is_absolute());
        assert!(resolve_local_path("./src").unwrap().ends_with("src"));
    }
}

fn local_entry_kind_rank(kind: &RemoteEntryKind) -> u8 {
    match kind {
        RemoteEntryKind::Directory => 0,
        RemoteEntryKind::File => 1,
        RemoteEntryKind::Symlink => 2,
        RemoteEntryKind::Other => 3,
    }
}
