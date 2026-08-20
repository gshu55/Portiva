import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type UIEvent } from "react";
import type {
  SerialProfile,
  SerialPortInfo,
  SerialRxEvent,
  TerminalColorPalette,
  TerminalRightClickBehavior,
  TerminalSize,
  TextEncoding,
  WorkspaceSessionTab,
} from "../../shared/types";
import { Icon } from "../../shared/Icon";
import { IconButton, Select, Toggle } from "../../shared/ui";

interface SerialTerminalPanelProps {
  isActive?: boolean;
  profile: SerialProfile | null;
  reportSizeWhenVisible?: boolean;
  tab: WorkspaceSessionTab;
  terminalTheme: TerminalColorPalette;
  terminalConfirmMultilinePaste?: boolean;
  terminalCopyRichText?: boolean;
  terminalRightClickBehavior?: TerminalRightClickBehavior;
  onResizeTerminal: (size?: TerminalSize, terminalId?: string) => Promise<void> | void;
  onCloseSerialTerminal: (terminalId: string) => Promise<void> | void;
  onOpenSerialTerminal: (terminalId: string, profile: SerialProfile) => Promise<void> | void;
  onReconfigureSerialTerminal: (terminalId: string, profile: SerialProfile) => Promise<void> | void;
  onRefreshSerialPorts?: () => Promise<SerialPortInfo[]> | Promise<void> | SerialPortInfo[] | void;
  onSendBytes: (bytes: number[], terminalId: string) => Promise<void> | void;
  onSendData: (data: string, terminalId: string) => Promise<void> | void;
  serialPorts?: SerialPortInfo[];
}

type SerialSendEnding = "configured" | "none";
type SerialSendMode = "text" | "hex";

interface SerialSendHistoryEntry {
  byteCount: number;
  content: string;
  id: string;
  mode: SerialSendMode;
}

interface SerialSendSlot {
  content: string;
  id: string;
  mode: SerialSendMode;
  sendEnding: SerialSendEnding;
  timedSendEnabled: boolean;
  timedSendIntervalMs: number;
}

interface SerialExchangeEntry {
  byteCount: number;
  content: string;
  direction: "rx" | "tx";
  id: string;
  mode?: SerialSendMode;
  timestampUs: number;
}

const maxHistoryItems = 12;
const estimatedTrafficRowHeight = 36;
const trafficVirtualOverscanPx = 720;
const defaultTimedSendIntervalMs = 1000;
const minTimedSendIntervalMs = 50;
const maxTimedSendIntervalMs = 600000;
const defaultSendSlotCount = 6;
const serialEncodingOptions: Array<{ label: string; value: TextEncoding }> = [
  { label: "ASCII", value: "ascii" },
  { label: "UTF-8", value: "utf-8" },
  { label: "GBK", value: "gbk" },
  { label: "Big5", value: "big5" },
  { label: "Shift_JIS", value: "shift-jis" },
  { label: "EUC-KR", value: "euc-kr" },
  { label: "UTF-16 LE", value: "utf-16le" },
  { label: "UTF-16 BE", value: "utf-16be" },
  { label: "Latin-1", value: "latin1" },
];
const commonSerialBaudRates = [
  110,
  300,
  600,
  1200,
  2400,
  4800,
  9600,
  14400,
  19200,
  38400,
  57600,
  74880,
  115200,
  128000,
  230400,
  250000,
  256000,
  460800,
  500000,
  921600,
  1000000,
  1500000,
  2000000,
];

function createSerialSendSlot(id: string, patch: Partial<SerialSendSlot> = {}): SerialSendSlot {
  return {
    content: "",
    id,
    mode: "text",
    sendEnding: "configured",
    timedSendEnabled: false,
    timedSendIntervalMs: defaultTimedSendIntervalMs,
    ...patch,
  };
}

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

