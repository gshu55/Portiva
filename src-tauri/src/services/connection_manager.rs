use std::collections::HashMap;
use std::sync::Mutex;

use crate::domain::capability::ConnectionCapabilities;
use crate::domain::connection::{
    ConnectionSession, ConnectionStatus, ConnectionTransportInfo, ConnectionTransportKind,
};
use crate::domain::profile::{ConnectionProfile, ConnectionType};
use crate::protocol::raw_tcp::RawTcpBackend;
use crate::protocol::serial::SerialBackend;
#[cfg(test)]
use crate::protocol::ssh::probe::SshEndpointProbeResult;
use crate::protocol::ssh::{SftpBackend, SshBackend};
use crate::protocol::telnet::TelnetBackend;
use crate::protocol::ProtocolBackend;

#[derive(Default)]
pub struct ConnectionManager {
    sessions: Mutex<HashMap<String, ConnectionSession>>,
    next_sequence: Mutex<u64>,
}

#[cfg(test)]
mod tests {
    use super::ConnectionManager;
    use crate::domain::profile::{ConnectionProfile, ConnectionType};

    #[test]
    fn rejects_reserved_protocols_until_enabled() {
        let manager = ConnectionManager::default();
        let mut profile = sample_profile(ConnectionType::Telnet);
        profile.host = Some("192.168.0.44".to_string());

        let error = manager.open_placeholder(profile).unwrap_err();

        assert!(error.contains("not enabled"));
    }

    #[test]
    fn opens_ssh_placeholder_session() {
        let manager = ConnectionManager::default();
        let profile = sample_profile(ConnectionType::Ssh);
        let session = manager.open_placeholder(profile).unwrap();

        assert!(session.capabilities.sftp);
        assert!(manager.get(&session.id).unwrap().is_some());
    }

    #[test]
    fn opens_multiple_sessions_for_the_same_profile() {
        let manager = ConnectionManager::default();
        let profile = sample_profile(ConnectionType::Ssh);
        let first = manager.open_placeholder(profile.clone()).unwrap();
        let second = manager.open_placeholder(profile).unwrap();

        assert_ne!(first.id, second.id);
        assert!(manager.get(&first.id).unwrap().is_some());
        assert!(manager.get(&second.id).unwrap().is_some());
    }

    #[test]
    fn opens_verified_ssh_transport_session_with_metadata() {
        let manager = ConnectionManager::default();
        let profile = sample_profile(ConnectionType::Ssh);
        let session = manager
            .open_verified_ssh_transport(
                profile,
                super::SshEndpointProbeResult {
                    transport: crate::protocol::ssh::probe::SshTransportProbeResult {
                        host: "example.com".to_string(),
                        port: 22,
                        server_identification: "SSH-2.0-Test".to_string(),
                    },
                    host_key_fingerprint: "SHA256:test".to_string(),
                },
            )
            .unwrap();

        assert!(matches!(
            session.status,
            crate::domain::connection::ConnectionStatus::Ready
        ));
        assert_eq!(
            session.transport.unwrap().server_identification.unwrap(),
            "SSH-2.0-Test"
        );
    }

    fn sample_profile(r#type: ConnectionType) -> ConnectionProfile {
        ConnectionProfile {
            id: "profile-1".to_string(),
            name: "Profile".to_string(),
            group_id: None,
            r#type,
            tags: None,
            host: Some("example.com".to_string()),
            port: Some(22),
            username: Some("deploy".to_string()),
            auth_type: Some("password".to_string()),
            private_key_path: None,
            enable_sftp: Some(true),
            port_name: None,
            baud_rate: None,
            data_bits: None,
            parity: None,
            stop_bits: None,
            flow_control: None,
            line_ending: None,
            encoding: None,
            dtr: None,
            rts: None,
            created_at: "2026-05-11T08:00:00.000Z".to_string(),
            updated_at: "2026-05-11T08:00:00.000Z".to_string(),
        }
    }
}

