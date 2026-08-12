use serde::{Deserialize, Serialize};

use super::capability::ConnectionCapabilities;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSession {
    pub id: String,
    pub profile_id: String,
    pub title: String,
    pub status: ConnectionStatus,
    pub capabilities: ConnectionCapabilities,
    pub transport: Option<ConnectionTransportInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTransportInfo {
    pub kind: ConnectionTransportKind,
    pub host: String,
    pub port: u16,
    pub server_identification: Option<String>,
    pub host_key_fingerprint: Option<String>,
    pub authenticated: bool,
    pub terminal_channel_ready: bool,
    pub file_transfer_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshHostOverview {
    pub hostname: String,
    pub operating_system: String,
    pub kernel_version: String,
    pub cpu_load_1: Option<f64>,
    pub cpu_count: Option<u32>,
    pub memory_used_bytes: Option<u64>,
    pub memory_total_bytes: Option<u64>,
    pub disk_used_bytes: Option<u64>,
    pub disk_total_bytes: Option<u64>,
    pub network_received_bytes: Option<u64>,
    pub network_transmitted_bytes: Option<u64>,
    pub uptime_seconds: Option<u64>,
    pub latency_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectionTransportKind {
    Ssh,
    Telnet,
    Serial,
    RawTcp,
    LocalShell,
    Wsl,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectionStatus {
    Ready,
    Connecting,
    Connected,
    Disconnected,
    Failed,
    Todo,
}

impl ConnectionSession {
    pub fn is_authenticated(&self) -> bool {
        self.transport
            .as_ref()
            .map(|transport| transport.authenticated)
            .unwrap_or(false)
    }

    pub fn is_file_transfer_ready(&self) -> bool {
        self.transport
            .as_ref()
            .map(|transport| transport.file_transfer_ready)
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ConnectionSession, ConnectionStatus, ConnectionTransportInfo, ConnectionTransportKind,
    };
    use crate::domain::capability::ConnectionCapabilities;

    #[test]
    fn transport_readiness_requires_authenticated_channel_state() {
        let session = ConnectionSession {
            id: "session-1".to_string(),
            profile_id: "profile-1".to_string(),
            title: "SSH".to_string(),
            status: ConnectionStatus::Ready,
            capabilities: ConnectionCapabilities::ssh(),
            transport: Some(ConnectionTransportInfo {
                kind: ConnectionTransportKind::Ssh,
                host: "example.com".to_string(),
                port: 22,
                server_identification: Some("SSH-2.0-Test".to_string()),
                host_key_fingerprint: Some("SHA256:test".to_string()),
                authenticated: false,
                terminal_channel_ready: false,
                file_transfer_ready: false,
            }),
        };

        assert!(!session.is_authenticated());
        assert!(!session.is_file_transfer_ready());
    }
}
