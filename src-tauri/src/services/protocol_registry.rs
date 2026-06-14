use crate::domain::capability::ProtocolDescriptor;
use crate::domain::profile::ConnectionType;
use crate::protocol::raw_tcp::RawTcpBackend;
use crate::protocol::serial::SerialBackend;
use crate::protocol::ssh::{SftpBackend, SshBackend};
use crate::protocol::telnet::TelnetBackend;
use crate::protocol::ProtocolBackend;

#[derive(Default)]
pub struct ProtocolRegistry;

impl ProtocolRegistry {
    pub fn list(&self) -> Vec<ProtocolDescriptor> {
        vec![
            descriptor(SshBackend, "SSH", true),
            descriptor(SftpBackend, "SFTP", true),
            descriptor(TelnetBackend, "Telnet", true),
            descriptor(SerialBackend, "Serial", true),
            descriptor(RawTcpBackend, "Raw TCP", true),
        ]
    }

    pub fn get(&self, protocol_type: ConnectionType) -> Option<ProtocolDescriptor> {
        self.list()
            .into_iter()
            .find(|descriptor| descriptor.protocol_type == protocol_type)
    }
}

fn descriptor(
    backend: impl ProtocolBackend,
    label: impl Into<String>,
    enabled: bool,
) -> ProtocolDescriptor {
    ProtocolDescriptor {
        protocol_type: backend.protocol_type(),
        label: label.into(),
        enabled,
        capabilities: backend.capabilities(),
    }
}

#[cfg(test)]
mod tests {
    use super::ProtocolRegistry;
    use crate::domain::profile::ConnectionType;

    #[test]
    fn lists_protocol_capabilities() {
        let registry = ProtocolRegistry;
        let protocols = registry.list();

        assert_eq!(protocols.len(), 5);
        assert!(protocols
            .iter()
            .any(|protocol| protocol.capabilities.terminal));
    }

    #[test]
    fn gets_ssh_descriptor() {
        let registry = ProtocolRegistry;
        let ssh = registry.get(ConnectionType::Ssh).unwrap();

        assert_eq!(ssh.label, "SSH");
        assert!(ssh.capabilities.sftp);
    }
}
