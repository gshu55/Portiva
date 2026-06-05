use std::collections::HashMap;
use std::sync::Mutex;

use crate::domain::tunnel::{TunnelRule, TunnelStatus};

#[derive(Default)]
pub struct TunnelService {
    tunnels: Mutex<HashMap<String, TunnelRule>>,
}

impl TunnelService {
    pub fn create(&self, mut rule: TunnelRule) -> Result<TunnelRule, String> {
        rule.validate()?;
        rule.status = TunnelStatus::Pending;

        self.tunnels
            .lock()
            .map_err(|_| "tunnel service lock poisoned".to_string())?
            .insert(rule.id.clone(), rule.clone());

        Ok(rule)
    }

    pub fn start(&self, tunnel_id: &str) -> Result<TunnelRule, String> {
        // TODO: ask SSH backend to create port forward task.
        self.set_status(tunnel_id, TunnelStatus::Active)
    }

    pub fn stop(&self, tunnel_id: &str) -> Result<TunnelRule, String> {
        // TODO: stop backend listener and remote channel.
        self.set_status(tunnel_id, TunnelStatus::Stopped)
    }

    pub fn list(&self) -> Result<Vec<TunnelRule>, String> {
        Ok(self
            .tunnels
            .lock()
            .map_err(|_| "tunnel service lock poisoned".to_string())?
            .values()
            .cloned()
            .collect())
    }

    fn set_status(&self, tunnel_id: &str, status: TunnelStatus) -> Result<TunnelRule, String> {
        let mut tunnels = self
            .tunnels
            .lock()
            .map_err(|_| "tunnel service lock poisoned".to_string())?;

        let tunnel = tunnels
            .get_mut(tunnel_id)
            .ok_or_else(|| format!("tunnel not found: {tunnel_id}"))?;
        tunnel.status = status;

        Ok(tunnel.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::TunnelService;
    use crate::domain::tunnel::{TunnelKind, TunnelRule, TunnelStatus};

    fn rule() -> TunnelRule {
        TunnelRule {
            id: "tunnel-1".to_string(),
            connection_id: "connection-1".to_string(),
            kind: TunnelKind::Local,
            local_host: "127.0.0.1".to_string(),
            local_port: 15432,
            remote_host: "localhost".to_string(),
            remote_port: 5432,
            status: TunnelStatus::Pending,
        }
    }

    #[test]
    fn starts_and_stops_tunnel() {
        let service = TunnelService::default();
        service.create(rule()).unwrap();

        assert!(matches!(
            service.start("tunnel-1").unwrap().status,
            TunnelStatus::Active
        ));
        assert!(matches!(
            service.stop("tunnel-1").unwrap().status,
            TunnelStatus::Stopped
        ));
    }
}
