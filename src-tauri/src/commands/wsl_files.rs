use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::domain::file_transfer::{
    RemoteEntry, RemoteEntryKind, TransferDirection, TransferProtocol, TransferStatus,
    TransferTask, TransferTaskItemKind,
};
use crate::services::transfer_service::{ConflictDirective, TransferService};

const TRANSFER_CANCELLED: &str = "transfer cancelled";
const WSL_CONNECTION_PREFIX: &str = "wsl-files:";
const COPY_BUFFER_BYTES: usize = 256 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslFileListResult {
    path: String,
    entries: Vec<RemoteEntry>,
}

#[derive(Debug)]
struct PlannedCopyFile {
    source: PathBuf,
    target: PathBuf,
}

#[derive(Debug)]
struct CopyPlan {
    directories: Vec<PathBuf>,
    files: Vec<PlannedCopyFile>,
    skipped_items: u64,
    total_bytes: u64,
}

#[tauri::command]
pub async fn wsl_file_home(distribution: String) -> Result<String, String> {
    validate_distribution_name(&distribution)?;
    tauri::async_runtime::spawn_blocking(move || query_wsl_home(&distribution))
        .await
        .map_err(|error| format!("failed to query WSL home directory: {error}"))?
}

#[tauri::command]
pub async fn wsl_file_list(
    distribution: String,
    path: String,
) -> Result<WslFileListResult, String> {
    tauri::async_runtime::spawn_blocking(move || list_wsl_directory(&distribution, &path))
        .await
        .map_err(|error| format!("failed to list WSL directory: {error}"))?
}

#[tauri::command]
pub async fn wsl_file_mkdir(distribution: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (linux_path, target) = resolve_wsl_path(&distribution, &path)?;
        if linux_path == "/" {
            return Err("refusing to create the WSL filesystem root".to_string());
        }
        fs::create_dir(&target)
            .map_err(|error| format!("failed to create WSL directory {linux_path}: {error}"))
    })
    .await
    .map_err(|error| format!("failed to create WSL directory: {error}"))?
}

#[tauri::command]
pub async fn wsl_file_remove(distribution: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (linux_path, target) = resolve_wsl_path(&distribution, &path)?;
        if linux_path == "/" {
            return Err("refusing to remove the WSL filesystem root".to_string());
        }
        remove_path(&target)
            .map_err(|error| format!("failed to remove WSL entry {linux_path}: {error}"))
    })
    .await
    .map_err(|error| format!("failed to remove WSL entry: {error}"))?
}

#[tauri::command]
pub async fn wsl_file_rename(distribution: String, from: String, to: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (from_linux, from_path) = resolve_wsl_path(&distribution, &from)?;
        let (to_linux, to_path) = resolve_wsl_path(&distribution, &to)?;
        if from_linux == "/" || to_linux == "/" {
            return Err("refusing to rename the WSL filesystem root".to_string());
        }
        fs::rename(&from_path, &to_path).map_err(|error| {
            format!("failed to rename WSL entry {from_linux} to {to_linux}: {error}")
        })
    })
    .await
    .map_err(|error| format!("failed to rename WSL entry: {error}"))?
}

#[tauri::command]
pub async fn wsl_transfer_upload(
    distribution: String,
    local_path: String,
    wsl_path: String,
    app_handle: AppHandle,
    transfer_service: State<'_, TransferService>,
) -> Result<TransferTask, String> {
    validate_distribution_name(&distribution)?;
    let source = resolve_local_source(&local_path)?;
    let (wsl_path, _) = resolve_wsl_path(&distribution, &wsl_path)?;
    if wsl_path == "/" {
        return Err("refusing to replace the WSL filesystem root".to_string());
    }
    let item_kind = copy_item_kind(&source)?;
    let task = transfer_service.wsl_copy(
        wsl_connection_id(&distribution),
        TransferDirection::Upload,
        item_kind,
        source.display().to_string(),
        wsl_path,
    )?;

    start_queued_wsl_transfers(app_handle, distribution)?;
    transfer_service.get(&task.id)
}