impl ConnectionManager {
    pub fn open_local_shell(&self, title: String) -> Result<ConnectionSession, String> {
        self.register_session(ConnectionSession {
            id: "session-local-shell".to_string(),
            profile_id: "local-shell".to_string(),
            title,
            status: ConnectionStatus::Connected,
            capabilities: ConnectionCapabilities::local_shell(),
            transport: Some(ConnectionTransportInfo {
                kind: ConnectionTransportKind::LocalShell,
                host: "localhost".to_string(),
                port: 0,
                server_identification: None,
                host_key_fingerprint: None,
                authenticated: true,
                terminal_channel_ready: true,
                file_transfer_ready: false,
            }),
        })
    }

    pub fn update_title(
        &self,
        connection_id: &str,
        title: String,
    ) -> Result<ConnectionSession, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "connection manager lock poisoned".to_string())?;
        let session = sessions
            .get_mut(connection_id)
            .ok_or_else(|| format!("connection not found: {connection_id}"))?;

        session.title = title;
        Ok(session.clone())
    }

    pub fn open_placeholder(
        &self,
        profile: ConnectionProfile,
    ) -> Result<ConnectionSession, String> {
        let session = match profile.r#type {
            ConnectionType::Ssh => {
                let backend = SshBackend;
                let _protocol_type = backend.protocol_type();
                backend.connect_placeholder(profile)?
            }
            ConnectionType::Sftp => {
                let backend = SftpBackend;
                let _protocol_type = backend.protocol_type();
                backend.connect_placeholder(profile)?
            }
            ConnectionType::Telnet => {
                let backend = TelnetBackend;
                let _protocol_type = backend.protocol_type();
                return Err("TODO: Telnet backend is reserved but not enabled in v0.1".to_string());
            }
            ConnectionType::Serial => {
                let backend = SerialBackend;
                let _protocol_type = backend.protocol_type();
                backend.connect_placeholder(profile)?
            }
            ConnectionType::RawTcp => {
                let backend = RawTcpBackend;
                let _protocol_type = backend.protocol_type();
                return Err("TODO: Raw TCP backend is reserved but not enabled in v0.1".to_string());
            }
        };

        self.register_session(session)
    }

    #[cfg(test)]
    pub fn open_verified_ssh_transport(
        &self,
        profile: ConnectionProfile,
        probe: SshEndpointProbeResult,
    ) -> Result<ConnectionSession, String> {
        if !matches!(profile.r#type, ConnectionType::Ssh | ConnectionType::Sftp) {
            return Err("verified SSH transport can only open SSH/SFTP profiles".to_string());
        }

        let mut session = match profile.r#type {
            ConnectionType::Sftp => SftpBackend.connect_placeholder(profile)?,
            _ => SshBackend.connect_placeholder(profile)?,
        };
        session.status = ConnectionStatus::Ready;
        session.transport = Some(ConnectionTransportInfo {
            kind: ConnectionTransportKind::Ssh,
            host: probe.transport.host,
            port: probe.transport.port,
            server_identification: Some(probe.transport.server_identification),
            host_key_fingerprint: Some(probe.host_key_fingerprint),
            authenticated: false,
            terminal_channel_ready: false,
            file_transfer_ready: false,
        });

        self.register_session(session)
    }

    pub fn open_pending_ssh_transport(
        &self,
        profile: ConnectionProfile,
    ) -> Result<ConnectionSession, String> {
        if !matches!(profile.r#type, ConnectionType::Ssh | ConnectionType::Sftp) {
            return Err("pending SSH transport can only open SSH/SFTP profiles".to_string());
        }

        let mut session = match profile.r#type {
            ConnectionType::Sftp => SftpBackend.connect_placeholder(profile)?,
            _ => SshBackend.connect_placeholder(profile)?,
        };
        session.status = ConnectionStatus::Connecting;
        self.register_session(session)
    }

    pub fn mark_ssh_transport_ready(
        &self,
        connection_id: &str,
        host: String,
        port: u16,
        host_key_fingerprint: String,
    ) -> Result<ConnectionSession, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "connection manager lock poisoned".to_string())?;
        let session = sessions
            .get_mut(connection_id)
            .ok_or_else(|| format!("connection not found: {connection_id}"))?;

        session.status = ConnectionStatus::Ready;
        session.transport = Some(ConnectionTransportInfo {
            kind: ConnectionTransportKind::Ssh,
            host,
            port,
            server_identification: None,
            host_key_fingerprint: Some(host_key_fingerprint),
            authenticated: false,
            terminal_channel_ready: false,
            file_transfer_ready: false,
        });

        Ok(session.clone())
    }

    fn register_session(
        &self,
        mut session: ConnectionSession,
    ) -> Result<ConnectionSession, String> {
        let mut next_sequence = self
            .next_sequence
            .lock()
            .map_err(|_| "connection sequence lock poisoned".to_string())?;
        *next_sequence = next_sequence.saturating_add(1);
        session.id = format!("session-{}-{}", session.profile_id, next_sequence);

        self.sessions
            .lock()
            .map_err(|_| "connection manager lock poisoned".to_string())?
            .insert(session.id.clone(), session.clone());

        Ok(session)
    }

    pub fn close(&self, connection_id: &str) -> Result<(), String> {
        // TODO: close terminal/file-transfer handles before dropping the session.
        self.sessions
            .lock()
            .map_err(|_| "connection manager lock poisoned".to_string())?
            .remove(connection_id);

        Ok(())
    }

    pub fn get(&self, connection_id: &str) -> Result<Option<ConnectionSession>, String> {
        Ok(self
            .sessions
            .lock()
            .map_err(|_| "connection manager lock poisoned".to_string())?
            .get(connection_id)
            .cloned())
    }

    pub fn mark_ssh_authenticated(
        &self,
        connection_id: &str,
        file_transfer_ready: bool,
    ) -> Result<ConnectionSession, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "connection manager lock poisoned".to_string())?;
        let session = sessions
            .get_mut(connection_id)
            .ok_or_else(|| format!("connection not found: {connection_id}"))?;

        let transport = session
            .transport
            .as_mut()
            .ok_or_else(|| "connection has no SSH transport metadata".to_string())?;
        if !matches!(transport.kind, ConnectionTransportKind::Ssh) {
            return Err("only SSH connections can be marked authenticated".to_string());
        }

        transport.authenticated = true;
        transport.terminal_channel_ready = false;
        transport.file_transfer_ready = file_transfer_ready;
        session.status = ConnectionStatus::Connected;

        Ok(session.clone())
    }

    pub fn mark_sftp_ready(&self, connection_id: &str) -> Result<ConnectionSession, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "connection manager lock poisoned".to_string())?;
        let session = sessions
            .get_mut(connection_id)
            .ok_or_else(|| format!("connection not found: {connection_id}"))?;
        let transport = session
            .transport
            .as_mut()
            .ok_or_else(|| "connection has no SSH transport metadata".to_string())?;

        if !transport.authenticated {
            return Err("SSH must be authenticated before opening SFTP".to_string());
        }

        transport.file_transfer_ready = true;

        Ok(session.clone())
    }

    pub fn mark_terminal_channel_ready(
        &self,
        connection_id: &str,
    ) -> Result<ConnectionSession, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "connection manager lock poisoned".to_string())?;
        let session = sessions
            .get_mut(connection_id)
            .ok_or_else(|| format!("connection not found: {connection_id}"))?;
        let transport = session
            .transport
            .as_mut()
            .ok_or_else(|| "connection has no SSH transport metadata".to_string())?;

        if !transport.authenticated {
            return Err("SSH must be authenticated before opening PTY".to_string());
        }

        transport.terminal_channel_ready = true;

        Ok(session.clone())
    }
}
