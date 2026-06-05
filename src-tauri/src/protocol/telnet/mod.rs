use crate::domain::capability::ConnectionCapabilities;
use crate::domain::connection::{ConnectionSession, ConnectionStatus};
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
        // TODO: implement Telnet IAC negotiation, ECHO, TERMINAL-TYPE, NAWS, and CRLF handling.
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