#[tauri::command]
pub async fn wsl_transfer_download(
    distribution: String,
    wsl_path: String,
    local_path: String,
    app_handle: AppHandle,
    transfer_service: State<'_, TransferService>,
) -> Result<TransferTask, String> {
    let (wsl_path, source) = resolve_wsl_path(&distribution, &wsl_path)?;
    let target = resolve_local_target(&local_path)?;
    if is_filesystem_root(&target) {
        return Err("refusing to replace a local filesystem root".to_string());
    }
    let item_kind = copy_item_kind(&source)?;
    let task = transfer_service.wsl_copy(
        wsl_connection_id(&distribution),
        TransferDirection::Download,
        item_kind,
        target.display().to_string(),
        wsl_path,
    )?;

    start_queued_wsl_transfers(app_handle, distribution)?;
    transfer_service.get(&task.id)
}

#[tauri::command]
pub fn wsl_transfer_list(
    distribution: String,
    transfer_service: State<'_, TransferService>,
) -> Result<Vec<TransferTask>, String> {
    validate_distribution_name(&distribution)?;
    let connection_id = wsl_connection_id(&distribution);
    Ok(transfer_service
        .list()?
        .into_iter()
        .filter(|task| {
            task.connection_id == connection_id && matches!(task.protocol, TransferProtocol::Wsl)
        })
        .collect())
}

#[tauri::command]
pub fn wsl_transfer_action(
    transfer_id: String,
    action: String,
    app_handle: AppHandle,
    transfer_service: State<'_, TransferService>,
) -> Result<TransferTask, String> {
    let existing = transfer_service.get(&transfer_id)?;
    if !matches!(existing.protocol, TransferProtocol::Wsl) {
        return Err(format!("transfer is not a WSL task: {transfer_id}"));
    }
    let distribution = distribution_from_connection_id(&existing.connection_id)?;

    let task = match action.as_str() {
        "cancel" => transfer_service.cancel(&transfer_id)?,
        "pause" => transfer_service.pause(&transfer_id)?,
        "resume" => transfer_service.resume(&transfer_id)?,
        "retry" => transfer_service.retry(&transfer_id)?,
        "delete" => return transfer_service.delete(&transfer_id),
        _ => return Err(format!("unsupported WSL transfer action: {action}")),
    };

    if action == "retry" {
        let _ = start_queued_wsl_transfers(app_handle, distribution)?;
    }
    transfer_service.get(&task.id)
}

fn list_wsl_directory(distribution: &str, path: &str) -> Result<WslFileListResult, String> {
    let (linux_path, target) = resolve_wsl_path(distribution, path)?;
    let mut entries = Vec::new();

    for entry in fs::read_dir(&target)
        .map_err(|error| format!("failed to list WSL directory {linux_path}: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("failed to read WSL directory entry: {error}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|error| format!("failed to inspect WSL entry {name}: {error}"))?;
        let entry_linux_path = join_linux_path(&linux_path, &name);
        entries.push(entry_from_metadata(name, entry_linux_path, metadata));
    }

    entries.sort_by(|left, right| {
        entry_kind_rank(&left.kind)
            .cmp(&entry_kind_rank(&right.kind))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(WslFileListResult {
        path: linux_path,
        entries,
    })
}

fn entry_from_metadata(name: String, path: String, metadata: fs::Metadata) -> RemoteEntry {
    let file_type = metadata.file_type();
    let kind = if file_type.is_symlink() {
        RemoteEntryKind::Symlink
    } else if metadata.is_dir() {
        RemoteEntryKind::Directory
    } else if metadata.is_file() {
        RemoteEntryKind::File
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

    RemoteEntry {
        name,
        path,
        kind,
        size: metadata.len(),
        modified_at,
        permissions,
        owner: None,
        group: None,
    }
}

fn entry_kind_rank(kind: &RemoteEntryKind) -> u8 {
    match kind {
        RemoteEntryKind::Directory => 0,
        RemoteEntryKind::File => 1,
        RemoteEntryKind::Symlink => 2,
        RemoteEntryKind::Other => 3,
    }
}

fn query_wsl_home(distribution: &str) -> Result<String, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let output = Command::new("wsl.exe")
            .args(["--distribution", distribution, "--exec", "printenv", "HOME"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|error| format!("failed to start WSL: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "failed to query the WSL home directory: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let home = String::from_utf8_lossy(&output.stdout).trim().to_string();
        normalize_linux_path(if home.is_empty() { "/" } else { &home })
    }

    #[cfg(not(windows))]
    {
        let _ = distribution;
        Err("WSL file access is only available on Windows".to_string())
    }
}

fn validate_distribution_name(distribution: &str) -> Result<(), String> {
    let trimmed = distribution.trim();
    if trimmed.is_empty()
        || trimmed != distribution
        || trimmed == "."
        || trimmed == ".."
        || trimmed.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
                )
        })
    {
        return Err("invalid WSL distribution name".to_string());
    }
    Ok(())
}

fn normalize_linux_path(path: &str) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() {
        return Ok("/".to_string());
    }
    if !path.starts_with('/') {
        return Err("WSL paths must be absolute Linux paths".to_string());
    }
    if path.contains('\0') || path.contains('\\') {
        return Err("WSL path contains an unsupported character".to_string());
    }

    let mut parts = Vec::new();
    for part in path.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            parts.pop();
            continue;
        }
        if part.chars().any(|character| {
            character.is_control() || matches!(character, ':' | '*' | '?' | '"' | '<' | '>' | '|')
        }) {
            return Err(format!(
                "WSL path component is not accessible from Windows: {part}"
            ));
        }
        parts.push(part);
    }

    Ok(if parts.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", parts.join("/"))
    })
}

