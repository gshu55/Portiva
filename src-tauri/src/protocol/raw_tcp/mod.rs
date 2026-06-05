use crate::domain::capability::ConnectionCapabilities;
use crate::domain::connection::{ConnectionSession, ConnectionStatus};
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
        // TODO: implement TcpStream connect, line-ending conversion, encoding, timeout, and reconnect policy.
        Ok(ConnectionSession {
            id: format!("session-{}", profile.id),
            profile_id: profile.id.clone(),
            title: profile.title(),
            status: ConnectionStatus::Todo,
            capabilities: self.capabilities(),
            transport: None,
        })
    }
}
