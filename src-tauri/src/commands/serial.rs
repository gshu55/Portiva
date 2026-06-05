use tauri::{AppHandle, State};

use crate::domain::connection::ConnectionSession;
use crate::domain::profile::ConnectionProfile;
use crate::domain::serial::SerialPortInfo;
use crate::domain::terminal::{TerminalSession, TerminalSize, TerminalSnapshot};
use crate::services::connection_manager::ConnectionManager;
use crate::services::serial_service::SerialService;
use crate::services::terminal_service::TerminalService;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialTerminalCreateResult {
    pub connection: ConnectionSession,
    pub terminal: TerminalSession,
    pub terminal_snapshot: TerminalSnapshot,
}

#[tauri::command]
pub fn serial_list_ports(
    serial_service: State<'_, SerialService>,
) -> Result<Vec<SerialPortInfo>, String> {
    serial_service.list_ports()
}

#[tauri::command]
pub fn serial_terminal_create(
    profile: ConnectionProfile,
    size: TerminalSize,
    connection_manager: State<'_, ConnectionManager>,
    terminal_service: State<'_, TerminalService>,
) -> Result<SerialTerminalCreateResult, String> {
    let connection = connection_manager.open_placeholder(profile)?;
    let terminal = match terminal_service.attach(connection.id.clone(), size) {
        Ok(terminal) => terminal,
        Err(error) => {
            let _ = connection_manager.close(&connection.id);
            return Err(error);
        }
    };
    let terminal_snapshot = terminal_service.snapshot(&terminal.id)?;

    Ok(SerialTerminalCreateResult {
        connection,
        terminal,
        terminal_snapshot,
    })
}

#[tauri::command]
pub fn serial_terminal_close(
    terminal_id: String,
    terminal_service: State<'_, TerminalService>,
    serial_service: State<'_, SerialService>,
) -> Result<bool, String> {
    let terminal = terminal_service.session(&terminal_id)?;
    serial_service.close_terminal(&terminal.connection_id, &terminal_id)
}

#[tauri::command]
pub fn serial_terminal_open(
    terminal_id: String,
    profile: ConnectionProfile,
    app_handle: AppHandle,
    terminal_service: State<'_, TerminalService>,
    serial_service: State<'_, SerialService>,
) -> Result<(), String> {
    let terminal = terminal_service.session(&terminal_id)?;
    serial_service.register_profile(&terminal.connection_id, profile)?;
    serial_service.open_terminal(&terminal.connection_id, &terminal_id, app_handle)?;
    let _ = terminal_service.mark_attached(&terminal_id)?;
    Ok(())
}

#[tauri::command]
pub fn serial_terminal_reconfigure(
    terminal_id: String,
    profile: ConnectionProfile,
    app_handle: AppHandle,
    terminal_service: State<'_, TerminalService>,
    serial_service: State<'_, SerialService>,
) -> Result<(), String> {
    let terminal = terminal_service.session(&terminal_id)?;
    let _ = serial_service.close_terminal(&terminal.connection_id, &terminal_id)?;
    serial_service.register_profile(&terminal.connection_id, profile)?;
    serial_service.open_terminal(&terminal.connection_id, &terminal_id, app_handle)?;
    let _ = terminal_service.mark_attached(&terminal_id)?;
    Ok(())
}
