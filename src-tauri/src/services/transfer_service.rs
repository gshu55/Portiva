use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::domain::file_transfer::{
    TransferConflictPolicy, TransferDirection, TransferProtocol, TransferStatus, TransferTask,
    TransferTaskItemKind,
};
use crate::utils::remote_path::normalize_remote_path;
use crate::utils::transfer_progress::progress_percent;

pub const DEFAULT_MAX_RUNNING_TRANSFERS_PER_CONNECTION: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictDirective {
    Wait,
    Overwrite,
    Skip,
    Cancel,
}

pub struct TransferService {
    tasks: Mutex<HashMap<String, TransferTask>>,
    next_sequence: Mutex<u64>,
}

impl Default for TransferService {
    fn default() -> Self {
        Self {
            tasks: Mutex::new(HashMap::new()),
            next_sequence: Mutex::new(0),
        }
    }
}

impl TransferService {
    #[cfg(test)]
    pub fn upload(
        &self,
        connection_id: String,
        local_path: String,
        remote_path: String,
    ) -> Result<TransferTask, String> {
        self.upload_with_kind(
            connection_id,
            local_path,
            remote_path,
            TransferTaskItemKind::File,
        )
    }

    pub fn upload_with_kind(
        &self,
        connection_id: String,
        local_path: String,
        remote_path: String,
        item_kind: TransferTaskItemKind,
    ) -> Result<TransferTask, String> {
        self.create_task(
            connection_id,
            TransferDirection::Upload,
            item_kind,
            local_path,
            normalize_remote_path(&remote_path),
        )
    }

    pub fn download(
        &self,
        connection_id: String,
        remote_path: String,
        local_path: String,
    ) -> Result<TransferTask, String> {
        self.create_task(
            connection_id,
            TransferDirection::Download,
            TransferTaskItemKind::File,
            local_path,
            normalize_remote_path(&remote_path),
        )
    }

    pub fn cancel(&self, transfer_id: &str) -> Result<TransferTask, String> {
        self.transition(transfer_id, "cancel", |status| {
            matches!(
                status,
                TransferStatus::Pending
                    | TransferStatus::Running
                    | TransferStatus::Paused
                    | TransferStatus::WaitingConflict
            )
            .then_some(TransferStatus::Cancelled)
        })
    }

    pub fn pause(&self, transfer_id: &str) -> Result<TransferTask, String> {
        self.transition(transfer_id, "pause", |status| {
            matches!(status, TransferStatus::Running).then_some(TransferStatus::Paused)
        })
    }

    pub fn resume(&self, transfer_id: &str) -> Result<TransferTask, String> {
        self.transition(transfer_id, "resume", |status| {
            matches!(status, TransferStatus::Paused).then_some(TransferStatus::Running)
        })
    }

