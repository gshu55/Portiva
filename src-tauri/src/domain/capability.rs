use serde::{Deserialize, Serialize};

use super::profile::ConnectionType;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionCapabilities {
    pub terminal: bool,
    pub file_transfer: bool,
    pub sftp: bool,
    pub scp: bool,
    pub tunnel: bool,
    pub port_forwarding: bool,
    pub pty_resize: bool,
    pub secure_transport: bool,
    pub reconnect: bool,
    pub local_file_access: bool,
    pub requires_host_key_verification: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolDescriptor {
    pub protocol_type: ConnectionType,
    pub label: String,
    pub enabled: bool,
    pub capabilities: ConnectionCapabilities,
}

impl ConnectionCapabilities {
    pub fn ssh() -> Self {
        Self {
            terminal: true,
            file_transfer: true,
            sftp: true,
            scp: true,
            tunnel: true,
            port_forwarding: true,
            pty_resize: true,
            secure_transport: true,
            reconnect: true,
            local_file_access: false,
            requires_host_key_verification: true,
        }
    }

    pub fn sftp_only() -> Self {
        Self {
            terminal: false,
            file_transfer: true,
            sftp: true,
            scp: false,
            tunnel: false,
            port_forwarding: false,
            pty_resize: false,
            secure_transport: true,
            reconnect: true,
            local_file_access: false,
            requires_host_key_verification: true,
        }
    }

    pub fn terminal_insecure() -> Self {
        Self {
            terminal: true,
            file_transfer: false,
            sftp: false,
            scp: false,
            tunnel: false,
            port_forwarding: false,
            pty_resize: true,
            secure_transport: false,
            reconnect: true,
            local_file_access: false,
            requires_host_key_verification: false,
        }
    }

    pub fn terminal_insecure_without_pty_resize() -> Self {
        Self {
            pty_resize: false,
            ..Self::terminal_insecure()
        }
    }

    pub fn local_shell() -> Self {
        Self {
            terminal: true,
            file_transfer: false,
            sftp: false,
            scp: false,
            tunnel: false,
            port_forwarding: false,
            pty_resize: true,
            secure_transport: true,
            reconnect: true,
            local_file_access: true,
            requires_host_key_verification: false,
        }
    }

    pub fn wsl() -> Self {
        Self {
            terminal: true,
            file_transfer: false,
            sftp: false,
            scp: false,
            tunnel: false,
            port_forwarding: false,
            pty_resize: true,
            secure_transport: true,
            reconnect: true,
            local_file_access: true,
            requires_host_key_verification: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ConnectionCapabilities;

    #[test]
    fn ssh_requires_host_key_verification() {
        let capabilities = ConnectionCapabilities::ssh();

        assert!(capabilities.requires_host_key_verification);
        assert!(capabilities.sftp);
    }

    #[test]
    fn raw_terminal_has_no_pty_resize() {
        let capabilities = ConnectionCapabilities::terminal_insecure_without_pty_resize();

        assert!(capabilities.terminal);
        assert!(!capabilities.pty_resize);
        assert!(!capabilities.secure_transport);
    }
}
