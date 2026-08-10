use tokio::sync::Mutex;

#[derive(Default)]
pub struct UpdateService {
    pub pending: Mutex<Option<tauri_plugin_updater::Update>>,
}
