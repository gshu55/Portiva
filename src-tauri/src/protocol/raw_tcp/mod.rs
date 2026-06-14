use crate::domain::capability::ConnectionCapabilities;
use crate::domain::connection::{
    ConnectionSession, ConnectionStatus, ConnectionTransportInfo, ConnectionTransportKind,
};
use crate::domain::profile::{ConnectionProfile, ConnectionType};
use crate::protocol::ProtocolBackend;

pub struct RawTcpBackend;

impl ProtocolBackend for RawTcpBackend {
    fn protocol_type(&self) -> ConnectionType {
        ConnectionType::RawTcp
    }

    fn capabilities(&self) -> ConnectionCapabilities {
        ConnectionCapabilities::terminal_insecure_without_pty_resize()
    }

    fn connect_placeholder(&self, profile: ConnectionProfile) -> Result<ConnectionSession, String> {
        let host = profile
            .host
            .as_deref()
            .unwrap_or("unconfigured-host")
            .to_string();
        let port = profile.port.unwrap_or(0);

        Ok(ConnectionSession {
            id: format!("session-{}", profile.id),
            profile_id: profile.id.clone(),
            title: profile.title(),
            status: ConnectionStatus::Ready,
            capabilities: self.capabilities(),
            transport: Some(ConnectionTransportInfo {
                kind: ConnectionTransportKind::RawTcp,
                host,
                port,
                server_identification: Some("Raw TCP".to_string()),
                host_key_fingerprint: None,
                authenticated: true,
                terminal_channel_ready: false,
                file_transfer_ready: false,
            }),
        })
    }
}
