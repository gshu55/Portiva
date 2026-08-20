import { useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type {
  TerminalColorPalette,
  TerminalRightClickBehavior,
  TerminalSession,
  TerminalSize,
  TerminalSnapshot,
} from "../../shared/types";
import { readClipboardText, writeClipboardHtml, writeClipboardText } from "../../shared/clipboard";
import { Icon } from "../../shared/Icon";
import { parseOsc7WorkingDirectory } from "../../shared/terminalWorkingDirectory";
import { resolveTerminalFontFamily, resolveTerminalFontSize } from "../../shared/terminalFonts";
import { TerminalSemanticHighlighter } from "./terminalSemanticHighlighter";

interface TerminalPaneProps {
  autoScroll?: boolean;
  clearRevision?: number;
  isActive?: boolean;
  reportSizeWhenVisible?: boolean;
  semanticHighlighting?: boolean;
  terminal: TerminalSession | null;
  terminalConfirmMultilinePaste?: boolean;
  terminalCopyRichText?: boolean;
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalRightClickBehavior?: TerminalRightClickBehavior;
  terminalTheme: TerminalColorPalette;
  terminalSnapshot: TerminalSnapshot | null;
  onActivity?: (terminalId: string) => void;
  onCloseDisconnected?: () => void;
  onCommandSubmitted?: (command: string) => void;
  onReconnectDisconnected?: () => void;
  onResizeTerminal: (size?: TerminalSize, terminalId?: string) => Promise<void> | void;
  onSendData: (data: string, terminalId: string) => Promise<void> | void;
  onTitleChange?: (terminalId: string, title: string) => void;
  onWorkingDirectoryChange?: (terminalId: string, path: string) => void;
}

type RgbColor = [number, number, number];
type MainstreamCli =
  | "aider"
  | "claude"
  | "codex"
  | "copilot"
  | "cursor"
  | "gemini"
  | "opencode"
  | "qwen";

const cliExecutableNames: Record<string, MainstreamCli> = {
  "@anthropic-ai/claude-code": "claude",
  "@google/gemini-cli": "gemini",
  "@openai/codex": "codex",
  "@qwen-code/qwen-code": "qwen",
  aider: "aider",
  "aider-chat": "aider",
  claude: "claude",
  codex: "codex",
  copilot: "copilot",
  "cursor-agent": "cursor",
  gemini: "gemini",
  opencode: "opencode",
  "opencode-ai": "opencode",
  qwen: "qwen",
  "qwen-code": "qwen",
};

const cliTitleMatchers: Array<[MainstreamCli, RegExp]> = [
  ["claude", /(?:^|[\s|\-—])claude(?:\s+code)?(?:$|[\s|\-—])/i],
  ["codex", /(?:^|[\s|\-—])codex(?:$|[\s|\-—])/i],
  ["gemini", /(?:^|[\s|\-—])gemini(?:$|[\s|\-—])/i],
  ["aider", /(?:^|[\s|\-—])aider(?:$|[\s|\-—])/i],
  ["opencode", /(?:^|[\s|\-—])opencode(?:$|[\s|\-—])/i],
  ["qwen", /(?:^|[\s|\-—])qwen(?:\s+code)?(?:$|[\s|\-—])/i],
  ["copilot", /(?:^|[\s|\-—])copilot(?:$|[\s|\-—])/i],
  ["cursor", /(?:^|[\s|\-—])cursor(?:\s+agent)?(?:$|[\s|\-—])/i],
];

function tokenizeCommand(command: string) {
  return (
    command
      .match(/"[^"]*"|'[^']*'|\S+/g)
      ?.map((token) => token.replace(/^["']|["']$/g, "")) ?? []
  );
}

function commandName(token: string) {
  return token
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.toLowerCase()
    .replace(/\.(?:cmd|exe|ps1)$/i, "") ?? "";
}

function detectMainstreamCliCommand(command: string): MainstreamCli | null {
  const tokens = tokenizeCommand(command.trim());
  let index = 0;

  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) {
    index += 1;
  }

  const wrapper = commandName(tokens[index] ?? "");
  if (wrapper === "sudo" || wrapper === "env") {
    index += 1;
    while (
      (tokens[index] ?? "").startsWith("-") ||
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")
    ) {
      index += 1;
    }
  }

  const packageRunner = commandName(tokens[index] ?? "");
  if (["bunx", "npx", "uvx"].includes(packageRunner)) {
    index += 1;
    while ((tokens[index] ?? "").startsWith("-")) {
      index += 1;
    }
  } else if (
    ["pnpm", "yarn"].includes(packageRunner) &&
    ["dlx", "exec"].includes((tokens[index + 1] ?? "").toLowerCase())
  ) {
    index += 2;
  } else if (packageRunner === "pipx" && (tokens[index + 1] ?? "").toLowerCase() === "run") {
    index += 2;
  }

  const executable = commandName(tokens[index] ?? "");
  if (["python", "python3", "py"].includes(executable) && (tokens[index + 1] ?? "").toLowerCase() === "-m") {
    return cliExecutableNames[commandName(tokens[index + 2] ?? "")] ?? null;
  }

  return cliExecutableNames[executable] ?? cliExecutableNames[(tokens[index] ?? "").toLowerCase()] ?? null;
}

function detectMainstreamCliTitle(title: string): MainstreamCli | null {
  return cliTitleMatchers.find(([, matcher]) => matcher.test(title.trim()))?.[0] ?? null;
}

function isShellTerminalTitle(title: string) {
  return /(?:^|[\\/\s])(?:bash|cmd|fish|nu|powershell|pwsh|zsh)(?:\.exe)?(?:$|[\s:|\-—])/i.test(title.trim());
}

function parseTerminalColor(color: string): RgbColor | null {
  const hexMatch = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (hexMatch) {
    return [
      Number.parseInt(hexMatch[1].slice(0, 2), 16),
      Number.parseInt(hexMatch[1].slice(2, 4), 16),
      Number.parseInt(hexMatch[1].slice(4, 6), 16),
    ];
  }

  const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color);
  return rgbMatch ? (rgbMatch.slice(1, 4).map(Number) as RgbColor) : null;
}

function isDarkColor(color: string) {
  const [red, green, blue] = parseTerminalColor(color) ?? [0, 0, 0];
  return red * 0.299 + green * 0.587 + blue * 0.114 < 150;
}

function formatOscRgb(color: RgbColor) {
  const channels = color.map((channel) => {
    const hex = Math.max(0, Math.min(255, channel)).toString(16).padStart(2, "0");
    return `${hex}${hex}`;
  });
  return `rgb:${channels.join("/")}`;
}

function createSearchSelectionTheme(theme: TerminalColorPalette) {
  const dark = isDarkColor(theme.background);

  return {
    selectionBackground: dark ? theme.brightYellow : theme.cursor,
    selectionForeground: dark ? "#142027" : "#FFFFFF",
    selectionInactiveBackground: dark ? theme.yellow : theme.cyan,
  };
}

function resolveXtermCanvasBackground(background: string) {
  const rgba = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*[\d.]+\s*\)$/i.exec(background);
  if (!rgba) {
    return background;
  }

  // The pane owns the wallpaper-aware glass fill. Keep the canvas virtually
  // transparent, but not alpha-zero: WebView2 can normalize alpha-zero xterm
  // backgrounds to opaque black or white on some GPU paths.
  return `rgba(${rgba[1]}, ${rgba[2]}, ${rgba[3]}, 0.01)`;
}

function createXtermTheme(theme: TerminalColorPalette, emphasizeSelection = false) {
  const searchSelection = emphasizeSelection ? createSearchSelectionTheme(theme) : null;

  return {
    background: resolveXtermCanvasBackground(theme.background),
    black: theme.black,
    blue: theme.blue,
    brightBlack: theme.brightBlack,
    brightBlue: theme.brightBlue,
    brightCyan: theme.brightCyan,
    brightGreen: theme.brightGreen,
    brightMagenta: theme.brightMagenta,
    brightRed: theme.brightRed,
    brightWhite: theme.brightWhite,
    brightYellow: theme.brightYellow,
    cursor: theme.cursor,
    cyan: theme.cyan,
    foreground: theme.foreground,
    green: theme.green,
    magenta: theme.magenta,
    red: theme.red,
    selectionBackground: searchSelection?.selectionBackground ?? theme.selectionBackground,
    selectionForeground: searchSelection?.selectionForeground,
    selectionInactiveBackground: searchSelection?.selectionInactiveBackground ?? theme.selectionBackground,
    white: theme.white,
    yellow: theme.yellow,
  };
}

type SearchStatus = "idle" | "found" | "empty" | "error";

const wordSeparators = " ~!@#$%^&*()+`-=[]{}|\\;:\"',./<>?\r\n\t";
const alternateBufferWheelScrollSpeed = 3;

interface AlternateBufferWheelState {
  partialRows: number;
}

function consumeAlternateBufferWheel(
  event: WheelEvent,
  terminalRows: number,
  terminalHeight: number,
  state: AlternateBufferWheelState,
) {
  if (event.deltaY === 0 || event.shiftKey) {
    return 0;
  }

  let amount = event.deltaY;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
    const cellHeight = Math.max(terminalHeight / Math.max(terminalRows, 1), 1);
    amount /= cellHeight;

    // Precision touchpads emit many small pixel deltas. Accumulate them instead
    // of turning every event into a keypress, which would make scrolling erratic.
    if (Math.abs(event.deltaY) < 50) {
      amount *= 0.3;
    }

    state.partialRows += amount;
    amount = Math.floor(Math.abs(state.partialRows)) * Math.sign(state.partialRows);
    state.partialRows %= 1;
  } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    amount *= Math.max(terminalRows, 1);
  }

  return amount;
}

