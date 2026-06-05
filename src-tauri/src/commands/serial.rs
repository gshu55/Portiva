use tauri::{AppHandle, State};

use crate::domain::profile::ConnectionProfile;
use crate::domain::serial::SerialPortInfo;
use crate::services::serial_service::SerialService;
use crate::services::terminal_service::TerminalService;

#[tauri::command]
pub fn serial_list_ports(
    serial_service: State<'_, SerialService>,
) -> Result<Vec<SerialPortInfo>, String> {
    serial_service.list_ports()
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
    serial_service.open_terminal(&terminal.connection_id, &terminal_id, app_handle)
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
    serial_service.open_terminal(&terminal.connection_id, &terminal_id, app_handle)
}
