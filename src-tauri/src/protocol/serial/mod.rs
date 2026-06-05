use crate::domain::capability::ConnectionCapabilities;
use crate::domain::connection::{
    ConnectionSession, ConnectionStatus, ConnectionTransportInfo, ConnectionTransportKind,
};
use crate::domain::profile::{ConnectionProfile, ConnectionType};
use crate::protocol::ProtocolBackend;

pub struct SerialBackend;

impl ProtocolBackend for SerialBackend {
    fn protocol_type(&self) -> ConnectionType {
        ConnectionType::Serial
    }

    fn capabilities(&self) -> ConnectionCapabilities {
        ConnectionCapabilities::terminal_insecure_without_pty_resize()
    }

    fn connect_placeholder(&self, profile: ConnectionProfile) -> Result<ConnectionSession, String> {
        let port_name = profile
            .port_name
            .as_deref()
            .unwrap_or("unconfigured-port")
            .to_string();
        let baud_rate = profile.baud_rate.unwrap_or(115_200);

        Ok(ConnectionSession {
            id: format!("session-{}", profile.id),
            profile_id: profile.id.clone(),
            title: profile.title(),
            status: ConnectionStatus::Ready,
            capabilities: self.capabilities(),
            transport: Some(ConnectionTransportInfo {
                kind: ConnectionTransportKind::Serial,
                host: port_name,
                port: 0,
                server_identification: Some(format!("{baud_rate} baud")),
                host_key_fingerprint: None,
                authenticated: true,
                terminal_channel_ready: false,
                file_transfer_ready: false,
            }),
        })
    }
}
