import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type {
  SerialProfile,
  TerminalColorPalette,
  TerminalRightClickBehavior,
  TerminalSize,
  WorkspaceSessionTab,
} from "../../shared/types";
import { writeClipboardText } from "../../shared/clipboard";
import { Icon } from "../../shared/Icon";
import { TerminalPane } from "./TerminalPane";

interface SerialTerminalPanelProps {
  isActive?: boolean;
  profile: SerialProfile | null;
  reportSizeWhenVisible?: boolean;
  tab: WorkspaceSessionTab;
  terminalTheme: TerminalColorPalette;
  terminalConfirmMultilinePaste?: boolean;
  terminalCopyRichText?: boolean;
  terminalRightClickBehavior?: TerminalRightClickBehavior;
  onResizeTerminal: (size?: TerminalSize, terminalId?: string) => void;
  onSendData: (data: string, terminalId: string) => Promise<void> | void;
}

type SerialSendEnding = "configured" | "none";

const maxHistoryItems = 12;

function serialLineEndingValue(lineEnding: SerialProfile["lineEnding"] | undefined) {
  switch (lineEnding) {
    case "cr":
      return "\r";
    case "lf":
      return "\n";
    case "crlf":
    default:
      return "\r\n";
  }
}

function serialLineEndingLabel(lineEnding: SerialProfile["lineEnding"] | undefined) {
  switch (lineEnding) {
    case "cr":
      return "CR";
    case "lf":
      return "LF";
    case "crlf":
    default:
      return "CRLF";
  }
}

function serialFrameLabel(profile: SerialProfile | null) {
  const dataBits = profile?.dataBits ?? 8;
  const parity = profile?.parity ?? "none";
  const parityLetter = parity === "none" ? "N" : parity === "odd" ? "O" : parity === "even" ? "E" : parity.slice(0, 1).toUpperCase();
  return `${dataBits}${parityLetter}${profile?.stopBits ?? 1}`;
}

function serialFlowLabel(profile: SerialProfile | null) {
  switch (profile?.flowControl) {
    case "hardware":
      return "RTS/CTS";
    case "software":
      return "XON/XOFF";
    case "none":
    default:
      return "No flow";
  }
}

function serialBaudLabel(tab: WorkspaceSessionTab, profile: SerialProfile | null) {
  if (profile?.baudRate) {
    return `${profile.baudRate} baud`;
  }

  return tab.connection.transport?.serverIdentification ?? "baud";
}

