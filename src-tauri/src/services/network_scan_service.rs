use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};

use crate::domain::network_scan::{
    NetworkInterfaceInfo, NetworkScanEvent, NetworkScanEventKind, NetworkScanRequest,
    NetworkScanResult, NetworkScanSession, NetworkScanStatus,
};
use crate::services::network_scan_interfaces::list_network_interfaces;
use crate::services::network_scan_probe::scan_host;
use crate::services::network_scan_subnet::cidr_hosts;

pub const NETWORK_SCAN_EVENT: &str = "portiva://network-scan-event";
const MAX_SCAN_PORTS: usize = 32;
const MIN_TIMEOUT_MS: u64 = 100;
const MAX_TIMEOUT_MS: u64 = 3 * 60 * 1000;
const MAX_CONCURRENCY: usize = 128;

#[derive(Default)]
pub struct NetworkScanService {
    tasks: Mutex<HashMap<String, Arc<AtomicBool>>>,
    next_sequence: AtomicU64,
}

struct PreparedScan {
    request: NetworkScanRequest,
    targets: Vec<Ipv4Addr>,
}

impl NetworkScanService {
    pub fn interfaces(&self) -> Result<Vec<NetworkInterfaceInfo>, String> {
        list_network_interfaces()
    }

    fn prepare(&self, mut request: NetworkScanRequest) -> Result<PreparedScan, String> {
        if !request.ping_enabled && !request.tcp_enabled {
            return Err("请至少启用一种主机探测方式".to_string());
        }
        if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&request.timeout_ms) {
            return Err(format!(
                "探测超时必须在 {MIN_TIMEOUT_MS}–{MAX_TIMEOUT_MS} 毫秒之间"
            ));
        }
        if request.concurrency == 0 || request.concurrency > MAX_CONCURRENCY {
            return Err(format!("并发数必须在 1–{MAX_CONCURRENCY} 之间"));
        }

        request.ports.sort_unstable();
        request.ports.dedup();
        if request.tcp_enabled && request.ports.is_empty() {
            return Err("启用 TCP 探测时至少需要填写一个端口".to_string());
        }
        if request.ports.len() > MAX_SCAN_PORTS {
            return Err(format!("一次最多探测 {MAX_SCAN_PORTS} 个 TCP 端口"));
        }

        let targets = cidr_hosts(request.cidr.trim())?;
        Ok(PreparedScan { request, targets })
    }

    fn register(&self, total: usize) -> Result<(NetworkScanSession, Arc<AtomicBool>), String> {
        let sequence = self.next_sequence.fetch_add(1, Ordering::Relaxed);
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let scan_id = format!("network-scan-{millis}-{sequence}");
        let cancelled = Arc::new(AtomicBool::new(false));
        self.tasks
            .lock()
            .map_err(|_| "网络扫描任务锁已损坏".to_string())?
            .insert(scan_id.clone(), Arc::clone(&cancelled));

        Ok((
            NetworkScanSession {
                scan_id,
                total,
                status: NetworkScanStatus::Running,
            },
            cancelled,
        ))
    }

    pub fn cancel(&self, scan_id: &str) -> Result<bool, String> {
        let tasks = self
            .tasks
            .lock()
            .map_err(|_| "网络扫描任务锁已损坏".to_string())?;
        let Some(cancelled) = tasks.get(scan_id) else {
            return Ok(false);
        };
        cancelled.store(true, Ordering::Relaxed);
        Ok(true)
    }

    fn finish(&self, scan_id: &str) {
        if let Ok(mut tasks) = self.tasks.lock() {
            tasks.remove(scan_id);
        }
    }
}

pub fn start_scan(
    app_handle: AppHandle,
    service: &NetworkScanService,
    request: NetworkScanRequest,
) -> Result<NetworkScanSession, String> {
    let prepared = service.prepare(request)?;
    let (session, cancelled) = service.register(prepared.targets.len())?;
    let scan_id = session.scan_id.clone();

    tauri::async_runtime::spawn(async move {
        run_scan(app_handle, scan_id, prepared, cancelled).await;
    });

    Ok(session)
}

