use tauri::{AppHandle, State};

use crate::domain::network_scan::{NetworkInterfaceInfo, NetworkScanRequest, NetworkScanSession};
use crate::services::network_scan_service::{start_scan, NetworkScanService};

#[tauri::command]
pub fn network_scan_interfaces(
    service: State<'_, NetworkScanService>,
) -> Result<Vec<NetworkInterfaceInfo>, String> {
    service.interfaces()
}

#[tauri::command]
pub fn network_scan_start(
    request: NetworkScanRequest,
    app_handle: AppHandle,
    service: State<'_, NetworkScanService>,
) -> Result<NetworkScanSession, String> {
    start_scan(app_handle, service.inner(), request)
}

#[tauri::command]
pub fn network_scan_cancel(
    scan_id: String,
    service: State<'_, NetworkScanService>,
) -> Result<bool, String> {
    service.cancel(&scan_id)
}
