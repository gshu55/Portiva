import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { formatBytes, formatUptime, formatUptimeDays } from "../../shared/format";
import { Icon, type IconName } from "../../shared/Icon";
import { sshCollectHostOverview, wslCollectHostOverview } from "../../shared/ipc/commands";
import { exponentialBackoffDelay } from "../../shared/retryBackoff";
import type { DiskPartitionOverview, SshHostOverview, WslHostOverview } from "../../shared/types";
import { Card, ConfirmDialog, IconButton, SegmentedControl, TextInput, VirtualList } from "../../shared/ui";
import type { SavedSshCommand } from "./useSavedSshCommands";
import "./sshTerminalWorkspace.css";

const sshOverviewRefreshIntervalMs = 1_000;
const sshOverviewMaximumRetryIntervalMs = 30_000;
const wslOverviewRefreshIntervalMs = 1_000;

interface SshTerminalWorkspaceProps {
  children: ReactNode;
  commandHistory: string[];
  commandPanelVisible: boolean;
  compact: boolean;
  connectionId: string;
  distribution?: string;
  isActive: boolean;
  pageLevelPanels?: boolean;
  profileId: string;
  savedCommands: SavedSshCommand[];
  sessionKind?: "ssh" | "wsl";
  sftpPanelAvailable: boolean;
  sftpPanelVisible: boolean;
  statusPanelVisible: boolean;
  terminalReady: boolean;
  onAddSavedCommand: (command: string) => void;
  onRemoveSavedCommand: (commandId: string) => void;
  onRunCommand: (command: string) => void;
  onToggleCommandPanel: () => void;
  onToggleSftpPanel: () => void;
  onToggleStatusPanel: () => void;
  onUpdateSavedCommand: (commandId: string, command: string) => void;
}

interface NetworkSample {
  receivedBytes: number;
  sampledAt: number;
  transmittedBytes: number;
}

interface HostOverviewState {
  data: SshHostOverview | null;
  error: string | null;
  loading: boolean;
  receivedBytesPerSecond: number | null;
  transmittedBytesPerSecond: number | null;
}

interface WslHostOverviewState {
  data: WslHostOverview | null;
  error: string | null;
  loading: boolean;
  receivedBytesPerSecond: number | null;
  transmittedBytesPerSecond: number | null;
}

function percent(used: number | null, total: number | null) {
  return used !== null && total ? Math.min(100, Math.max(0, Math.round((used / total) * 100))) : null;
}

function overviewError(error: unknown) {
  const message = String(error).replace(/^Error:\s*/i, "").trim();
  return message || "系统信息获取失败";
}