async fn run_scan(
    app_handle: AppHandle,
    scan_id: String,
    prepared: PreparedScan,
    cancelled: Arc<AtomicBool>,
) {
    let total = prepared.targets.len();
    let mut scanned = 0usize;

    for chunk in prepared.targets.chunks(prepared.request.concurrency) {
        if cancelled.load(Ordering::Relaxed) {
            finish_with_event(
                &app_handle,
                &scan_id,
                NetworkScanEventKind::Cancelled,
                scanned,
                total,
                None,
            );
            return;
        }

        let mut jobs = Vec::with_capacity(chunk.len());
        for ip in chunk.iter().copied() {
            let request = prepared.request.clone();
            jobs.push((
                ip,
                tauri::async_runtime::spawn(async move { scan_host(ip, request).await }),
            ));
        }

        let mut results = Vec::with_capacity(jobs.len());
        for (ip, job) in jobs {
            match job.await {
                Ok(result) => results.push(result),
                Err(error) => results.push(NetworkScanResult {
                    ip: ip.to_string(),
                    reachable: false,
                    ping_succeeded: false,
                    latency_ms: None,
                    open_ports: Vec::new(),
                    discovery_methods: Vec::new(),
                    error: Some(format!("探测任务执行失败：{error}")),
                }),
            }
        }

        if cancelled.load(Ordering::Relaxed) {
            finish_with_event(
                &app_handle,
                &scan_id,
                NetworkScanEventKind::Cancelled,
                scanned,
                total,
                None,
            );
            return;
        }

        scanned += results.len();
        let _ = app_handle.emit(
            NETWORK_SCAN_EVENT,
            NetworkScanEvent {
                scan_id: scan_id.clone(),
                kind: NetworkScanEventKind::Progress,
                scanned,
                total,
                results,
                message: None,
            },
        );
    }

    finish_with_event(
        &app_handle,
        &scan_id,
        NetworkScanEventKind::Completed,
        scanned,
        total,
        None,
    );
}

fn finish_with_event(
    app_handle: &AppHandle,
    scan_id: &str,
    kind: NetworkScanEventKind,
    scanned: usize,
    total: usize,
    message: Option<String>,
) {
    app_handle.state::<NetworkScanService>().finish(scan_id);
    let _ = app_handle.emit(
        NETWORK_SCAN_EVENT,
        NetworkScanEvent {
            scan_id: scan_id.to_string(),
            kind,
            scanned,
            total,
            results: Vec::new(),
            message,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::{NetworkScanService, MAX_CONCURRENCY, MAX_TIMEOUT_MS};
    use crate::domain::network_scan::NetworkScanRequest;

    fn request(timeout_ms: u64, concurrency: usize) -> NetworkScanRequest {
        NetworkScanRequest {
            cidr: "192.168.1.1/32".to_string(),
            ping_enabled: true,
            tcp_enabled: false,
            ports: Vec::new(),
            timeout_ms,
            concurrency,
        }
    }

    #[test]
    fn accepts_timeout_and_concurrency_upper_bounds() {
        let service = NetworkScanService::default();
        let prepared = service.prepare(request(MAX_TIMEOUT_MS, MAX_CONCURRENCY));

        assert!(prepared.is_ok());
    }

    #[test]
    fn rejects_values_above_timeout_and_concurrency_upper_bounds() {
        let service = NetworkScanService::default();

        assert!(service
            .prepare(request(MAX_TIMEOUT_MS + 1, MAX_CONCURRENCY))
            .is_err());
        assert!(service
            .prepare(request(MAX_TIMEOUT_MS, MAX_CONCURRENCY + 1))
            .is_err());
    }
}
