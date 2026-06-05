use tauri::State;

use crate::domain::logging::{LogEntry, LogLevel};
use crate::services::log_service::LogService;

#[tauri::command]
pub fn log_list(log_service: State<'_, LogService>) -> Result<Vec<LogEntry>, String> {
    log_service.list()
}

#[tauri::command]
pub fn log_clear(log_service: State<'_, LogService>) -> Result<Vec<LogEntry>, String> {
    log_service.clear()?;
    log_service.list()
}

#[tauri::command]
pub fn log_record_placeholder(
    level: LogLevel,
    target: String,
    message: String,
    log_service: State<'_, LogService>,
) -> Result<LogEntry, String> {
    // TODO: replace direct calls with tracing subscriber bridge and rolling file sink.
    log_service.record(level, target, message)
}
