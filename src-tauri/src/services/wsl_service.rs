use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};

const WSL_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(5);
const WSL_HOST_OVERVIEW_TIMEOUT: Duration = Duration::from_secs(4);

const WSL_HOST_OVERVIEW_COMMAND: &str = r#"LC_ALL=C
cpu_usage_percent=""
cpu_count=""
memory_total_kb=""
memory_available_kb=""
memory_free_kb=""
memory_buffers_kb=""
memory_cached_kb=""
disk_total_kb=""
disk_used_kb=""
network_received_bytes=""
network_transmitted_bytes=""
uptime_seconds=""

if [ -r /proc/stat ] && command -v awk >/dev/null 2>&1; then
  cpu_sample_1=$(awk '/^cpu / {total=0; for (i=2; i<=NF; i++) total += $i; print total, $5 + $6; exit}' /proc/stat)
  set -- $cpu_sample_1
  cpu_total_1=${1:-}
  cpu_idle_1=${2:-}
  sleep 0.2
  cpu_sample_2=$(awk '/^cpu / {total=0; for (i=2; i<=NF; i++) total += $i; print total, $5 + $6; exit}' /proc/stat)
  set -- $cpu_sample_2
  cpu_total_2=${1:-}
  cpu_idle_2=${2:-}
  if [ -n "$cpu_total_1" ] && [ -n "$cpu_total_2" ] && [ "$cpu_total_2" -gt "$cpu_total_1" ] 2>/dev/null; then
    cpu_usage_percent=$(awk -v total1="$cpu_total_1" -v idle1="$cpu_idle_1" -v total2="$cpu_total_2" -v idle2="$cpu_idle_2" 'BEGIN {delta=total2-total1; idle=idle2-idle1; if (delta > 0) printf "%.1f", ((delta-idle)*100)/delta}')
  fi
fi

if command -v getconf >/dev/null 2>&1; then
  cpu_count=$(getconf _NPROCESSORS_ONLN 2>/dev/null)
fi
if [ -z "$cpu_count" ] && command -v nproc >/dev/null 2>&1; then
  cpu_count=$(nproc 2>/dev/null)
fi

if [ -r /proc/meminfo ]; then
  while read key value unit; do
    case "$key" in
      MemTotal:) memory_total_kb=$value ;;
      MemAvailable:) memory_available_kb=$value ;;
      MemFree:) memory_free_kb=$value ;;
      Buffers:) memory_buffers_kb=$value ;;
      Cached:) memory_cached_kb=$value ;;
    esac
  done < /proc/meminfo
fi
if [ -z "$memory_available_kb" ] && [ -n "$memory_free_kb" ]; then
  memory_available_kb=$((memory_free_kb + memory_buffers_kb + memory_cached_kb))
fi

if [ -r /proc/uptime ]; then
  read uptime_seconds _ < /proc/uptime
  uptime_seconds=${uptime_seconds%%.*}
fi

if command -v df >/dev/null 2>&1 && command -v awk >/dev/null 2>&1; then
  disk_values=$(df -Pk / 2>/dev/null | awk 'END {print $2 " " $3}')
  set -- $disk_values
  disk_total_kb=${1:-}
  disk_used_kb=${2:-}
fi

if [ -r /proc/net/dev ] && command -v awk >/dev/null 2>&1; then
  network_values=$(awk -F '[: ]+' '$2 != "lo" && NF >= 11 {received += $3; transmitted += $11} END {printf "%.0f %.0f", received, transmitted}' /proc/net/dev)
  set -- $network_values
  network_received_bytes=${1:-}
  network_transmitted_bytes=${2:-}
fi

if [ -r /etc/os-release ]; then
  . /etc/os-release
  operating_system=${PRETTY_NAME:-${NAME:-Linux}}
else
  operating_system=$(uname -s 2>/dev/null)
fi
hostname_value=$(hostname 2>/dev/null)
kernel_version=$(uname -r 2>/dev/null)

