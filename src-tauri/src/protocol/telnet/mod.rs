use crate::domain::capability::ConnectionCapabilities;
use crate::domain::connection::{
    ConnectionSession, ConnectionStatus, ConnectionTransportInfo, ConnectionTransportKind,
};
use crate::domain::profile::{ConnectionProfile, ConnectionType};
use crate::protocol::ProtocolBackend;

pub struct TelnetBackend;

impl ProtocolBackend for TelnetBackend {
    fn protocol_type(&self) -> ConnectionType {
        ConnectionType::Telnet
    }

    fn capabilities(&self) -> ConnectionCapabilities {
        ConnectionCapabilities::terminal_insecure()
    }

    fn connect_placeholder(&self, profile: ConnectionProfile) -> Result<ConnectionSession, String> {
        let host = profile
            .host
            .as_deref()
            .unwrap_or("unconfigured-host")
            .to_string();
        let port = profile.port.unwrap_or(23);

        Ok(ConnectionSession {
            id: format!("session-{}", profile.id),
            profile_id: profile.id.clone(),
            title: profile.title(),
            status: ConnectionStatus::Ready,
            capabilities: self.capabilities(),
            transport: Some(ConnectionTransportInfo {
                kind: ConnectionTransportKind::Telnet,
                host,
                port,
                server_identification: Some("Telnet".to_string()),
                host_key_fingerprint: None,
                authenticated: true,
                terminal_channel_ready: false,
                file_transfer_ready: false,
            }),
        })
    }
}
