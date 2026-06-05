import { LogPanel } from "../../logs/LogPanel";
import type { LogEntry } from "../../../shared/types";

interface DiagnosticsLogsProps {
  logs: LogEntry[];
  onClearLogs: () => void;
}

export function DiagnosticsLogs({ logs, onClearLogs }: DiagnosticsLogsProps) {
  return (
    <section className="diagnostics-panel diagnostics-logs">
      <LogPanel entries={logs} onClear={onClearLogs} />
    </section>
  );
}
