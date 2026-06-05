use tauri::State;

use crate::domain::tunnel::TunnelRule;
use crate::services::tunnel_service::TunnelService;

#[tauri::command]
pub fn tunnel_create(
    rule: TunnelRule,
    tunnel_service: State<'_, TunnelService>,
) -> Result<TunnelRule, String> {
    tunnel_service.create(rule)
}

#[tauri::command]
pub fn tunnel_start(
    tunnel_id: String,
    tunnel_service: State<'_, TunnelService>,
) -> Result<TunnelRule, String> {
    tunnel_service.start(&tunnel_id)
}

#[tauri::command]
pub fn tunnel_stop(
    tunnel_id: String,
    tunnel_service: State<'_, TunnelService>,
) -> Result<TunnelRule, String> {
    tunnel_service.stop(&tunnel_id)
}

#[tauri::command]
pub fn tunnel_list(tunnel_service: State<'_, TunnelService>) -> Result<Vec<TunnelRule>, String> {
    tunnel_service.list()
}