function serialRuntimeProfile(profile: SerialProfile | null, tab: WorkspaceSessionTab): SerialProfile {
  const now = new Date().toISOString();
  return {
    id: profile?.id ?? `${tab.connection.id}-serial-runtime`,
    name: profile?.name ?? tab.connection.title,
    groupId: profile?.groupId,
    type: "serial",
    tags: profile?.tags ?? ["serial"],
    portName: profile?.portName ?? tab.connection.transport?.host ?? "",
    baudRate: profile?.baudRate ?? 115200,
    dataBits: profile?.dataBits ?? 8,
    parity: profile?.parity ?? "none",
    stopBits: profile?.stopBits ?? 1,
    flowControl: profile?.flowControl ?? "none",
    lineEnding: profile?.lineEnding ?? "crlf",
    encoding: profile?.encoding ?? "utf-8",
    dtr: profile?.dtr ?? true,
    rts: profile?.rts ?? true,
    createdAt: profile?.createdAt ?? now,
    updatedAt: now,
  };
}

function parseSerialHexDraft(input: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    return { bytes: [] };
  }

  const compact = trimmed.replace(/0x/gi, "").replace(/[\s,;:_-]+/g, "");
  if (!compact) {
    return { bytes: [] };
  }

  if (/[^0-9a-fA-F]/.test(compact)) {
    return { bytes: [], error: "HEX 只能包含 0-9、A-F 和分隔符。" };
  }

  if (compact.length % 2 !== 0) {
    return { bytes: [], error: "HEX 需要按两个字符组成一个字节。" };
  }

  const bytes: number[] = [];
  for (let index = 0; index < compact.length; index += 2) {
    bytes.push(Number.parseInt(compact.slice(index, index + 2), 16));
  }

  return { bytes };
}

function detectSerialRxMode(bytes: number[], text: string): SerialSendMode {
  if (!bytes.length) {
    return "text";
  }

  for (const char of text) {
    if (char === "\uFFFD" || /\p{C}/u.test(char) || /\p{Co}/u.test(char)) {
      continue;
    }

    return "text";
  }

  return "hex";
}

function clampTimedSendInterval(value: number) {
  if (!Number.isFinite(value)) {
    return defaultTimedSendIntervalMs;
  }

  return Math.min(maxTimedSendIntervalMs, Math.max(minTimedSendIntervalMs, Math.round(value)));
}

function currentTimestampUs() {
  return Math.round((performance.timeOrigin + performance.now()) * 1000);
}