fn resolve_wsl_path(distribution: &str, path: &str) -> Result<(String, PathBuf), String> {
    validate_distribution_name(distribution)?;
    let linux_path = normalize_linux_path(path)?;

    #[cfg(windows)]
    {
        let mut target = PathBuf::from(format!(r"\\wsl.localhost\{distribution}"));
        for part in linux_path.trim_start_matches('/').split('/') {
            if !part.is_empty() {
                target.push(part);
            }
        }
        Ok((linux_path, target))
    }

    #[cfg(not(windows))]
    {
        let _ = (distribution, linux_path);
        Err("WSL file access is only available on Windows".to_string())
    }
}

fn join_linux_path(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{}/{name}", parent.trim_end_matches('/'))
    }
}

fn resolve_local_source(path: &str) -> Result<PathBuf, String> {
    let target = resolve_local_target(path)?;
    if !target.exists() {
        return Err(format!(
            "local transfer source does not exist: {}",
            target.display()
        ));
    }
    Ok(target)
}

fn resolve_local_target(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path.trim());
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err("local transfer paths must be absolute".to_string());
    }
    Ok(path)
}

fn is_filesystem_root(path: &Path) -> bool {
    path.parent().is_none()
}

fn copy_item_kind(path: &Path) -> Result<TransferTaskItemKind, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        format!(
            "failed to inspect transfer source {}: {error}",
            path.display()
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "symbolic link transfer is not supported: {}",
            path.display()
        ));
    }
    if metadata.is_dir() {
        return Ok(TransferTaskItemKind::Directory);
    }
    if metadata.is_file() {
        return Ok(TransferTaskItemKind::File);
    }
    Err(format!("unsupported transfer source: {}", path.display()))
}

fn wsl_connection_id(distribution: &str) -> String {
    format!("{WSL_CONNECTION_PREFIX}{distribution}")
}

fn distribution_from_connection_id(connection_id: &str) -> Result<String, String> {
    let distribution = connection_id
        .strip_prefix(WSL_CONNECTION_PREFIX)
        .ok_or_else(|| format!("invalid WSL transfer connection: {connection_id}"))?;
    validate_distribution_name(distribution)?;
    Ok(distribution.to_string())
}

fn start_queued_wsl_transfers(
    app_handle: AppHandle,
    distribution: String,
) -> Result<Vec<TransferTask>, String> {
    let connection_id = wsl_connection_id(&distribution);
    let transfer_service = app_handle.state::<TransferService>();
    let Some(task) =
        transfer_service.start_next_pending_for_connection_with_limit(&connection_id, 1)?
    else {
        return Ok(Vec::new());
    };
    let task = transfer_service.mark_running(&task.id, None)?;
    let started = task.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let task_id = task.id.clone();
        let result = copy_wsl_task(&app_handle.state::<TransferService>(), &distribution, &task);
        finish_wsl_transfer(app_handle, distribution, task_id, result);
    });

    Ok(vec![started])
}

