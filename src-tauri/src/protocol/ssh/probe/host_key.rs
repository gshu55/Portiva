use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::keys::ssh_key;
use russh::{client, Disconnect};

use crate::domain::profile::ConnectionProfile;
use crate::protocol::ssh::SSH_CONNECT_TIMEOUT_SECS;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshHostKeyProbeResult {
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
}

pub async fn probe_ssh_host_key(
    profile: &ConnectionProfile,
) -> Result<SshHostKeyProbeResult, String> {
    let host = profile
        .host
        .as_deref()
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .ok_or_else(|| "SSH host is required".to_string())?
        .to_string();
    let port = profile.port.unwrap_or(22);
    let timeout = Duration::from_secs(SSH_CONNECT_TIMEOUT_SECS);
    let fingerprint = Arc::new(Mutex::new(None));
    let handler = HostKeyProbeHandler {
        fingerprint: Arc::clone(&fingerprint),
    };
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(timeout),
        nodelay: true,
        ..Default::default()
    });

    let session = tokio::time::timeout(
        timeout,
        client::connect(config, (host.as_str(), port), handler),
    )
    .await
    .map_err(|_| format!("timed out probing SSH host key {host}:{port}"))?
    .map_err(|error| format!("failed to probe SSH host key {host}:{port}: {error}"))?;
    let _ = session
        .disconnect(Disconnect::ByApplication, "host key probe complete", "en")
        .await;

    let fingerprint = fingerprint
        .lock()
        .map_err(|_| "SSH host key probe state lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "SSH server did not provide a host key fingerprint".to_string())?;

    Ok(SshHostKeyProbeResult {
        host,
        port,
        fingerprint,
    })
}

struct HostKeyProbeHandler {
    fingerprint: Arc<Mutex<Option<String>>>,
}

impl client::Handler for HostKeyProbeHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key
            .fingerprint(ssh_key::HashAlg::Sha256)
            .to_string();
        if let Ok(mut state) = self.fingerprint.lock() {
            *state = Some(fingerprint);
        }

        Ok(true)
    }
}
