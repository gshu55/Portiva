use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelRule {
    pub id: String,
    pub connection_id: String,
    pub kind: TunnelKind,
    pub local_host: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub status: TunnelStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TunnelKind {
    Local,
    Remote,
    Dynamic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TunnelStatus {
    Pending,
    Active,
    Stopped,
    Failed,
}

impl TunnelRule {
    pub fn validate(&self) -> Result<(), String> {
        if self.local_port == 0 || self.remote_port == 0 {
            return Err("tunnel ports must be greater than zero".to_string());
        }

        if self.local_host.trim().is_empty() || self.remote_host.trim().is_empty() {
            return Err("tunnel hosts are required".to_string());
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{TunnelKind, TunnelRule, TunnelStatus};

    #[test]
    fn validates_tunnel_ports() {
        let rule = TunnelRule {
            id: "tunnel-1".to_string(),
            connection_id: "connection-1".to_string(),
            kind: TunnelKind::Local,
            local_host: "127.0.0.1".to_string(),
            local_port: 0,
            remote_host: "localhost".to_string(),
            remote_port: 5432,
            status: TunnelStatus::Pending,
        };

        assert!(rule.validate().is_err());
    }
}
