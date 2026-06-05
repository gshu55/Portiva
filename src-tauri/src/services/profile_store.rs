use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::domain::profile::{ConnectionProfile, ConnectionType, ProfileGroup, RecentConnection};
use crate::utils::{app_paths, clock};

pub struct ProfileStore {
    profiles: Mutex<HashMap<String, ConnectionProfile>>,
    recent: Mutex<Vec<RecentConnection>>,
    profile_path: Option<PathBuf>,
    recent_path: Option<PathBuf>,
}

impl Default for ProfileStore {
    fn default() -> Self {
        Self::with_paths(
            app_paths::profiles_path(),
            app_paths::recent_connections_path(),
        )
    }
}

impl ProfileStore {
    #[cfg(test)]
    pub fn in_memory() -> Self {
        let sample = sample_ssh_profile();
        let mut profiles = HashMap::new();
        profiles.insert(sample.id.clone(), sample);

        Self {
            profiles: Mutex::new(profiles),
            recent: Mutex::new(Vec::new()),
            profile_path: None,
            recent_path: None,
        }
    }

    #[cfg(test)]
    pub fn with_path(path: PathBuf) -> Self {
        let recent_path = path
            .parent()
            .map(|parent| parent.join("recent.json"))
            .unwrap_or_else(app_paths::recent_connections_path);
        Self::with_paths(path, recent_path)
    }

    pub fn with_paths(profile_path: PathBuf, recent_path: PathBuf) -> Self {
        let mut profiles = load_profiles(&profile_path).unwrap_or_default();
        profiles.retain(|_, profile| !is_builtin_sample_ssh_profile(profile));
        let mut recent = load_recent_connections(&recent_path).unwrap_or_default();
        recent.retain(|entry| entry.profile_id != "prod-ssh");

        Self {
            profiles: Mutex::new(profiles),
            recent: Mutex::new(recent),
            profile_path: Some(profile_path),
            recent_path: Some(recent_path),
        }
    }

    pub fn list(&self) -> Result<Vec<ConnectionProfile>, String> {
        let stored = self
            .profiles
            .lock()
            .map_err(|_| "profile store lock poisoned".to_string())?;

        Ok(stored.values().cloned().collect())
    }

    pub fn upsert(&self, profile: ConnectionProfile) -> Result<String, String> {
        validate_profile(&profile)?;

        let id = profile.id.clone();
        self.profiles
            .lock()
            .map_err(|_| "profile store lock poisoned".to_string())?
            .insert(id.clone(), profile);

        self.persist_profiles()?;

        Ok(id)
    }

    pub fn delete(&self, profile_id: &str) -> Result<(), String> {
        self.profiles
            .lock()
            .map_err(|_| "profile store lock poisoned".to_string())?
            .remove(profile_id);
        self.recent
            .lock()
            .map_err(|_| "profile recent lock poisoned".to_string())?
            .retain(|entry| entry.profile_id != profile_id);

        self.persist_profiles()?;
        self.persist_recent()?;

        Ok(())
    }

    pub fn groups(&self) -> Result<Vec<ProfileGroup>, String> {
        let profiles = self.list()?;
        let mut counts: HashMap<String, usize> = HashMap::new();

        for profile in profiles {
            let group_id = profile.group_id.unwrap_or_else(|| "ungrouped".to_string());
            *counts.entry(group_id).or_insert(0) += 1;
        }

        let mut groups = counts
            .into_iter()
            .map(|(id, profile_count)| ProfileGroup {
                name: group_name(&id),
                id,
                profile_count,
            })
            .collect::<Vec<_>>();

        groups.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(groups)
    }

    pub fn recent(&self) -> Result<Vec<RecentConnection>, String> {
        let recent = self
            .recent
            .lock()
            .map_err(|_| "profile recent lock poisoned".to_string())?;

        Ok(recent.clone())
    }

