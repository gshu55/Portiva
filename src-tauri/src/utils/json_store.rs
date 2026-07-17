use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::de::DeserializeOwned;
use serde::Serialize;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn load_json<T: DeserializeOwned>(path: &Path, label: &str) -> Result<Option<T>, String> {
    if path.exists() {
        match read_json(path, label) {
            Ok(value) => return Ok(Some(value)),
            Err(primary_error) => {
                let backup = backup_path(path);
                if backup.exists() {
                    match read_json(&backup, label) {
                        Ok(value) => {
                            eprintln!(
                                "{label} primary file is invalid; recovered previous data from {}: {primary_error}",
                                backup.display()
                            );
                            return Ok(Some(value));
                        }
                        Err(backup_error) => {
                            return Err(format!(
                                "{primary_error}; backup recovery failed: {backup_error}"
                            ));
                        }
                    }
                }
                return Err(primary_error);
            }
        }
    }

    let backup = backup_path(path);
    if backup.exists() {
        let value = read_json(&backup, label)?;
        eprintln!(
            "{label} primary file is missing; recovered previous data from {}",
            backup.display()
        );
        return Ok(Some(value));
    }

    Ok(None)
}

pub fn write_json<T: Serialize + ?Sized>(
    path: &Path,
    value: &T,
    label: &str,
) -> Result<(), String> {
    let raw = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("failed to encode {label}: {error}"))?;
    write_bytes(path, &raw, label)
}

fn read_json<T: DeserializeOwned>(path: &Path, label: &str) -> Result<T, String> {
    let raw = fs::read(path)
        .map_err(|error| format!("failed to read {label} {}: {error}", path.display()))?;
    serde_json::from_slice(&raw)
        .map_err(|error| format!("failed to parse {label} {}: {error}", path.display()))
}

fn write_bytes(path: &Path, value: &[u8], label: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {label} directory: {error}"))?;
    }

    if path.exists() {
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| format!("failed to inspect {label}: {error}"))?;
        if !metadata.file_type().is_file() {
            return Err(format!(
                "refusing to replace non-file {label}: {}",
                path.display()
            ));
        }
    }

    let temporary = temporary_path(path);
    let mut temporary_file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("failed to create temporary {label}: {error}"))?;

    let write_result = (|| {
        temporary_file
            .write_all(value)
            .map_err(|error| format!("failed to write temporary {label}: {error}"))?;
        temporary_file
            .flush()
            .map_err(|error| format!("failed to flush temporary {label}: {error}"))?;
        temporary_file
            .sync_all()
            .map_err(|error| format!("failed to sync temporary {label}: {error}"))
    })();
    drop(temporary_file);

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }

    let backup = backup_path(path);
    let had_primary = path.exists();
    if had_primary {
        if backup.exists() {
            fs::remove_file(&backup)
                .map_err(|error| format!("failed to replace {label} backup: {error}"))?;
        }
        if let Err(error) = fs::rename(path, &backup) {
            let _ = fs::remove_file(&temporary);
            return Err(format!("failed to prepare {label} backup: {error}"));
        }
    }

    if let Err(error) = fs::rename(&temporary, path) {
        if had_primary {
            let _ = fs::rename(&backup, path);
        }
        let _ = fs::remove_file(&temporary);
        return Err(format!("failed to commit {label}: {error}"));
    }

    sync_parent(path);
    Ok(())
}

fn backup_path(path: &Path) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(".bak");
    PathBuf::from(value)
}

fn temporary_path(path: &Path) -> PathBuf {
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1;
    let mut value = path.as_os_str().to_os_string();
    value.push(format!(".tmp-{}-{sequence}", std::process::id()));
    PathBuf::from(value)
}

#[cfg(unix)]
fn sync_parent(path: &Path) {
    if let Some(parent) = path.parent() {
        let _ = File::open(parent).and_then(|directory| directory.sync_all());
    }
}

#[cfg(not(unix))]
fn sync_parent(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::{backup_path, load_json, write_json};

    #[test]
    fn keeps_previous_version_as_recovery_backup() {
        let path = test_path("atomic-json.json");
        cleanup(&path);

        write_json(&path, &vec![1_u8], "test json").unwrap();
        write_json(&path, &vec![2_u8], "test json").unwrap();
        std::fs::write(&path, b"not-json").unwrap();

        let recovered: Vec<u8> = load_json(&path, "test json").unwrap().unwrap();
        assert_eq!(recovered, vec![1]);

        cleanup(&path);
    }

    #[test]
    fn returns_none_when_primary_and_backup_are_missing() {
        let path = test_path("missing-json.json");
        cleanup(&path);

        assert!(load_json::<Vec<u8>>(&path, "test json").unwrap().is_none());
    }

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("portiva-{name}-{}", std::process::id()))
    }

    fn cleanup(path: &Path) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(backup_path(path));
    }

    use std::path::{Path, PathBuf};
}
