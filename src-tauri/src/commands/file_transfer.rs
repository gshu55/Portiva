use std::collections::VecDeque;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
use std::{env, fs};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::domain::file_transfer::{
    FileTransferSession, RemoteEntry, RemoteEntryKind, TransferConflictPolicy, TransferDirection,
    TransferStatus, TransferTask, TransferTaskItemKind, TransferUploadItem,
};
use crate::domain::logging::LogLevel;
use crate::services::connection_manager::ConnectionManager;
use crate::services::file_transfer_service::FileTransferService;
use crate::services::log_service::LogService;
use crate::services::ssh_session_service::{SftpTransferDirective, SshSessionService};
use crate::services::transfer_service::{ConflictDirective, TransferService};
use crate::utils::remote_path::{join_remote_path, normalize_remote_path};

const TRANSFER_CANCELLED: &str = "transfer cancelled";
const SFTP_MAX_RUNNING_TRANSFERS_PER_CONNECTION: usize = 1;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileListResult {
    pub path: String,
    pub entries: Vec<RemoteEntry>,
}

const LOCAL_ROOTS_PATH: &str = "portiva://local-roots";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileUploadRequest {
    local_path: String,
    remote_path: String,
}

#[derive(Debug)]
struct PlannedUploadFile {
    local_path: PathBuf,
    remote_path: String,
}