    pub fn mark_recent(&self, profile_id: &str) -> Result<RecentConnection, String> {
        let profile = self
            .list()?
            .into_iter()
            .find(|profile| profile.id == profile_id)
            .ok_or_else(|| format!("profile not found: {profile_id}"))?;
        let title = profile.title();

        let entry = RecentConnection {
            profile_id: profile.id,
            title,
            last_connected_at: clock::now_stamp(),
        };

        let mut recent = self
            .recent
            .lock()
            .map_err(|_| "profile recent lock poisoned".to_string())?;
        recent.retain(|existing| existing.profile_id != entry.profile_id);
        recent.insert(0, entry.clone());
        recent.truncate(10);
        drop(recent);

        self.persist_recent()?;

        Ok(entry)
    }

    fn persist_profiles(&self) -> Result<(), String> {
        let Some(path) = &self.profile_path else {
            return Ok(());
        };

        let profiles = self
            .profiles
            .lock()
            .map_err(|_| "profile store lock poisoned".to_string())?;
        let mut values = profiles.values().cloned().collect::<Vec<_>>();
        values.sort_by(|left, right| left.name.cmp(&right.name));
        write_profiles(path, &values)
    }

    fn persist_recent(&self) -> Result<(), String> {
        let Some(path) = &self.recent_path else {
            return Ok(());
        };

        let recent = self
            .recent
            .lock()
            .map_err(|_| "profile recent lock poisoned".to_string())?;
        write_recent_connections(path, &recent)
    }
}

fn load_profiles(path: &Path) -> Result<HashMap<String, ConnectionProfile>, String> {
    if !path.exists() {
        return Err("profiles file does not exist".to_string());
    }

    let raw =
        fs::read_to_string(path).map_err(|error| format!("failed to read profiles: {error}"))?;
    let profiles: Vec<ConnectionProfile> =
        serde_json::from_str(&raw).map_err(|error| format!("failed to parse profiles: {error}"))?;

    let mut stored = HashMap::new();
    for profile in profiles {
        validate_profile(&profile)?;
        stored.insert(profile.id.clone(), profile);
    }

    Ok(stored)
}

fn write_profiles(path: &Path, profiles: &[ConnectionProfile]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create profile directory: {error}"))?;
    }

    let raw = serde_json::to_string_pretty(profiles)
        .map_err(|error| format!("failed to encode profiles: {error}"))?;
    fs::write(path, raw).map_err(|error| format!("failed to write profiles: {error}"))
}

fn load_recent_connections(path: &Path) -> Result<Vec<RecentConnection>, String> {
    if !path.exists() {
        return Err("recent connections file does not exist".to_string());
    }

    let raw = fs::read_to_string(path)
        .map_err(|error| format!("failed to read recent connections: {error}"))?;
    let mut recent: Vec<RecentConnection> = serde_json::from_str(&raw)
        .map_err(|error| format!("failed to parse recent connections: {error}"))?;
    recent.retain(|entry| !entry.profile_id.trim().is_empty());
    recent.truncate(10);
    Ok(recent)
}

fn write_recent_connections(path: &Path, recent: &[RecentConnection]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create recent connections directory: {error}"))?;
    }

    let raw = serde_json::to_string_pretty(recent)
        .map_err(|error| format!("failed to encode recent connections: {error}"))?;
    fs::write(path, raw).map_err(|error| format!("failed to write recent connections: {error}"))
}

fn group_name(group_id: &str) -> String {
    match group_id {
        "servers" => "Servers".to_string(),
        "devices" => "Devices".to_string(),
        "network" => "Network".to_string(),
        "ungrouped" => "Ungrouped".to_string(),
        value => value.to_string(),
    }
}

