use std::collections::HashMap;
use std::sync::Mutex;

use crate::domain::file_transfer::{FileTransferSession, TransferProtocol};

#[derive(Default)]
pub struct FileTransferService {
    sessions: Mutex<HashMap<String, FileTransferSession>>,
    next_sequence: Mutex<u64>,
}

impl FileTransferService {
    pub fn open(&self, connection_id: String) -> Result<FileTransferSession, String> {
        let mut next_sequence = self
            .next_sequence
            .lock()
            .map_err(|_| "file transfer sequence lock poisoned".to_string())?;
        *next_sequence = next_sequence.saturating_add(1);

        let session = FileTransferSession {
            id: format!("transfer-{connection_id}-{}", *next_sequence),
            connection_id,
            protocol: TransferProtocol::Sftp,
        };

        self.sessions
            .lock()
            .map_err(|_| "file transfer service lock poisoned".to_string())?
            .insert(session.id.clone(), session.clone());
        Ok(session)
    }

    pub fn session(&self, session_id: &str) -> Result<FileTransferSession, String> {
        self.require_session(session_id)
    }

    pub fn close(&self, session_id: &str) -> Result<bool, String> {
        let removed = self
            .sessions
            .lock()
            .map_err(|_| "file transfer service lock poisoned".to_string())?
            .remove(session_id)
            .is_some();

        Ok(removed)
    }

    pub fn close_by_connection(&self, connection_id: &str) -> Result<usize, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "file transfer service lock poisoned".to_string())?;
        let session_ids = sessions
            .values()
            .filter(|session| session.connection_id == connection_id)
            .map(|session| session.id.clone())
            .collect::<Vec<_>>();

        for session_id in &session_ids {
            sessions.remove(session_id);
        }
        Ok(session_ids.len())
    }

    fn require_session(&self, session_id: &str) -> Result<FileTransferSession, String> {
        self.sessions
            .lock()
            .map_err(|_| "file transfer service lock poisoned".to_string())?
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("file transfer session not found: {session_id}"))
    }
}

#[cfg(test)]
mod tests {
    use super::FileTransferService;

    #[test]
    fn opens_and_reads_session() {
        let service = FileTransferService::default();
        let session = service.open("connection-1".to_string()).unwrap();

        assert_eq!(
            service.session(&session.id).unwrap().connection_id,
            "connection-1"
        );
    }

    #[test]
    fn close_by_connection_removes_only_matching_sessions() {
        let service = FileTransferService::default();
        let closed_session = service.open("connection-1".to_string()).unwrap();
        let kept_session = service.open("connection-2".to_string()).unwrap();
        assert_eq!(service.close_by_connection("connection-1").unwrap(), 1);
        assert!(service.session(&closed_session.id).is_err());
        assert!(service.session(&kept_session.id).is_ok());
    }

    #[test]
    fn close_removes_single_session() {
        let service = FileTransferService::default();
        let closed_session = service.open("connection-1".to_string()).unwrap();
        let kept_session = service.open("connection-1".to_string()).unwrap();

        assert!(service.close(&closed_session.id).unwrap());
        assert!(!service.close(&closed_session.id).unwrap());
        assert!(service.session(&closed_session.id).is_err());
        assert!(service.session(&kept_session.id).is_ok());
    }
}
