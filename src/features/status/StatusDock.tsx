import { LogPanel } from "../logs/LogPanel";
import { connectionStatusLabel } from "../../shared/labels";
import type { ConnectionSummary, LogEntry } from "../../shared/types";

interface StatusDockProps {
  connection: ConnectionSummary | null;
  logs: LogEntry[];
  message: string;
  onClearLogs?: () => void;
}

interface StatusStripProps {
  connection: ConnectionSummary | null;
  logs: LogEntry[];
  message: string;
}

export function StatusDock({
  connection,
  logs,
  message,
  onClearLogs,
}: StatusDockProps) {
  return (
    <footer className="status-dock">
      <LogPanel entries={logs} onClear={onClearLogs} />
      <StatusStrip connection={connection} logs={logs} message={message} />
    </footer>
  );
}

export function StatusStrip({ connection, logs, message }: StatusStripProps) {
  return (
    <section className="status-strip">
      <strong>状态</strong>
      <span>{connection ? `${connection.title} / ${connectionStatusLabel(connection.status)}` : "没有活动连接"}</span>
      <span>{message}</span>
      <span>{logs.length} 条日志记录</span>
    </section>
  );
}