fn validate_profile(profile: &ConnectionProfile) -> Result<(), String> {
    if profile.name.trim().is_empty() {
        return Err("profile name is required".to_string());
    }

    match profile.r#type {
        ConnectionType::Ssh
        | ConnectionType::Sftp
        | ConnectionType::Telnet
        | ConnectionType::RawTcp => {
            if profile
                .host
                .as_deref()
                .unwrap_or_default()
                .trim()
                .is_empty()
            {
                return Err("host is required".to_string());
            }

            match profile.port {
                Some(1..=65535) => {}
                _ => return Err("port must be between 1 and 65535".to_string()),
            }

            if matches!(profile.r#type, ConnectionType::Ssh | ConnectionType::Sftp)
                && profile
                    .username
                    .as_deref()
                    .unwrap_or_default()
                    .trim()
                    .is_empty()
            {
                return Err("username is required".to_string());
            }

            if matches!(profile.r#type, ConnectionType::Ssh | ConnectionType::Sftp)
                && profile.auth_type.as_deref() == Some("private-key")
                && profile
                    .private_key_path
                    .as_deref()
                    .unwrap_or_default()
                    .trim()
                    .is_empty()
            {
                return Err("private key path is required".to_string());
            }
        }
        ConnectionType::Serial => {
            if profile
                .port_name
                .as_deref()
                .unwrap_or_default()
                .trim()
                .is_empty()
            {
                return Err("serial port is required".to_string());
            }

            match profile.data_bits.unwrap_or(8) {
                5..=8 => {}
                _ => return Err("serial data bits must be 5, 6, 7, or 8".to_string()),
            }

            match profile.parity.as_deref().unwrap_or("none") {
                "none" | "odd" | "even" => {}
                "mark" | "space" => {
                    return Err("mark/space parity is not supported yet".to_string());
                }
                _ => return Err("unsupported serial parity".to_string()),
            }

            match profile.stop_bits.unwrap_or(1.0) {
                value if (value - 1.0).abs() < f32::EPSILON => {}
                value if (value - 2.0).abs() < f32::EPSILON => {}
                value if (value - 1.5).abs() < f32::EPSILON => {
                    return Err("1.5 serial stop bits are not supported yet".to_string());
                }
                _ => return Err("serial stop bits must be 1 or 2".to_string()),
            }

            match profile.flow_control.as_deref().unwrap_or("none") {
                "none" | "software" | "hardware" => {}
                _ => return Err("unsupported serial flow control".to_string()),
            }

            match profile.encoding.as_deref().unwrap_or("utf-8") {
                "ascii" | "utf-8" | "gbk" | "big5" | "shift-jis" | "euc-kr" | "utf-16le"
                | "utf-16be" | "latin1" => {}
                _ => return Err("unsupported serial encoding".to_string()),
            }

            match profile.line_ending.as_deref().unwrap_or("crlf") {
                "crlf" | "cr" | "lf" => {}
                _ => return Err("unsupported serial line ending".to_string()),
            }
        }
    }

    Ok(())
}

#[cfg(test)]
fn sample_ssh_profile() -> ConnectionProfile {
    let now = "2026-05-11T08:00:00.000Z".to_string();

    ConnectionProfile {
        id: "prod-ssh".to_string(),
        name: "Production SSH".to_string(),
        group_id: Some("servers".to_string()),
        r#type: ConnectionType::Ssh,
        tags: Some(vec!["prod".to_string(), "ssh".to_string()]),
        host: Some("10.24.1.18".to_string()),
        port: Some(22),
        username: Some("deploy".to_string()),
        auth_type: Some("password".to_string()),
        private_key_path: None,
        port_name: None,
        baud_rate: None,
        data_bits: None,
        parity: None,
        stop_bits: None,
        flow_control: None,
        line_ending: None,
        encoding: None,
        dtr: None,
        rts: None,
        created_at: now.clone(),
        updated_at: now,
    }
}

fn is_builtin_sample_ssh_profile(profile: &ConnectionProfile) -> bool {
    profile.id == "prod-ssh"
        && profile.r#type == ConnectionType::Ssh
        && profile.host.as_deref() == Some("10.24.1.18")
        && profile.port == Some(22)
        && profile.username.as_deref() == Some("deploy")
}

#[cfg(test)]
mod tests {
    use super::ProfileStore;
    use crate::domain::profile::ConnectionType;
    use std::path::PathBuf;

    #[test]
    fn exposes_default_groups() {
        let store = ProfileStore::in_memory();
        let groups = store.groups().unwrap();

        assert_eq!(groups[0].id, "servers");
        assert_eq!(groups[0].profile_count, 1);
    }

    #[test]
    fn marks_profile_as_recent() {
        let store = ProfileStore::in_memory();
        let recent = store.mark_recent("prod-ssh").unwrap();

        assert_eq!(recent.profile_id, "prod-ssh");
        assert_eq!(store.recent().unwrap()[0].profile_id, "prod-ssh");
        assert!(recent.last_connected_at.starts_with("unix:"));
    }

    #[test]
    fn default_profile_can_be_deleted() {
        let store = ProfileStore::in_memory();

        store.delete("prod-ssh").unwrap();

        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn validates_ssh_username_and_port() {
        let store = ProfileStore::in_memory();
        let mut profile = store.list().unwrap().remove(0);
        profile.id = "invalid".to_string();
        profile.username = Some(" ".to_string());

        assert_eq!(store.upsert(profile).unwrap_err(), "username is required");

        let mut profile = super::sample_ssh_profile();
        profile.id = "invalid-port".to_string();
        profile.port = Some(0);

        assert_eq!(
            store.upsert(profile).unwrap_err(),
            "port must be between 1 and 65535"
        );
    }

    #[test]
    fn validates_tcp_protocol_port() {
        let store = ProfileStore::in_memory();
        let mut profile = super::sample_ssh_profile();
        profile.id = "raw".to_string();
        profile.r#type = ConnectionType::RawTcp;
        profile.username = None;
        profile.port = None;

        assert_eq!(
            store.upsert(profile).unwrap_err(),
            "port must be between 1 and 65535"
        );
    }

    #[test]
    fn validates_serial_runtime_options() {
        let store = ProfileStore::in_memory();
        let mut profile = super::sample_ssh_profile();
        profile.id = "serial".to_string();
        profile.r#type = ConnectionType::Serial;
        profile.host = None;
        profile.port = None;
        profile.username = None;
        profile.auth_type = None;
        profile.port_name = Some("COM3".to_string());
        profile.baud_rate = Some(115_200);
        profile.data_bits = Some(8);
        profile.parity = Some("mark".to_string());

        assert_eq!(
            store.upsert(profile.clone()).unwrap_err(),
            "mark/space parity is not supported yet"
        );

        profile.parity = Some("none".to_string());
        profile.stop_bits = Some(1.5);
        assert_eq!(
            store.upsert(profile.clone()).unwrap_err(),
            "1.5 serial stop bits are not supported yet"
        );

        profile.stop_bits = Some(1.0);
        profile.encoding = Some("unknown".to_string());
        assert_eq!(
            store.upsert(profile).unwrap_err(),
            "unsupported serial encoding"
        );
    }

    #[test]
    fn persists_profiles_to_config_file() {
        let path = test_path("profiles-persist.json");
        let _ = std::fs::remove_file(&path);

        let store = ProfileStore::with_path(path.clone());
        let mut profile = super::sample_ssh_profile();
        profile.id = "persisted".to_string();
        profile.name = "Persisted".to_string();

        store.upsert(profile).unwrap();

        let reloaded = ProfileStore::with_path(path.clone());
        assert!(reloaded
            .list()
            .unwrap()
            .iter()
            .any(|profile| profile.id == "persisted"));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn persists_recent_connections_to_config_file() {
        let profile_path = test_path("profiles-with-recent.json");
        let recent_path = test_path("recent-persist.json");
        let _ = std::fs::remove_file(&profile_path);
        let _ = std::fs::remove_file(&recent_path);

        let store = ProfileStore::with_paths(profile_path.clone(), recent_path.clone());
        let mut profile = super::sample_ssh_profile();
        profile.id = "recent-profile".to_string();
        profile.name = "Recent Profile".to_string();
        store.upsert(profile).unwrap();
        store.mark_recent("recent-profile").unwrap();

        let reloaded = ProfileStore::with_paths(profile_path.clone(), recent_path.clone());
        let recent = reloaded.recent().unwrap();

        assert_eq!(recent[0].profile_id, "recent-profile");
        assert!(recent[0].last_connected_at.starts_with("unix:"));

        let _ = std::fs::remove_file(profile_path);
        let _ = std::fs::remove_file(recent_path);
    }

    #[test]
    fn deleting_profile_removes_recent_entry() {
        let store = ProfileStore::in_memory();
        store.mark_recent("prod-ssh").unwrap();

        store.delete("prod-ssh").unwrap();

        assert!(store.recent().unwrap().is_empty());
    }

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("portiva-{name}-{}", std::process::id()))
    }
}
