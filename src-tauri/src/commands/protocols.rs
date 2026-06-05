use tauri::State;

use crate::domain::capability::ProtocolDescriptor;
use crate::domain::profile::ConnectionType;
use crate::services::protocol_registry::ProtocolRegistry;

#[tauri::command]
pub fn protocol_list(protocol_registry: State<'_, ProtocolRegistry>) -> Vec<ProtocolDescriptor> {
    protocol_registry.list()
}

#[tauri::command]
pub fn protocol_get(
    protocol_type: ConnectionType,
    protocol_registry: State<'_, ProtocolRegistry>,
) -> Result<ProtocolDescriptor, String> {
    protocol_registry
        .get(protocol_type)
        .ok_or_else(|| "protocol not found".to_string())
}
