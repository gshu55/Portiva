import type { LogEntry } from "../../shared/types";
import { logLevelLabel } from "../../shared/labels";

interface LogPanelProps {
  entries: LogEntry[];
  onClear?: () => void;
}

export function LogPanel({ entries, onClear }: LogPanelProps) {
  const counts = entries.reduce(
    (current, entry) => ({
      ...current,
      [entry.level]: current[entry.level] + 1,
    }),
    { debug: 0, error: 0, info: 0, warn: 0 } satisfies Record<LogEntry["level"], number>,
  );

  return (
    <section className="log-panel">
      <div className="dock-heading">
        <div className="log-heading-copy">
          <strong>日志</strong>
          <span>
            {entries.length} 条 / 错误 {counts.error} / 警告 {counts.warn}
          </span>
        </div>
        {onClear ? (
          <button
            aria-label="清除日志"
            disabled={entries.length === 0}
            onClick={onClear}
            title="清除日志"
            type="button"
          >
            清除
          </button>
        ) : null}
      </div>
      <div className="log-list">
        {entries.length > 0 ? (
          entries.map((entry) => (
            <article className={`log-row ${entry.level}`} key={entry.id}>
              <span>{logLevelLabel(entry.level)}</span>
              <time dateTime={entry.createdAt}>{formatLogTime(entry.createdAt)}</time>
              <code>{entry.target}</code>
              <small>{entry.id}</small>
              <p>{entry.message}</p>
            </article>
          ))
        ) : (
          <span className="log-empty">暂无日志。</span>
        )}
      </div>
    </section>
  );
}

function formatLogTime(value: string) {
  if (value.startsWith("unix:")) {
    const seconds = Number.parseInt(value.slice("unix:".length), 10);

    if (Number.isFinite(seconds)) {
      return new Date(seconds * 1000).toLocaleString();
    }
  }

  return value;
}