function formatExchangeTime(timestampUs: number) {
  const date = new Date(Math.floor(timestampUs / 1000));
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  const milliseconds = date.getMilliseconds().toString().padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${milliseconds}`;
}

function formatByteSize(byteCount: number) {
  if (byteCount < 1024) {
    return `${byteCount}B`;
  }

  const kilobytes = byteCount / 1024;
  if (kilobytes < 1024) {
    return `${kilobytes >= 10 ? kilobytes.toFixed(0) : kilobytes.toFixed(1)}K`;
  }

  const megabytes = kilobytes / 1024;
  return `${megabytes >= 10 ? megabytes.toFixed(0) : megabytes.toFixed(1)}M`;
}

function findTrafficVirtualIndex(offsets: number[], target: number) {
  if (!offsets.length || target <= 0) {
    return 0;
  }

  let low = 0;
  let high = offsets.length - 1;
  let result = 0;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] <= target) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return result;
}

export function SerialTerminalPanel({
  onCloseSerialTerminal,
  onOpenSerialTerminal,
  onReconfigureSerialTerminal,
  onRefreshSerialPorts,
  onSendBytes,
  onSendData,
  profile,
  serialPorts = [],
  tab,
}: SerialTerminalPanelProps) {
  const [autoScroll, setAutoScroll] = useState(true);
  const [exchangeLog, setExchangeLog] = useState<SerialExchangeEntry[]>([]);
  const [trafficMeasureVersion, setTrafficMeasureVersion] = useState(0);
  const [trafficScrollTop, setTrafficScrollTop] = useState(0);
  const [trafficViewportHeight, setTrafficViewportHeight] = useState(0);
  const [hexError, setHexError] = useState("");
  const [history, setHistory] = useState<SerialSendHistoryEntry[]>([]);
  const [sendSlots, setSendSlots] = useState<SerialSendSlot[]>(() =>
    Array.from({ length: defaultSendSlotCount }, (_value, index) => createSerialSendSlot(`serial-send-slot-${index}`)),
  );
  const exchangeLogRef = useRef<HTMLDivElement | null>(null);
  const historyIndexRef = useRef<number | null>(null);
  const lastTimestampUsRef = useRef(0);
  const nextExchangeIdRef = useRef(0);
  const nextSendSlotIdRef = useRef(defaultSendSlotCount);
  const trafficRowHeightsRef = useRef<Map<string, number>>(new Map());
  const trafficRowObserversRef = useRef<Map<string, ResizeObserver>>(new Map());
  const timedSendInFlightRef = useRef<Set<string>>(new Set());
  const [outputPaused, setOutputPaused] = useState(false);
  const [runtimeProfile, setRuntimeProfile] = useState<SerialProfile>(() => serialRuntimeProfile(profile, tab));
  const [serialActionPending, setSerialActionPending] = useState(false);
  const [serialOpen, setSerialOpen] = useState(Boolean(tab.terminal && tab.connection.status !== "disconnected" && tab.connection.status !== "failed"));
  const terminal = tab.terminal;
  const portName = tab.connection.transport?.host ?? profile?.portName ?? tab.connection.title;
  const terminalReady = Boolean(terminal && terminal.status !== "closed" && serialOpen);
  const selectedPortIsDetected = serialPorts.some((port) => port.portName === runtimeProfile.portName);
  const statusText = terminalReady ? "OPEN" : "CLOSED";
  const configuredEnding = runtimeProfile.lineEnding;
  const serialPortOptions = useMemo(
    () => [
      ...(runtimeProfile.portName && !selectedPortIsDetected
        ? [{ label: `${runtimeProfile.portName}（当前配置）`, value: runtimeProfile.portName }]
        : []),
      ...serialPorts.map((port) => ({
        disabled: !port.isAvailable && port.portName !== runtimeProfile.portName,
        label: `${port.displayName || port.portName}${port.isAvailable ? "" : "（占用）"}`,
        value: port.portName,
      })),
    ],
    [runtimeProfile.portName, selectedPortIsDetected, serialPorts],
  );
  const baudRateOptions = useMemo(() => {
    if (commonSerialBaudRates.includes(runtimeProfile.baudRate)) {
      return commonSerialBaudRates;
    }

    return [...commonSerialBaudRates, runtimeProfile.baudRate].sort((left, right) => left - right);
  }, [runtimeProfile.baudRate]);
  const statusChips = useMemo(
    () => [
      serialBaudLabel(tab, runtimeProfile),
      serialFrameLabel(runtimeProfile),
      serialFlowLabel(runtimeProfile),
      runtimeProfile.encoding.toUpperCase(),
      `DTR ${runtimeProfile.dtr ? "ON" : "OFF"}`,
      `RTS ${runtimeProfile.rts ? "ON" : "OFF"}`,
    ],
    [runtimeProfile, tab],
  );

  const appendExchangeEntry = useCallback((entry: Omit<SerialExchangeEntry, "id" | "timestampUs"> & { timestampUs?: number }) => {
    const timestampUs = Math.max(entry.timestampUs ?? currentTimestampUs(), lastTimestampUsRef.current + 1);
    lastTimestampUsRef.current = timestampUs;
    const nextEntry: SerialExchangeEntry = {
      ...entry,
      id: `serial-exchange-${nextExchangeIdRef.current}`,
      timestampUs,
    };
    nextExchangeIdRef.current += 1;
    setExchangeLog((current) => [...current, nextEntry]);
  }, []);

  const handleTrafficScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    setTrafficScrollTop(event.currentTarget.scrollTop);
  }, []);

  const registerTrafficRow = useCallback((entryId: string) => (node: HTMLElement | null) => {
    trafficRowObserversRef.current.get(entryId)?.disconnect();
    trafficRowObserversRef.current.delete(entryId);

    if (!node) {
      return;
    }

    const updateHeight = () => {
      const nextHeight = node.getBoundingClientRect().height || estimatedTrafficRowHeight;
      const previousHeight = trafficRowHeightsRef.current.get(entryId);
      if (previousHeight === undefined || Math.abs(previousHeight - nextHeight) > 0.5) {
        trafficRowHeightsRef.current.set(entryId, nextHeight);
        setTrafficMeasureVersion((version) => version + 1);
      }
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(node);
    trafficRowObserversRef.current.set(entryId, observer);
  }, []);

  const sendDraft = useCallback(async (slotId: string) => {
    const slot = sendSlots.find((item) => item.id === slotId);
    const draft = slot?.content ?? "";
    if (!slot || !terminalReady || !terminal || !draft.trim()) {
      return;
    }

    const content = draft.trim();
    let byteCount = 0;

    if (slot.mode === "hex") {
      const parsed = parseSerialHexDraft(content);
      if (parsed.error) {
        setHexError(parsed.error);
        return;
      }

      if (!parsed.bytes.length) {
        return;
      }

      byteCount = parsed.bytes.length;
      await Promise.resolve(onSendBytes(parsed.bytes, terminal.id));
      appendExchangeEntry({
        byteCount,
        content,
        direction: "tx",
        mode: slot.mode,
      });
    } else {
      const payload =
        slot.sendEnding === "configured"
          ? `${draft}${serialLineEndingValue(configuredEnding)}`
          : draft;

      byteCount = payload.length;
      await Promise.resolve(onSendData(payload, terminal.id));
      appendExchangeEntry({
        byteCount,
        content,
        direction: "tx",
        mode: slot.mode,
      });
    }

    setHistory((current) => {
      const id = `${slot.mode}:${content}`;
      if (current[0]?.id === id && current[0].byteCount === byteCount) {
        return current;
      }

      const next = [
        {
          byteCount,
          content,
          id,
          mode: slot.mode,
        },
        ...current.filter((item) => item.id !== id),
      ];
      return next.slice(0, maxHistoryItems);
    });
    setHexError("");
    historyIndexRef.current = null;
  }, [appendExchangeEntry, configuredEnding, onSendBytes, onSendData, sendSlots, terminal, terminalReady]);

  useEffect(() => {
    setRuntimeProfile(serialRuntimeProfile(profile, tab));
  }, [profile?.id, tab.connection.id]);

  useEffect(() => {
    setSerialOpen(Boolean(tab.terminal && tab.connection.status !== "disconnected" && tab.connection.status !== "failed"));
  }, [tab.connection.status, terminal?.id]);

  useEffect(() => {
    if (serialOpen || !runtimeProfile.portName || selectedPortIsDetected) {
      return;
    }

    setRuntimeProfile((current) =>
      current.portName === runtimeProfile.portName
        ? {
            ...current,
            portName: "",
            updatedAt: new Date().toISOString(),
          }
        : current,
    );
  }, [runtimeProfile.portName, selectedPortIsDetected, serialOpen]);

  useEffect(() => {
    setExchangeLog([]);
    trafficRowHeightsRef.current.clear();
    for (const observer of trafficRowObserversRef.current.values()) {
      observer.disconnect();
    }
    trafficRowObserversRef.current.clear();
    setTrafficMeasureVersion((version) => version + 1);
    setTrafficScrollTop(0);
  }, [terminal?.id]);

  useEffect(() => {
    const log = exchangeLogRef.current;
    if (!log) {
      return undefined;
    }

    const updateViewportHeight = () => {
      setTrafficViewportHeight(log.clientHeight);
    };

    updateViewportHeight();
    const observer = new ResizeObserver(updateViewportHeight);
    observer.observe(log);

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => () => {
    for (const observer of trafficRowObserversRef.current.values()) {
      observer.disconnect();
    }
    trafficRowObserversRef.current.clear();
  }, []);

  useEffect(() => {
    if (!terminal) {
      return undefined;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<SerialRxEvent>("portiva://serial-rx", (event) => {
          if (disposed || outputPaused || event.payload.terminalId !== terminal.id) {
            return;
          }

          appendExchangeEntry({
            byteCount: event.payload.bytes.length,
            content: event.payload.text,
            direction: "rx",
            mode: detectSerialRxMode(event.payload.bytes, event.payload.text),
            timestampUs: event.payload.timestampUs,
          });
        }),
      )
      .then((dispose) => {
        if (disposed) {
          dispose();
          return;
        }

        unlisten = dispose;
      })
      .catch(() => {
        // Browser preview cannot subscribe to Tauri events.
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [appendExchangeEntry, outputPaused, terminal]);

  useEffect(() => {
    if (!autoScroll) {
      return;
    }

    const log = exchangeLogRef.current;
    if (log) {
      window.requestAnimationFrame(() => {
        log.scrollTop = log.scrollHeight;
      });
    }
  }, [autoScroll, exchangeLog.length, trafficMeasureVersion]);

  useEffect(() => {
    const timedSlots = sendSlots.filter((slot) => slot.timedSendEnabled && slot.content.trim());
    if (!terminalReady || !terminal || !timedSlots.length) {
      return undefined;
    }

    const intervalIds = timedSlots.map((slot) =>
      window.setInterval(() => {
        if (timedSendInFlightRef.current.has(slot.id)) {
          return;
        }

        timedSendInFlightRef.current.add(slot.id);
        void sendDraft(slot.id).finally(() => {
          timedSendInFlightRef.current.delete(slot.id);
        });
      }, slot.timedSendIntervalMs),
    );

    return () => {
      for (const intervalId of intervalIds) {
        window.clearInterval(intervalId);
      }

      for (const slot of timedSlots) {
        timedSendInFlightRef.current.delete(slot.id);
      }
    };
  }, [sendDraft, sendSlots, terminal, terminalReady]);

  const updateRuntimeProfile = (patch: Partial<SerialProfile>) => {
    const nextProfile = {
      ...runtimeProfile,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    setRuntimeProfile(nextProfile);

    if (!serialOpen || !terminal || serialActionPending) {
      return;
    }

    setSerialActionPending(true);
    void Promise.resolve(onReconfigureSerialTerminal(terminal.id, nextProfile))
      .then(() => {
        setSerialOpen(true);
      })
      .catch(() => {
        setSerialOpen(false);
      })
      .finally(() => {
        setSerialActionPending(false);
      });
  };

  const updateSendSlot = (slotId: string, patch: Partial<SerialSendSlot>) => {
    setSendSlots((current) => current.map((slot) => (slot.id === slotId ? { ...slot, ...patch } : slot)));
  };

  const toggleSerial = async () => {
    if (!terminal || serialActionPending) {
      return;
    }

    setSerialActionPending(true);
    try {
      if (serialOpen) {
        await Promise.resolve(onCloseSerialTerminal(terminal.id));
        setSerialOpen(false);
      } else {
        await Promise.resolve(onOpenSerialTerminal(terminal.id, runtimeProfile));
        setSerialOpen(true);
      }
    } catch (error) {
      setSerialOpen(false);
    } finally {
      setSerialActionPending(false);
    }
  };

  const addSendSlot = () => {
    const id = `serial-send-slot-${nextSendSlotIdRef.current}`;
    nextSendSlotIdRef.current += 1;
    setSendSlots((current) => [...current, createSerialSendSlot(id)]);
  };

  const removeSendSlot = (slotId: string) => {
    setSendSlots((current) => {
      if (current.length <= 1) {
        return current;
      }

      return current.filter((slot) => slot.id !== slotId);
    });
  };

  const handleSubmit = (slotId: string, event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void sendDraft(slotId);
  };

  const handleInputKeyDown = (slotId: string, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const current = historyIndexRef.current;
      const next = current === null ? 0 : Math.min(history.length - 1, current + 1);
      historyIndexRef.current = history.length ? next : null;
      updateSendSlot(slotId, {
        content: history[next]?.content ?? sendSlots.find((slot) => slot.id === slotId)?.content ?? "",
        mode: history[next]?.mode ?? sendSlots.find((slot) => slot.id === slotId)?.mode ?? "text",
      });
      setHexError("");
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
        updateSendSlot(slotId, { content: "" });
        return;
      }

      historyIndexRef.current = next;
      updateSendSlot(slotId, {
        content: history[next]?.content ?? "",
        mode: history[next]?.mode ?? sendSlots.find((slot) => slot.id === slotId)?.mode ?? "text",
      });
      setHexError("");
    }
  };

  const restoreHistory = (entry: SerialSendHistoryEntry) => {
    setSendSlots((current) => {
      const emptySlot = current.find((slot) => !slot.content.trim());
      if (emptySlot) {
        return current.map((slot) => (slot.id === emptySlot.id ? { ...slot, content: entry.content, mode: entry.mode } : slot));
      }

      const id = `serial-send-slot-${nextSendSlotIdRef.current}`;
      nextSendSlotIdRef.current += 1;
      return [...current, createSerialSendSlot(id, { content: entry.content, mode: entry.mode })];
    });
    setHexError("");
    historyIndexRef.current = null;
  };

  const clearSendHistory = () => {
    setHistory([]);
    historyIndexRef.current = null;
  };

  const removeSendHistoryEntry = (entryId: string) => {
    setHistory((current) => current.filter((entry) => entry.id !== entryId));
    historyIndexRef.current = null;
  };

  const clearExchangeLog = () => {
    trafficRowHeightsRef.current.clear();
    for (const observer of trafficRowObserversRef.current.values()) {
      observer.disconnect();
    }
    trafficRowObserversRef.current.clear();
    setExchangeLog([]);
    setTrafficMeasureVersion((version) => version + 1);
    setTrafficScrollTop(0);
  };

  const trafficVirtualMetrics = useMemo(() => {
    const offsets: number[] = [];
    let totalHeight = 0;

    for (const entry of exchangeLog) {
      offsets.push(totalHeight);
      totalHeight += trafficRowHeightsRef.current.get(entry.id) ?? estimatedTrafficRowHeight;
    }

    return { offsets, totalHeight };
  }, [exchangeLog, trafficMeasureVersion]);

  const trafficVisibleRange = useMemo(() => {
    if (!exchangeLog.length) {
      return { end: 0, start: 0 };
    }

    const visibleTop = Math.max(0, trafficScrollTop - trafficVirtualOverscanPx);
    const visibleBottom = trafficScrollTop + trafficViewportHeight + trafficVirtualOverscanPx;
    const start = findTrafficVirtualIndex(trafficVirtualMetrics.offsets, visibleTop);
    const end = Math.min(exchangeLog.length, findTrafficVirtualIndex(trafficVirtualMetrics.offsets, visibleBottom) + 2);
    return { end, start };
  }, [exchangeLog.length, trafficScrollTop, trafficViewportHeight, trafficVirtualMetrics]);

  const visibleExchangeLog = exchangeLog.slice(trafficVisibleRange.start, trafficVisibleRange.end);
  const trafficWindowTop = trafficVirtualMetrics.offsets[trafficVisibleRange.start] ?? 0;

  return (
    <section className="serial-terminal-panel">
      <header className="serial-session-bar">
        <div className="serial-link-identity">
          <span className="serial-port-mark">
            <Icon name="plug" />
          </span>
          <strong>{runtimeProfile.portName || portName}</strong>
          <span>{serialBaudLabel(tab, runtimeProfile)}</span>
        </div>
        <div className="serial-chip-row" aria-label="串口状态">
          <span className="serial-status-chip">{statusText}</span>
          {statusChips.slice(1).map((chip) => (
            <span key={chip}>{chip}</span>
          ))}
        </div>
      </header>

      <div className="serial-control-layout">
        <div className="serial-main-pane">
          <section className="serial-traffic-panel" aria-label="串口通信内容区">
            <header className="serial-traffic-toolbar">
              <strong>通信内容区</strong>
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
                <button title="清屏" type="button" onClick={clearExchangeLog}>
                  <Icon name="trash" />
                </button>
              </div>
            </header>
            <div className="serial-traffic-log" ref={exchangeLogRef} onScroll={handleTrafficScroll}>
              {exchangeLog.length ? (
                <div className="serial-traffic-virtual" style={{ height: trafficVirtualMetrics.totalHeight }}>
                  <div className="serial-traffic-window" style={{ transform: `translateY(${trafficWindowTop}px)` }}>
                    {visibleExchangeLog.map((entry) => (
                      <article className={`serial-traffic-row ${entry.direction}`} key={entry.id} ref={registerTrafficRow(entry.id)}>
                        <span className="serial-traffic-time">{formatExchangeTime(entry.timestampUs)}</span>
                        <span className="serial-traffic-direction">{entry.direction === "tx" ? "发送" : "接收"}</span>
                        <span className="serial-traffic-mode">{entry.mode ? entry.mode.toUpperCase() : "-"}</span>
                        <span className="serial-traffic-size">{formatByteSize(entry.byteCount)}</span>
                        <pre>{entry.content}</pre>
                      </article>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="serial-traffic-empty">暂无串口通信内容</div>
              )}
            </div>
          </section>

          <div className="serial-command-strip">
            <div className="serial-send-toolbar">
              <span>发送输入</span>
              <button className="serial-add-send-slot" type="button" onClick={addSendSlot}>
                <Icon name="plus" />
                <span>新增输入</span>
              </button>
            </div>

            <div className="serial-send-slots">
              {sendSlots.map((slot, index) => (
                <form className="serial-send-form" key={slot.id} noValidate onSubmit={(event) => handleSubmit(slot.id, event)}>
                  <input
                    aria-label={`串口发送内容 ${index + 1}`}
                    autoComplete="off"
                    className="serial-send-input"
                    disabled={!terminalReady}
                    placeholder={slot.mode === "hex" ? "01 03 00 00 FF" : "AT"}
                    spellCheck={false}
                    type="text"
                    value={slot.content}
                    onChange={(event) => {
                      updateSendSlot(slot.id, { content: event.currentTarget.value });
                      setHexError("");
                      historyIndexRef.current = null;
                    }}
                    onKeyDown={(event) => handleInputKeyDown(slot.id, event)}
                  />
                  <span className="serial-send-index">{index + 1}</span>
                  <div
                    className={`serial-send-mode ${slot.mode === "hex" ? "mode-hex" : "mode-text"}`}
                    role="group"
                    aria-label={`串口发送模式 ${index + 1}`}
                  >
                    <button
                      aria-pressed={slot.mode === "text"}
                      className={slot.mode === "text" ? "active" : ""}
                      type="button"
                      onClick={() => {
                        updateSendSlot(slot.id, { mode: "text" });
                        setHexError("");
                      }}
                    >
                      TEXT
                    </button>
                    <button
                      aria-pressed={slot.mode === "hex"}
                      className={slot.mode === "hex" ? "active" : ""}
                      type="button"
                      onClick={() => {
                        updateSendSlot(slot.id, { mode: "hex" });
                        setHexError("");
                      }}
                    >
                      HEX
                    </button>
                  </div>
                  <Select
                    aria-label={`发送结束符 ${index + 1}`}
                    className="serial-send-ending-select"
                    disabled={slot.mode === "hex"}
                    menuWidth={112}
                    style={{ width: 112 }}
                    value={slot.sendEnding}
                    options={[
                      { label: `+${serialLineEndingLabel(configuredEnding)}`, value: "configured" },
                      { label: "无结束符", value: "none" },
                    ]}
                    onChange={(sendEnding) => updateSendSlot(slot.id, { sendEnding: sendEnding as SerialSendEnding })}
                  />
                  <label className={["serial-timed-send", slot.timedSendEnabled ? "active" : ""].join(" ")}>
                    <input
                      checked={slot.timedSendEnabled}
                      disabled={!terminalReady}
                      type="checkbox"
                      onChange={(event) => updateSendSlot(slot.id, { timedSendEnabled: event.currentTarget.checked })}
                    />
                    <span>定时</span>
                    <input
                      aria-label={`定时发送间隔 ${index + 1}（毫秒）`}
                      max={maxTimedSendIntervalMs}
                      min={minTimedSendIntervalMs}
                      step={50}
                      type="number"
                      value={slot.timedSendIntervalMs}
                      onChange={(event) => updateSendSlot(slot.id, { timedSendIntervalMs: clampTimedSendInterval(event.currentTarget.valueAsNumber) })}
                    />
                    <span>ms</span>
                  </label>
                  <button className="serial-send-submit" disabled={!terminalReady || !slot.content.trim()} type="submit">
                    <Icon name="terminal" />
                    <span>发送</span>
                  </button>
                  <button
                    className="serial-send-delete"
                    disabled={sendSlots.length <= 1}
                    title={sendSlots.length <= 1 ? "至少保留一个输入" : "删除输入"}
                    type="button"
                    onClick={() => removeSendSlot(slot.id)}
                  >
                    <Icon name="x" />
                  </button>
                </form>
              ))}
            </div>
            {hexError ? <span className="serial-send-error">{hexError}</span> : null}

          </div>
        </div>

        <div className="serial-control-main">
          <section className="serial-config-panel" aria-label="串口连接参数">
            <label className="serial-port-config-field">
              <span>端口</span>
              <span className="serial-port-config-control">
                <Select
                  className="serial-port-select"
                  disabled={serialActionPending}
                  value={runtimeProfile.portName}
                  placeholder={serialPorts.length ? "选择端口" : "未检测到端口"}
                  options={serialPortOptions}
                  onChange={(portName) => updateRuntimeProfile({ portName })}
                />
                <IconButton disabled={serialActionPending || !onRefreshSerialPorts} icon="refresh-ccw" title="刷新端口" onClick={() => void onRefreshSerialPorts?.()} />
              </span>
            </label>
            <label>
              <span>波特率</span>
              <Select
                value={runtimeProfile.baudRate}
                options={baudRateOptions.map((baudRate) => ({ label: baudRate, value: baudRate }))}
                onChange={(baudRate) => updateRuntimeProfile({ baudRate })}
              />
            </label>
            <label>
              <span>数据位</span>
              <Select
                value={runtimeProfile.dataBits}
                options={[5, 6, 7, 8].map((value) => ({ label: value, value }))}
                onChange={(dataBits) => updateRuntimeProfile({ dataBits: dataBits as SerialProfile["dataBits"] })}
              />
            </label>
            <label>
              <span>校验</span>
              <Select
                value={runtimeProfile.parity}
                options={[
                  { label: "无", value: "none" },
                  { label: "奇校验", value: "odd" },
                  { label: "偶校验", value: "even" },
                ]}
                onChange={(parity) => updateRuntimeProfile({ parity: parity as SerialProfile["parity"] })}
              />
            </label>
            <label>
              <span>停止位</span>
              <Select
                value={runtimeProfile.stopBits}
                options={[
                  { label: "1", value: 1 },
                  { label: "2", value: 2 },
                ]}
                onChange={(stopBits) => updateRuntimeProfile({ stopBits: stopBits as SerialProfile["stopBits"] })}
              />
            </label>
            <label>
              <span>流控</span>
              <Select
                value={runtimeProfile.flowControl}
                options={[
                  { label: "无", value: "none" },
                  { label: "软件", value: "software" },
                  { label: "硬件", value: "hardware" },
                ]}
                onChange={(flowControl) => updateRuntimeProfile({ flowControl: flowControl as SerialProfile["flowControl"] })}
              />
            </label>
            <label>
              <span>编码</span>
              <Select
                value={runtimeProfile.encoding}
                options={serialEncodingOptions}
                onChange={(encoding) => updateRuntimeProfile({ encoding: encoding as SerialProfile["encoding"] })}
              />
            </label>
            <label>
              <span>结束符</span>
              <Select
                value={runtimeProfile.lineEnding}
                options={[
                  { label: "CRLF", value: "crlf" },
                  { label: "CR", value: "cr" },
                  { label: "LF", value: "lf" },
                ]}
                onChange={(lineEnding) => updateRuntimeProfile({ lineEnding: lineEnding as SerialProfile["lineEnding"] })}
              />
            </label>
            <Toggle
              checked={Boolean(runtimeProfile.dtr)}
              className="serial-config-check"
              label="DTR"
              onChange={(event) => updateRuntimeProfile({ dtr: event.currentTarget.checked })}
            />
            <Toggle
              checked={Boolean(runtimeProfile.rts)}
              className="serial-config-check"
              label="RTS"
              onChange={(event) => updateRuntimeProfile({ rts: event.currentTarget.checked })}
            />
            <div className="serial-config-actions">
              <button
                className={serialOpen ? "serial-close-action" : "serial-open-action"}
                disabled={serialActionPending || !terminal || !runtimeProfile.portName.trim()}
                type="button"
                onClick={() => void toggleSerial()}
              >
                {serialOpen ? "关闭" : "打开"}
              </button>
            </div>
          </section>

          <section className="serial-send-history" aria-label="串口发送历史">
            <div className="serial-send-history-header">
              <strong>发送历史</strong>
              <span>{history.length ? `${history.length}/${maxHistoryItems}` : "暂无"}</span>
              <button disabled={!history.length} title="清空发送历史" type="button" onClick={clearSendHistory}>
                <Icon name="trash" />
              </button>
            </div>
            {history.length ? (
              <div className="serial-send-history-list">
                {history.map((entry) => (
                  <div className="serial-send-history-item" key={entry.id}>
                    <button className="serial-history-restore" type="button" onClick={() => restoreHistory(entry)}>
                      <span className="serial-history-mode">{entry.mode.toUpperCase()}</span>
                      <span className="serial-history-content">{entry.content}</span>
                      <span className="serial-history-count">{entry.byteCount}B</span>
                    </button>
                    <button className="serial-history-delete" title="删除此历史" type="button" onClick={() => removeSendHistoryEntry(entry.id)}>
                      <Icon name="x" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </section>
  );
}
