import { StatusStrip } from "../../status/StatusDock";
import type { ConnectionSummary, LogEntry } from "../../../shared/types";

interface DiagnosticsStatusProps {
  connection: ConnectionSummary | null;
  logs: LogEntry[];
  message: string;
}

export function DiagnosticsStatus({ connection, logs, message }: DiagnosticsStatusProps) {
  return (
    <section className="diagnostics-panel diagnostics-status">
      <StatusStrip connection={connection} logs={logs} message={message} />
    </section>
  );
}