printf 'portivaWslOverviewVersion\t1\n'
printf 'hostname\t%s\n' "$hostname_value"
printf 'operatingSystem\t%s\n' "$operating_system"
printf 'kernelVersion\t%s\n' "$kernel_version"
printf 'cpuUsagePercent\t%s\n' "$cpu_usage_percent"
printf 'cpuCount\t%s\n' "$cpu_count"
printf 'memoryTotalKb\t%s\n' "$memory_total_kb"
printf 'memoryAvailableKb\t%s\n' "$memory_available_kb"
printf 'diskTotalKb\t%s\n' "$disk_total_kb"
printf 'diskUsedKb\t%s\n' "$disk_used_kb"
printf 'networkReceivedBytes\t%s\n' "$network_received_bytes"
printf 'networkTransmittedBytes\t%s\n' "$network_transmitted_bytes"
printf 'uptimeSeconds\t%s\n' "$uptime_seconds"
"#;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WslDiscovery {
    pub supported: bool,
    pub available: bool,
    pub distributions: Vec<WslDistributionInfo>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WslDistributionInfo {
    pub name: String,
    pub is_default: bool,
    pub state: WslDistributionState,
    pub version: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WslDistributionState {
    Running,
    Stopped,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WslHostOverview {
    pub distribution: String,
    pub hostname: String,
    pub operating_system: String,
    pub kernel_version: String,
    pub cpu_usage_percent: Option<f64>,
    pub cpu_count: Option<u32>,
    pub memory_used_bytes: Option<u64>,
    pub memory_total_bytes: Option<u64>,
    pub disk_used_bytes: Option<u64>,
    pub disk_total_bytes: Option<u64>,
    pub network_received_bytes: Option<u64>,
    pub network_transmitted_bytes: Option<u64>,
    pub uptime_seconds: Option<u64>,
    pub latency_ms: u64,
}

pub fn discover_wsl() -> WslDiscovery {
    discover_wsl_for_platform()
}

pub fn collect_wsl_host_overview(distribution: &str) -> Result<WslHostOverview, String> {
    let distribution = validate_distribution_name(distribution)?;
    ensure_distribution_is_running(&discover_wsl(), distribution)?;
    collect_wsl_host_overview_for_platform(distribution)
}

fn validate_distribution_name(distribution: &str) -> Result<&str, String> {
    let distribution = distribution.trim();
    if distribution.is_empty() {
        return Err("WSL 发行版名称不能为空".to_string());
    }
    if distribution.contains(['\r', '\n', '\0']) {
        return Err("WSL 发行版名称包含无效字符".to_string());
    }
    Ok(distribution)
}

fn ensure_distribution_is_running(
    discovery: &WslDiscovery,
    distribution: &str,
) -> Result<(), String> {
    if !discovery.supported {
        return Err("当前平台不支持 WSL".to_string());
    }
    if !discovery.available {
        return Err(discovery
            .message
            .clone()
            .unwrap_or_else(|| "WSL 当前不可用".to_string()));
    }

    let found = discovery
        .distributions
        .iter()
        .find(|item| item.name == distribution)
        .ok_or_else(|| format!("未找到 WSL 发行版：{distribution}"))?;
    if found.state != WslDistributionState::Running {
        return Err(format!("WSL 发行版 {distribution} 未运行，已跳过资源采集"));
    }
    Ok(())
}

#[cfg(windows)]
fn collect_wsl_host_overview_for_platform(distribution: &str) -> Result<WslHostOverview, String> {
    let started_at = Instant::now();
    let output = run_wsl_command(
        &[
            "--distribution",
            distribution,
            "--exec",
            "sh",
            "-lc",
            WSL_HOST_OVERVIEW_COMMAND,
        ],
        WSL_HOST_OVERVIEW_TIMEOUT,
    )
    .map_err(|error| {
        if error.kind() == std::io::ErrorKind::TimedOut {
            format!(
                "读取 WSL 资源占用超时（{} 秒）",
                WSL_HOST_OVERVIEW_TIMEOUT.as_secs()
            )
        } else {
            format!("无法读取 WSL 资源占用：{error}")
        }
    })?;

    let stdout = decode_wsl_output(&output.stdout);
    if !output.status.success() {
        let stderr = decode_wsl_output(&output.stderr);
        let detail = [stderr.trim(), stdout.trim()]
            .into_iter()
            .find(|value| !value.is_empty())
            .unwrap_or("WSL 资源采集命令执行失败");
        return Err(detail.to_string());
    }

    parse_wsl_host_overview(distribution, &stdout, started_at.elapsed())
}

#[cfg(not(windows))]
fn collect_wsl_host_overview_for_platform(_distribution: &str) -> Result<WslHostOverview, String> {
    Err("当前平台不支持 WSL".to_string())
}

#[cfg(windows)]
fn discover_wsl_for_platform() -> WslDiscovery {
    use std::io::ErrorKind;

    let output = match run_wsl_command(&["--list", "--verbose"], WSL_DISCOVERY_TIMEOUT) {
        Ok(output) => output,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return WslDiscovery {
                supported: true,
                available: false,
                distributions: Vec::new(),
                message: Some("未找到 wsl.exe，请先在 Windows 中安装 WSL。".to_string()),
            };
        }
        Err(error) => {
            return WslDiscovery {
                supported: true,
                available: false,
                distributions: Vec::new(),
                message: Some(if error.kind() == ErrorKind::TimedOut {
                    format!("查询 WSL 超时（{} 秒）", WSL_DISCOVERY_TIMEOUT.as_secs())
                } else {
                    format!("无法查询 WSL：{error}")
                }),
            };
        }
    };

    let stdout = decode_wsl_output(&output.stdout);
    if !output.status.success() {
        let stderr = decode_wsl_output(&output.stderr);
        let detail = [stderr.trim(), stdout.trim()]
            .into_iter()
            .find(|value| !value.is_empty())
            .unwrap_or("WSL 命令执行失败");
        return WslDiscovery {
            supported: true,
            available: false,
            distributions: Vec::new(),
            message: Some(detail.to_string()),
        };
    }

    let distributions = parse_wsl_distributions(&stdout);
    WslDiscovery {
        supported: true,
        available: true,
        message: if distributions.is_empty() {
            Some("WSL 已启用，但尚未安装 Linux 发行版。".to_string())
        } else {
            None
        },
        distributions,
    }
}

#[cfg(windows)]
fn run_wsl_command(args: &[&str], timeout: Duration) -> std::io::Result<std::process::Output> {
    use std::io::{Error, ErrorKind, Read};
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Output, Stdio};
    use std::thread;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut child = Command::new("wsl.exe")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let deadline = Instant::now() + timeout;

    loop {
        if let Some(status) = child.try_wait()? {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            if let Some(mut pipe) = child.stdout.take() {
                pipe.read_to_end(&mut stdout)?;
            }
            if let Some(mut pipe) = child.stderr.take() {
                pipe.read_to_end(&mut stderr)?;
            }
            return Ok(Output {
                status,
                stdout,
                stderr,
            });
        }

        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::new(ErrorKind::TimedOut, "wsl.exe command timed out"));
        }
        thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(not(windows))]
