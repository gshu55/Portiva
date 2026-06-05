use crate::domain::capability::ConnectionCapabilities;
use crate::domain::connection::ConnectionSession;
use crate::domain::profile::{ConnectionProfile, ConnectionType};

pub mod raw_tcp;
pub mod serial;
pub mod ssh;
pub mod telnet;

pub trait ProtocolBackend: Send + Sync {
    fn protocol_type(&self) -> ConnectionType;

    fn capabilities(&self) -> ConnectionCapabilities;

    fn connect_placeholder(&self, profile: ConnectionProfile) -> Result<ConnectionSession, String>;
}
