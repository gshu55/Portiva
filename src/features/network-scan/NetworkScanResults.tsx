import { useDeferredValue, useMemo, useState } from "react";
import type { NetworkScanResult } from "../../shared/types";
import { Button, SegmentedControl, TextInput, VirtualList } from "../../shared/ui";
import type { NetworkScannerStatus } from "./useNetworkScanner";

type ResultFilter = "online" | "all" | "offline";

interface NetworkScanResultsProps {
  results: NetworkScanResult[];
  status: NetworkScannerStatus;
  onCreateProfile: (host: string, port: number) => void;
}

export function NetworkScanResults({ onCreateProfile, results, status }: NetworkScanResultsProps) {
  const [filter, setFilter] = useState<ResultFilter>("online");
  const [query, setQuery] = useState("");
  const deferredResults = useDeferredValue(results);
  const deferredQuery = useDeferredValue(query.trim());
  const counts = useMemo(() => {
    let online = 0;
    for (const result of deferredResults) {
      if (result.reachable) online += 1;
    }
    return { all: deferredResults.length, online, offline: deferredResults.length - online };
  }, [deferredResults]);
  const visibleResults = useMemo(() => deferredResults.filter((result) => {
    if (filter === "online" && !result.reachable) return false;
    if (filter === "offline" && result.reachable) return false;
    return !deferredQuery || result.ip.includes(deferredQuery) || result.openPorts.some((port) => String(port).includes(deferredQuery));
  }), [deferredQuery, deferredResults, filter]);

  const isScanning = status === "starting" || status === "running" || status === "cancelling";

  return (
    <section className="network-scan-results">
      <header className="network-scan-results-toolbar">
        <div>
          <span>DISCOVERY LOG</span>
          <h3>发现结果</h3>
        </div>
        <div className="network-scan-result-filters">
          <SegmentedControl
            aria-label="结果筛选"
            options={[
              { count: counts.online, label: "在线", value: "online" },
              { count: counts.all, label: "全部", value: "all" },
              { count: counts.offline, label: "无响应", value: "offline" },
            ]}
            value={filter}
            onChange={setFilter}
          />
          <TextInput
            aria-label="筛选 IP 或端口"
            leadingIcon="search"
            placeholder="筛选 IP / 端口"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
      </header>

      <div
        aria-label="网络扫描结果滚动区域"
        className="network-scan-table-scroll"
        role="region"
        tabIndex={0}
      >
        <div className="network-scan-table" role="table" aria-label="网络扫描结果">
          <div className="network-scan-table-header" role="row">
            <span role="columnheader">状态</span>
            <span role="columnheader">IP 地址</span>
            <span role="columnheader">发现方式</span>
            <span role="columnheader">延迟</span>
            <span role="columnheader">开放端口</span>
            <span role="columnheader">操作</span>
          </div>
          <VirtualList
            className="network-scan-table-body"
            empty={<NetworkScanEmptyState hasResults={results.length > 0} isScanning={isScanning} />}
            estimateHeight={48}
            items={visibleResults}
            keyExtractor={(result) => result.ip}
            renderItem={(result) => (
              <NetworkScanResultRow result={result} onCreateProfile={onCreateProfile} />
            )}
            role="rowgroup"
          />
        </div>
      </div>
    </section>
  );
}

function NetworkScanResultRow({
  onCreateProfile,
  result,
}: {
  onCreateProfile: (host: string, port: number) => void;
  result: NetworkScanResult;
}) {
  const recommendedPort = result.openPorts.includes(22)
    ? 22
    : result.openPorts.includes(23)
      ? 23
      : result.openPorts[0] ?? 22;

  return (
    <div className={`network-scan-row ${result.error ? "error" : result.reachable ? "online" : "offline"}`} role="row">
      <span className="network-scan-host-state" role="cell" title={result.error}>
        <i aria-hidden="true" />
        {result.error ? "错误" : result.reachable ? "在线" : "无响应"}
      </span>
      <strong className="network-scan-ip" role="cell">{result.ip}</strong>
      <span className="network-scan-methods" role="cell">
        {result.discoveryMethods.length
          ? result.discoveryMethods.map((method) => <small key={method}>{method.toUpperCase()}</small>)
          : <em>—</em>}
      </span>
      <span className="network-scan-latency" role="cell">
        {typeof result.latencyMs === "number" ? `${result.latencyMs} ms` : "—"}
      </span>
      <span className="network-scan-ports" role="cell" title={result.openPorts.join(", ")}>
        {result.openPorts.length ? result.openPorts.join(" · ") : "—"}
      </span>
      <span role="cell">
        <Button
          disabled={!result.reachable}
          icon="plus"
          onClick={() => onCreateProfile(result.ip, recommendedPort)}
          size="sm"
          title={`为 ${result.ip}:${recommendedPort} 新建连接`}
          tone="muted"
        >
          新建连接
        </Button>
      </span>
    </div>
  );
}

function NetworkScanEmptyState({ hasResults, isScanning }: { hasResults: boolean; isScanning: boolean }) {
  return (
    <div className="network-scan-empty">
      <div className={`network-scan-radar ${isScanning ? "active" : ""}`} aria-hidden="true">
        <i /><i /><i /><span />
      </div>
      <strong>{isScanning ? "正在监听局域网响应" : hasResults ? "当前筛选条件没有结果" : "等待扫描任务"}</strong>
      <p>{isScanning ? "结果将按批次实时进入列表" : hasResults ? "切换结果范围或修改筛选关键词" : "选择本机接口，使用 Ping 开始发现设备"}</p>
    </div>
  );
}
