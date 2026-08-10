use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterfaceInfo {
    pub name: String,
    pub address: String,
    pub prefix_length: u8,
    pub cidr: String,
    pub is_loopback: bool,
    pub is_private: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkScanRequest {
    pub cidr: String,
    pub ping_enabled: bool,
    pub tcp_enabled: bool,
    #[serde(default)]
    pub ports: Vec<u16>,
    pub timeout_ms: u64,
    pub concurrency: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkScanSession {
    pub scan_id: String,
    pub total: usize,
    pub status: NetworkScanStatus,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NetworkScanStatus {
    Running,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkScanResult {
    pub ip: String,
    pub reachable: bool,
    pub ping_succeeded: bool,
    pub latency_ms: Option<u64>,
    pub open_ports: Vec<u16>,
    pub discovery_methods: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NetworkScanEventKind {
    Progress,
    Completed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkScanEvent {
    pub scan_id: String,
    pub kind: NetworkScanEventKind,
    pub scanned: usize,
    pub total: usize,
    pub results: Vec<NetworkScanResult>,
    pub message: Option<String>,
}
