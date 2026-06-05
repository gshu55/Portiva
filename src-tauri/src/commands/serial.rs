use tauri::State;

use crate::domain::serial::SerialPortInfo;
use crate::services::serial_service::SerialService;

#[tauri::command]
pub fn serial_list_ports(
    serial_service: State<'_, SerialService>,
) -> Result<Vec<SerialPortInfo>, String> {
    serial_service.list_ports()
}
