use crate::domain::capability::ConnectionCapabilities;
use crate::domain::connection::{ConnectionSession, ConnectionStatus};
use crate::domain::profile::{ConnectionProfile, ConnectionType};
use crate::protocol::ProtocolBackend;

pub mod probe;

pub struct SshBackend;
pub struct SftpBackend;

impl ProtocolBackend for SshBackend {
    fn protocol_type(&self) -> ConnectionType {
        ConnectionType::Ssh
    }

    fn capabilities(&self) -> ConnectionCapabilities {
        ConnectionCapabilities::ssh()
    }

    fn connect_placeholder(&self, profile: ConnectionProfile) -> Result<ConnectionSession, String> {
        // TODO: use russh/russh-sftp, SecretStore, and KnownHostsStore here.
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

impl ProtocolBackend for SftpBackend {
    fn protocol_type(&self) -> ConnectionType {
        ConnectionType::Sftp
    }

    fn capabilities(&self) -> ConnectionCapabilities {
        ConnectionCapabilities::sftp_only()
    }

    fn connect_placeholder(&self, profile: ConnectionProfile) -> Result<ConnectionSession, String> {
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
