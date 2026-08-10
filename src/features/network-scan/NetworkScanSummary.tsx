import type { NetworkScanResult } from "../../shared/types";
import type { NetworkScannerStatus } from "./useNetworkScanner";

interface NetworkScanSummaryProps {
  results: NetworkScanResult[];
  scanned: number;
  status: NetworkScannerStatus;
  total: number;
}

const statusLabels: Record<NetworkScannerStatus, string> = {
  idle: "待命",
  starting: "准备中",
  running: "扫描中",
  cancelling: "正在停止",
  completed: "已完成",
  cancelled: "已停止",
  failed: "异常",
};

export function NetworkScanSummary({ results, scanned, status, total }: NetworkScanSummaryProps) {
  let online = 0;
  let pingHosts = 0;
  let openPorts = 0;
  for (const result of results) {
    if (result.reachable) online += 1;
    if (result.pingSucceeded) pingHosts += 1;
    openPorts += result.openPorts.length;
  }
  const progress = total ? Math.min(100, Math.round((scanned / total) * 100)) : 0;

  return (
    <section className="network-scan-summary" aria-label="扫描概况">
      <div className="network-scan-stat status">
        <span>任务状态</span>
        <strong>{statusLabels[status]}</strong>
        <i className={`network-scan-status-light ${status}`} aria-hidden="true" />
      </div>
      <div className="network-scan-stat">
        <span>扫描进度</span>
        <strong>{scanned}<small> / {total || "—"}</small></strong>
      </div>
      <div className="network-scan-stat">
        <span>在线主机</span>
        <strong>{online}</strong>
      </div>
      <div className="network-scan-stat">
        <span>Ping 响应</span>
        <strong>{pingHosts}</strong>
      </div>
      <div className="network-scan-stat">
        <span>开放端口</span>
        <strong>{openPorts}</strong>
      </div>
      <div className="network-scan-progress" aria-label={`扫描进度 ${progress}%`} role="progressbar" aria-valuemax={100} aria-valuemin={0} aria-valuenow={progress}>
        <span style={{ width: `${progress}%` }} />
      </div>
    </section>
  );
}