export function SerialTerminalPanel({
  isActive = true,
  onResizeTerminal,
  onSendData,
  profile,
  reportSizeWhenVisible = false,
  tab,
  terminalTheme,
  terminalConfirmMultilinePaste = true,
  terminalCopyRichText = false,
  terminalRightClickBehavior = "context-menu",
}: SerialTerminalPanelProps) {
  const [autoScroll, setAutoScroll] = useState(true);
  const [clearRevision, setClearRevision] = useState(0);
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const [outputPaused, setOutputPaused] = useState(false);
  const [sendEnding, setSendEnding] = useState<SerialSendEnding>("configured");
  const terminal = tab.terminal;
  const snapshotText = tab.terminalSnapshot?.bufferPreview ?? "";
  const portName = tab.connection.transport?.host ?? profile?.portName ?? tab.connection.title;
  const statusText = tab.connection.status === "connected" || tab.connection.status === "ready" ? "OPEN" : tab.connection.status.toUpperCase();
  const configuredEnding = profile?.lineEnding ?? "crlf";
  const statusChips = useMemo(
    () => [
      serialBaudLabel(tab, profile),
      serialFrameLabel(profile),
      serialFlowLabel(profile),
      (profile?.encoding ?? "utf-8").toUpperCase(),
      `DTR ${profile?.dtr ? "ON" : "OFF"}`,
      `RTS ${profile?.rts ? "ON" : "OFF"}`,
    ],
    [profile, tab],
  );

  const sendDraft = async () => {
    if (!terminal || !draft) {
      return;
    }

    const payload =
      sendEnding === "configured"
        ? `${draft}${serialLineEndingValue(configuredEnding)}`
        : draft;

    await Promise.resolve(onSendData(payload, terminal.id));
    setHistory((current) => {
      const next = [draft, ...current.filter((item) => item !== draft)];
      return next.slice(0, maxHistoryItems);
    });
    historyIndexRef.current = null;
    setDraft("");
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void sendDraft();
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const current = historyIndexRef.current;
      const next = current === null ? 0 : Math.min(history.length - 1, current + 1);
      historyIndexRef.current = history.length ? next : null;
      setDraft(history[next] ?? draft);
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      const current = historyIndexRef.current;
      if (current === null) {
        return;
      }

      const next = current - 1;
      if (next < 0) {
        historyIndexRef.current = null;
        setDraft("");
        return;
      }

      historyIndexRef.current = next;
      setDraft(history[next] ?? "");
    }
  };

  const copyBuffer = async () => {
    try {
      await writeClipboardText(snapshotText);
    } catch (error) {
      console.warn("复制串口缓冲区失败", error);
    }
  };

  return (
    <section className="serial-terminal-panel">
      <header className="serial-session-bar">
        <div className="serial-link-identity">
          <span className="serial-port-mark">
            <Icon name="plug" />
          </span>
          <strong>{portName}</strong>
          <span>{serialBaudLabel(tab, profile)}</span>
        </div>
        <div className="serial-chip-row" aria-label="串口状态">
          <span className="serial-status-chip">{statusText}</span>
          {statusChips.slice(1).map((chip) => (
            <span key={chip}>{chip}</span>
          ))}
        </div>
      </header>

      <div className="serial-command-strip">
        <form className="serial-send-form" onSubmit={handleSubmit}>
          <input
            aria-label="串口发送内容"
            autoComplete="off"
            disabled={!terminal}
            list={`${tab.connection.id}-serial-history`}
            placeholder="AT"
            spellCheck={false}
            value={draft}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              historyIndexRef.current = null;
            }}
            onKeyDown={handleInputKeyDown}
          />
          <datalist id={`${tab.connection.id}-serial-history`}>
            {history.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
          <select
            aria-label="发送结束符"
            value={sendEnding}
            onChange={(event) => setSendEnding(event.currentTarget.value as SerialSendEnding)}
          >
            <option value="configured">+{serialLineEndingLabel(configuredEnding)}</option>
            <option value="none">无结束符</option>
          </select>
          <button disabled={!terminal || !draft} type="submit">
            <Icon name="terminal" />
            <span>发送</span>
          </button>
        </form>

        <div className="serial-monitor-actions">
          <label className="serial-toggle-pill">
            <input
              checked={autoScroll}
              type="checkbox"
              onChange={(event) => setAutoScroll(event.currentTarget.checked)}
            />
            <span>自动滚动</span>
          </label>
          <button
            aria-pressed={outputPaused}
            className={outputPaused ? "active" : ""}
            title={outputPaused ? "恢复显示" : "暂停显示"}
            type="button"
            onClick={() => setOutputPaused((current) => !current)}
          >
            <Icon name={outputPaused ? "play" : "pause"} />
          </button>
          <button title="清屏" type="button" onClick={() => setClearRevision((current) => current + 1)}>
            <Icon name="trash" />
          </button>
          <button disabled={!snapshotText} title="复制缓冲区" type="button" onClick={() => void copyBuffer()}>
            <Icon name="copy" />
          </button>
        </div>
      </div>

      <TerminalPane
        autoScroll={autoScroll}
        clearRevision={clearRevision}
        isActive={isActive}
        outputPaused={outputPaused}
        reportSizeWhenVisible={reportSizeWhenVisible}
        terminal={terminal}
        terminalConfirmMultilinePaste={terminalConfirmMultilinePaste}
        terminalCopyRichText={terminalCopyRichText}
        terminalSnapshot={tab.terminalSnapshot}
        terminalRightClickBehavior={terminalRightClickBehavior}
        terminalTheme={terminalTheme}
        onResizeTerminal={onResizeTerminal}
        onSendData={onSendData}
      />
    </section>
  );
}
