use serde::{Deserialize, Serialize};

use super::capability::ConnectionCapabilities;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectionType {
    Ssh,
    Sftp,
    Telnet,
    Serial,
    RawTcp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub group_id: Option<String>,
    pub r#type: ConnectionType,
    pub tags: Option<Vec<String>>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub auth_type: Option<String>,
    pub private_key_path: Option<String>,
    pub enable_sftp: Option<bool>,
    pub port_name: Option<String>,
    pub baud_rate: Option<u32>,
    pub data_bits: Option<u8>,
    pub parity: Option<String>,
    pub stop_bits: Option<f32>,
    pub flow_control: Option<String>,
    pub line_ending: Option<String>,
    pub encoding: Option<String>,
    pub dtr: Option<bool>,
    pub rts: Option<bool>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileGroup {
    pub id: String,
    pub name: String,
    pub profile_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentConnection {
    pub profile_id: String,
    pub title: String,
    pub last_connected_at: String,
}

impl ConnectionProfile {
    pub fn capabilities(&self) -> ConnectionCapabilities {
        match self.r#type {
            ConnectionType::Ssh => ConnectionCapabilities::ssh(),
            ConnectionType::Sftp => ConnectionCapabilities::sftp_only(),
            ConnectionType::Telnet => ConnectionCapabilities::terminal_insecure(),
            ConnectionType::Serial | ConnectionType::RawTcp => {
                ConnectionCapabilities::terminal_insecure_without_pty_resize()
            }
        }
    }

    pub fn title(&self) -> String {
        match self.r#type {
            ConnectionType::Serial => format!(
                "[SERIAL] {}",
                self.port_name.as_deref().unwrap_or("unconfigured-port")
            ),
            ConnectionType::Ssh => format!(
                "[SSH] {}",
                self.host.as_deref().unwrap_or("unconfigured-host")
            ),
            ConnectionType::Sftp => format!(
                "[SFTP] {}",
                self.host.as_deref().unwrap_or("unconfigured-host")
            ),
            ConnectionType::Telnet => format!(
                "[TELNET] {}",
                self.host.as_deref().unwrap_or("unconfigured-host")
            ),
            ConnectionType::RawTcp => format!(
                "[RAW] {}",
                self.host.as_deref().unwrap_or("unconfigured-host")
            ),
        }
    }
}