fn discover_wsl_for_platform() -> WslDiscovery {
    WslDiscovery {
        supported: false,
        available: false,
        distributions: Vec::new(),
        message: None,
    }
}

fn decode_wsl_output(bytes: &[u8]) -> String {
    let looks_like_utf16_le = bytes.starts_with(&[0xff, 0xfe])
        || bytes
            .iter()
            .skip(1)
            .step_by(2)
            .take(32)
            .any(|byte| *byte == 0);

    if !looks_like_utf16_le {
        return String::from_utf8_lossy(bytes)
            .trim_start_matches('\u{feff}')
            .to_string();
    }

    let units = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .skip_while(|unit| *unit == 0xfeff)
        .collect::<Vec<_>>();
    String::from_utf16_lossy(&units)
        .trim_matches('\0')
        .to_string()
}

fn parse_wsl_distributions(output: &str) -> Vec<WslDistributionInfo> {
    output
        .lines()
        .filter_map(parse_wsl_distribution_line)
        .collect()
}

fn parse_wsl_distribution_line(line: &str) -> Option<WslDistributionInfo> {
    let line = line.trim_matches(['\0', '\u{feff}', '\r', '\n']).trim();
    if line.is_empty() {
        return None;
    }

    let is_default = line.starts_with('*');
    let fields = line.strip_prefix('*').unwrap_or(line).trim_start();
    let (name_and_state, version_label) = take_last_field(fields)?;
    let version = version_label.parse::<u8>().ok()?;
    if version != 1 && version != 2 {
        return None;
    }

    let (name, state_label) = take_last_field(name_and_state)?;
    if name.is_empty() {
        return None;
    }

    Some(WslDistributionInfo {
        name: name.to_string(),
        is_default,
        state: parse_wsl_state(state_label),
        version: Some(version),
    })
}