function useSshHostOverview(profileId: string, connectionId: string, enabled: boolean) {
  const [state, setState] = useState<HostOverviewState>({
    data: null,
    error: null,
    loading: false,
    receivedBytesPerSecond: null,
    transmittedBytesPerSecond: null,
  });
  const refreshingRef = useRef(false);
  const mountedRef = useRef(true);
  const previousNetworkSampleRef = useRef<NetworkSample | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<boolean | null> => {
    if (!enabled || refreshingRef.current) {
      return null;
    }

    refreshingRef.current = true;
    setState((current) => ({ ...current, error: null, loading: true }));

    try {
      const data = await sshCollectHostOverview(profileId, connectionId);
      const sampledAt = Date.now();
      const previous = previousNetworkSampleRef.current;
      const elapsedSeconds = previous ? Math.max(0.001, (sampledAt - previous.sampledAt) / 1000) : null;
      const canCalculateRate =
        previous &&
        elapsedSeconds &&
        data.networkReceivedBytes !== null &&
        data.networkTransmittedBytes !== null &&
        data.networkReceivedBytes >= previous.receivedBytes &&
        data.networkTransmittedBytes >= previous.transmittedBytes;

      if (data.networkReceivedBytes !== null && data.networkTransmittedBytes !== null) {
        previousNetworkSampleRef.current = {
          receivedBytes: data.networkReceivedBytes,
          sampledAt,
          transmittedBytes: data.networkTransmittedBytes,
        };
      }

      if (mountedRef.current) {
        setState({
          data,
          error: null,
          loading: false,
          receivedBytesPerSecond: canCalculateRate
            ? (data.networkReceivedBytes! - previous.receivedBytes) / elapsedSeconds
            : null,
          transmittedBytesPerSecond: canCalculateRate
            ? (data.networkTransmittedBytes! - previous.transmittedBytes) / elapsedSeconds
            : null,
        });
      }
      return true;
    } catch (error) {
      if (mountedRef.current) {
        setState((current) => ({ ...current, error: overviewError(error), loading: false }));
      }
      return false;
    } finally {
      refreshingRef.current = false;
    }
  }, [connectionId, enabled, profileId]);

  useEffect(() => {
    previousNetworkSampleRef.current = null;
    if (!enabled) {
      return;
    }

    let disposed = false;
    let timer: number | null = null;
    let consecutiveFailures = 0;
    const poll = async () => {
      const succeeded = await refresh();
      if (disposed) {
        return;
      }

      if (succeeded === true) {
        consecutiveFailures = 0;
      } else if (succeeded === false) {
        consecutiveFailures += 1;
      }

      const delay = exponentialBackoffDelay(
        consecutiveFailures,
        sshOverviewRefreshIntervalMs,
        sshOverviewMaximumRetryIntervalMs,
      );
      timer = window.setTimeout(() => void poll(), delay);
    };

    void poll();
    return () => {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [connectionId, enabled, profileId, refresh]);

  return state;
}

function useWslHostOverview(distribution: string, enabled: boolean) {
  const [state, setState] = useState<WslHostOverviewState>({
    data: null,
    error: null,
    loading: false,
    receivedBytesPerSecond: null,
    transmittedBytesPerSecond: null,
  });
  const refreshingRef = useRef(false);
  const mountedRef = useRef(true);
  const previousNetworkSampleRef = useRef<NetworkSample | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled || !distribution || refreshingRef.current) {
      return;
    }

    refreshingRef.current = true;
    setState((current) => ({ ...current, error: null, loading: true }));

    try {
      const data = await wslCollectHostOverview(distribution);
      const sampledAt = Date.now();
      const previous = previousNetworkSampleRef.current;
      const elapsedSeconds = previous ? Math.max(0.001, (sampledAt - previous.sampledAt) / 1000) : null;
      const canCalculateRate =
        previous &&
        elapsedSeconds &&
        data.networkReceivedBytes !== null &&
        data.networkTransmittedBytes !== null &&
        data.networkReceivedBytes >= previous.receivedBytes &&
        data.networkTransmittedBytes >= previous.transmittedBytes;

      if (data.networkReceivedBytes !== null && data.networkTransmittedBytes !== null) {
        previousNetworkSampleRef.current = {
          receivedBytes: data.networkReceivedBytes,
          sampledAt,
          transmittedBytes: data.networkTransmittedBytes,
        };
      }

      if (mountedRef.current) {
        setState({
          data,
          error: null,
          loading: false,
          receivedBytesPerSecond: canCalculateRate
            ? (data.networkReceivedBytes! - previous.receivedBytes) / elapsedSeconds
            : null,
          transmittedBytesPerSecond: canCalculateRate
            ? (data.networkTransmittedBytes! - previous.transmittedBytes) / elapsedSeconds
            : null,
        });
      }
    } catch (error) {
      if (mountedRef.current) {
        setState((current) => ({ ...current, error: overviewError(error), loading: false }));
      }
    } finally {
      refreshingRef.current = false;
    }
  }, [distribution, enabled]);

  useEffect(() => {
    previousNetworkSampleRef.current = null;
    if (!enabled || !distribution) {
      return;
    }

    void refresh();
    const timer = window.setInterval(() => void refresh(), wslOverviewRefreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [distribution, enabled, refresh]);

  return state;
}

function SystemSummaryItem({
  className = "",
  icon,
  label,
  title,
  value,
}: {
  className?: string;
  icon: IconName;
  label: string;
  title: string;
  value: string;
}) {
  return (
    <span aria-label={`${label} ${value}`} className={["ssh-system-summary-item", className].filter(Boolean).join(" ")} title={title}>
      <Icon name={icon} />
      <strong>{value}</strong>
    </span>
  );
}

function partitionUsage(partition: DiskPartitionOverview | null) {
  const value = percent(partition?.usedBytes ?? null, partition?.totalBytes ?? null);
  return value === null ? "—" : `${value}%`;
}

function partitionDetail(label: string, partition: DiskPartitionOverview | null) {
  if (!partition) {
    return `${label}：未检测到已挂载分区`;
  }

  return [
    `${label} · ${partition.mountPoint}`,
    partition.device ? `设备：${partition.device}` : null,
    partition.fileSystem ? `文件系统：${partition.fileSystem}` : null,
    `已用：${formatBytes(partition.usedBytes)} / ${formatBytes(partition.totalBytes)}`,
    `可用：${formatBytes(partition.availableBytes)} · 占用 ${partitionUsage(partition)}`,
  ].filter(Boolean).join("\n");
}

function DiskSummaryItem({
  efi,
  root,
}: {
  efi: DiskPartitionOverview | null;
  root: DiskPartitionOverview | null;
}) {
  const rootUsage = partitionUsage(root);
  const efiUsage = partitionUsage(efi);
  return (
    <span
      aria-label={`磁盘 根分区 ${rootUsage} EFI 分区 ${efiUsage}`}
      className="ssh-system-summary-item ssh-system-disk-item"
      title={`${partitionDetail("根分区", root)}\n\n${partitionDetail("EFI 分区", efi)}`}
    >
      <Icon name="hard-drive" />
      <strong>
        <span><b>/</b>{rootUsage}</span>
        <span className={efi ? "" : "unavailable"}><b>EFI</b>{efiUsage}</span>
      </strong>
    </span>
  );
}

function NetworkSummaryItem({
  direction,
  title,
  value,
}: {
  direction: "received" | "transmitted";
  title: string;
  value: string;
}) {
  const received = direction === "received";
  return (
    <span
      aria-label={`${received ? "网络下载" : "网络上传"} ${value}`}
      className={["ssh-system-summary-item", "ssh-system-network-item", direction].join(" ")}
      title={title}
    >
      <Icon name="network" />
      <strong><b aria-hidden="true">{received ? "↓" : "↑"}</b>{value}</strong>
    </span>
  );
}

function CommandRow({
  command,
  disabled = false,
  isSaved,
  onDelete,
  onEdit,
  onRun,
  onSave,
}: {
  command: string;
  disabled?: boolean;
  isSaved?: boolean;
  onDelete?: () => void;
  onEdit?: () => void;
  onRun: () => void;
  onSave?: () => void;
}) {
  return (
    <div className="ssh-command-row">
      <button className="ssh-command-value" disabled={disabled} onClick={onRun} title={`执行：${command}`} type="button">
        <code>{command}</code>
      </button>
      <div className="ssh-command-row-actions">
        {onSave ? (
          <IconButton
            aria-label={isSaved ? `已收藏 ${command}` : `收藏 ${command}`}
            disabled={isSaved}
            icon={isSaved ? "check" : "save"}
            onClick={onSave}
            size="sm"
            title={isSaved ? "已收藏" : "保存为常用命令"}
            tone="muted"
          />
        ) : null}
        {onEdit ? <IconButton aria-label={`编辑 ${command}`} icon="edit" onClick={onEdit} size="sm" title="编辑" tone="muted" /> : null}
        <IconButton aria-label={`执行 ${command}`} disabled={disabled} icon="play" onClick={onRun} size="sm" title="执行命令" tone="primary" />
        {onDelete ? <IconButton aria-label={`删除 ${command}`} icon="trash" onClick={onDelete} size="sm" title="删除" tone="danger" /> : null}
      </div>
    </div>
  );
}

export function SshTerminalWorkspace({
  children,
  commandHistory,
  commandPanelVisible,
  compact,
  connectionId,
  distribution = "",
  isActive,
  pageLevelPanels = false,
  profileId,
  savedCommands,
  sessionKind = "ssh",
  sftpPanelAvailable,
  sftpPanelVisible,
  statusPanelVisible,
  terminalReady,
  onAddSavedCommand,
  onRemoveSavedCommand,
  onRunCommand,
  onToggleCommandPanel,
  onToggleSftpPanel,
  onToggleStatusPanel,
  onUpdateSavedCommand,
}: SshTerminalWorkspaceProps) {
  const [activeCommandView, setActiveCommandView] = useState<"history" | "saved">("history");
  const [newCommand, setNewCommand] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SavedSshCommand | null>(null);
  const sshOverview = useSshHostOverview(
    profileId,
    connectionId,
    sessionKind === "ssh" && isActive && statusPanelVisible && terminalReady,
  );
  const wslOverview = useWslHostOverview(
    distribution,
    sessionKind === "wsl" && isActive && statusPanelVisible && terminalReady,
  );
  const overview = sessionKind === "wsl" ? wslOverview : sshOverview;
  const savedCommandValues = useMemo(() => new Set(savedCommands.map((item) => item.command)), [savedCommands]);
  const memoryPercent = percent(overview.data?.memoryUsedBytes ?? null, overview.data?.memoryTotalBytes ?? null);
  const rootPartition = overview.data?.diskPartitions?.find((partition) => partition.role === "root") ?? null;
  const efiPartition = overview.data?.diskPartitions?.find((partition) => partition.role === "efi") ?? null;
  const cpuPercent = sessionKind === "wsl"
    ? wslOverview.data?.cpuUsagePercent === null || wslOverview.data?.cpuUsagePercent === undefined
      ? null
      : Math.round(wslOverview.data.cpuUsagePercent)
    : sshOverview.data?.cpuLoad1 !== null && sshOverview.data?.cpuLoad1 !== undefined && sshOverview.data.cpuCount
      ? Math.min(100, Math.round((sshOverview.data.cpuLoad1 / sshOverview.data.cpuCount) * 100))
      : null;

  const addCommand = (event: FormEvent) => {
    event.preventDefault();
    if (!newCommand.trim()) {
      return;
    }
    onAddSavedCommand(newCommand);
    setNewCommand("");
    setActiveCommandView("saved");
  };

  const commitEdit = () => {
    if (!editingId || !editingDraft.trim()) {
      return;
    }
    onUpdateSavedCommand(editingId, editingDraft);
    setEditingId(null);
    setEditingDraft("");
  };

  const networkReceivedValue = overview.receivedBytesPerSecond === null
    ? "等待采样"
    : `${formatBytes(overview.receivedBytesPerSecond)}/s`;
  const networkTransmittedValue = overview.transmittedBytesPerSecond === null
    ? "等待采样"
    : `${formatBytes(overview.transmittedBytesPerSecond)}/s`;
  const networkReceivedDetail = overview.data
    ? `累计下载 ${formatBytes(overview.data.networkReceivedBytes)}`
    : "网络下载数据不可用";
  const networkTransmittedDetail = overview.data
    ? `累计上传 ${formatBytes(overview.data.networkTransmittedBytes)}`
    : "网络上传数据不可用";
  const sessionLabel = sessionKind === "wsl" ? "WSL" : "SSH";
  const filePanelLabel = sessionKind === "wsl" ? "WSL 文件栏" : "SFTP 栏";

  return (
    <section
      className={[
        "ssh-session-workspace",
        sessionKind === "wsl" ? "wsl-session-workspace" : "",
        pageLevelPanels ? "page-level-panels" : "",
        compact ? "compact" : "",
        commandPanelVisible ? "commands-expanded" : "commands-hidden",
        statusPanelVisible ? "status-visible" : "status-hidden",
      ].filter(Boolean).join(" ")}
    >
      <div className="ssh-terminal-stage">
        {children}
        {isActive ? (
          <div aria-label={`${sessionLabel} 面板控制`} className="ssh-terminal-panel-controls" role="toolbar">
            <IconButton
              aria-label={commandPanelVisible ? "隐藏命令栏" : "显示命令栏"}
              aria-pressed={commandPanelVisible}
              icon="command"
              onClick={onToggleCommandPanel}
              size="sm"
              title={commandPanelVisible ? "隐藏命令栏" : "显示命令栏"}
              tone="muted"
            />
            <IconButton
              aria-label={sftpPanelVisible ? `隐藏 ${filePanelLabel}` : `显示 ${filePanelLabel}`}
              aria-pressed={sftpPanelAvailable && sftpPanelVisible}
              disabled={!sftpPanelAvailable}
              icon="folder-open"
              onClick={onToggleSftpPanel}
              size="sm"
              title={sftpPanelAvailable ? (sftpPanelVisible ? `隐藏 ${filePanelLabel}` : `显示 ${filePanelLabel}`) : `当前会话暂不可用 ${filePanelLabel}`}
              tone="muted"
            />
            <IconButton
              aria-label={statusPanelVisible ? "隐藏底部状态" : "显示底部状态"}
              aria-pressed={statusPanelVisible}
              icon="activity"
              onClick={onToggleStatusPanel}
              size="sm"
              title={statusPanelVisible ? "隐藏底部状态" : "显示底部状态"}
              tone="muted"
            />
          </div>
        ) : null}
      </div>
      {commandPanelVisible ? (
        <Card
          as="aside"
          className="ssh-command-panel"
          header={
            <div className="ssh-command-panel-heading">
              <div><Icon name="command" /><span><strong>命令助手</strong><small>历史与常用命令</small></span></div>
            </div>
          }
          tone="solid"
        >
          <div className="ssh-command-panel-body">
            <form className="ssh-command-add" onSubmit={addCommand}>
              <TextInput aria-label="新增常用命令" fieldSize="sm" mono placeholder="输入常用命令…" value={newCommand} onChange={(event) => setNewCommand(event.currentTarget.value)} />
              <IconButton aria-label="保存常用命令" disabled={!newCommand.trim()} icon="plus" size="sm" title="保存常用命令" tone="primary" type="submit" />
            </form>

            <div className="ssh-command-view-switch">
              <SegmentedControl
                aria-label="切换命令列表"
                className="segmented-control ssh-command-tabs"
                options={[
                  { count: commandHistory.length, icon: "command", label: "历史命令", value: "history" },
                  { count: savedCommands.length, icon: "save", label: "常用命令", value: "saved" },
                ]}
                value={activeCommandView}
                onChange={setActiveCommandView}
              />
            </div>

            <section aria-label={activeCommandView === "history" ? "历史命令" : "常用命令"} className="ssh-command-tab-panel">
              {activeCommandView === "history" ? (
                <VirtualList
                  aria-label="历史命令"
                  className="ssh-command-list"
                  empty={<span className="ssh-command-empty">执行命令后会显示在这里</span>}
                  estimateHeight={42}
                  items={commandHistory}
                  keyExtractor={(command, index) => `${index}-${command}`}
                  renderItem={(command) => (
                    <CommandRow
                      command={command}
                      disabled={!terminalReady}
                      isSaved={savedCommandValues.has(command)}
                      onRun={() => onRunCommand(command)}
                      onSave={() => {
                        onAddSavedCommand(command);
                        setActiveCommandView("saved");
                      }}
                    />
                  )}
                />
              ) : (
                <VirtualList
                  aria-label="常用命令"
                  className="ssh-command-list"
                  empty={<span className="ssh-command-empty">保存后可跨终端会话使用</span>}
                  estimateHeight={42}
                  items={savedCommands}
                  keyExtractor={(item) => item.id}
                  renderItem={(item) =>
                    editingId === item.id ? (
                      <div className="ssh-command-edit-row">
                        <TextInput
                          aria-label="编辑常用命令"
                          autoFocus
                          fieldSize="sm"
                          mono
                          value={editingDraft}
                          onChange={(event) => setEditingDraft(event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitEdit();
                            } else if (event.key === "Escape") {
                              setEditingId(null);
                            }
                          }}
                        />
                        <IconButton aria-label="保存编辑" disabled={!editingDraft.trim()} icon="check" onClick={commitEdit} size="sm" title="保存" tone="primary" />
                        <IconButton aria-label="取消编辑" icon="x" onClick={() => setEditingId(null)} size="sm" title="取消" tone="muted" />
                      </div>
                    ) : (
                      <CommandRow
                        command={item.command}
                        disabled={!terminalReady}
                        onDelete={() => setDeleteTarget(item)}
                        onEdit={() => {
                          setEditingId(item.id);
                          setEditingDraft(item.command);
                        }}
                        onRun={() => onRunCommand(item.command)}
                      />
                    )
                  }
                />
              )}
            </section>
          </div>
        </Card>
      ) : null}

      {statusPanelVisible ? (
        <Card as="footer" className={["ssh-system-panel", sessionKind === "wsl" ? "wsl-system-panel" : ""].filter(Boolean).join(" ")} tone="solid">
          <div className="ssh-system-summary">
          <span
            className={["ssh-system-host", overview.error ? "error" : ""].filter(Boolean).join(" ")}
            title={
              overview.error
                ? overview.error
                : overview.data
                  ? `${overview.data.operatingSystem} · ${overview.data.kernelVersion} · ${overview.data.latencyMs} ms`
                  : terminalReady
                    ? "正在采集主机状态…"
                    : sessionKind === "wsl" ? "WSL 终端就绪后自动采集" : "SSH 认证完成后自动采集"
            }
          >
            <Icon name="server" />
            <strong>{overview.data?.hostname ?? (overview.loading ? "采集中…" : sessionKind === "wsl" ? distribution || "WSL" : "SSH 主机")}</strong>
          </span>
          <SystemSummaryItem className="ssh-system-cpu-item" icon="cpu" label="CPU" title={overview.data?.cpuCount ? `${overview.data.cpuCount} 核${sessionKind === "ssh" ? " · 1 分钟负载换算" : " · 实时占用"}` : "CPU 信息不可用"} value={cpuPercent === null ? "—" : `${cpuPercent}%`} />
          <SystemSummaryItem
            className="ssh-system-memory-item"
            icon="server"
            label="内存"
            title={overview.data ? `已用 ${formatBytes(overview.data.memoryUsedBytes)} / 总量 ${formatBytes(overview.data.memoryTotalBytes)}${memoryPercent === null ? "" : ` · ${memoryPercent}%`}` : "内存信息不可用"}
            value={overview.data ? `${formatBytes(overview.data.memoryUsedBytes)} / ${formatBytes(overview.data.memoryTotalBytes)}` : "—"}
          />
          <DiskSummaryItem efi={efiPartition} root={rootPartition} />
          <NetworkSummaryItem direction="received" title={networkReceivedDetail} value={networkReceivedValue} />
          <NetworkSummaryItem direction="transmitted" title={networkTransmittedDetail} value={networkTransmittedValue} />
          <SystemSummaryItem
            icon="activity"
            label="运行"
            title={overview.data?.kernelVersion ?? "运行时间不可用"}
            value={(sessionKind === "ssh" ? formatUptimeDays : formatUptime)(overview.data?.uptimeSeconds ?? null)}
          />
          </div>
        </Card>
      ) : null}

      <ConfirmDialog
        confirmLabel="删除命令"
        description={deleteTarget ? <code>{deleteTarget.command}</code> : null}
        open={Boolean(deleteTarget)}
        title="删除常用命令？"
        tone="danger"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) {
            onRemoveSavedCommand(deleteTarget.id);
          }
          setDeleteTarget(null);
        }}
      />
    </section>
  );
}
