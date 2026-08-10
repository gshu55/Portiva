use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::domain::network_scan::{NetworkScanRequest, NetworkScanResult};

#[derive(Default)]
struct TcpProbeResult {
    open_ports: Vec<u16>,
    responded: bool,
}

pub(crate) async fn scan_host(ip: Ipv4Addr, request: NetworkScanRequest) -> NetworkScanResult {
    let timeout = Duration::from_millis(request.timeout_ms);
    let ping_task = request
        .ping_enabled
        .then(|| tauri::async_runtime::spawn_blocking(move || probe_ping(ip, request.timeout_ms)));
    let tcp_task = request.tcp_enabled.then(|| {
        let ports = request.ports.clone();
        tauri::async_runtime::spawn(async move { probe_tcp(ip, ports, timeout).await })
    });

    let mut ping_succeeded = false;
    let mut latency_ms = None;
    let mut error = None;
    if let Some(task) = ping_task {
        match task.await {
            Ok(Ok(latency)) => {
                ping_succeeded = latency.is_some();
                latency_ms = latency;
            }
            Ok(Err(probe_error)) => error = Some(probe_error),
            Err(task_error) => error = Some(format!("Ping 任务执行失败：{task_error}")),
        }
    }

    let tcp_result = if let Some(task) = tcp_task {
        match task.await {
            Ok(result) => result,
            Err(task_error) => {
                error.get_or_insert_with(|| format!("TCP 任务执行失败：{task_error}"));
                TcpProbeResult::default()
            }
        }
    } else {
        TcpProbeResult::default()
    };

    let mut discovery_methods = Vec::with_capacity(2);
    if ping_succeeded {
        discovery_methods.push("ping".to_string());
    }
    if tcp_result.responded {
        discovery_methods.push("tcp".to_string());
    }

    NetworkScanResult {
        ip: ip.to_string(),
        reachable: ping_succeeded || tcp_result.responded,
        ping_succeeded,
        latency_ms,
        open_ports: tcp_result.open_ports,
        discovery_methods,
        error,
    }
}

fn probe_ping(ip: Ipv4Addr, timeout_ms: u64) -> Result<Option<u64>, String> {
    let started_at = Instant::now();
    let mut command = ping_command(ip, timeout_ms);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let status = command
        .status()
        .map_err(|error| format!("无法启动系统 Ping：{error}"))?;
    Ok(status
        .success()
        .then(|| started_at.elapsed().as_millis() as u64))
}

#[cfg(target_os = "windows")]
fn ping_command(ip: Ipv4Addr, timeout_ms: u64) -> Command {
    let mut command = Command::new("ping");
    command.args(["-n", "1", "-w", &timeout_ms.to_string(), &ip.to_string()]);
    command
}

#[cfg(target_os = "macos")]
fn ping_command(ip: Ipv4Addr, timeout_ms: u64) -> Command {
    let mut command = Command::new("/sbin/ping");
    command.args([
        "-n",
        "-c",
        "1",
        "-W",
        &timeout_ms.to_string(),
        &ip.to_string(),
    ]);
    command
}

#[cfg(all(unix, not(target_os = "macos")))]
fn ping_command(ip: Ipv4Addr, timeout_ms: u64) -> Command {
    let timeout_seconds = timeout_ms.div_ceil(1000).max(1);
    let mut command = Command::new("ping");
    command.args([
        "-n",
        "-c",
        "1",
        "-W",
        &timeout_seconds.to_string(),
        &ip.to_string(),
    ]);
    command
}

async fn probe_tcp(ip: Ipv4Addr, ports: Vec<u16>, timeout: Duration) -> TcpProbeResult {
    let mut jobs = Vec::with_capacity(ports.len());
    for port in ports {
        jobs.push(tauri::async_runtime::spawn(async move {
            let address = SocketAddr::new(IpAddr::V4(ip), port);
            let result =
                tokio::time::timeout(timeout, tokio::net::TcpStream::connect(address)).await;
            (port, result)
        }));
    }

    let mut probe = TcpProbeResult::default();
    for job in jobs {
        let Ok((port, result)) = job.await else {
            continue;
        };
        match result {
            Ok(Ok(_)) => {
                probe.responded = true;
                probe.open_ports.push(port);
            }
            Ok(Err(error)) if error.kind() == ErrorKind::ConnectionRefused => {
                probe.responded = true;
            }
            Ok(Err(_)) | Err(_) => {}
        }
    }
    probe.open_ports.sort_unstable();
    probe
}

#[cfg(test)]
mod tests {
    use super::ping_command;
    use std::net::Ipv4Addr;

    #[test]
    fn ping_command_targets_the_requested_address() {
        let address = Ipv4Addr::new(192, 0, 2, 15);
        let command = ping_command(address, 800);
        let args = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(args.iter().any(|value| value == "192.0.2.15"));
        assert!(args.iter().any(|value| value == "1"));
    }
}
