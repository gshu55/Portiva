use std::fs::{self, File, OpenOptions, TryLockError};
use std::io;
use std::path::Path;

use tauri::{Manager, Resource, Runtime};

use crate::utils::app_paths;

struct InstanceGuard {
    _file: File,
}

impl Resource for InstanceGuard {}

fn try_acquire(path: &Path) -> io::Result<Option<InstanceGuard>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(InstanceGuard { _file: file })),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

#[cfg_attr(test, allow(dead_code))]
pub fn acquire_or_exit<R: Runtime>(app: &tauri::App<R>) -> io::Result<()> {
    let path = app_paths::portiva_config_dir().join("instance.lock");
    let Some(guard) = try_acquire(&path)? else {
        // Avoid dropping a secondary macOS plugin instance, which could remove
        // the primary instance's socket during an overlapping startup.
        std::process::exit(0);
    };
    // Tauri releases resources immediately before exit or restart.
    app.resources_table().add(guard);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::try_acquire;
    use std::path::Path;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn lock_excludes_other_process_and_is_released_on_drop() {
        const PATH_ENV: &str = "PORTIVA_TEST_INSTANCE_LOCK_PATH";
        const EXPECT_LOCK_ENV: &str = "PORTIVA_TEST_INSTANCE_LOCK_EXPECTED";
        if let Some(path) = std::env::var_os(PATH_ENV) {
            let acquired = try_acquire(Path::new(&path)).unwrap().is_some();
            assert_eq!(acquired, std::env::var(EXPECT_LOCK_ENV).unwrap() == "yes");
            return;
        }

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "portiva-instance-lock-{}-{unique}",
            std::process::id()
        ));

        let first = try_acquire(&path).unwrap().expect("first lock");
        let mut resources = tauri::ResourceTable::default();
        resources.add(first);
        let check_child = |expect_lock: bool| {
            let result = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "single_instance_guard::tests::lock_excludes_other_process_and_is_released_on_drop",
                ])
                .env(PATH_ENV, &path)
                .env(EXPECT_LOCK_ENV, if expect_lock { "yes" } else { "no" })
                .output()
                .unwrap();
            assert!(
                result.status.success()
                    && String::from_utf8_lossy(&result.stdout).contains("1 passed"),
                "child test failed: {}{}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            );
        };
        check_child(false);
        drop(resources);
        check_child(true);
        std::fs::remove_file(path).unwrap();
    }
}