function alternateBufferArrowSequence(instance: Terminal, direction: number) {
  const prefix = instance.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[";
  return `${prefix}${direction < 0 ? "A" : "B"}`;
}

function isTerminalSearchShortcut(event: KeyboardEvent) {
  if (event.key.toLowerCase() !== "f" || event.altKey) {
    return false;
  }

  return event.metaKey || (event.ctrlKey && event.shiftKey);
}

function readTerminalPlainText(instance: Terminal | null) {
  if (!instance) {
    return "";
  }

  const buffer = instance.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }

  return lines.join("\n");
}

function isWholeWordMatch(source: string, index: number, termLength: number) {
  const before = index === 0 ? "" : source[index - 1];
  const afterIndex = index + termLength;
  const after = afterIndex >= source.length ? "" : source[afterIndex];

  return (!before || wordSeparators.includes(before)) && (!after || wordSeparators.includes(after));
}

function countSearchMatches(
  source: string,
  term: string,
  caseSensitive: boolean,
  wholeWord: boolean,
) {
  if (!source || !term) {
    return 0;
  }

  const haystack = caseSensitive ? source : source.toLowerCase();
  const needle = caseSensitive ? term : term.toLowerCase();
  let count = 0;
  let index = 0;

  while (index <= haystack.length - needle.length) {
    const matchIndex = haystack.indexOf(needle, index);
    if (matchIndex === -1) {
      break;
    }

    if (!wholeWord || isWholeWordMatch(haystack, matchIndex, needle.length)) {
      count += 1;
    }

    index = matchIndex + needle.length;
  }

  return count;
}

function isSensitiveTerminalPrompt(instance: Terminal) {
  const buffer = instance.buffer.active;
  const line = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true).trim() ?? "";
  return /(?:password|passphrase|authentication\s+token|one[- ]time\s+(?:code|password)|otp|密码|口令|验证码)\s*(?:for\s+\S+)?\s*[:：]?\s*$/i.test(line);
}