fn copy_wsl_task(
    transfer_service: &TransferService,
    distribution: &str,
    task: &TransferTask,
) -> Result<(u64, u64), String> {
    let (source, target) = match task.direction {
        TransferDirection::Upload => {
            let (_, target) = resolve_wsl_path(distribution, &task.remote_path)?;
            (PathBuf::from(&task.local_path), target)
        }
        TransferDirection::Download => {
            let (_, source) = resolve_wsl_path(distribution, &task.remote_path)?;
            (source, PathBuf::from(&task.local_path))
        }
    };

    if !resolve_destination_conflict(transfer_service, &task.id, &target)? {
        transfer_service.set_totals(&task.id, 0, 1)?;
        transfer_service.mark_item_skipped(&task.id)?;
        return Ok((0, 0));
    }

    let plan = scan_copy_plan(transfer_service, &task.id, &source, &target)?;
    let total_items = plan.directories.len() as u64 + plan.files.len() as u64 + plan.skipped_items;
    transfer_service.set_totals(&task.id, plan.total_bytes, total_items.max(1))?;
    if plan.skipped_items > 0 {
        transfer_service.mark_items_skipped(&task.id, plan.skipped_items)?;
    }

    let target_was_created = !target.exists();
    let result = execute_copy_plan(transfer_service, &task.id, &plan);
    if result.is_err() && target_was_created {
        let _ = remove_path(&target);
    }
    result.map(|transferred| (transferred, plan.total_bytes))
}

fn resolve_destination_conflict(
    transfer_service: &TransferService,
    task_id: &str,
    target: &Path,
) -> Result<bool, String> {
    if !target.exists() {
        return Ok(true);
    }

    loop {
        wait_for_transfer_ready(transfer_service, task_id)?;
        let requested = transfer_service.request_conflict(task_id, target.display().to_string())?;
        if matches!(requested.status, TransferStatus::WaitingConflict) {
            break;
        }
        match requested.conflict_policy {
            crate::domain::file_transfer::TransferConflictPolicy::OverwriteAll => {
                remove_path(target)?;
                return Ok(true);
            }
            crate::domain::file_transfer::TransferConflictPolicy::SkipAll => return Ok(false),
            _ => thread::sleep(Duration::from_millis(120)),
        }
    }

    loop {
        match transfer_service.take_conflict_directive(task_id)? {
            ConflictDirective::Wait => thread::sleep(Duration::from_millis(120)),
            ConflictDirective::Overwrite => {
                remove_path(target)?;
                return Ok(true);
            }
            ConflictDirective::Skip => return Ok(false),
            ConflictDirective::Cancel => return Err(TRANSFER_CANCELLED.to_string()),
        }
    }
}

fn scan_copy_plan(
    transfer_service: &TransferService,
    task_id: &str,
    source: &Path,
    target: &Path,
) -> Result<CopyPlan, String> {
    let metadata = fs::symlink_metadata(source).map_err(|error| {
        format!(
            "failed to inspect transfer source {}: {error}",
            source.display()
        )
    })?;
    if metadata.is_file() {
        return Ok(CopyPlan {
            directories: Vec::new(),
            files: vec![PlannedCopyFile {
                source: source.to_path_buf(),
                target: target.to_path_buf(),
            }],
            skipped_items: 0,
            total_bytes: metadata.len(),
        });
    }

    let mut directories = vec![target.to_path_buf()];
    let mut files = Vec::new();
    let mut skipped_items = 0_u64;
    let mut total_bytes = 0_u64;
    let mut pending = VecDeque::from([(source.to_path_buf(), target.to_path_buf())]);

    while let Some((source_directory, target_directory)) = pending.pop_front() {
        wait_for_transfer_ready(transfer_service, task_id)?;
        for entry in fs::read_dir(&source_directory).map_err(|error| {
            format!(
                "failed to scan transfer directory {}: {error}",
                source_directory.display()
            )
        })? {
            let entry = entry.map_err(|error| format!("failed to read transfer entry: {error}"))?;
            let source_path = entry.path();
            let target_path = target_directory.join(entry.file_name());
            let metadata = fs::symlink_metadata(&source_path).map_err(|error| {
                format!(
                    "failed to inspect transfer entry {}: {error}",
                    source_path.display()
                )
            })?;
            if metadata.file_type().is_symlink() {
                skipped_items = skipped_items.saturating_add(1);
            } else if metadata.is_dir() {
                directories.push(target_path.clone());
                pending.push_back((source_path, target_path));
            } else if metadata.is_file() {
                total_bytes = total_bytes.saturating_add(metadata.len());
                files.push(PlannedCopyFile {
                    source: source_path,
                    target: target_path,
                });
            } else {
                skipped_items = skipped_items.saturating_add(1);
            }
        }
    }

    Ok(CopyPlan {
        directories,
        files,
        skipped_items,
        total_bytes,
    })
}