#[derive(Debug)]
struct DirectoryUploadPlan {
    directories: Vec<String>,
    files: Vec<PlannedUploadFile>,
    skipped_items: u64,
    failed_items: u64,
    last_error: Option<String>,
    total_bytes: u64,
}

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

    if session.is_file_transfer_ready() && ssh_sessions.has_sftp(&connection_id)? {
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

    require_sftp(&ssh_sessions, &session.connection_id)?;
    ssh_sessions
        .list_dir(&session.connection_id, &remote_path)
        .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
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
    require_sftp(&ssh_sessions, &connection_id)?;
    let item_kind = local_upload_item_kind(&local_path)?;
    let task = transfer_service.upload_with_kind(
        connection_id.clone(),
        local_path,
        remote_path,
        item_kind,
    )?;
    let _ = logs.record(
        LogLevel::Info,
        "transfer",
        format!("queued upload {}", task.remote_path),
    );

    start_queued_sftp_transfers(app_handle, connection_id)?;
    transfer_service.get(&task.id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn file_transfer_upload_batch(
    session_id: String,
    remote_path: String,
    uploads: Vec<FileUploadRequest>,
    app_handle: AppHandle,
    file_transfer_service: State<'_, FileTransferService>,
    ssh_sessions: State<'_, SshSessionService>,
    transfer_service: State<'_, TransferService>,
    logs: State<'_, LogService>,
) -> Result<TransferTask, String> {
    if uploads.is_empty() {
        return Err("batch upload requires at least one item".to_string());
    }

    let session = file_transfer_service.session(&session_id)?;
    let connection_id = session.connection_id.clone();
    require_sftp(&ssh_sessions, &connection_id)?;

    // 先校验整批拖入项，确保失败时不会留下半个批量任务。
    let prepared = uploads
        .into_iter()
        .map(|upload| {
            let item_kind = local_upload_item_kind(&upload.local_path)?;
            Ok((upload, item_kind))
        })
        .collect::<Result<Vec<_>, String>>()?;

    let task = if prepared.len() == 1 {
        let (upload, item_kind) = prepared
            .into_iter()
            .next()
            .ok_or_else(|| "batch upload item disappeared during validation".to_string())?;
        transfer_service.upload_with_kind(
            connection_id.clone(),
            upload.local_path,
            upload.remote_path,
            item_kind,
        )?
    } else {
        let batch_items = prepared
            .into_iter()
            .map(|(upload, item_kind)| TransferUploadItem {
                local_path: upload.local_path,
                remote_path: normalize_remote_path(&upload.remote_path),
                item_kind,
            })
            .collect::<Vec<_>>();
        transfer_service.upload_batch(connection_id.clone(), remote_path, batch_items)?
    };

    let _ = logs.record(
        LogLevel::Info,
        "transfer",
        if task.batch_items.is_empty() {
            format!("queued upload {}", task.remote_path)
        } else {
            format!(
                "queued batch upload of {} items to {}",
                task.batch_items.len(),
                task.remote_path
            )
        },
    );

    start_queued_sftp_transfers(app_handle, connection_id)?;
    transfer_service.get(&task.id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
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
    require_sftp(&ssh_sessions, &connection_id)?;
    let task = transfer_service.download(connection_id.clone(), remote_path, local_path)?;
    let _ = logs.record(
        LogLevel::Info,
        "transfer",
        format!("queued download {}", task.remote_path),
    );

    start_queued_sftp_transfers(app_handle, connection_id)?;
    transfer_service.get(&task.id)
}

fn spawn_sftp_upload(app_handle: AppHandle, connection_id: String, task: TransferTask) {
    tauri::async_runtime::spawn(async move {
        let task_id = task.id.clone();
        let transfer_service = app_handle.state::<TransferService>();
        let ssh_sessions = app_handle.state::<SshSessionService>();

        let result = match task.item_kind.clone() {
            TransferTaskItemKind::File => {
                upload_single_file_task(&ssh_sessions, &transfer_service, &connection_id, &task)
                    .await
            }
            TransferTaskItemKind::Directory => {
                upload_directory_task(&ssh_sessions, &transfer_service, &connection_id, &task).await
            }
            TransferTaskItemKind::Batch => {
                upload_batch_task(&ssh_sessions, &transfer_service, &connection_id, &task).await
            }
        };

        finish_background_transfer(app_handle, connection_id, task_id, result);
    });
}

async fn upload_single_file_task(
    ssh_sessions: &SshSessionService,
    transfer_service: &TransferService,
    connection_id: &str,
    task: &TransferTask,
) -> Result<crate::services::ssh_session_service::SftpTransferOutcome, String> {
    let total_bytes = tokio::fs::metadata(&task.local_path)
        .await
        .map_err(|error| format!("failed to inspect local upload source: {error}"))?
        .len();
    transfer_service.set_totals(&task.id, total_bytes, 1)?;

    match upload_file_with_task_conflict(
        ssh_sessions,
        transfer_service,
        connection_id,
        &task.id,
        &task.local_path,
        &task.remote_path,
        0,
        total_bytes,
    )
    .await?
    {
        Some(outcome) => {
            transfer_service.mark_item_completed(&task.id)?;
            Ok(outcome)
        }
        None => {
            transfer_service.mark_item_skipped(&task.id)?;
            Ok(crate::services::ssh_session_service::SftpTransferOutcome {
                total_bytes: Some(total_bytes),
                transferred_bytes: 0,
            })
        }
    }
}

async fn upload_directory_task(
    ssh_sessions: &SshSessionService,
    transfer_service: &TransferService,
    connection_id: &str,
    task: &TransferTask,
) -> Result<crate::services::ssh_session_service::SftpTransferOutcome, String> {
    let plan = scan_upload_directory(
        &task.local_path,
        &task.remote_path,
        transfer_service,
        &task.id,
    )
    .await?;
    upload_plan_task(
        ssh_sessions,
        transfer_service,
        connection_id,
        &task.id,
        plan,
    )
    .await
}

async fn upload_batch_task(
    ssh_sessions: &SshSessionService,
    transfer_service: &TransferService,
    connection_id: &str,
    task: &TransferTask,
) -> Result<crate::services::ssh_session_service::SftpTransferOutcome, String> {
    let plan = scan_upload_batch(&task.batch_items, transfer_service, &task.id).await?;
    upload_plan_task(
        ssh_sessions,
        transfer_service,
        connection_id,
        &task.id,
        plan,
    )
    .await
}

async fn upload_plan_task(
    ssh_sessions: &SshSessionService,
    transfer_service: &TransferService,
    connection_id: &str,
    task_id: &str,
    plan: DirectoryUploadPlan,
) -> Result<crate::services::ssh_session_service::SftpTransferOutcome, String> {
    let total_items = plan.directories.len() as u64
        + plan.files.len() as u64
        + plan.skipped_items
        + plan.failed_items;
    transfer_service.set_totals(task_id, plan.total_bytes, total_items)?;
    if plan.skipped_items > 0 {
        transfer_service.mark_items_skipped(task_id, plan.skipped_items)?;
    }
    if plan.failed_items > 0 {
        transfer_service.mark_items_failed(
            task_id,
            plan.failed_items,
            plan.last_error
                .clone()
                .unwrap_or_else(|| "failed to scan part of the local directory".to_string()),
        )?;
    }

    let mut blocked_remote_directories: Vec<String> = Vec::new();
    for remote_directory in &plan.directories {
        wait_for_transfer_ready(
            transfer_service,
            task_id,
            transfer_service.get(task_id)?.transferred_bytes,
            Some(plan.total_bytes),
        )
        .await?;

        if blocked_remote_directories
            .iter()
            .any(|blocked| remote_path_is_within(remote_directory, blocked))
        {
            transfer_service.mark_item_skipped(task_id)?;
            continue;
        }

        match ensure_remote_directory_for_task(
            ssh_sessions,
            transfer_service,
            connection_id,
            task_id,
            remote_directory,
        )
        .await
        {
            Ok(true) => {
                transfer_service.mark_item_completed(task_id)?;
            }
            Ok(false) => {
                transfer_service.mark_item_skipped(task_id)?;
                blocked_remote_directories.push(remote_directory.clone());
            }
            Err(error) if error == TRANSFER_CANCELLED => return Err(error),
            Err(error) => {
                transfer_service.mark_item_failed(task_id, error)?;
                blocked_remote_directories.push(remote_directory.clone());
            }
        }
    }

    let mut transferred_bytes = 0_u64;
    for file in &plan.files {
        wait_for_transfer_ready(
            transfer_service,
            task_id,
            transferred_bytes,
            Some(plan.total_bytes),
        )
        .await?;

        if blocked_remote_directories
            .iter()
            .any(|blocked| remote_path_is_within(&file.remote_path, blocked))
        {
            transfer_service.mark_item_skipped(task_id)?;
            continue;
        }

        match upload_file_with_task_conflict(
            ssh_sessions,
            transfer_service,
            connection_id,
            task_id,
            &file.local_path.to_string_lossy(),
            &file.remote_path,
            transferred_bytes,
            plan.total_bytes,
        )
        .await
        {
            Ok(Some(outcome)) => {
                transferred_bytes = transferred_bytes.saturating_add(outcome.transferred_bytes);
                transfer_service.mark_progress(
                    task_id,
                    transferred_bytes,
                    Some(plan.total_bytes),
                )?;
                transfer_service.mark_item_completed(task_id)?;
            }
            Ok(None) => {
                transfer_service.mark_item_skipped(task_id)?;
            }
            Err(error) if error == TRANSFER_CANCELLED => return Err(error),
            Err(error) => {
                transfer_service.mark_item_failed(task_id, error)?;
            }
        }
    }

    Ok(crate::services::ssh_session_service::SftpTransferOutcome {
        total_bytes: Some(plan.total_bytes),
        transferred_bytes,
    })
}

async fn scan_upload_batch(
    batch_items: &[TransferUploadItem],
    transfer_service: &TransferService,
    task_id: &str,
) -> Result<DirectoryUploadPlan, String> {
    let mut combined = DirectoryUploadPlan {
        directories: Vec::new(),
        files: Vec::new(),
        skipped_items: 0,
        failed_items: 0,
        last_error: None,
        total_bytes: 0,
    };

    for item in batch_items {
        wait_for_transfer_ready(transfer_service, task_id, 0, None).await?;

        match &item.item_kind {
            TransferTaskItemKind::Directory => {
                let plan = scan_upload_directory(
                    &item.local_path,
                    &item.remote_path,
                    transfer_service,
                    task_id,
                )
                .await?;
                combined.directories.extend(plan.directories);
                combined.files.extend(plan.files);
                combined.skipped_items = combined.skipped_items.saturating_add(plan.skipped_items);
                combined.failed_items = combined.failed_items.saturating_add(plan.failed_items);
                combined.total_bytes = combined.total_bytes.saturating_add(plan.total_bytes);
                if plan.last_error.is_some() {
                    combined.last_error = plan.last_error;
                }
            }
            TransferTaskItemKind::File => {
                let local_path = PathBuf::from(&item.local_path);
                match tokio::fs::symlink_metadata(&local_path).await {
                    Ok(metadata) if metadata.file_type().is_symlink() => {
                        combined.skipped_items = combined.skipped_items.saturating_add(1);
                    }
                    Ok(metadata) if metadata.is_file() => {
                        combined.total_bytes = combined.total_bytes.saturating_add(metadata.len());
                        combined.files.push(PlannedUploadFile {
                            local_path,
                            remote_path: normalize_remote_path(&item.remote_path),
                        });
                    }
                    Ok(_) => {
                        combined.failed_items = combined.failed_items.saturating_add(1);
                        combined.last_error = Some(format!(
                            "unsupported local upload source: {}",
                            item.local_path
                        ));
                    }
                    Err(error) => {
                        combined.failed_items = combined.failed_items.saturating_add(1);
                        combined.last_error = Some(format!(
                            "failed to inspect local upload source {}: {error}",
                            item.local_path
                        ));
                    }
                }
            }
            TransferTaskItemKind::Batch => {
                return Err("nested batch upload items are not supported".to_string());
            }
        }
    }

    Ok(combined)
}

async fn scan_upload_directory(
    local_root: &str,
    remote_root: &str,
    transfer_service: &TransferService,
    task_id: &str,
) -> Result<DirectoryUploadPlan, String> {
    let root = PathBuf::from(local_root);
    let mut pending = VecDeque::from([(root.clone(), normalize_remote_path(remote_root))]);
    let mut directories = vec![normalize_remote_path(remote_root)];
    let mut files = Vec::new();
    let mut skipped_items = 0_u64;
    let mut failed_items = 0_u64;
    let mut last_error = None;
    let mut total_bytes = 0_u64;

    while let Some((local_directory, remote_directory)) = pending.pop_front() {
        wait_for_transfer_ready(transfer_service, task_id, 0, None).await?;
        let mut entries = match tokio::fs::read_dir(&local_directory).await {
            Ok(entries) => entries,
            Err(error) if local_directory == root => {
                return Err(format!(
                    "failed to scan local upload directory {}: {error}",
                    local_directory.display()
                ));
            }
            Err(error) => {
                failed_items = failed_items.saturating_add(1);
                last_error = Some(format!(
                    "failed to scan local upload directory {}: {error}",
                    local_directory.display()
                ));
                continue;
            }
        };

        loop {
            let entry = match entries.next_entry().await {
                Ok(Some(entry)) => entry,
                Ok(None) => break,
                Err(error) => {
                    failed_items = failed_items.saturating_add(1);
                    last_error = Some(format!(
                        "failed to read local upload directory {}: {error}",
                        local_directory.display()
                    ));
                    break;
                }
            };
            let local_path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.is_empty() || name.contains('\u{fffd}') {
                skipped_items = skipped_items.saturating_add(1);
                continue;
            }
            let metadata = match tokio::fs::symlink_metadata(&local_path).await {
                Ok(metadata) => metadata,
                Err(error) => {
                    failed_items = failed_items.saturating_add(1);
                    last_error = Some(format!(
                        "failed to inspect local upload entry {}: {error}",
                        local_path.display()
                    ));
                    continue;
                }
            };
            let remote_path = join_remote_path(&remote_directory, &name);

            if metadata.file_type().is_symlink() {
                skipped_items = skipped_items.saturating_add(1);
            } else if metadata.is_dir() {
                directories.push(remote_path.clone());
                pending.push_back((local_path, remote_path));
            } else if metadata.is_file() {
                total_bytes = total_bytes.saturating_add(metadata.len());
                files.push(PlannedUploadFile {
                    local_path,
                    remote_path,
                });
            } else {
                skipped_items = skipped_items.saturating_add(1);
            }
        }
    }

    Ok(DirectoryUploadPlan {
        directories,
        files,
        skipped_items,
        failed_items,
        last_error,
        total_bytes,
    })
}

async fn ensure_remote_directory_for_task(
    ssh_sessions: &SshSessionService,
    transfer_service: &TransferService,
    connection_id: &str,
    task_id: &str,
    remote_path: &str,
) -> Result<bool, String> {
    match ssh_sessions.entry_kind(connection_id, remote_path).await? {
        Some(RemoteEntryKind::Directory) => Ok(true),
        Some(_) => {
            if !wait_for_conflict_choice(transfer_service, task_id, remote_path).await? {
                return Ok(false);
            }
            ssh_sessions.remove(connection_id, remote_path).await?;
            ssh_sessions.mkdir(connection_id, remote_path).await?;
            Ok(true)
        }
        None => ssh_sessions
            .mkdir(connection_id, remote_path)
            .await
            .map(|_| true),
    }
}

#[allow(clippy::too_many_arguments)]
async fn upload_file_with_task_conflict(
    ssh_sessions: &SshSessionService,
    transfer_service: &TransferService,
    connection_id: &str,
    task_id: &str,
    local_path: &str,
    remote_path: &str,
    transferred_before_file: u64,
    task_total_bytes: u64,
) -> Result<Option<crate::services::ssh_session_service::SftpTransferOutcome>, String> {
    loop {
        wait_for_transfer_ready(
            transfer_service,
            task_id,
            transferred_before_file,
            Some(task_total_bytes),
        )
        .await?;

        if ssh_sessions
            .entry_kind(connection_id, remote_path)
            .await?
            .is_some()
        {
            if !wait_for_conflict_choice(transfer_service, task_id, remote_path).await? {
                return Ok(None);
            }
            ssh_sessions.remove(connection_id, remote_path).await?;
        }

        let result = ssh_sessions
            .upload_file_with_progress(
                connection_id,
                local_path,
                remote_path,
                |file_transferred_bytes, _| {
                    transfer_progress_directive(
                        transfer_service,
                        task_id,
                        transferred_before_file.saturating_add(file_transferred_bytes),
                        Some(task_total_bytes),
                    )
                },
            )
            .await;

        match result {
            Ok(outcome) => return Ok(Some(outcome)),
            Err(error) if is_upload_conflict_error(&error) => continue,
            Err(error) => return Err(error),
        }
    }
}

async fn wait_for_conflict_choice(
    transfer_service: &TransferService,
    task_id: &str,
    remote_path: &str,
) -> Result<bool, String> {
    loop {
        let requested = transfer_service.request_conflict(task_id, remote_path.to_string())?;
        match requested.status {
            TransferStatus::WaitingConflict => break,
            TransferStatus::Running => match requested.conflict_policy {
                TransferConflictPolicy::OverwriteAll => return Ok(true),
                TransferConflictPolicy::SkipAll => return Ok(false),
                policy => {
                    return Err(format!(
                        "cannot apply transfer conflict policy {policy:?} while running"
                    ))
                }
            },
            TransferStatus::Paused => {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            TransferStatus::Cancelled => return Err(TRANSFER_CANCELLED.to_string()),
            status => {
                return Err(format!(
                    "cannot wait for transfer conflict while status is {status:?}"
                ))
            }
        }
    }

    loop {
        match transfer_service.take_conflict_directive(task_id)? {
            ConflictDirective::Wait => {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            ConflictDirective::Overwrite => return Ok(true),
            ConflictDirective::Skip => return Ok(false),
            ConflictDirective::Cancel => return Err(TRANSFER_CANCELLED.to_string()),
        }
    }
}

async fn wait_for_transfer_ready(
    transfer_service: &TransferService,
    task_id: &str,
    transferred_bytes: u64,
    total_bytes: Option<u64>,
) -> Result<(), String> {
    loop {
        match transfer_progress_directive(
            transfer_service,
            task_id,
            transferred_bytes,
            total_bytes,
        )? {
            SftpTransferDirective::Continue => return Ok(()),
            SftpTransferDirective::Pause => {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
        }
    }
}

fn remote_path_is_within(path: &str, directory: &str) -> bool {
    directory == "/"
        || path == directory
        || path
            .strip_prefix(directory)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn is_upload_conflict_error(error: &str) -> bool {
    error.contains("upload target already exists")
        || error.contains("upload target appeared during transfer")
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

    require_sftp(&ssh_sessions, &connection_id)?;

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
    require_sftp(&ssh_sessions, &session.connection_id)?;
    ssh_sessions
        .mkdir(&session.connection_id, &remote_path)
        .await
}

#[tauri::command]
pub async fn file_transfer_remove(
    session_id: String,
    remote_path: String,
    file_transfer_service: State<'_, FileTransferService>,
    ssh_sessions: State<'_, SshSessionService>,
) -> Result<(), String> {
    let session = file_transfer_service.session(&session_id)?;
    require_sftp(&ssh_sessions, &session.connection_id)?;
    ssh_sessions
        .remove(&session.connection_id, &remote_path)
        .await
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
    require_sftp(&ssh_sessions, &session.connection_id)?;
    ssh_sessions
        .rename(&session.connection_id, &from, &to)
        .await
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
pub fn file_transfer_resolve_conflict(
    transfer_id: String,
    policy: TransferConflictPolicy,
    transfer_service: State<'_, TransferService>,
) -> Result<TransferTask, String> {
    transfer_service.resolve_conflict(&transfer_id, policy)
}

#[tauri::command]
pub fn file_transfer_retry(
    transfer_id: String,
    app_handle: AppHandle,
    ssh_sessions: State<'_, SshSessionService>,
    transfer_service: State<'_, TransferService>,
) -> Result<TransferTask, String> {
    let existing = transfer_service.get(&transfer_id)?;
    require_sftp(&ssh_sessions, &existing.connection_id)?;
    let task = transfer_service.retry(&transfer_id)?;

    let _ = start_queued_sftp_transfers(app_handle, task.connection_id.clone())?;

    transfer_service.get(&task.id)
}

fn require_sftp(ssh_sessions: &SshSessionService, connection_id: &str) -> Result<(), String> {
    if ssh_sessions.has_sftp(connection_id)? {
        return Ok(());
    }

    Err(format!(
        "SFTP connection is unavailable for {connection_id}; reconnect before continuing"
    ))
}

fn local_upload_item_kind(local_path: &str) -> Result<TransferTaskItemKind, String> {
    let metadata = fs::symlink_metadata(local_path)
        .map_err(|error| format!("failed to inspect local upload source {local_path}: {error}"))?;

    if metadata.file_type().is_symlink() {
        return Err(format!(
            "symbolic link upload is not supported: {local_path}"
        ));
    }
    if metadata.is_dir() {
        return Ok(TransferTaskItemKind::Directory);
    }
    if metadata.is_file() {
        return Ok(TransferTaskItemKind::File);
    }

    Err(format!("unsupported local upload source: {local_path}"))
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

        Ok(LocalFileListResult {
            path: LOCAL_ROOTS_PATH.to_string(),
            entries,
        })
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

        Ok(LocalFileListResult {
            path: LOCAL_ROOTS_PATH.to_string(),
            entries,
        })
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
    use super::{
        normalize_remote_list_path, remote_path_is_within, resolve_local_path, scan_upload_batch,
    };
    use crate::domain::file_transfer::{TransferTaskItemKind, TransferUploadItem};
    use crate::services::transfer_service::TransferService;

    struct TempDirectory(std::path::PathBuf);

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn batch_scan_combines_files_and_recursive_directories() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = TempDirectory(std::env::temp_dir().join(format!(
            "portiva-batch-upload-scan-{}-{unique}",
            std::process::id()
        )));
        let directory = temp.0.join("folder");
        let nested = directory.join("nested");
        let standalone = temp.0.join("standalone.txt");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(directory.join("inside.txt"), b"inside").unwrap();
        std::fs::write(nested.join("deep.txt"), b"deep").unwrap();
        std::fs::write(&standalone, b"single").unwrap();

        let service = TransferService::default();
        let task = service
            .upload_batch(
                "connection-1".to_string(),
                "/srv/upload".to_string(),
                vec![
                    TransferUploadItem {
                        local_path: standalone.display().to_string(),
                        remote_path: "/srv/upload/standalone.txt".to_string(),
                        item_kind: TransferTaskItemKind::File,
                    },
                    TransferUploadItem {
                        local_path: directory.display().to_string(),
                        remote_path: "/srv/upload/folder".to_string(),
                        item_kind: TransferTaskItemKind::Directory,
                    },
                ],
            )
            .unwrap();
        service.mark_running(&task.id, None).unwrap();

        let plan = tauri::async_runtime::block_on(scan_upload_batch(
            &task.batch_items,
            &service,
            &task.id,
        ))
        .unwrap();

        assert_eq!(plan.directories.len(), 2);
        assert_eq!(plan.files.len(), 3);
        assert_eq!(plan.total_bytes, 16);
        assert_eq!(plan.skipped_items, 0);
        assert_eq!(plan.failed_items, 0);
    }

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

    #[test]
    fn blocked_remote_directory_matches_only_its_own_tree() {
        assert!(remote_path_is_within("/srv/upload", "/srv/upload"));
        assert!(remote_path_is_within(
            "/srv/upload/nested/file.txt",
            "/srv/upload"
        ));
        assert!(!remote_path_is_within(
            "/srv/upload-other/file.txt",
            "/srv/upload"
        ));
        assert!(remote_path_is_within("/any/path", "/"));
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
