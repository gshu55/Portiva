import { Button, Select, TextInput, Toggle } from "../../shared/ui";
import type { NetworkInterfaceInfo } from "../../shared/types";
import {
  capNumericInput,
  MAX_SCAN_CONCURRENCY,
  MAX_SCAN_TIMEOUT_MS,
  MIN_SCAN_CONCURRENCY,
  MIN_SCAN_TIMEOUT_MS,
  type NetworkScanDraft,
} from "./networkScanConfig";

interface NetworkScanControlsProps {
  busy: boolean;
  draft: NetworkScanDraft;
  interfaces: NetworkInterfaceInfo[];
  interfacesLoading: boolean;
  selectedInterface: string;
  validationError?: string;
  onCancel: () => void;
  onChange: (patch: Partial<NetworkScanDraft>) => void;
  onInterfaceChange: (value: string) => void;
  onRefreshInterfaces: () => void;
  onStart: () => void;
}

export function NetworkScanControls({
  busy,
  draft,
  interfaces,
  interfacesLoading,
  onCancel,
  onChange,
  onInterfaceChange,
  onRefreshInterfaces,
  onStart,
  selectedInterface,
  validationError,
}: NetworkScanControlsProps) {
  const interfaceOptions = interfaces.map((item) => ({
    label: `${item.name} · ${item.address}/${item.prefixLength}`,
    value: `${item.name}|${item.address}`,
  }));

  return (
    <aside className="network-scan-controls" aria-label="扫描配置">
      <div className="network-scan-primary-action">
        {busy ? (
          <Button fullWidth icon="ban" onClick={onCancel} size="lg" tone="danger">
            停止扫描
          </Button>
        ) : (
          <Button fullWidth icon="play" onClick={onStart} size="lg" tone="primary">
            开始扫描
          </Button>
        )}
      </div>

      {validationError ? <p className="network-scan-validation" role="alert">{validationError}</p> : null}

      <section className="network-scan-control-section">
        <div className="network-scan-section-heading">
          <div>
            <span>SCAN PLAN</span>
            <h3>扫描计划</h3>
          </div>
          <Button
            aria-label="刷新网络接口"
            disabled={busy || interfacesLoading}
            icon="refresh-ccw"
            onClick={onRefreshInterfaces}
            size="sm"
            title="刷新网络接口"
            tone="muted"
          >
            刷新
          </Button>
        </div>

        <div className="network-scan-field-group">
          <label>
            <span>网络接口</span>
            <Select
              aria-label="网络接口"
              disabled={busy || interfacesLoading}
              options={interfaceOptions}
              placeholder={interfacesLoading ? "正在读取接口…" : "选择本机接口"}
              value={selectedInterface}
              onChange={onInterfaceChange}
            />
          </label>
          <label>
            <span>目标网段</span>
            <TextInput
              aria-invalid={Boolean(validationError)}
              disabled={busy}
              leadingIcon="network"
              mono
              placeholder="192.168.1.0/24"
              value={draft.cidr}
              onChange={(event) => onChange({ cidr: event.currentTarget.value })}
            />
          </label>
        </div>
      </section>

      <section className="network-scan-control-section">
        <div className="network-scan-section-heading compact">
          <div>
            <span>PROBE STACK</span>
            <h3>探测策略</h3>
          </div>
        </div>
        <div className="network-scan-strategies">
          <Toggle
            checked={draft.pingEnabled}
            description="默认策略，调用桌面系统 Ping 探测主机"
            disabled={busy}
            label="Ping 探测"
            onChange={(event) => onChange({ pingEnabled: event.currentTarget.checked })}
          />
          <Toggle
            checked={draft.tcpEnabled}
            description="可选增强，识别拒绝连接或开放指定端口的主机"
            disabled={busy}
            label="TCP 端口探测"
            onChange={(event) => onChange({ tcpEnabled: event.currentTarget.checked })}
          />
        </div>

        {draft.tcpEnabled ? (
          <label className="network-scan-ports-field">
            <span>TCP 端口</span>
            <TextInput
              disabled={busy}
              mono
              placeholder="22, 23, 80, 443 或 8000-8010"
              value={draft.portsText}
              onChange={(event) => onChange({ portsText: event.currentTarget.value })}
            />
            <small>最多 32 个端口；连接被拒绝也会计为主机有响应。</small>
          </label>
        ) : null}

        <div className="network-scan-field-grid">
          <label>
            <span className="network-scan-field-caption">
              <span>单次超时</span>
              <small>最大 3 分钟</small>
            </span>
            <span className="network-scan-number-control">
              <TextInput
                aria-label="单次超时（毫秒）"
                autoComplete="off"
                className="network-scan-number-input"
                disabled={busy}
                inputMode="numeric"
                max={MAX_SCAN_TIMEOUT_MS}
                min={MIN_SCAN_TIMEOUT_MS}
                mono
                step={100}
                type="number"
                value={draft.timeoutMs}
                onChange={(event) => onChange({
                  timeoutMs: capNumericInput(event.currentTarget.value, MAX_SCAN_TIMEOUT_MS),
                })}
              />
              <span aria-hidden="true">ms</span>
            </span>
          </label>
          <label>
            <span className="network-scan-field-caption">
              <span>并发任务</span>
              <small>上限 128</small>
            </span>
            <span className="network-scan-number-control">
              <TextInput
                aria-label="并发任务数"
                autoComplete="off"
                className="network-scan-number-input"
                disabled={busy}
                inputMode="numeric"
                max={MAX_SCAN_CONCURRENCY}
                min={MIN_SCAN_CONCURRENCY}
                mono
                step={1}
                type="number"
                value={draft.concurrency}
                onChange={(event) => onChange({
                  concurrency: capNumericInput(event.currentTarget.value, MAX_SCAN_CONCURRENCY),
                })}
              />
              <span aria-hidden="true">任务</span>
            </span>
          </label>
        </div>
      </section>
    </aside>
  );
}