fn execute_copy_plan(
    transfer_service: &TransferService,
    task_id: &str,
    plan: &CopyPlan,
) -> Result<u64, String> {
    for directory in &plan.directories {
        wait_for_transfer_ready(transfer_service, task_id)?;
        fs::create_dir_all(directory).map_err(|error| {
            format!(
                "failed to create transfer directory {}: {error}",
                directory.display()
            )
        })?;
        transfer_service.mark_item_completed(task_id)?;
    }

    let mut transferred_bytes = 0_u64;
    for file in &plan.files {
        wait_for_transfer_ready(transfer_service, task_id)?;
        if let Some(parent) = file.target.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "failed to create transfer directory {}: {error}",
                    parent.display()
                )
            })?;
        }
        transferred_bytes = copy_file_with_progress(
            transfer_service,
            task_id,
            &file.source,
            &file.target,
            transferred_bytes,
            plan.total_bytes,
        )?;
        transfer_service.mark_item_completed(task_id)?;
    }
    Ok(transferred_bytes)
}

fn copy_file_with_progress(
    transfer_service: &TransferService,
    task_id: &str,
    source: &Path,
    target: &Path,
    transferred_before_file: u64,
    total_bytes: u64,
) -> Result<u64, String> {
    let mut source_file = File::open(source).map_err(|error| {
        format!(
            "failed to open transfer source {}: {error}",
            source.display()
        )
    })?;
    let temporary = temporary_copy_path(target, task_id)?;
    let mut target_file = File::create(&temporary).map_err(|error| {
        format!(
            "failed to create transfer target {}: {error}",
            temporary.display()
        )
    })?;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut file_bytes = 0_u64;

    let result = (|| -> Result<(), String> {
        loop {
            wait_for_transfer_ready(transfer_service, task_id)?;
            let count = source_file.read(&mut buffer).map_err(|error| {
                format!(
                    "failed to read transfer source {}: {error}",
                    source.display()
                )
            })?;
            if count == 0 {
                break;
            }
            target_file.write_all(&buffer[..count]).map_err(|error| {
                format!(
                    "failed to write transfer target {}: {error}",
                    temporary.display()
                )
            })?;
            file_bytes = file_bytes.saturating_add(count as u64);
            transfer_service.mark_progress(
                task_id,
                transferred_before_file.saturating_add(file_bytes),
                Some(total_bytes),
            )?;
        }
        target_file.flush().map_err(|error| {
            format!(
                "failed to flush transfer target {}: {error}",
                temporary.display()
            )
        })?;
        drop(target_file);
        fs::rename(&temporary, target).map_err(|error| {
            format!(
                "failed to finalize transfer target {}: {error}",
                target.display()
            )
        })?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map(|_| transferred_before_file.saturating_add(file_bytes))
}

fn temporary_copy_path(target: &Path, task_id: &str) -> Result<PathBuf, String> {
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("invalid transfer target: {}", target.display()))?;
    let suffix = task_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .collect::<String>();
    Ok(target.with_file_name(format!(".{name}.portiva-{suffix}.part")))
}

fn wait_for_transfer_ready(
    transfer_service: &TransferService,
    task_id: &str,
) -> Result<(), String> {
    loop {
        match transfer_service.status(task_id)? {
            TransferStatus::Cancelled => return Err(TRANSFER_CANCELLED.to_string()),
            TransferStatus::Paused => thread::sleep(Duration::from_millis(120)),
            TransferStatus::Running => return Ok(()),
            status => {
                return Err(format!(
                    "cannot continue WSL transfer while status is {status:?}"
                ))
            }
        }
    }
}

fn finish_wsl_transfer(
    app_handle: AppHandle,
    distribution: String,
    task_id: String,
    result: Result<(u64, u64), String>,
) {
    let transfer_service = app_handle.state::<TransferService>();
    match result {
        Ok((transferred_bytes, total_bytes)) => {
            let _ = transfer_service.mark_completed(&task_id, transferred_bytes, Some(total_bytes));
        }
        Err(error) if error == TRANSFER_CANCELLED => {}
        Err(error) => {
            let _ = transfer_service.mark_failed(&task_id, error);
        }
    }
    let _ = start_queued_wsl_transfers(app_handle, distribution);
}

fn remove_path(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path)
            .map_err(|error| format!("failed to remove directory {}: {error}", path.display()))
    } else {
        fs::remove_file(path)
            .map_err(|error| format!("failed to remove file {}: {error}", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        execute_copy_plan, normalize_linux_path, scan_copy_plan, validate_distribution_name,
    };
    use crate::domain::file_transfer::{TransferDirection, TransferStatus, TransferTaskItemKind};
    use crate::services::transfer_service::TransferService;

    struct TempDirectory(std::path::PathBuf);

    impl TempDirectory {
        fn new(label: &str) -> Self {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "portiva-wsl-{label}-{}-{unique}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn normalizes_absolute_linux_paths_without_escaping_root() {
        assert_eq!(
            normalize_linux_path("/home/evo/../dev").unwrap(),
            "/home/dev"
        );
        assert_eq!(normalize_linux_path("/../../etc").unwrap(), "/etc");
        assert_eq!(normalize_linux_path("/").unwrap(), "/");
        assert!(normalize_linux_path("relative/path").is_err());
        assert!(normalize_linux_path("/mnt/c/a\\b").is_err());
    }

    #[test]
    fn rejects_distribution_names_that_can_escape_the_unc_share() {
        assert!(validate_distribution_name("Ubuntu").is_ok());
        assert!(validate_distribution_name("Team Linux").is_ok());
        assert!(validate_distribution_name("../Ubuntu").is_err());
        assert!(validate_distribution_name("Ubuntu\\other").is_err());
        assert!(validate_distribution_name(" Ubuntu").is_err());
    }

    #[test]
    fn recursively_copies_a_directory_and_tracks_task_progress() {
        let temp = TempDirectory::new("recursive-copy");
        let source = temp.0.join("source");
        let target = temp.0.join("target");
        std::fs::create_dir_all(source.join("nested")).unwrap();
        std::fs::write(source.join("root.txt"), b"root").unwrap();
        std::fs::write(source.join("nested").join("child.txt"), b"child").unwrap();

        let service = TransferService::default();
        let task = service
            .wsl_copy(
                "wsl-files:Ubuntu".to_string(),
                TransferDirection::Upload,
                TransferTaskItemKind::Directory,
                source.display().to_string(),
                "/tmp/target".to_string(),
            )
            .unwrap();
        let started = service
            .start_next_pending_for_connection_with_limit("wsl-files:Ubuntu", 1)
            .unwrap()
            .unwrap();
        service.mark_running(&started.id, None).unwrap();

        let plan = scan_copy_plan(&service, &task.id, &source, &target).unwrap();
        let total_items = (plan.directories.len() + plan.files.len()) as u64;
        service
            .set_totals(&task.id, plan.total_bytes, total_items)
            .unwrap();
        let transferred = execute_copy_plan(&service, &task.id, &plan).unwrap();
        let completed = service
            .mark_completed(&task.id, transferred, Some(plan.total_bytes))
            .unwrap();

        assert_eq!(std::fs::read(target.join("root.txt")).unwrap(), b"root");
        assert_eq!(
            std::fs::read(target.join("nested").join("child.txt")).unwrap(),
            b"child"
        );
        assert!(matches!(completed.status, TransferStatus::Completed));
        assert_eq!(completed.transferred_bytes, 9);
        assert_eq!(completed.completed_items, total_items);
    }
}
