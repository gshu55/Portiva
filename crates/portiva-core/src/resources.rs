//! Read-only Linux resource sampling over a separate SSH exec channel.
use crate::{Client, SessionId};
use anyhow::{Context, Result, bail};
use russh::ChannelMsg;
use std::time::Duration;

const COMMAND: &str = "if [ ! -r /proc/stat ] || [ ! -r /proc/meminfo ]; then exit 69; fi\nLC_ALL=C\nexport LC_ALL\nprintf 'PORTIVA_RESOURCES_V1\\n'\nhead -n 1 /proc/stat\nprintf '__MEMORY__\\n'\ncat /proc/meminfo\nprintf '__DISK__\\n'\ndf -Pk / 2>/dev/null || :";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CpuCounters {
    total: u64,
    idle: u64,
}

impl CpuCounters {
    /// First samples and counter resets have no meaningful utilization yet.
    pub fn usage_since(self, previous: Self) -> Option<f32> {
        let total = self.total.checked_sub(previous.total)?;
        let idle = self.idle.checked_sub(previous.idle)?;
        (total > 0).then(|| 100. * total.saturating_sub(idle) as f32 / total as f32)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResourceUsage {
    pub used: u64,
    pub total: u64,
}

impl ResourceUsage {
    pub fn percent(self) -> f32 {
        if self.total == 0 {
            0.
        } else {
            (100. * self.used as f32 / self.total as f32).clamp(0., 100.)
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteResources {
    pub cpu: CpuCounters,
    pub memory: Option<ResourceUsage>,
    /// Used bytes and full capacity of the filesystem mounted at `/`.
    pub disk: Option<ResourceUsage>,
}

impl Client {
    pub async fn remote_resources(&self, id: SessionId) -> Result<RemoteResources> {
        let session = self.session(id)?;
        let mut channel = tokio::select! {
            _ = session.cancelled.cancelled() => bail!("连接已关闭"),
            result = tokio::time::timeout(Duration::from_secs(6), async {
                session.handle.lock().await.channel_open_session().await
            }) => result.context("资源采集通道超时")??,
        };
        let result = tokio::select! {
            _ = session.cancelled.cancelled() => Err(anyhow::anyhow!("连接已关闭")),
            result = tokio::time::timeout(Duration::from_secs(6), async {
                channel.exec(true, COMMAND).await?;
                let mut output = Vec::new();
                let mut received = 0;
                let mut exit_status = None;
                while let Some(message) = channel.wait().await {
                    match message {
                        ChannelMsg::Data { data } => {
                            received += data.len();
                            output.extend_from_slice(&data);
                        }
                        ChannelMsg::ExtendedData { data, .. } => received += data.len(),
                        ChannelMsg::Failure => bail!("服务器拒绝资源采集通道"),
                        ChannelMsg::ExitStatus { exit_status: status } => exit_status = Some(status),
                        ChannelMsg::Close | ChannelMsg::Eof => break,
                        _ => {}
                    }
                    anyhow::ensure!(received <= 64 * 1024, "资源采集输出过大");
                }
                anyhow::ensure!(exit_status.is_none_or(|status| status == 0), "服务器不支持资源采集（需要 Linux /proc）");
                parse_resources(std::str::from_utf8(&output).context("资源采集编码无效")?)
            }) => result.context("资源采集超时").and_then(|result| result),
        };
        // Close only this exec channel, including on rejection, cancellation and timeout.
        let _ = tokio::time::timeout(Duration::from_secs(1), channel.close()).await;
        result
    }
}

fn parse_resources(output: &str) -> Result<RemoteResources> {
    let (_, output) = output
        .split_once("PORTIVA_RESOURCES_V1\n")
        .context("服务器未返回 Linux 资源数据")?;
    let (cpu, rest) = output.split_once("__MEMORY__\n").context("缺少 CPU 数据")?;
    let (memory, disk) = rest.split_once("__DISK__\n").context("缺少内存数据")?;
    let mut fields = cpu.split_whitespace();
    anyhow::ensure!(fields.next() == Some("cpu"), "CPU 数据无效");
    // guest/guest_nice are already included in user/nice; never sum them twice.
    let counters: Vec<u64> = fields
        .take(8)
        .map(str::parse)
        .collect::<std::result::Result<_, _>>()?;
    anyhow::ensure!(counters.len() >= 4, "CPU 计数器不完整");
    let total = counters
        .iter()
        .try_fold(0u64, |sum, value| sum.checked_add(*value))
        .context("CPU 计数器溢出")?;
    let idle = counters[3]
        .checked_add(counters.get(4).copied().unwrap_or_default())
        .context("CPU 空闲计数器溢出")?;
    let value = |key: &str| -> Option<u64> {
        memory.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            (name == key)
                .then(|| {
                    value
                        .split_whitespace()
                        .next()?
                        .parse::<u64>()
                        .ok()?
                        .checked_mul(1024)
                })
                .flatten()
        })
    };
    let memory = value("MemTotal")
        .filter(|total| *total > 0)
        .and_then(|total| {
            let available = value("MemAvailable").or_else(|| {
                value("MemFree")?
                    .checked_add(value("Buffers")?)?
                    .checked_add(value("Cached")?)?
                    .checked_add(value("SReclaimable").unwrap_or_default())
                    .map(|free| free.saturating_sub(value("Shmem").unwrap_or_default()))
            })?;
            Some(ResourceUsage {
                used: total.saturating_sub(available),
                total,
            })
        });
    let disk = disk.lines().skip(1).find_map(|line| {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() < 6 {
            return None;
        }
        let used = fields[2].parse::<u64>().ok()?.checked_mul(1024)?;
        let total = fields[1]
            .parse::<u64>()
            .ok()?
            .checked_mul(1024)
            .filter(|total| *total > 0)?;
        Some(ResourceUsage { used, total })
    });
    Ok(RemoteResources {
        cpu: CpuCounters { total, idle },
        memory,
        disk,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample(cpu: &str, mem: &str, disk: &str) -> String {
        format!("PORTIVA_RESOURCES_V1\ncpu {cpu}\n__MEMORY__\n{mem}\n__DISK__\n{disk}")
    }
    #[test]
    fn cpu_deltas_ignore_guest_and_memory_uses_available() {
        let a = parse_resources(&sample("100 0 50 800 50 0 0 0 20 0", "MemTotal: 1000 kB\nMemAvailable: 600 kB", "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 1000 300 600 34% /")).unwrap();
        let b = parse_resources(&sample(
            "140 0 60 840 60 0 0 0 40 0",
            "MemTotal: 1000 kB\nMemAvailable: 600 kB",
            "",
        ))
        .unwrap();
        assert_eq!(b.cpu.usage_since(a.cpu), Some(50.));
        assert_eq!(a.cpu.usage_since(a.cpu), None);
        assert_eq!(a.cpu.usage_since(b.cpu), None);
        assert_eq!(a.memory.unwrap().percent(), 40.);
        assert_eq!(
            a.disk.unwrap(),
            ResourceUsage {
                used: 300 * 1024,
                total: 1000 * 1024
            }
        );
        assert_eq!(b.disk, None);
    }
    #[test]
    fn missing_or_invalid_metrics_never_become_fake_zeroes() {
        assert!(parse_resources("permission denied").is_err());
        assert!(parse_resources(&sample("1 2", "", "")).is_err());
        assert!(parse_resources(&sample("18446744073709551615 2 3 4", "", "")).is_err());
        let a = parse_resources(&sample(
            "1 2 3 4",
            "MemTotal: 1000 kB\nMemFree: 200 kB\nBuffers: 20 kB\nCached: 100 kB\nShmem: 10 kB",
            "",
        ))
        .unwrap();
        assert_eq!(a.memory.unwrap().used, 690 * 1024);
        let b = parse_resources(&sample("1 2 3 4", "MemTotal: 1000 kB", "")).unwrap();
        assert_eq!(b.memory, None);
        assert_eq!(b.disk, None);
    }
}
