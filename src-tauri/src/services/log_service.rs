use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::domain::logging::{LogEntry, LogLevel};
use crate::security::redaction;
use crate::utils::{app_paths, clock, json_store};

pub struct LogService {
    entries: Mutex<Vec<LogEntry>>,
    path: Option<PathBuf>,
}

impl Default for LogService {
    fn default() -> Self {
        Self::with_path(app_paths::logs_path())
    }
}

impl LogService {
    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self {
            entries: Mutex::new(Vec::new()),
            path: None,
        }
    }

    pub fn with_path(path: PathBuf) -> Self {
        let entries = load_logs(&path).unwrap_or_else(|error| {
            eprintln!("failed to load logs; using an empty log: {error}");
            Vec::new()
        });
        Self {
            entries: Mutex::new(entries),
            path: Some(path),
        }
    }

    pub fn record(
        &self,
        level: LogLevel,
        target: impl Into<String>,
        message: impl Into<String>,
    ) -> Result<LogEntry, String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "log service lock poisoned".to_string())?;

        let entry = LogEntry {
            id: format!("log-{}", next_log_sequence(&entries)),
            level,
            target: target.into(),
            message: redaction::redact(&message.into()),
            created_at: clock::now_stamp(),
        };

        let mut next_entries = entries.clone();
        next_entries.push(entry.clone());
        if next_entries.len() > 500 {
            let excess = next_entries.len() - 500;
            next_entries.drain(0..excess);
        }

        self.persist(&next_entries)?;
        *entries = next_entries;

        Ok(entry)
    }

    pub fn list(&self) -> Result<Vec<LogEntry>, String> {
        let entries = self
            .entries
            .lock()
            .map_err(|_| "log service lock poisoned".to_string())?;

        Ok(entries.clone())
    }

    pub fn clear(&self) -> Result<(), String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "log service lock poisoned".to_string())?;
        self.persist(&[])?;
        entries.clear();
        Ok(())
    }

    fn persist(&self, entries: &[LogEntry]) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Ok(());
        };

        write_logs(path, entries)
    }
}

fn load_logs(path: &Path) -> Result<Vec<LogEntry>, String> {
    let mut entries: Vec<LogEntry> = json_store::load_json(path, "logs")?.unwrap_or_default();
    entries.retain(|entry| !entry.id.trim().is_empty());
    if entries.len() > 500 {
        let excess = entries.len() - 500;
        entries.drain(0..excess);
    }
    Ok(entries)
}

fn write_logs(path: &Path, entries: &[LogEntry]) -> Result<(), String> {
    json_store::write_json(path, entries, "logs")
}

fn next_log_sequence(entries: &[LogEntry]) -> u64 {
    entries
        .iter()
        .filter_map(|entry| entry.id.strip_prefix("log-")?.parse::<u64>().ok())
        .max()
        .unwrap_or_default()
        .saturating_add(1)
}

#[cfg(test)]
mod tests {
    use super::LogService;
    use crate::domain::logging::LogLevel;
    use std::path::PathBuf;

    #[test]
    fn redacts_sensitive_log_messages() {
        let service = LogService::in_memory();
        let entry = service
            .record(LogLevel::Info, "auth", "password=hunter2")
            .unwrap();

        assert_eq!(entry.message, "[REDACTED]");
    }

    #[test]
    fn returns_empty_entries_when_empty() {
        let service = LogService::in_memory();

        assert!(service.list().unwrap().is_empty());
    }

    #[test]
    fn persists_redacted_logs_to_config_file() {
        let path = test_path("logs-persist.json");
        let _ = std::fs::remove_file(&path);

        let service = LogService::with_path(path.clone());
        service
            .record(LogLevel::Warn, "auth", "token=abc123")
            .unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("[REDACTED]"));
        assert!(!raw.contains("abc123"));

        let reloaded = LogService::with_path(path.clone());
        assert_eq!(reloaded.list().unwrap().len(), 1);

        let _ = std::fs::remove_file(path);
    }

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("portiva-{name}-{}", std::process::id()))
    }
}