    pub fn request_conflict(
        &self,
        transfer_id: &str,
        remote_path: String,
    ) -> Result<TransferTask, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "transfer service lock poisoned".to_string())?;
        let task = tasks
            .get_mut(transfer_id)
            .ok_or_else(|| format!("transfer not found: {transfer_id}"))?;

        if matches!(
            task.status,
            TransferStatus::Cancelled | TransferStatus::Paused
        ) {
            return Ok(task.clone());
        }
        if !matches!(task.status, TransferStatus::Running) {
            return Err(format!(
                "cannot request conflict resolution while status is {:?}",
                task.status
            ));
        }
        if matches!(
            task.conflict_policy,
            TransferConflictPolicy::OverwriteAll | TransferConflictPolicy::SkipAll
        ) {
            return Ok(task.clone());
        }

        task.status = TransferStatus::WaitingConflict;
        task.conflict_policy = TransferConflictPolicy::Ask;
        task.conflict_path = Some(remote_path);
        task.updated_at = now_stamp();
        Ok(task.clone())
    }

    pub fn resolve_conflict(
        &self,
        transfer_id: &str,
        policy: TransferConflictPolicy,
    ) -> Result<TransferTask, String> {
        if !matches!(
            policy,
            TransferConflictPolicy::Overwrite
                | TransferConflictPolicy::OverwriteAll
                | TransferConflictPolicy::Skip
                | TransferConflictPolicy::SkipAll
        ) {
            return Err(
                "transfer conflict resolution must be overwrite, overwrite-all, skip, or skip-all"
                    .to_string(),
            );
        }

        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "transfer service lock poisoned".to_string())?;
        let task = tasks
            .get_mut(transfer_id)
            .ok_or_else(|| format!("transfer not found: {transfer_id}"))?;

        if !matches!(task.status, TransferStatus::WaitingConflict) {
            return Err(format!(
                "cannot resolve conflict while status is {:?}",
                task.status
            ));
        }

        task.conflict_policy = policy;
        task.updated_at = now_stamp();
        Ok(task.clone())
    }

    pub fn take_conflict_directive(&self, transfer_id: &str) -> Result<ConflictDirective, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "transfer service lock poisoned".to_string())?;
        let task = tasks
            .get_mut(transfer_id)
            .ok_or_else(|| format!("transfer not found: {transfer_id}"))?;

        if matches!(task.status, TransferStatus::Cancelled) {
            return Ok(ConflictDirective::Cancel);
        }
        if !matches!(task.status, TransferStatus::WaitingConflict) {
            return Err(format!(
                "transfer is not waiting for conflict resolution: {:?}",
                task.status
            ));
        }

        let keep_policy = matches!(
            task.conflict_policy,
            TransferConflictPolicy::OverwriteAll | TransferConflictPolicy::SkipAll
        );
        let directive = match task.conflict_policy {
            TransferConflictPolicy::Ask => return Ok(ConflictDirective::Wait),
            TransferConflictPolicy::Overwrite | TransferConflictPolicy::OverwriteAll => {
                ConflictDirective::Overwrite
            }
            TransferConflictPolicy::Skip | TransferConflictPolicy::SkipAll => {
                ConflictDirective::Skip
            }
            TransferConflictPolicy::Rename => {
                return Err("rename conflict resolution is not supported".to_string())
            }
        };

        task.status = TransferStatus::Running;
        if !keep_policy {
            task.conflict_policy = TransferConflictPolicy::Ask;
        }
        task.conflict_path = None;
        task.updated_at = now_stamp();
        Ok(directive)
    }

    pub fn retry(&self, transfer_id: &str) -> Result<TransferTask, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "transfer service lock poisoned".to_string())?;

        let task = tasks
            .get_mut(transfer_id)
            .ok_or_else(|| format!("transfer not found: {transfer_id}"))?;

        if !matches!(task.status, TransferStatus::Failed) {
            return Err(format!(
                "cannot retry transfer while status is {:?}",
                task.status
            ));
        }

        task.retry_count = task.retry_count.saturating_add(1);
        task.status = TransferStatus::Pending;
        task.error = None;
        task.conflict_policy = TransferConflictPolicy::Ask;
        task.conflict_path = None;
        task.total_bytes = None;
        task.transferred_bytes = 0;
        task.total_items = None;
        task.completed_items = 0;
        task.skipped_items = 0;
        task.failed_items = 0;
        task.speed_bytes_per_second = None;
        task.updated_at = now_stamp();
        Ok(task.clone())
    }

    pub fn delete(&self, transfer_id: &str) -> Result<TransferTask, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "transfer service lock poisoned".to_string())?;

        let task = tasks
            .get(transfer_id)
            .ok_or_else(|| format!("transfer not found: {transfer_id}"))?;

        if matches!(
            task.status,
            TransferStatus::Running | TransferStatus::Paused | TransferStatus::WaitingConflict
        ) {
            return Err("cancel the active transfer before deleting it".to_string());
        }

        tasks
            .remove(transfer_id)
            .ok_or_else(|| format!("transfer not found: {transfer_id}"))
    }

    pub fn mark_running(
        &self,
        transfer_id: &str,
        total_bytes: Option<u64>,
    ) -> Result<TransferTask, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "transfer service lock poisoned".to_string())?;
        let task = tasks
            .get_mut(transfer_id)
            .ok_or_else(|| format!("transfer not found: {transfer_id}"))?;

        if !matches!(
            task.status,
            TransferStatus::Pending | TransferStatus::Running
        ) {
            return Err(format!(
                "cannot start transfer while status is {:?}",
                task.status
            ));
        }

        task.status = TransferStatus::Running;
        task.total_bytes = total_bytes;
        task.error = None;
        task.updated_at = now_stamp();

        Ok(task.clone())
    }

    pub fn mark_progress(
        &self,
        transfer_id: &str,
        transferred_bytes: u64,
        total_bytes: Option<u64>,
    ) -> Result<TransferTask, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "transfer service lock poisoned".to_string())?;
        let task = tasks
            .get_mut(transfer_id)
            .ok_or_else(|| format!("transfer not found: {transfer_id}"))?;

        if matches!(task.status, TransferStatus::Cancelled) {
            return Ok(task.clone());
        }

        if !matches!(task.status, TransferStatus::Running) {
            return Ok(task.clone());
        }
        task.transferred_bytes = transferred_bytes;
        task.total_bytes = total_bytes.or(task.total_bytes);
        task.updated_at = now_stamp();

        Ok(task.clone())
    }

    pub fn set_totals(
        &self,
        transfer_id: &str,
        total_bytes: u64,
        total_items: u64,
    ) -> Result<TransferTask, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "transfer service lock poisoned".to_string())?;
        let task = tasks
            .get_mut(transfer_id)
            .ok_or_else(|| format!("transfer not found: {transfer_id}"))?;

        if matches!(task.status, TransferStatus::Cancelled) {
            return Ok(task.clone());
        }
        if !matches!(
            task.status,
            TransferStatus::Running | TransferStatus::Paused
        ) {
            return Err(format!(
                "cannot set transfer totals while status is {:?}",
                task.status
            ));
        }

        task.total_bytes = Some(total_bytes);
        task.total_items = Some(total_items);
        task.updated_at = now_stamp();
        Ok(task.clone())
    }

    pub fn mark_item_completed(&self, transfer_id: &str) -> Result<TransferTask, String> {
        self.update_item_counts(transfer_id, 1, 0, 0, None)
    }

    pub fn mark_item_skipped(&self, transfer_id: &str) -> Result<TransferTask, String> {
        self.update_item_counts(transfer_id, 0, 1, 0, None)
    }

    pub fn mark_items_skipped(
        &self,
        transfer_id: &str,
        count: u64,
    ) -> Result<TransferTask, String> {
        self.update_item_counts(transfer_id, 0, count, 0, None)
    }

    pub fn mark_item_failed(
        &self,
        transfer_id: &str,
        error: String,
    ) -> Result<TransferTask, String> {
        self.update_item_counts(transfer_id, 0, 0, 1, Some(error))
    }

    pub fn mark_items_failed(
        &self,
        transfer_id: &str,
        count: u64,
        error: String,
    ) -> Result<TransferTask, String> {
        self.update_item_counts(transfer_id, 0, 0, count, Some(error))
    }

    pub fn mark_completed(
        &self,
        transfer_id: &str,
        transferred_bytes: u64,
        total_bytes: Option<u64>,
    ) -> Result<TransferTask, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "transfer service lock poisoned".to_string())?;
        let task = tasks
            .get_mut(transfer_id)
            .ok_or_else(|| format!("transfer not found: {transfer_id}"))?;

        if matches!(task.status, TransferStatus::Cancelled) {
            return Ok(task.clone());
        }

        if !matches!(
            task.status,
            TransferStatus::Running | TransferStatus::Paused
        ) {
            return Err(format!(
                "cannot complete transfer while status is {:?}",
                task.status
            ));
        }

        task.status = if task.skipped_items > 0 || task.failed_items > 0 {
            TransferStatus::Partial
        } else {
            TransferStatus::Completed
        };
        task.transferred_bytes = transferred_bytes;
        task.total_bytes = total_bytes.or(Some(transferred_bytes));
        task.speed_bytes_per_second = None;
        if matches!(task.status, TransferStatus::Completed) {
            task.error = None;
        }
        task.updated_at = now_stamp();

        Ok(task.clone())
    }

    fn update_item_counts(
        &self,
        transfer_id: &str,
        completed: u64,
        skipped: u64,
        failed: u64,
        error: Option<String>,
    ) -> Result<TransferTask, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "transfer service lock poisoned".to_string())?;
        let task = tasks
            .get_mut(transfer_id)
            .ok_or_else(|| format!("transfer not found: {transfer_id}"))?;

        if matches!(task.status, TransferStatus::Cancelled) {
            return Ok(task.clone());
        }
        if !matches!(
            task.status,
            TransferStatus::Running | TransferStatus::Paused
        ) {
            return Err(format!(
                "cannot update transfer items while status is {:?}",
                task.status
            ));
        }

        task.completed_items = task.completed_items.saturating_add(completed);
        task.skipped_items = task.skipped_items.saturating_add(skipped);
        task.failed_items = task.failed_items.saturating_add(failed);
        if error.is_some() {
            task.error = error;
        }
        task.updated_at = now_stamp();
        Ok(task.clone())
    }

    pub fn mark_failed(&self, transfer_id: &str, error: String) -> Result<TransferTask, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "transfer service lock poisoned".to_string())?;
        let task = tasks
            .get_mut(transfer_id)
            .ok_or_else(|| format!("transfer not found: {transfer_id}"))?;

        if matches!(task.status, TransferStatus::Cancelled) {
            return Ok(task.clone());
        }

        if !matches!(
            task.status,
            TransferStatus::Running | TransferStatus::Paused | TransferStatus::WaitingConflict
        ) {
            return Err(format!(
                "cannot fail transfer while status is {:?}",
                task.status
            ));
        }

        task.status = TransferStatus::Failed;
        task.error = Some(error);
        task.updated_at = now_stamp();

        Ok(task.clone())
    }

    pub fn status(&self, transfer_id: &str) -> Result<TransferStatus, String> {
        let tasks = self
            .tasks
            .lock()
            .map_err(|_| "transfer service lock poisoned".to_string())?;
        let task = tasks
            .get(transfer_id)
            .ok_or_else(|| format!("transfer not found: {transfer_id}"))?;

        Ok(task.status.clone())
    }

    pub fn get(&self, transfer_id: &str) -> Result<TransferTask, String> {
        self.tasks
            .lock()
            .map_err(|_| "transfer service lock poisoned".to_string())?
            .get(transfer_id)
            .cloned()
            .ok_or_else(|| format!("transfer not found: {transfer_id}"))
    }

    pub fn start_next_pending_for_connection(
        &self,
        connection_id: &str,
    ) -> Result<Option<TransferTask>, String> {
        self.start_next_pending_for_connection_with_limit(
            connection_id,
            DEFAULT_MAX_RUNNING_TRANSFERS_PER_CONNECTION,
        )
    }

    pub fn start_next_pending_for_connection_with_limit(
        &self,
        connection_id: &str,
        max_running: usize,
    ) -> Result<Option<TransferTask>, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "transfer service lock poisoned".to_string())?;

        let running_count = tasks
            .values()
            .filter(|task| {
                task.connection_id == connection_id
                    && matches!(
                        task.status,
                        TransferStatus::Running
                            | TransferStatus::Paused
                            | TransferStatus::WaitingConflict
                    )
            })
            .count();
        if running_count >= max_running.max(1) {
            return Ok(None);
        }

        let Some(next_id) = tasks
            .values()
            .filter(|task| {
                task.connection_id == connection_id
                    && matches!(task.status, TransferStatus::Pending)
            })
            .min_by_key(|task| transfer_sequence(&task.id))
            .map(|task| task.id.clone())
        else {
            return Ok(None);
        };

        let task = tasks
            .get_mut(&next_id)
            .ok_or_else(|| format!("transfer not found: {next_id}"))?;
        task.status = TransferStatus::Running;
        task.error = None;
        task.updated_at = now_stamp();

        Ok(Some(task.clone()))
    }

    pub fn cancel_by_connection(&self, connection_id: &str) -> Result<usize, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "transfer service lock poisoned".to_string())?;
        let now = now_stamp();
        let mut cancelled_count = 0;

        for task in tasks.values_mut() {
            if task.connection_id != connection_id
                || !matches!(
                    task.status,
                    TransferStatus::Pending
                        | TransferStatus::Running
                        | TransferStatus::Paused
                        | TransferStatus::WaitingConflict
                )
            {
                continue;
            }

            task.status = TransferStatus::Cancelled;
            task.updated_at = now.clone();
            cancelled_count += 1;
        }

        Ok(cancelled_count)
    }

    pub fn list(&self) -> Result<Vec<TransferTask>, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "transfer service lock poisoned".to_string())?
            .values()
            .cloned()
            .collect::<Vec<_>>();

        tasks.sort_by_key(|task| transfer_sequence(&task.id));

        for task in &tasks {
            let _progress = progress_percent(task.transferred_bytes, task.total_bytes);
        }

        Ok(tasks)
    }

    fn create_task(
        &self,
        connection_id: String,
        direction: TransferDirection,
        item_kind: TransferTaskItemKind,
        local_path: String,
        remote_path: String,
    ) -> Result<TransferTask, String> {
        let now = now_stamp();
        let direction_label = match direction {
            TransferDirection::Upload => "upload",
            TransferDirection::Download => "download",
        };
        let sequence = {
            let mut next_sequence = self
                .next_sequence
                .lock()
                .map_err(|_| "transfer sequence lock poisoned".to_string())?;
            *next_sequence = next_sequence.saturating_add(1);
            *next_sequence
        };
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "transfer service lock poisoned".to_string())?;
        let task = TransferTask {
            id: format!(
                "transfer-{direction_label}-{sequence}-{}",
                now.replace(':', "-")
            ),
            connection_id,
            direction,
            protocol: TransferProtocol::Sftp,
            item_kind,
            local_path,
            remote_path,
            status: TransferStatus::Pending,
            conflict_policy: TransferConflictPolicy::Ask,
            conflict_path: None,
            retry_count: 0,
            total_bytes: None,
            transferred_bytes: 0,
            total_items: None,
            completed_items: 0,
            skipped_items: 0,
            failed_items: 0,
            speed_bytes_per_second: None,
            error: None,
            created_at: now.clone(),
            updated_at: now,
        };

        tasks.insert(task.id.clone(), task.clone());

        Ok(task)
    }

    fn transition(
        &self,
        transfer_id: &str,
        action: &str,
        next_status: impl FnOnce(&TransferStatus) -> Option<TransferStatus>,
    ) -> Result<TransferTask, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "transfer service lock poisoned".to_string())?;

        let task = tasks
            .get_mut(transfer_id)
            .ok_or_else(|| format!("transfer not found: {transfer_id}"))?;

        let status = next_status(&task.status)
            .ok_or_else(|| format!("cannot {action} transfer while status is {:?}", task.status))?;
        task.status = status;
        task.updated_at = now_stamp();
        Ok(task.clone())
    }
}

