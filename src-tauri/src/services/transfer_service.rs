use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::domain::file_transfer::{
    TransferConflictPolicy, TransferDirection, TransferProtocol, TransferStatus, TransferTask,
};
use crate::utils::remote_path::normalize_remote_path;
use crate::utils::transfer_progress::progress_percent;

pub const DEFAULT_MAX_RUNNING_TRANSFERS_PER_CONNECTION: usize = 3;

#[derive(Default)]
pub struct TransferService {
    tasks: Mutex<HashMap<String, TransferTask>>,
}

impl TransferService {
    pub fn upload(
        &self,
        connection_id: String,
        local_path: String,
        remote_path: String,
    ) -> Result<TransferTask, String> {
        self.create_task(
            connection_id,
            TransferDirection::Upload,
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
            local_path,
            normalize_remote_path(&remote_path),
        )
    }

    pub fn cancel(&self, transfer_id: &str) -> Result<TransferTask, String> {
        self.set_status(transfer_id, TransferStatus::Cancelled)
    }

    pub fn pause(&self, transfer_id: &str) -> Result<TransferTask, String> {
        self.set_status(transfer_id, TransferStatus::Paused)
    }

    pub fn resume(&self, transfer_id: &str) -> Result<TransferTask, String> {
        self.set_status(transfer_id, TransferStatus::Running)
    }

    pub fn retry(&self, transfer_id: &str) -> Result<TransferTask, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "transfer service lock poisoned".to_string())?;

        let task = tasks
            .get_mut(transfer_id)
            .ok_or_else(|| format!("transfer not found: {transfer_id}"))?;

        task.retry_count = task.retry_count.saturating_add(1);
        task.status = TransferStatus::Pending;
        task.error = None;
        task.transferred_bytes = 0;
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
            TransferStatus::Running | TransferStatus::Paused
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

        if !matches!(task.status, TransferStatus::Paused) {
            task.status = TransferStatus::Running;
        }
        task.transferred_bytes = transferred_bytes;
        task.total_bytes = total_bytes.or(task.total_bytes);
        task.updated_at = now_stamp();

        Ok(task.clone())
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

        task.status = TransferStatus::Completed;
        task.transferred_bytes = transferred_bytes;
        task.total_bytes = total_bytes.or(Some(transferred_bytes));
        task.speed_bytes_per_second = None;
        task.error = None;
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
                        TransferStatus::Running | TransferStatus::Paused
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
                || matches!(task.status, TransferStatus::Cancelled)
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
        let tasks = self
            .tasks
            .lock()
            .map_err(|_| "transfer service lock poisoned".to_string())?
            .values()
            .cloned()
            .collect::<Vec<_>>();

        for task in &tasks {
            let _progress = progress_percent(task.transferred_bytes, task.total_bytes);
        }

        Ok(tasks)
    }

    fn create_task(
        &self,
        connection_id: String,
        direction: TransferDirection,
        local_path: String,
        remote_path: String,
    ) -> Result<TransferTask, String> {
        let now = now_stamp();
        let direction_label = match direction {
            TransferDirection::Upload => "upload",
            TransferDirection::Download => "download",
        };
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "transfer service lock poisoned".to_string())?;
        let sequence = tasks.len() + 1;
        let task = TransferTask {
            id: format!(
                "transfer-{direction_label}-{sequence}-{}",
                now.replace(':', "-")
            ),
            connection_id,
            direction,
            protocol: TransferProtocol::Sftp,
            local_path,
            remote_path,
            status: TransferStatus::Pending,
            conflict_policy: TransferConflictPolicy::Ask,
            retry_count: 0,
            total_bytes: None,
            transferred_bytes: 0,
            speed_bytes_per_second: None,
            error: None,
            created_at: now.clone(),
            updated_at: now,
        };

        tasks.insert(task.id.clone(), task.clone());

        Ok(task)
    }

    fn set_status(
        &self,
        transfer_id: &str,
        status: TransferStatus,
    ) -> Result<TransferTask, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "transfer service lock poisoned".to_string())?;

        let task = tasks
            .get_mut(transfer_id)
            .ok_or_else(|| format!("transfer not found: {transfer_id}"))?;

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
    use super::TransferService;
    use crate::domain::file_transfer::TransferStatus;

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
}