fn take_last_field(value: &str) -> Option<(&str, &str)> {
    let value = value.trim_end();
    let boundary = value.rfind(|character: char| character.is_whitespace())?;
    let field = value[boundary..].trim();
    let remaining = value[..boundary].trim_end();
    (!field.is_empty() && !remaining.is_empty()).then_some((remaining, field))
}

fn parse_wsl_state(value: &str) -> WslDistributionState {
    let normalized = value.trim().to_lowercase();
    if normalized == "running" || normalized.contains("运行") {
        WslDistributionState::Running
    } else if normalized == "stopped" || normalized.contains("停止") {
        WslDistributionState::Stopped
    } else {
        WslDistributionState::Unknown
    }
}

fn parse_wsl_host_overview(
    distribution: &str,
    output: &str,
    elapsed: Duration,
) -> Result<WslHostOverview, String> {
    let values = output
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .collect::<HashMap<_, _>>();

    if values.get("portivaWslOverviewVersion") != Some(&"1") {
        return Err("WSL 资源采集返回了不受支持的数据".to_string());
    }

    let memory_total_kb = parse_optional_number::<u64>(&values, "memoryTotalKb");
    let memory_available_kb = parse_optional_number::<u64>(&values, "memoryAvailableKb");
    let memory_total_bytes = memory_total_kb.map(|value| value.saturating_mul(1024));
    let memory_used_bytes = memory_total_kb
        .zip(memory_available_kb)
        .map(|(total, available)| total.saturating_sub(available).saturating_mul(1024));
    let cpu_usage_percent = parse_optional_number::<f64>(&values, "cpuUsagePercent")
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value.clamp(0.0, 100.0));
    let cpu_count = parse_optional_number::<u32>(&values, "cpuCount").filter(|value| *value > 0);
    let disk_total_bytes = parse_optional_number::<u64>(&values, "diskTotalKb")
        .map(|value| value.saturating_mul(1024));
    let disk_used_bytes =
        parse_optional_number::<u64>(&values, "diskUsedKb").map(|value| value.saturating_mul(1024));

    Ok(WslHostOverview {
        distribution: distribution.to_string(),
        hostname: value_or_fallback(&values, "hostname", distribution),
        operating_system: value_or_fallback(&values, "operatingSystem", "Linux"),
        kernel_version: value_or_fallback(&values, "kernelVersion", "未知内核"),
        cpu_usage_percent,
        cpu_count,
        memory_used_bytes,
        memory_total_bytes,
        disk_used_bytes,
        disk_total_bytes,
        network_received_bytes: parse_optional_number::<u64>(&values, "networkReceivedBytes"),
        network_transmitted_bytes: parse_optional_number::<u64>(&values, "networkTransmittedBytes"),
        uptime_seconds: parse_optional_number::<u64>(&values, "uptimeSeconds"),
        latency_ms: elapsed.as_millis().clamp(1, u64::MAX as u128) as u64,
    })
}