fn now_stamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();

    format!("unix:{seconds}")
}

fn transfer_sequence(transfer_id: &str) -> u64 {
    transfer_id
        .split('-')
        .nth(2)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::{ConflictDirective, TransferService};
    use crate::domain::file_transfer::{
        TransferConflictPolicy, TransferStatus, TransferTaskItemKind,
    };

    #[test]
    fn can_pause_resume_and_cancel_transfer() {
        let service = TransferService::default();
        let task = service
            .upload(
                "connection-1".to_string(),
                "local.txt".to_string(),
                "/tmp/remote.txt".to_string(),
            )
            .unwrap();

        service.mark_running(&task.id, None).unwrap();

        assert!(matches!(
            service.pause(&task.id).unwrap().status,
            TransferStatus::Paused
        ));
        assert!(matches!(
            service.resume(&task.id).unwrap().status,
            TransferStatus::Running
        ));
        assert!(matches!(
            service.cancel(&task.id).unwrap().status,
            TransferStatus::Cancelled
        ));
    }

    #[test]
    fn retry_resets_failed_transfer_for_queueing() {
        let service = TransferService::default();
        let task = service
            .download(
                "connection-1".to_string(),
                "/tmp/remote.txt".to_string(),
                "local.txt".to_string(),
            )
            .unwrap();

        service.mark_running(&task.id, None).unwrap();
        service
            .mark_failed(&task.id, "network error".to_string())
            .unwrap();
        let retried = service.retry(&task.id).unwrap();

        assert_eq!(retried.retry_count, 1);
        assert!(matches!(retried.status, TransferStatus::Pending));
        assert_eq!(retried.transferred_bytes, 0);
    }

    #[test]
    fn can_complete_transfer_with_byte_counts() {
        let service = TransferService::default();
        let task = service
            .download(
                "connection-1".to_string(),
                "/tmp/remote.txt".to_string(),
                "local.txt".to_string(),
            )
            .unwrap();

        service.mark_running(&task.id, Some(5)).unwrap();
        let completed = service.mark_completed(&task.id, 5, Some(5)).unwrap();

        assert!(matches!(completed.status, TransferStatus::Completed));
        assert_eq!(completed.transferred_bytes, 5);
        assert_eq!(completed.total_bytes, Some(5));
    }

    #[test]
    fn can_update_transfer_progress() {
        let service = TransferService::default();
        let task = service
            .upload(
                "connection-1".to_string(),
                "local.txt".to_string(),
                "/tmp/remote.txt".to_string(),
            )
            .unwrap();

        service.mark_running(&task.id, Some(10)).unwrap();
        let running = service.mark_progress(&task.id, 3, Some(10)).unwrap();

        assert!(matches!(running.status, TransferStatus::Running));
        assert_eq!(running.transferred_bytes, 3);
        assert_eq!(running.total_bytes, Some(10));
    }

    #[test]
    fn exposes_transfer_status_for_runtime_control() {
        let service = TransferService::default();
        let task = service
            .upload(
                "connection-1".to_string(),
                "local.txt".to_string(),
                "/tmp/remote.txt".to_string(),
            )
            .unwrap();

        assert!(matches!(
            service.status(&task.id).unwrap(),
            TransferStatus::Pending
        ));
        service.mark_running(&task.id, None).unwrap();
        service.pause(&task.id).unwrap();
        assert!(matches!(
            service.status(&task.id).unwrap(),
            TransferStatus::Paused
        ));
        service.resume(&task.id).unwrap();
        assert!(matches!(
            service.status(&task.id).unwrap(),
            TransferStatus::Running
        ));
    }

    #[test]
    fn cancel_prevents_late_completion_or_failure() {
        let service = TransferService::default();
        let task = service
            .download(
                "connection-1".to_string(),
                "/tmp/remote.txt".to_string(),
                "local.txt".to_string(),
            )
            .unwrap();

        service.cancel(&task.id).unwrap();
        assert!(matches!(
            service.status(&task.id).unwrap(),
            TransferStatus::Cancelled
        ));

        let completed = service.mark_completed(&task.id, 10, Some(10)).unwrap();
        let failed = service
            .mark_failed(&task.id, "late error".to_string())
            .unwrap();

        assert!(matches!(completed.status, TransferStatus::Cancelled));
        assert!(matches!(failed.status, TransferStatus::Cancelled));
        assert!(failed.error.is_none());
    }

    #[test]
    fn creates_unique_task_ids_for_fast_queueing() {
        let service = TransferService::default();
        let first = service
            .upload(
                "connection-1".to_string(),
                "local-a.txt".to_string(),
                "/tmp/a.txt".to_string(),
            )
            .unwrap();
        let second = service
            .upload(
                "connection-1".to_string(),
                "local-b.txt".to_string(),
                "/tmp/b.txt".to_string(),
            )
            .unwrap();

        assert_ne!(first.id, second.id);
        assert_eq!(service.list().unwrap().len(), 2);
    }

    #[test]
    fn task_ids_are_not_reused_after_delete() {
        let service = TransferService::default();
        let first = service
            .upload(
                "connection-1".to_string(),
                "local-a.txt".to_string(),
                "/tmp/a.txt".to_string(),
            )
            .unwrap();
        service.delete(&first.id).unwrap();
        let second = service
            .upload(
                "connection-1".to_string(),
                "local-b.txt".to_string(),
                "/tmp/b.txt".to_string(),
            )
            .unwrap();

        assert_ne!(first.id, second.id);
    }

    #[test]
    fn rejects_invalid_transfer_transitions() {
        let service = TransferService::default();
        let task = service
            .upload(
                "connection-1".to_string(),
                "local.txt".to_string(),
                "/tmp/remote.txt".to_string(),
            )
            .unwrap();

        assert!(service.pause(&task.id).is_err());
        assert!(service.resume(&task.id).is_err());
        assert!(service.retry(&task.id).is_err());

        service.mark_running(&task.id, None).unwrap();
        assert!(service.retry(&task.id).is_err());
        service.cancel(&task.id).unwrap();
        assert!(service.resume(&task.id).is_err());
        assert!(service.retry(&task.id).is_err());
    }

    #[test]
    fn starts_one_pending_transfer_per_connection_fifo() {
        let service = TransferService::default();
        let first = service
            .upload(
                "connection-1".to_string(),
                "local-a.txt".to_string(),
                "/tmp/a.txt".to_string(),
            )
            .unwrap();
        let second = service
            .download(
                "connection-1".to_string(),
                "/tmp/b.txt".to_string(),
                "local-b.txt".to_string(),
            )
            .unwrap();

        let started = service
            .start_next_pending_for_connection_with_limit("connection-1", 1)
            .unwrap()
            .unwrap();
        let blocked = service
            .start_next_pending_for_connection_with_limit("connection-1", 1)
            .unwrap();

        assert_eq!(started.id, first.id);
        assert!(matches!(started.status, TransferStatus::Running));
        assert!(blocked.is_none());
        assert!(matches!(
            service.get(&second.id).unwrap().status,
            TransferStatus::Pending
        ));
    }

    #[test]
    fn starts_next_pending_after_active_finishes() {
        let service = TransferService::default();
        let first = service
            .upload(
                "connection-1".to_string(),
                "local-a.txt".to_string(),
                "/tmp/a.txt".to_string(),
            )
            .unwrap();
        let second = service
            .upload(
                "connection-1".to_string(),
                "local-b.txt".to_string(),
                "/tmp/b.txt".to_string(),
            )
            .unwrap();

        service
            .start_next_pending_for_connection_with_limit("connection-1", 1)
            .unwrap();
        service.mark_completed(&first.id, 1, Some(1)).unwrap();
        let next = service
            .start_next_pending_for_connection_with_limit("connection-1", 1)
            .unwrap()
            .unwrap();

        assert_eq!(next.id, second.id);
    }

    #[test]
    fn starts_multiple_pending_transfers_up_to_limit() {
        let service = TransferService::default();
        let first = service
            .upload(
                "connection-1".to_string(),
                "local-a.txt".to_string(),
                "/tmp/a.txt".to_string(),
            )
            .unwrap();
        let second = service
            .upload(
                "connection-1".to_string(),
                "local-b.txt".to_string(),
                "/tmp/b.txt".to_string(),
            )
            .unwrap();
        let third = service
            .upload(
                "connection-1".to_string(),
                "local-c.txt".to_string(),
                "/tmp/c.txt".to_string(),
            )
            .unwrap();

        let one = service
            .start_next_pending_for_connection_with_limit("connection-1", 2)
            .unwrap()
            .unwrap();
        let two = service
            .start_next_pending_for_connection_with_limit("connection-1", 2)
            .unwrap()
            .unwrap();
        let blocked = service
            .start_next_pending_for_connection_with_limit("connection-1", 2)
            .unwrap();

        assert_eq!(one.id, first.id);
        assert_eq!(two.id, second.id);
        assert!(blocked.is_none());
        assert!(matches!(
            service.get(&third.id).unwrap().status,
            TransferStatus::Pending
        ));
    }

    #[test]
    fn cancel_by_connection_only_cancels_matching_tasks() {
        let service = TransferService::default();
        let matching = service
            .upload(
                "connection-1".to_string(),
                "local-a.txt".to_string(),
                "/tmp/a.txt".to_string(),
            )
            .unwrap();
        let other = service
            .upload(
                "connection-2".to_string(),
                "local-b.txt".to_string(),
                "/tmp/b.txt".to_string(),
            )
            .unwrap();

        assert_eq!(service.cancel_by_connection("connection-1").unwrap(), 1);
        let tasks = service.list().unwrap();
        let matching = tasks.iter().find(|task| task.id == matching.id).unwrap();
        let other = tasks.iter().find(|task| task.id == other.id).unwrap();

        assert!(matches!(matching.status, TransferStatus::Cancelled));
        assert!(matches!(other.status, TransferStatus::Pending));
    }

    #[test]
    fn can_delete_inactive_transfer_from_queue() {
        let service = TransferService::default();
        let task = service
            .upload(
                "connection-1".to_string(),
                "local-a.txt".to_string(),
                "/tmp/a.txt".to_string(),
            )
            .unwrap();

        let deleted = service.delete(&task.id).unwrap();

        assert_eq!(deleted.id, task.id);
        assert!(service.get(&task.id).is_err());
        assert!(service.list().unwrap().is_empty());
    }

    #[test]
    fn rejects_deleting_active_transfer() {
        let service = TransferService::default();
        let task = service
            .upload(
                "connection-1".to_string(),
                "local-a.txt".to_string(),
                "/tmp/a.txt".to_string(),
            )
            .unwrap();

        service.mark_running(&task.id, Some(10)).unwrap();

        assert!(service.delete(&task.id).is_err());
        assert!(matches!(
            service.get(&task.id).unwrap().status,
            TransferStatus::Running
        ));
    }

    #[test]
    fn directory_task_waits_for_explicit_conflict_resolution() {
        let service = TransferService::default();
        let task = service
            .upload_with_kind(
                "connection-1".to_string(),
                "local-directory".to_string(),
                "/tmp/remote-directory".to_string(),
                TransferTaskItemKind::Directory,
            )
            .unwrap();
        service.mark_running(&task.id, None).unwrap();

        let waiting = service
            .request_conflict(&task.id, "/tmp/remote-directory/file.txt".to_string())
            .unwrap();
        assert!(matches!(waiting.status, TransferStatus::WaitingConflict));
        assert_eq!(
            waiting.conflict_path.as_deref(),
            Some("/tmp/remote-directory/file.txt")
        );
        assert_eq!(
            service.take_conflict_directive(&task.id).unwrap(),
            ConflictDirective::Wait
        );

        service
            .resolve_conflict(&task.id, TransferConflictPolicy::Overwrite)
            .unwrap();
        assert_eq!(
            service.take_conflict_directive(&task.id).unwrap(),
            ConflictDirective::Overwrite
        );
        let running = service.get(&task.id).unwrap();
        assert!(matches!(running.status, TransferStatus::Running));
        assert!(running.conflict_path.is_none());
    }

    #[test]
    fn overwrite_all_policy_is_kept_for_remaining_conflicts() {
        let service = TransferService::default();
        let task = service
            .upload_with_kind(
                "connection-1".to_string(),
                "local-directory".to_string(),
                "/tmp/remote-directory".to_string(),
                TransferTaskItemKind::Directory,
            )
            .unwrap();
        service.mark_running(&task.id, None).unwrap();
        service
            .request_conflict(&task.id, "/tmp/remote-directory/a.txt".to_string())
            .unwrap();
        service
            .resolve_conflict(&task.id, TransferConflictPolicy::OverwriteAll)
            .unwrap();

        assert_eq!(
            service.take_conflict_directive(&task.id).unwrap(),
            ConflictDirective::Overwrite
        );
        let next = service
            .request_conflict(&task.id, "/tmp/remote-directory/b.txt".to_string())
            .unwrap();
        assert!(matches!(next.status, TransferStatus::Running));
        assert!(matches!(
            next.conflict_policy,
            TransferConflictPolicy::OverwriteAll
        ));
        assert!(next.conflict_path.is_none());
    }

    #[test]
    fn skip_all_policy_is_kept_for_remaining_conflicts() {
        let service = TransferService::default();
        let task = service
            .upload_with_kind(
                "connection-1".to_string(),
                "local-directory".to_string(),
                "/tmp/remote-directory".to_string(),
                TransferTaskItemKind::Directory,
            )
            .unwrap();
        service.mark_running(&task.id, None).unwrap();
        service
            .request_conflict(&task.id, "/tmp/remote-directory/a.txt".to_string())
            .unwrap();
        service
            .resolve_conflict(&task.id, TransferConflictPolicy::SkipAll)
            .unwrap();

        assert_eq!(
            service.take_conflict_directive(&task.id).unwrap(),
            ConflictDirective::Skip
        );
        let next = service
            .request_conflict(&task.id, "/tmp/remote-directory/b.txt".to_string())
            .unwrap();
        assert!(matches!(next.status, TransferStatus::Running));
        assert!(matches!(
            next.conflict_policy,
            TransferConflictPolicy::SkipAll
        ));
        assert!(next.conflict_path.is_none());
    }

    #[test]
    fn completed_task_with_skipped_items_is_partial() {
        let service = TransferService::default();
        let task = service
            .upload(
                "connection-1".to_string(),
                "local.txt".to_string(),
                "/tmp/remote.txt".to_string(),
            )
            .unwrap();
        service.mark_running(&task.id, Some(10)).unwrap();
        service.set_totals(&task.id, 10, 1).unwrap();
        service.mark_item_skipped(&task.id).unwrap();

        let completed = service.mark_completed(&task.id, 0, Some(10)).unwrap();

        assert!(matches!(completed.status, TransferStatus::Partial));
        assert_eq!(completed.skipped_items, 1);
    }
}
