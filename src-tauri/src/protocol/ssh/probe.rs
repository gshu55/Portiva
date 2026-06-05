use std::time::Duration;

use crate::domain::profile::ConnectionProfile;

pub mod host_key;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshTransportProbeResult {
    pub host: String,
    pub port: u16,
    pub server_identification: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshEndpointProbeResult {
    pub transport: SshTransportProbeResult,
    pub host_key_fingerprint: String,
}

pub async fn probe_ssh_endpoint(
    profile: &ConnectionProfile,
) -> Result<SshEndpointProbeResult, String> {
    let transport = probe_ssh_transport(profile).await?;
    let host_key = host_key::probe_ssh_host_key(profile).await?;

    Ok(SshEndpointProbeResult {
        transport,
        host_key_fingerprint: host_key.fingerprint,
    })
}

pub async fn probe_ssh_transport(
    profile: &ConnectionProfile,
) -> Result<SshTransportProbeResult, String> {
    let host = profile
        .host
        .as_deref()
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .ok_or_else(|| "SSH host is required".to_string())?
        .to_string();
    let port = profile.port.unwrap_or(22);
    let timeout = Duration::from_secs(5);

    let stream = tokio::time::timeout(
        timeout,
        tokio::net::TcpStream::connect((host.as_str(), port)),
    )
    .await
    .map_err(|_| format!("timed out connecting SSH transport {host}:{port}"))?
    .map_err(|error| format!("failed to connect SSH transport {host}:{port}: {error}"))?;

    let mut reader = tokio::io::BufReader::new(stream);
    let mut line = String::new();
    tokio::time::timeout(
        timeout,
        tokio::io::AsyncBufReadExt::read_line(&mut reader, &mut line),
    )
    .await
    .map_err(|_| "timed out reading SSH identification".to_string())?
    .map_err(|error| format!("failed to read SSH identification: {error}"))?;
    let server_identification = parse_ssh_identification(&line)?;

    Ok(SshTransportProbeResult {
        host,
        port,
        server_identification,
    })
}

pub fn parse_ssh_identification(line: &str) -> Result<String, String> {
    let identification = line.trim_end_matches(['\r', '\n']).trim();

    if identification.is_empty() {
        return Err("SSH server returned an empty identification string".to_string());
    }

    if !identification.starts_with("SSH-") {
        return Err(format!(
            "target did not return an SSH identification string: {identification}"
        ));
    }

    Ok(identification.to_string())
}

#[cfg(test)]
mod tests {
    use super::parse_ssh_identification;

    #[test]
    fn accepts_valid_ssh_identification() {
        let parsed = parse_ssh_identification("SSH-2.0-OpenSSH_9.7\r\n").unwrap();

        assert_eq!(parsed, "SSH-2.0-OpenSSH_9.7");
    }

    #[test]
    fn rejects_non_ssh_banner() {
        let error = parse_ssh_identification("HTTP/1.1 200 OK\r\n").unwrap_err();

        assert!(error.contains("did not return an SSH identification"));
    }
}