function captureSubmittedCommands(data: string, currentDraft: string) {
  const commands: string[] = [];
  let draft = currentDraft;
  let previous = "";
  const normalized = data
    .replace(/\x1b\[200~/g, "")
    .replace(/\x1b\[201~/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1bO./g, "");

  for (const character of normalized) {
    if (character === "\n" && previous === "\r") {
      previous = character;
      continue;
    }

    if (character === "\r" || character === "\n") {
      const command = draft.trim();
      if (command) {
        commands.push(command);
      }
      draft = "";
    } else if (character === "\x7f" || character === "\b") {
      draft = Array.from(draft).slice(0, -1).join("");
    } else if (character === "\x03" || character === "\x15") {
      draft = "";
    } else if (character === "\x17") {
      draft = draft.replace(/\S+\s*$/, "");
    } else if (character >= " ") {
      draft += character;
    }

    previous = character;
  }

  return { commands, draft };
}

export function TerminalPane({
  autoScroll = true,
  clearRevision = 0,
  isActive = true,
  onResizeTerminal,
  onActivity,
  onCloseDisconnected,
  onCommandSubmitted,
  onReconnectDisconnected,
  onSendData,
  onTitleChange,
  onWorkingDirectoryChange,
  reportSizeWhenVisible = false,
  semanticHighlighting = false,
  terminal,
  terminalConfirmMultilinePaste = true,
  terminalCopyRichText = false,
  terminalFontFamily,
  terminalFontSize,
  terminalRightClickBehavior = "context-menu",
  terminalTheme,
  terminalSnapshot,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const commandDraftRef = useRef("");
  const commandSubmittedRef = useRef(onCommandSubmitted);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const semanticHighlighterRef = useRef<TerminalSemanticHighlighter | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const pasteTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastBufferRef = useRef("");
  const renderInitializedRef = useRef(false);
  const replayingSnapshotRef = useRef(false);
  const snapshotReplayRevisionRef = useRef(0);
  const lastClearRevisionRef = useRef(clearRevision);
  const pendingOutputRef = useRef("");
  const outputFrameRef = useRef<number | null>(null);
  const lastReportedSizeRef = useRef<TerminalSize | null>(null);
  const autoScrollRef = useRef(autoScroll);
  const resizeTerminalRef = useRef(onResizeTerminal);
  const resizeQueueRef = useRef(Promise.resolve());
  const sendDataRef = useRef(onSendData);
  const inputQueueRef = useRef(Promise.resolve());
  const isActiveRef = useRef(isActive);
  const terminalStatusRef = useRef(terminal?.status ?? null);
  const activityRef = useRef(onActivity);
  const closeDisconnectedRef = useRef(onCloseDisconnected);
  const reconnectDisconnectedRef = useRef(onReconnectDisconnected);
  const titleChangeRef = useRef(onTitleChange);
  const workingDirectoryChangeRef = useRef(onWorkingDirectoryChange);
  const openSearchRef = useRef<() => void>(() => undefined);
  const reportSizeWhenVisibleRef = useRef(reportSizeWhenVisible);
  const reportSizeRef = useRef<((force?: boolean) => void) | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const tuiReportedForegroundRef = useRef<RgbColor>(
    parseTerminalColor(terminalTheme.foreground) ?? [217, 226, 234],
  );
  const tuiReportedBackgroundRef = useRef<RgbColor>(
    parseTerminalColor(terminalTheme.background) ?? [8, 10, 12],
  );
  const activeMainstreamCliRef = useRef<MainstreamCli | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);
  const [searchStatus, setSearchStatus] = useState<SearchStatus>("idle");
  const [searchMatchIndex, setSearchMatchIndex] = useState(-1);
  const [pasteDraft, setPasteDraft] = useState<string | null>(null);
  const [alternateScreenCli, setAlternateScreenCli] = useState<MainstreamCli | null>(null);
  const [dismissedScrollbackHintFor, setDismissedScrollbackHintFor] = useState<string | null>(null);
  const [copiedScrollbackFixFor, setCopiedScrollbackFixFor] = useState<string | null>(null);
  const terminalBuffer = terminalSnapshot?.bufferPreview ?? "";
  const terminalOutputChunk = terminalSnapshot?.outputChunk ?? "";
  const terminalStatus = terminal?.status ?? terminalSnapshot?.status ?? null;
  const normalizedSearchQuery = searchQuery.trim();
  const searchMatchCount = useMemo(
    () => {
      if (!isSearchOpen || !normalizedSearchQuery) {
        return 0;
      }

      return countSearchMatches(
        terminalBuffer,
        normalizedSearchQuery,
        searchCaseSensitive,
        searchWholeWord,
      );
    },
    [isSearchOpen, terminalBuffer, normalizedSearchQuery, searchCaseSensitive, searchWholeWord],
  );
  const emphasizeSearchSelection = isSearchOpen && searchStatus === "found";
  const pasteText = pasteDraft ?? "";
  const pasteLineCount = pasteDraft !== null ? pasteText.split(/\r\n|\r|\n/).length : 0;
  const resolvedTerminalFontFamily = resolveTerminalFontFamily(terminalFontFamily);
  const resolvedTerminalFontSize = resolveTerminalFontSize(terminalFontSize);
  const resolvedScrollbackLines = Math.min(
    100_000,
    Math.max(1000, Math.round(terminal?.renderPolicy.scrollbackLines ?? 10_000)),
  );

  useEffect(() => {
    resizeTerminalRef.current = onResizeTerminal;
  }, [onResizeTerminal]);

  useEffect(() => {
    activityRef.current = onActivity;
  }, [onActivity]);

  useEffect(() => {
    tuiReportedForegroundRef.current =
      parseTerminalColor(terminalTheme.foreground) ?? [217, 226, 234];
    tuiReportedBackgroundRef.current =
      parseTerminalColor(terminalTheme.background) ?? [8, 10, 12];
  }, [terminalTheme]);

  useEffect(() => {
    sendDataRef.current = onSendData;
  }, [onSendData]);

  useEffect(() => {
    commandSubmittedRef.current = onCommandSubmitted;
  }, [onCommandSubmitted]);

  useEffect(() => {
    terminalStatusRef.current = terminalStatus;
  }, [terminalStatus]);

  useEffect(() => {
    closeDisconnectedRef.current = onCloseDisconnected;
  }, [onCloseDisconnected]);

  useEffect(() => {
    reconnectDisconnectedRef.current = onReconnectDisconnected;
  }, [onReconnectDisconnected]);

  useEffect(() => {
    titleChangeRef.current = onTitleChange;
  }, [onTitleChange]);

  useEffect(() => {
    workingDirectoryChangeRef.current = onWorkingDirectoryChange;
  }, [onWorkingDirectoryChange]);

  useEffect(() => {
    autoScrollRef.current = autoScroll;
  }, [autoScroll]);

  const enqueueInput = (data: string, terminalId: string) => {
    inputQueueRef.current = inputQueueRef.current
      .then(() => Promise.resolve(sendDataRef.current(data, terminalId)))
      .catch((error) => {
        console.warn("终端输入发送失败", error);
      });
    return inputQueueRef.current;
  };

  const enqueueResize = (size: TerminalSize, terminalId: string) => {
    // SSH window-change requests are asynchronous. Keep them ordered so an
    // older measurement can never arrive after the latest one.
    resizeQueueRef.current = resizeQueueRef.current
      .catch(() => undefined)
      .then(() => Promise.resolve(resizeTerminalRef.current(size, terminalId)))
      .catch((error) => {
        console.warn("终端尺寸调整失败", error);
      });
  };

  const shouldKeepScrollAtBottom = (instance: Terminal) => {
    if (!autoScrollRef.current || instance.buffer.active.type === "alternate") {
      return false;
    }

    return instance.buffer.active.baseY - instance.buffer.active.viewportY <= 1;
  };

  const writeOutput = (instance: Terminal, output: string, onParsed?: () => void) => {
    const keepScrollAtBottom = shouldKeepScrollAtBottom(instance);
    instance.write(output, () => {
      if (keepScrollAtBottom && instance.buffer.active.type !== "alternate") {
        instance.scrollToBottom();
      }
      onParsed?.();
    });
  };

  const replaySnapshot = (instance: Terminal, output: string) => {
    snapshotReplayRevisionRef.current += 1;
    const revision = snapshotReplayRevisionRef.current;
    // 历史 ANSI 数据可能包含设备状态查询；重放只用于恢复画面，不能再次回写远端。
    replayingSnapshotRef.current = true;
    writeOutput(instance, output, () => {
      if (xtermRef.current === instance && snapshotReplayRevisionRef.current === revision) {
        replayingSnapshotRef.current = false;
      }
    });
  };

  const flushPendingOutput = () => {
    outputFrameRef.current = null;
    const instance = xtermRef.current;
    const output = pendingOutputRef.current;

    if (!instance || !output) {
      return;
    }

    pendingOutputRef.current = "";
    writeOutput(instance, output);
  };

  const enqueueOutput = (output: string) => {
    if (!output) {
      return;
    }

    pendingOutputRef.current += output;
    if (outputFrameRef.current !== null) {
      return;
    }

    outputFrameRef.current = window.requestAnimationFrame(flushPendingOutput);
  };

  const openSearch = () => {
    closeContextMenu();
    setIsSearchOpen(true);
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  };

  const closeSearch = () => {
    setIsSearchOpen(false);
    setSearchStatus("idle");
    setSearchMatchIndex(-1);
    searchAddonRef.current?.clearDecorations();
    window.requestAnimationFrame(() => {
      xtermRef.current?.focus();
    });
  };

  const isMultilinePaste = (text: string) => /\r\n|\r|\n/.test(text);

  const closePasteConfirm = () => {
    setPasteDraft(null);
    window.requestAnimationFrame(() => {
      xtermRef.current?.focus();
    });
  };

  const sendPastedText = (text: string) => {
    if (!terminal || terminalStatus === "closed" || !text) {
      return;
    }

    // 由 xterm 根据当前 bracketed-paste 模式统一处理换行和粘贴边界。
    xtermRef.current?.paste(text);
  };

  const queuePastedText = async (text: string) => {
    if (!text) {
      return;
    }

    if (terminalConfirmMultilinePaste && isMultilinePaste(text)) {
      setPasteDraft(text);
      window.requestAnimationFrame(() => {
        pasteTextAreaRef.current?.focus();
        pasteTextAreaRef.current?.setSelectionRange(text.length, text.length);
      });
      return;
    }

    sendPastedText(text);
  };

  const confirmPasteDraft = async () => {
    const text = pasteText;
    setPasteDraft(null);
    sendPastedText(text);
    window.requestAnimationFrame(() => {
      xtermRef.current?.focus();
    });
  };

  const findNext = (query = searchQuery, incremental = false, advanceIndex = true) => {
    const term = query.trim();
    if (!term) {
      searchAddonRef.current?.clearDecorations();
      setSearchStatus("idle");
      setSearchMatchIndex(-1);
      return false;
    }

    const searchOptions: ISearchOptions = {
      caseSensitive: searchCaseSensitive,
      incremental,
      wholeWord: searchWholeWord,
    };

    try {
      const found = searchAddonRef.current?.findNext(term, searchOptions) ?? false;
      setSearchStatus(found ? "found" : "empty");
      setSearchMatchIndex((previous) => {
        if (!found || searchMatchCount <= 0) {
          return -1;
        }

        if (!advanceIndex || previous < 0) {
          return 0;
        }

        return (previous + 1) % searchMatchCount;
      });
      return found;
    } catch (error) {
      console.warn("终端搜索失败", error);
      setSearchStatus("error");
      setSearchMatchIndex(-1);
      return false;
    }
  };

  const findPrevious = (query = searchQuery) => {
    const term = query.trim();
    if (!term) {
      searchAddonRef.current?.clearDecorations();
      setSearchStatus("idle");
      setSearchMatchIndex(-1);
      return false;
    }

    const searchOptions: ISearchOptions = {
      caseSensitive: searchCaseSensitive,
      wholeWord: searchWholeWord,
    };

    try {
      const found = searchAddonRef.current?.findPrevious(term, searchOptions) ?? false;
      setSearchStatus(found ? "found" : "empty");
      setSearchMatchIndex((previous) => {
        if (!found || searchMatchCount <= 0) {
          return -1;
        }

        if (previous < 0) {
          return searchMatchCount - 1;
        }

        return (previous - 1 + searchMatchCount) % searchMatchCount;
      });
      return found;
    } catch (error) {
      console.warn("终端搜索失败", error);
      setSearchStatus("error");
      setSearchMatchIndex(-1);
      return false;
    }
  };

  useEffect(() => {
    openSearchRef.current = openSearch;
  });

  useEffect(() => {
    isActiveRef.current = isActive;
    if (!isActive) {
      return;
    }

    window.requestAnimationFrame(() => {
      reportSizeRef.current?.();
      xtermRef.current?.focus();
    });
  }, [isActive, terminal?.id]);

  useEffect(() => {
    reportSizeWhenVisibleRef.current = reportSizeWhenVisible;
    window.requestAnimationFrame(() => {
      reportSizeRef.current?.();
    });
  }, [reportSizeWhenVisible, terminal?.id]);

  useEffect(() => {
    const container = containerRef.current;

    commandDraftRef.current = "";
    activeMainstreamCliRef.current = null;
    setAlternateScreenCli(null);

    if (!terminal || !container) {
      xtermRef.current?.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      lastBufferRef.current = "";
      renderInitializedRef.current = false;
      replayingSnapshotRef.current = false;
      snapshotReplayRevisionRef.current += 1;
      return;
    }

    container.replaceChildren();
    const instance = new Terminal({
      allowProposedApi: true,
      allowTransparency: true,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      disableStdin: false,
      fontFamily: resolvedTerminalFontFamily,
      fontSize: resolvedTerminalFontSize,
      scrollback: resolvedScrollbackLines,
      theme: createXtermTheme(terminalTheme),
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon({ highlightLimit: 2000 });
    const serializeAddon = new SerializeAddon();
    const semanticHighlighter = new TerminalSemanticHighlighter(instance, terminalTheme, semanticHighlighting);
    instance.loadAddon(fitAddon);
    instance.loadAddon(searchAddon);
    instance.loadAddon(serializeAddon);
    instance.open(container);
    const workingDirectoryHandler = instance.parser.registerOscHandler(7, (data) => {
      const path = parseOsc7WorkingDirectory(data);

      if (path) {
        workingDirectoryChangeRef.current?.(terminal.id, path);
      }

      return true;
    });
    const foregroundQueryHandler = instance.parser.registerOscHandler(10, (data) => {
      if (data.trim() !== "?") {
        return false;
      }

      instance.input(
        `\x1b]10;${formatOscRgb(tuiReportedForegroundRef.current)}\x1b\\`,
        false,
      );
      return true;
    });
    const backgroundQueryHandler = instance.parser.registerOscHandler(11, (data) => {
      if (data.trim() !== "?") {
        return false;
      }

      // Full-screen TUIs such as Codex require both OSC 10 and OSC 11 before
      // enabling their native composer background. Report the real terminal
      // palette and let each TUI paint its own complete input region.
      instance.input(
        `\x1b]11;${formatOscRgb(tuiReportedBackgroundRef.current)}\x1b\\`,
        false,
      );
      return true;
    });
    let activeBufferType = instance.buffer.active.type;
    let alternateScreenResizeFrame: number | null = null;
    const syncAlternateScreenCli = () => {
      const nextBufferType = instance.buffer.active.type;
      const enteredAlternateScreen =
        activeBufferType !== "alternate" && nextBufferType === "alternate";
      activeBufferType = nextBufferType;
      const nextCli = nextBufferType === "alternate" ? activeMainstreamCliRef.current : null;
      setAlternateScreenCli((current) => (current === nextCli ? current : nextCli));

      if (enteredAlternateScreen) {
        if (alternateScreenResizeFrame !== null) {
          window.cancelAnimationFrame(alternateScreenResizeFrame);
        }
        alternateScreenResizeFrame = window.requestAnimationFrame(() => {
          alternateScreenResizeFrame = null;
          if (xtermRef.current === instance) {
            // Full-screen TUIs calculate their whole layout from PTY rows.
            // Re-send even an unchanged size so a missed/stale window-change
            // cannot leave only the bottom portion visible.
            reportSizeRef.current?.(true);
          }
        });
      }
    };
    const setActiveMainstreamCli = (cli: MainstreamCli | null) => {
      if (activeMainstreamCliRef.current === cli) {
        syncAlternateScreenCli();
        return;
      }
      activeMainstreamCliRef.current = cli;
      syncAlternateScreenCli();
    };
    const titleChangeHandler = instance.onTitleChange((title) => {
      titleChangeRef.current?.(terminal.id, title);
      const detectedCli = detectMainstreamCliTitle(title);
      if (detectedCli) {
        setActiveMainstreamCli(detectedCli);
      } else if (activeMainstreamCliRef.current && isShellTerminalTitle(title)) {
        setActiveMainstreamCli(null);
      }
    });
    const bufferChangeHandler = instance.buffer.onBufferChange(syncAlternateScreenCli);
    const writeParsedHandler = instance.onWriteParsed(() => {
      activityRef.current?.(terminal.id);
      semanticHighlighter.schedule();
    });
    const semanticScrollHandler = instance.onScroll(() => semanticHighlighter.schedule());
    instance.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && isTerminalSearchShortcut(event)) {
        event.preventDefault();
        openSearchRef.current();
        return false;
      }

      if (event.type !== "keydown" || terminalStatusRef.current !== "closed") {
        return true;
      }

      if (event.repeat) {
        event.preventDefault();
        event.stopPropagation();
        return false;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        closeDisconnectedRef.current?.();
        return false;
      }

      if (event.key.toLowerCase() === "r" && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        reconnectDisconnectedRef.current?.();
        return false;
      }

      return false;
    });
    instance.onData((data) => {
      if (terminalStatusRef.current === "closed" || replayingSnapshotRef.current) {
        return;
      }

      if (isSensitiveTerminalPrompt(instance)) {
        commandDraftRef.current = "";
      } else {
        const capture = captureSubmittedCommands(data, commandDraftRef.current);
        commandDraftRef.current = capture.draft;
        capture.commands.forEach((command) => {
          semanticHighlighterRef.current?.trackCommand(command);
          if (!activeMainstreamCliRef.current) {
            const detectedCli = detectMainstreamCliCommand(command);
            if (detectedCli) {
              setActiveMainstreamCli(detectedCli);
            }
          }
          commandSubmittedRef.current?.(command);
        });
      }
      void enqueueInput(data, terminal.id);
    });
    const alternateWheelState: AlternateBufferWheelState = { partialRows: 0 };
    instance.attachCustomWheelEventHandler((event) => {
      if (
        instance.buffer.active.type !== "alternate" ||
        instance.modes.mouseTrackingMode !== "none"
      ) {
        alternateWheelState.partialRows = 0;
        return true;
      }

      const direction = consumeAlternateBufferWheel(
        event,
        instance.rows,
        container.clientHeight,
        alternateWheelState,
      );
      if (direction === 0) {
        event.preventDefault();
        return false;
      }

      const sequence = alternateBufferArrowSequence(instance, direction);
      instance.input(sequence.repeat(alternateBufferWheelScrollSpeed), true);
      event.preventDefault();
      return false;
    });
    xtermRef.current = instance;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    serializeAddonRef.current = serializeAddon;
    semanticHighlighterRef.current = semanticHighlighter;
    lastBufferRef.current = "";
    renderInitializedRef.current = false;
    replayingSnapshotRef.current = false;
    snapshotReplayRevisionRef.current += 1;

    const reportSize = (force = false) => {
      const fitAddonInstance = fitAddonRef.current;
      const terminalInstance = xtermRef.current;
      const host = containerRef.current;

      if (!fitAddonInstance || !terminalInstance || !host) {
        return;
      }

      if (host.clientWidth <= 0 || host.clientHeight <= 0) {
        return;
      }

      fitAddon.fit();
      const nextSize = {
        cols: terminalInstance.cols,
        rows: terminalInstance.rows,
        widthPx: Math.round(host.clientWidth),
        heightPx: Math.round(host.clientHeight),
      };
      const previousSize = lastReportedSizeRef.current;

      // Hidden panes still need to fit xterm's canvas, but their dimensions
      // must not be marked as reported until a PTY resize was really queued.
      if (!isActiveRef.current && !reportSizeWhenVisibleRef.current) {
        return;
      }

      if (
        !force &&
        previousSize &&
        previousSize.cols === nextSize.cols &&
        previousSize.rows === nextSize.rows &&
        previousSize.widthPx === nextSize.widthPx &&
        previousSize.heightPx === nextSize.heightPx
      ) {
        return;
      }

      lastReportedSizeRef.current = nextSize;
      enqueueResize(nextSize, terminal.id);
    };
    reportSizeRef.current = reportSize;

    window.requestAnimationFrame(() => {
      reportSize();
      if (isActiveRef.current) {
        instance.focus();
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimerRef.current) {
        window.clearTimeout(resizeTimerRef.current);
      }

      resizeTimerRef.current = window.setTimeout(reportSize, 120);
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      workingDirectoryHandler.dispose();
      foregroundQueryHandler.dispose();
      backgroundQueryHandler.dispose();
      titleChangeHandler.dispose();
      bufferChangeHandler.dispose();
      writeParsedHandler.dispose();
      semanticScrollHandler.dispose();
      semanticHighlighter.dispose();
      activeMainstreamCliRef.current = null;
      if (alternateScreenResizeFrame !== null) {
        window.cancelAnimationFrame(alternateScreenResizeFrame);
        alternateScreenResizeFrame = null;
      }
      if (resizeTimerRef.current) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      instance.dispose();
      if (outputFrameRef.current !== null) {
        window.cancelAnimationFrame(outputFrameRef.current);
        outputFrameRef.current = null;
      }
      pendingOutputRef.current = "";
      if (xtermRef.current === instance) {
        xtermRef.current = null;
        fitAddonRef.current = null;
        searchAddonRef.current = null;
        serializeAddonRef.current = null;
        semanticHighlighterRef.current = null;
        lastBufferRef.current = "";
        renderInitializedRef.current = false;
        replayingSnapshotRef.current = false;
        snapshotReplayRevisionRef.current += 1;
        lastReportedSizeRef.current = null;
        reportSizeRef.current = null;
        inputQueueRef.current = Promise.resolve();
      }
    };
  }, [terminal?.id]);

  useEffect(() => {
    if (!isSearchOpen) {
      return;
    }

    const query = searchQuery.trim();
    if (!query) {
      searchAddonRef.current?.clearDecorations();
      setSearchStatus("idle");
      setSearchMatchIndex(-1);
      return;
    }

    findNext(query, true, false);
  }, [isSearchOpen, searchQuery, searchCaseSensitive, searchWholeWord, terminalBuffer, searchMatchCount]);

  useEffect(() => {
    if (!xtermRef.current) {
      return;
    }

    xtermRef.current.options.theme = createXtermTheme(terminalTheme, emphasizeSearchSelection);
    semanticHighlighterRef.current?.update(terminalTheme, semanticHighlighting);
  }, [terminalTheme, emphasizeSearchSelection, semanticHighlighting]);

  useEffect(() => {
    if (!xtermRef.current || xtermRef.current.options.scrollback === resolvedScrollbackLines) {
      return;
    }

    xtermRef.current.options.scrollback = resolvedScrollbackLines;
  }, [resolvedScrollbackLines]);

  useEffect(() => {
    const instance = xtermRef.current;

    if (!instance) {
      return;
    }

    instance.options = {
      fontFamily: resolvedTerminalFontFamily,
      fontSize: resolvedTerminalFontSize,
    };

    let disposed = false;
    let frameId = window.requestAnimationFrame(() => {
      if (disposed || xtermRef.current !== instance) {
        return;
      }

      instance.clearTextureAtlas();
      instance.refresh(0, instance.rows - 1);
      reportSizeRef.current?.();
    });

    void document.fonts
      ?.load(`${resolvedTerminalFontSize}px ${resolvedTerminalFontFamily}`)
      .then(() => {
        if (disposed || xtermRef.current !== instance) {
          return;
        }

        window.cancelAnimationFrame(frameId);
        frameId = window.requestAnimationFrame(() => {
          instance.clearTextureAtlas();
          instance.refresh(0, instance.rows - 1);
          reportSizeRef.current?.();
        });
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frameId);
    };
  }, [resolvedTerminalFontFamily, resolvedTerminalFontSize]);

  useEffect(() => {
    const instance = xtermRef.current;

    if (!instance || !terminal) {
      return;
    }

    if (!renderInitializedRef.current) {
      replaySnapshot(instance, terminalBuffer);
      lastBufferRef.current = terminalBuffer;
      renderInitializedRef.current = true;
      return;
    }

    const previousBuffer = lastBufferRef.current;
    if (terminalOutputChunk) {
      const appendedBuffer = `${previousBuffer}${terminalOutputChunk}`;
      // 预览缓冲区会从头部截断；只要新预览仍是累计输出的后缀，就可以安全地增量解析。
      const canAppendChunk =
        terminalBuffer === appendedBuffer || appendedBuffer.endsWith(terminalBuffer);

      if (canAppendChunk) {
        enqueueOutput(terminalOutputChunk);
        lastBufferRef.current = terminalBuffer;
        return;
      }

      // A full snapshot may arrive while the live terminal is already fully
      // rendered (for example after an explicit snapshot refresh). Its latest
      // chunk is still safe to append, while reset + replay would visibly
      // clear an alternate-screen TUI and may replay a truncated ANSI stream.
      if (terminalBuffer.endsWith(terminalOutputChunk)) {
        enqueueOutput(terminalOutputChunk);
        lastBufferRef.current = terminalBuffer;
        return;
      }
    }

    if (terminalBuffer !== previousBuffer) {
      if (terminalStatus === "attached") {
        // A snapshot without new output only synchronizes the retained raw
        // buffer. The mounted xterm already owns the authoritative live screen.
        lastBufferRef.current = terminalBuffer;
        return;
      }

      pendingOutputRef.current = "";
      if (outputFrameRef.current !== null) {
        window.cancelAnimationFrame(outputFrameRef.current);
        outputFrameRef.current = null;
      }
      instance.reset();
      replaySnapshot(instance, terminalBuffer);
      lastBufferRef.current = terminalBuffer;
    }
  }, [terminal?.id, terminalBuffer, terminalOutputChunk, terminalSnapshot, terminalStatus]);

  useEffect(() => {
    if (lastClearRevisionRef.current === clearRevision) {
      return;
    }

    lastClearRevisionRef.current = clearRevision;
    pendingOutputRef.current = "";
    if (outputFrameRef.current !== null) {
      window.cancelAnimationFrame(outputFrameRef.current);
      outputFrameRef.current = null;
    }
    xtermRef.current?.reset();
    lastBufferRef.current = terminalBuffer;
  }, [clearRevision, terminalBuffer]);

  const closeContextMenu = () => setContextMenu(null);

  const copyTerminalText = async () => {
    const selection = xtermRef.current?.getSelection() ?? "";
    const text = selection || readTerminalPlainText(xtermRef.current);

    if (!text) {
      closeContextMenu();
      return;
    }

    try {
      if (terminalCopyRichText) {
        const html = serializeAddonRef.current?.serializeAsHTML({
          includeGlobalBackground: true,
          onlySelection: Boolean(selection),
        });

        if (html) {
          await writeClipboardHtml(html, text);
          return;
        }
      }

      await writeClipboardText(text);
    } catch (error) {
      console.warn("复制终端内容失败", error);
    } finally {
      closeContextMenu();
    }
  };

  const copySelectedTerminalText = async (selection: string) => {
    try {
      if (terminalCopyRichText) {
        const html = serializeAddonRef.current?.serializeAsHTML({
          includeGlobalBackground: true,
          onlySelection: true,
        });

        if (html) {
          await writeClipboardHtml(html, selection);
          return;
        }
      }

      await writeClipboardText(selection);
    } catch (error) {
      console.warn("复制终端选中内容失败", error);
    } finally {
      closeContextMenu();
    }
  };

  const copyTerminalPlainText = async () => {
    const selection = xtermRef.current?.getSelection() ?? "";
    const text = selection || readTerminalPlainText(xtermRef.current);

    try {
      if (text) {
        await writeClipboardText(text);
      }
    } catch (error) {
      console.warn("复制终端内容失败", error);
    } finally {
      closeContextMenu();
    }
  };

  const pasteClipboardText = async () => {
    if (!terminal || terminalStatus === "closed") {
      closeContextMenu();
      return;
    }

    try {
      const text = await readClipboardText();
      await queuePastedText(text);
    } catch (error) {
      console.warn("粘贴终端内容失败", error);
    } finally {
      closeContextMenu();
    }
  };

  const handleSmartCopyOrPaste = async () => {
    const selection = xtermRef.current?.getSelection() ?? "";

    if (selection) {
      await copySelectedTerminalText(selection);
      return;
    }

    await pasteClipboardText();
  };

  const showTuiScrollbackHint = Boolean(
    alternateScreenCli &&
      terminal &&
      terminal.status !== "closed" &&
      dismissedScrollbackHintFor !== terminal.id,
  );

  const copyCodexInlineCommand = async () => {
    if (!terminal) {
      return;
    }

    try {
      await writeClipboardText("codex --no-alt-screen");
      setCopiedScrollbackFixFor(terminal.id);
    } catch (error) {
      console.warn("复制 Codex 长对话兼容命令失败", error);
    }
  };

  return (
    <section
      className="terminal-pane"
      tabIndex={-1}
      onClick={(event) => {
        if (
          (event.target as HTMLElement).closest(
            ".terminal-search-bar, .terminal-paste-confirm, .terminal-tui-scrollback-hint",
          )
        ) {
          return;
        }

        closeContextMenu();
        xtermRef.current?.focus();
      }}
      onMouseDownCapture={(event) => {
        if (
          (event.target as HTMLElement).closest(
            ".terminal-search-bar, .terminal-paste-confirm, .terminal-tui-scrollback-hint",
          )
        ) {
          return;
        }

        xtermRef.current?.focus();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (terminalRightClickBehavior === "disabled") {
          closeContextMenu();
          return;
        }

        if (terminalRightClickBehavior === "paste") {
          void pasteClipboardText();
          return;
        }

        if (terminalRightClickBehavior === "copy-or-paste") {
          void handleSmartCopyOrPaste();
          return;
        }

        setContextMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <div className="xterm-host" ref={containerRef} />
      {showTuiScrollbackHint && terminal ? (
        <aside className="terminal-tui-scrollback-hint" role="status">
          <span aria-hidden="true" className="terminal-tui-scrollback-hint-indicator" />
          <span className="terminal-tui-scrollback-hint-copy">
            <strong>长对话未进入终端回滚</strong>
            <span>
              {alternateScreenCli === "codex"
                ? "退出后用 inline 模式重启，可保留完整滚动记录"
                : `${alternateScreenCli} 正在使用备用屏幕，请启用其 inline 模式`}
            </span>
          </span>
          {alternateScreenCli === "codex" ? (
            <button
              className="terminal-tui-scrollback-hint-action"
              onClick={() => void copyCodexInlineCommand()}
              title={'长期生效：在 ~/.codex/config.toml 中设置 [tui] alternate_screen = "never"'}
              type="button"
            >
              {copiedScrollbackFixFor === terminal.id ? "已复制" : "复制启动命令"}
            </button>
          ) : null}
          <button
            aria-label="关闭长对话兼容提示"
            className="terminal-tui-scrollback-hint-close"
            onClick={() => setDismissedScrollbackHintFor(terminal.id)}
            title="本次终端不再提示"
            type="button"
          >
            <Icon name="x" />
          </button>
        </aside>
      ) : null}
      {pasteDraft !== null ? (
        <div className="terminal-paste-confirm-backdrop" role="presentation">
          <div
            aria-modal="true"
            className="terminal-paste-confirm"
            role="dialog"
            aria-labelledby="terminal-paste-confirm-title"
          >
            <header>
              <div>
                <strong id="terminal-paste-confirm-title">确认多行粘贴</strong>
                <span>{pasteLineCount} 行内容将发送到终端</span>
              </div>
            </header>
            <textarea
              ref={pasteTextAreaRef}
              aria-label="编辑多行粘贴内容"
              spellCheck={false}
              value={pasteText}
              onChange={(event) => setPasteDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closePasteConfirm();
                  return;
                }

                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void confirmPasteDraft();
                }
              }}
            />
            <footer>
              <button type="button" onClick={closePasteConfirm}>
                取消
              </button>
              <button disabled={!pasteText} type="button" onClick={() => void confirmPasteDraft()}>
                确认粘贴
              </button>
            </footer>
          </div>
        </div>
      ) : null}
      {isSearchOpen ? (
        <div className="terminal-search-bar" role="search">
          <input
            ref={searchInputRef}
            aria-label="搜索终端内容"
            autoComplete="off"
            enterKeyHint="search"
            name="terminal-search"
            placeholder="搜索终端内容…"
            spellCheck={false}
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") {
                event.preventDefault();
                closeSearch();
                return;
              }

              if (event.key === "Enter") {
                event.preventDefault();
                if (event.shiftKey) {
                  findPrevious();
                } else {
                  findNext();
                }
              }
            }}
          />
          <button
            aria-label="大小写匹配"
            aria-pressed={searchCaseSensitive}
            className={searchCaseSensitive ? "terminal-search-option is-active" : "terminal-search-option"}
            onClick={() => setSearchCaseSensitive((enabled) => !enabled)}
            title="大小写匹配"
            type="button"
          >
            Aa
          </button>
          <button
            aria-label="全词匹配"
            aria-pressed={searchWholeWord}
            className={searchWholeWord ? "terminal-search-option is-active" : "terminal-search-option"}
            onClick={() => setSearchWholeWord((enabled) => !enabled)}
            title="全词匹配"
            type="button"
          >
            词
          </button>
          <span className="terminal-search-count" aria-live="polite">
            {searchQuery.trim()
              ? searchStatus === "empty" || searchMatchCount <= 0
                ? "无匹配"
                : searchStatus === "error"
                  ? "搜索失败"
                  : searchStatus === "found"
                    ? `${Math.max(searchMatchIndex + 1, 1)}/${searchMatchCount}`
                    : ""
              : ""}
          </span>
          <button
            aria-label="上一个匹配"
            disabled={!searchQuery.trim()}
            onClick={() => findPrevious()}
            title="上一个匹配"
            type="button"
          >
            <Icon name="chevron-left" />
          </button>
          <button
            aria-label="下一个匹配"
            disabled={!searchQuery.trim()}
            onClick={() => findNext()}
            title="下一个匹配"
            type="button"
          >
            <Icon name="chevron-right" />
          </button>
          <button aria-label="关闭搜索" onClick={closeSearch} title="关闭搜索" type="button">
            <Icon name="x" />
          </button>
        </div>
      ) : null}
      {contextMenu ? (
        <div
          className="terminal-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
        >
          <button
            onClick={() => void copyTerminalText()}
            role="menuitem"
            title={terminalCopyRichText ? "复制选中内容或缓冲区，并保留终端颜色格式" : "复制选中内容或缓冲区"}
            type="button"
          >
            <Icon name="copy" />
            <span>复制</span>
          </button>
          {terminalCopyRichText ? (
            <button onClick={() => void copyTerminalPlainText()} role="menuitem" title="仅复制纯文本" type="button">
              <Icon name="copy" />
              <span>纯文本</span>
            </button>
          ) : null}
          <button onClick={() => void pasteClipboardText()} role="menuitem" title="粘贴到终端" type="button">
            <Icon name="terminal" />
            <span>粘贴</span>
          </button>
          <button onClick={openSearch} role="menuitem" title="搜索终端内容" type="button">
            <Icon name="command" />
            <span>搜索</span>
          </button>
        </div>
      ) : null}
    </section>
  );
}
