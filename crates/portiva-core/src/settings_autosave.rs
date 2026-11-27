use crate::{Settings, Store};
use anyhow::Result;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{runtime::Handle, task::JoinHandle};

/// Coalesces edits and serializes writes independently of any settings editor's lifetime.
#[derive(Clone)]
pub struct SettingsAutosave {
    store: Arc<Store>,
    state: Arc<Mutex<Pending>>,
}

#[derive(Default)]
struct Pending {
    settings: Option<Settings>,
    running: bool,
}

impl SettingsAutosave {
    pub fn new(store: Arc<Store>) -> Self {
        Self {
            store,
            state: Arc::default(),
        }
    }

    /// Only the first edit starts a worker; its result describes the final write in the batch.
    pub fn save(
        &self,
        settings: Settings,
        runtime: &Handle,
    ) -> Option<JoinHandle<(Settings, Result<()>)>> {
        let mut pending = self.state.lock().unwrap_or_else(|e| e.into_inner());
        pending.settings = Some(settings);
        if pending.running {
            return None;
        }
        pending.running = true;
        drop(pending);
        let writer = self.clone();
        Some(runtime.spawn_blocking(move || {
            loop {
                // The blocking worker also drains pending edits during runtime shutdown.
                std::thread::sleep(Duration::from_millis(120));
                let settings = writer
                    .state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .settings
                    .take()
                    .expect("a running settings writer has pending edits");
                let result = writer.store.save_settings(&settings);
                let mut pending = writer.state.lock().unwrap_or_else(|e| e.into_inner());
                if pending.settings.is_none() {
                    pending.running = false;
                    return (settings, result);
                }
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn coalesces_edits_and_drains_after_editor_closes() -> Result<()> {
        let data = tempfile::tempdir()?;
        let store = Arc::new(Store::open(data.path())?);
        let saver = SettingsAutosave::new(store.clone());
        let mut settings = Settings::default();
        let mut workers = vec![saver.save(settings.clone(), &Handle::current()).unwrap()];
        for opacity in 0..=100 {
            settings.background.opacity = opacity;
            settings.sftp_panel.visible = opacity % 2 == 0;
            settings.sftp_panel.left = opacity % 3 == 0;
            settings.sftp_panel.width = 360 + u16::from(opacity);
            if let Some(worker) = saver.save(settings.clone(), &Handle::current()) {
                workers.push(worker);
            }
        }
        drop(saver);
        for worker in workers {
            let (_, result) = worker.await?;
            result?;
        }
        assert_eq!(store.settings()?, settings);
        Ok(())
    }

    #[tokio::test]
    async fn rejects_invalid_settings_without_overwriting_saved_values() -> Result<()> {
        let data = tempfile::tempdir()?;
        let store = Arc::new(Store::open(data.path())?);
        let valid = Settings::default();
        store.save_settings(&valid)?;
        let saver = SettingsAutosave::new(store.clone());
        let mut invalid = valid.clone();
        invalid.keymap.copy = "Ctrl+".into();
        let (_, result) = saver.save(invalid, &Handle::current()).unwrap().await?;
        assert!(result.is_err());
        assert_eq!(store.settings()?, valid);
        Ok(())
    }
}