fn parse_optional_number<T>(values: &HashMap<&str, &str>, key: &str) -> Option<T>
where
    T: std::str::FromStr,
{
    values.get(key)?.trim().parse().ok()
}

fn value_or_fallback(values: &HashMap<&str, &str>, key: &str, fallback: &str) -> String {
    values
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        decode_wsl_output, ensure_distribution_is_running, parse_wsl_distributions,
        parse_wsl_host_overview, WslDiscovery, WslDistributionInfo, WslDistributionState,
    };
    use std::time::Duration;

    #[test]
    fn parses_verbose_wsl_list_with_default_and_spaced_names() {
        let output = "  NAME                   STATE           VERSION\r\n\
                      * Ubuntu                 Running         2\r\n\
                        Team Linux             Stopped         1\r\n";

        assert_eq!(
            parse_wsl_distributions(output),
            vec![
                WslDistributionInfo {
                    name: "Ubuntu".to_string(),
                    is_default: true,
                    state: WslDistributionState::Running,
                    version: Some(2),
                },
                WslDistributionInfo {
                    name: "Team Linux".to_string(),
                    is_default: false,
                    state: WslDistributionState::Stopped,
                    version: Some(1),
                },
            ]
        );
    }

    #[test]
    fn decodes_utf16_le_wsl_output() {
        let value = "\u{feff}* Ubuntu  Running  2\r\n";
        let bytes = value
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();

        assert_eq!(
            decode_wsl_output(&bytes),
            value.trim_start_matches('\u{feff}')
        );
    }

    #[test]
    fn recognizes_localized_states() {
        let distributions = parse_wsl_distributions("* Ubuntu  正在运行  2\r\n  Debian  已停止  2");

        assert_eq!(distributions[0].state, WslDistributionState::Running);
        assert_eq!(distributions[1].state, WslDistributionState::Stopped);
    }

    #[test]
    fn parses_wsl_host_overview_metrics() {
        let output = "portivaWslOverviewVersion\t1\n\
                      hostname\tportiva-dev\n\
                      operatingSystem\tUbuntu 24.04 LTS\n\
                      kernelVersion\t6.6.87.2-microsoft-standard-WSL2\n\
                      cpuUsagePercent\t27.5\n\
                      cpuCount\t8\n\
                      memoryTotalKb\t8192000\n\
                      memoryAvailableKb\t6144000\n\
                      diskTotalKb\t104857600\n\
                      diskUsedKb\t26214400\n\
                      networkReceivedBytes\t1024\n\
                      networkTransmittedBytes\t2048\n\
                      uptimeSeconds\t3600\n";

        let overview = parse_wsl_host_overview("Ubuntu", output, Duration::from_millis(240))
            .expect("overview should parse");

        assert_eq!(overview.distribution, "Ubuntu");
        assert_eq!(overview.hostname, "portiva-dev");
        assert_eq!(overview.cpu_usage_percent, Some(27.5));
        assert_eq!(overview.cpu_count, Some(8));
        assert_eq!(overview.memory_used_bytes, Some(2_097_152_000));
        assert_eq!(overview.disk_used_bytes, Some(26_843_545_600));
        assert_eq!(overview.network_transmitted_bytes, Some(2048));
        assert_eq!(overview.uptime_seconds, Some(3600));
        assert_eq!(overview.latency_ms, 240);
    }

    #[test]
    fn refuses_to_collect_metrics_from_stopped_distribution() {
        let discovery = WslDiscovery {
            supported: true,
            available: true,
            distributions: vec![WslDistributionInfo {
                name: "Ubuntu".to_string(),
                is_default: true,
                state: WslDistributionState::Stopped,
                version: Some(2),
            }],
            message: None,
        };

        let error = ensure_distribution_is_running(&discovery, "Ubuntu")
            .expect_err("stopped distributions must not be sampled");
        assert!(error.contains("未运行"));
        assert!(error.contains("跳过资源采集"));
    }
}
