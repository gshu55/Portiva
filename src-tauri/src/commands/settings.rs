use tauri::State;

use crate::domain::logging::LogLevel;
use crate::domain::settings::AppSettings;
use crate::services::log_service::LogService;
use crate::services::settings_store::SettingsStore;

#[tauri::command]
pub fn settings_get(settings_store: State<'_, SettingsStore>) -> Result<AppSettings, String> {
    settings_store.get()
}

#[tauri::command]
pub fn settings_update(
    settings: AppSettings,
    settings_store: State<'_, SettingsStore>,
    logs: State<'_, LogService>,
) -> Result<AppSettings, String> {
    let updated = settings_store.update(settings)?;
    let _ = logs.record(LogLevel::Info, "settings", "updated application settings");
    Ok(updated)
}
