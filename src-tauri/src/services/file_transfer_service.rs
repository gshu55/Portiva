use std::collections::HashMap;
use std::sync::Mutex;

use crate::domain::file_transfer::{
    FileTransferSession, RemoteEntry, RemoteEntryKind, TransferProtocol,
};
use crate::utils::clock;
use crate::utils::remote_path::{join_remote_path, normalize_remote_path};

#[derive(Default)]
pub struct FileTransferService {
    sessions: Mutex<HashMap<String, FileTransferSession>>,
    entries: Mutex<HashMap<String, Vec<RemoteEntry>>>,
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
        self.entries
            .lock()
            .map_err(|_| "file transfer entries lock poisoned".to_string())?
            .entry(session.id.clone())
            .or_insert_with(|| sample_remote_entries("/"));

        Ok(session)
    }

    pub fn list_dir(
        &self,
        session_id: &str,
        remote_path: &str,
    ) -> Result<Vec<RemoteEntry>, String> {
        self.require_session(session_id)?;
        // TODO: replace session-scoped directory state with FileTransferConnection::list_dir.
        let remote_path = normalize_remote_path(remote_path);
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "file transfer entries lock poisoned".to_string())?
            .get(session_id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|entry| parent_path(&entry.path) == remote_path)
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| {
            entry_kind_rank(&left.kind)
                .cmp(&entry_kind_rank(&right.kind))
                .then_with(|| left.name.cmp(&right.name))
        });
        Ok(entries)
    }

    pub fn mkdir(&self, session_id: &str, remote_path: &str) -> Result<(), String> {
        self.require_session(session_id)?;
        // TODO: call FileTransferConnection::mkdir(remote_path).
        let path = normalize_remote_path(remote_path);
        let name = entry_name(&path)?;
        let mut entries_by_session = self
            .entries
            .lock()
            .map_err(|_| "file transfer entries lock poisoned".to_string())?;
        let entries = entries_by_session
            .entry(session_id.to_string())
            .or_default();

        if entries.iter().any(|entry| entry.path == path) {
            return Err(format!("remote entry already exists: {path}"));
        }

        entries.push(RemoteEntry {
            name,
            path,
            kind: RemoteEntryKind::Directory,
            size: 0,
            modified_at: Some(clock::now_stamp()),
            permissions: Some("drwxr-xr-x".to_string()),
            owner: None,
            group: None,
        });

        Ok(())
    }

    pub fn remove(&self, session_id: &str, remote_path: &str) -> Result<(), String> {
        self.require_session(session_id)?;
        // TODO: call FileTransferConnection::remove(remote_path).
        let path = normalize_remote_path(remote_path);
        let prefix = format!("{path}/");
        let mut entries_by_session = self
            .entries
            .lock()
            .map_err(|_| "file transfer entries lock poisoned".to_string())?;
        let entries = entries_by_session
            .entry(session_id.to_string())
            .or_default();
        let before = entries.len();
        entries.retain(|entry| entry.path != path && !entry.path.starts_with(&prefix));

        if entries.len() == before {
            return Err(format!("remote entry not found: {path}"));
        }

        Ok(())
    }

    pub fn rename(&self, session_id: &str, from: &str, to: &str) -> Result<(), String> {
        self.require_session(session_id)?;
        // TODO: call FileTransferConnection::rename(from, to).
        let from = normalize_remote_path(from);
        let to = normalize_remote_path(to);
        let to_name = entry_name(&to)?;
        let from_prefix = format!("{from}/");
        let to_prefix = format!("{to}/");
        let mut entries_by_session = self
            .entries
            .lock()
            .map_err(|_| "file transfer entries lock poisoned".to_string())?;
        let entries = entries_by_session
            .entry(session_id.to_string())
            .or_default();

        if entries.iter().any(|entry| entry.path == to) {
            return Err(format!("remote entry already exists: {to}"));
        }

        let mut renamed = false;
        for entry in entries.iter_mut() {
            if entry.path == from {
                entry.path = to.clone();
                entry.name = to_name.clone();
                entry.modified_at = Some(clock::now_stamp());
                renamed = true;
            } else if entry.path.starts_with(&from_prefix) {
                entry.path = entry.path.replacen(&from_prefix, &to_prefix, 1);
                entry.modified_at = Some(clock::now_stamp());
            }
        }

        if !renamed {
            return Err(format!("remote entry not found: {from}"));
        }

        Ok(())
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

        self.entries
            .lock()
            .map_err(|_| "file transfer entries lock poisoned".to_string())?
            .remove(session_id);

        Ok(removed)
    }

    pub fn close_by_connection(&self, connection_id: &str) -> Result<usize, String> {
        // TODO: close protocol handles before removing file transfer sessions.
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
        drop(sessions);

        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "file transfer entries lock poisoned".to_string())?;
        for session_id in &session_ids {
            entries.remove(session_id);
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

fn parent_path(path: &str) -> String {
    let path = normalize_remote_path(path);

    if path == "." || path == "/" {
        return ".".to_string();
    }

    match path.rsplit_once('/') {
        Some(("", _)) => "/".to_string(),
        Some((parent, _)) if !parent.is_empty() => parent.to_string(),
        _ => ".".to_string(),
    }
}

fn entry_name(path: &str) -> Result<String, String> {
    let path = normalize_remote_path(path);
    let name = path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .trim();

    if name.is_empty() || name == "." {
        return Err("remote entry name is required".to_string());
    }

    Ok(name.to_string())
}

fn entry_kind_rank(kind: &RemoteEntryKind) -> u8 {
    match kind {
        RemoteEntryKind::Directory => 0,
        RemoteEntryKind::File => 1,
        RemoteEntryKind::Symlink => 2,
        RemoteEntryKind::Other => 3,
    }
}

fn sample_remote_entries(remote_path: &str) -> Vec<RemoteEntry> {
    vec![
        RemoteEntry {
            name: "releases".to_string(),
            path: join_remote_path(remote_path, "releases"),
            kind: RemoteEntryKind::Directory,
            size: 0,
            modified_at: None,
            permissions: Some("drwxr-xr-x".to_string()),
            owner: None,
            group: None,
        },
        RemoteEntry {
            name: "deploy.log".to_string(),
            path: join_remote_path(remote_path, "deploy.log"),
            kind: RemoteEntryKind::File,
            size: 4096,
            modified_at: None,
            permissions: Some("-rw-r--r--".to_string()),
            owner: None,
            group: None,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::FileTransferService;

    #[test]
    fn mkdir_updates_session_listing() {
        let service = FileTransferService::default();
        let session = service.open("connection-1".to_string()).unwrap();

        service.mkdir(&session.id, "/releases/next").unwrap();

        let entries = service.list_dir(&session.id, "/releases").unwrap();
        assert!(entries.iter().any(|entry| entry.name == "next"));
    }

    #[test]
    fn rename_updates_entry_and_descendant_paths() {
        let service = FileTransferService::default();
        let session = service.open("connection-1".to_string()).unwrap();
        service.mkdir(&session.id, "/releases/next").unwrap();

        service
            .rename(&session.id, "/releases", "/archive")
            .unwrap();

        let root_entries = service.list_dir(&session.id, "/").unwrap();
        let archive_entries = service.list_dir(&session.id, "/archive").unwrap();

        assert!(root_entries.iter().any(|entry| entry.name == "archive"));
        assert!(archive_entries.iter().any(|entry| entry.name == "next"));
    }

    #[test]
    fn remove_updates_entry_and_descendants() {
        let service = FileTransferService::default();
        let session = service.open("connection-1".to_string()).unwrap();
        service.mkdir(&session.id, "/releases/next").unwrap();

        service.remove(&session.id, "/releases").unwrap();

        assert!(service
            .list_dir(&session.id, "/")
            .unwrap()
            .iter()
            .all(|entry| entry.name != "releases"));
        assert!(service
            .list_dir(&session.id, "/releases")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn close_by_connection_removes_sessions_and_directory_state() {
        let service = FileTransferService::default();
        let closed_session = service.open("connection-1".to_string()).unwrap();
        let kept_session = service.open("connection-2".to_string()).unwrap();
        service.mkdir(&closed_session.id, "/releases/next").unwrap();

        assert_eq!(service.close_by_connection("connection-1").unwrap(), 1);
        assert!(service.session(&closed_session.id).is_err());
        assert!(service.list_dir(&closed_session.id, "/").is_err());
        assert!(service.session(&kept_session.id).is_ok());
        assert!(!service.list_dir(&kept_session.id, "/").unwrap().is_empty());
    }

    #[test]
    fn close_removes_single_session_and_directory_state() {
        let service = FileTransferService::default();
        let closed_session = service.open("connection-1".to_string()).unwrap();
        let kept_session = service.open("connection-1".to_string()).unwrap();

        service.mkdir(&closed_session.id, "/scratch").unwrap();

        assert!(service.close(&closed_session.id).unwrap());
        assert!(!service.close(&closed_session.id).unwrap());
        assert!(service.session(&closed_session.id).is_err());
        assert!(service.list_dir(&closed_session.id, "/").is_err());
        assert!(service.session(&kept_session.id).is_ok());
    }
}
