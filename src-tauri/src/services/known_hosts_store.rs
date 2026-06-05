use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::domain::secret::KnownHostEntry;
use crate::security::fingerprint::{fingerprint_matches, normalize_fingerprint};
use crate::utils::app_paths;

pub struct KnownHostsStore {
    fingerprints: Mutex<HashMap<String, String>>,
    path: Option<PathBuf>,
}

impl Default for KnownHostsStore {
    fn default() -> Self {
        Self::with_path(app_paths::known_hosts_path())
    }
}

impl KnownHostsStore {
    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self {
            fingerprints: Mutex::new(HashMap::new()),
            path: None,
        }
    }

    pub fn with_path(path: PathBuf) -> Self {
        Self {
            fingerprints: Mutex::new(load_known_hosts(&path).unwrap_or_default()),
            path: Some(path),
        }
    }

    pub fn verify_host_key(
        &self,
        host: &str,
        fingerprint: &str,
    ) -> Result<KnownHostDecision, String> {
        let host = normalize_host(host)?;
        let fingerprint = normalize_fingerprint(fingerprint);
        let known = self
            .fingerprints
            .lock()
            .map_err(|_| "known_hosts store lock poisoned".to_string())?;

        match known.get(&host) {
            Some(existing) if fingerprint_matches(existing, &fingerprint) => {
                Ok(KnownHostDecision::Trusted)
            }
            Some(_) => Ok(KnownHostDecision::Changed),
            None => Ok(KnownHostDecision::Unknown),
        }
    }

    pub fn trust_host_key(&self, host: &str, fingerprint: &str) -> Result<(), String> {
        let host = normalize_host(host)?;
        self.fingerprints
            .lock()
            .map_err(|_| "known_hosts store lock poisoned".to_string())?
            .insert(host, normalize_fingerprint(fingerprint));

        self.persist()?;

        Ok(())
    }

    pub fn delete(&self, host: &str) -> Result<(), String> {
        let host = normalize_host(host)?;
        self.fingerprints
            .lock()
            .map_err(|_| "known_hosts store lock poisoned".to_string())?
            .remove(&host);

        self.persist()
    }

    pub fn list(&self) -> Result<Vec<KnownHostEntry>, String> {
        let mut entries = self
            .fingerprints
            .lock()
            .map_err(|_| "known_hosts store lock poisoned".to_string())?
            .iter()
            .map(|(host, fingerprint)| KnownHostEntry {
                host: host.clone(),
                fingerprint: fingerprint.clone(),
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| left.host.cmp(&right.host));
        Ok(entries)
    }

    fn persist(&self) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Ok(());
        };

        let fingerprints = self
            .fingerprints
            .lock()
            .map_err(|_| "known_hosts store lock poisoned".to_string())?;
        let mut entries = fingerprints
            .iter()
            .map(|(host, fingerprint)| KnownHostEntry {
                host: host.clone(),
                fingerprint: fingerprint.clone(),
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| left.host.cmp(&right.host));
        write_known_hosts(path, &entries)
    }
}

pub enum KnownHostDecision {
    Trusted,
    Unknown,
    Changed,
}

fn normalize_host(host: &str) -> Result<String, String> {
    let host = host.trim().to_ascii_lowercase();

    if host.is_empty() {
        return Err("known host is required".to_string());
    }

    Ok(host)
}

fn load_known_hosts(path: &Path) -> Result<HashMap<String, String>, String> {
    if !path.exists() {
        return Err("known_hosts file does not exist".to_string());
    }

    let raw =
        fs::read_to_string(path).map_err(|error| format!("failed to read known_hosts: {error}"))?;
    let entries: Vec<KnownHostEntry> = serde_json::from_str(&raw)
        .map_err(|error| format!("failed to parse known_hosts: {error}"))?;

    let mut known = HashMap::new();
    for entry in entries {
        known.insert(
            normalize_host(&entry.host)?,
            normalize_fingerprint(&entry.fingerprint),
        );
    }

    Ok(known)
}

fn write_known_hosts(path: &Path, entries: &[KnownHostEntry]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create known_hosts directory: {error}"))?;
    }

    let raw = serde_json::to_string_pretty(entries)
        .map_err(|error| format!("failed to encode known_hosts: {error}"))?;
    fs::write(path, raw).map_err(|error| format!("failed to write known_hosts: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{KnownHostDecision, KnownHostsStore};
    use std::path::PathBuf;

    #[test]
    fn unknown_host_requires_confirmation() {
        let store = KnownHostsStore::in_memory();

        assert!(matches!(
            store.verify_host_key("example.com", "SHA256:aa").unwrap(),
            KnownHostDecision::Unknown
        ));
    }

    #[test]
    fn trusted_host_matches_normalized_fingerprint() {
        let store = KnownHostsStore::in_memory();
        store.trust_host_key("example.com", "SHA256:AA:BB").unwrap();

        assert!(matches!(
            store.verify_host_key("example.com", "aabb").unwrap(),
            KnownHostDecision::Trusted
        ));
    }

    #[test]
    fn changed_host_key_is_detected() {
        let store = KnownHostsStore::in_memory();
        store.trust_host_key("example.com", "SHA256:aa").unwrap();

        assert!(matches!(
            store.verify_host_key("example.com", "SHA256:bb").unwrap(),
            KnownHostDecision::Changed
        ));
    }

    #[test]
    fn lists_trusted_hosts() {
        let store = KnownHostsStore::in_memory();
        store.trust_host_key("example.com", "SHA256:aa").unwrap();

        assert_eq!(store.list().unwrap()[0].host, "example.com");
    }

    #[test]
    fn persists_known_hosts_to_config_file() {
        let path = test_path("known-hosts-persist.json");
        let _ = std::fs::remove_file(&path);

        let store = KnownHostsStore::with_path(path.clone());
        store.trust_host_key("Example.COM", "SHA256:AA:BB").unwrap();

        let reloaded = KnownHostsStore::with_path(path.clone());
        assert!(matches!(
            reloaded.verify_host_key("example.com", "aabb").unwrap(),
            KnownHostDecision::Trusted
        ));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rejects_empty_known_host() {
        let store = KnownHostsStore::in_memory();

        assert_eq!(
            store.trust_host_key(" ", "SHA256:aa").unwrap_err(),
            "known host is required"
        );
    }

    #[test]
    fn deletes_known_host() {
        let store = KnownHostsStore::in_memory();
        store.trust_host_key("example.com", "SHA256:aa").unwrap();

        store.delete("example.com").unwrap();

        assert!(matches!(
            store.verify_host_key("example.com", "SHA256:aa").unwrap(),
            KnownHostDecision::Unknown
        ));
    }

    #[test]
    fn delete_updates_persisted_known_hosts() {
        let path = test_path("known-hosts-delete.json");
        let _ = std::fs::remove_file(&path);

        let store = KnownHostsStore::with_path(path.clone());
        store.trust_host_key("example.com", "SHA256:aa").unwrap();
        store.delete("example.com").unwrap();

        let reloaded = KnownHostsStore::with_path(path.clone());
        assert!(reloaded.list().unwrap().is_empty());

        let _ = std::fs::remove_file(path);
    }

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("portiva-{name}-{}", std::process::id()))
    }
}
