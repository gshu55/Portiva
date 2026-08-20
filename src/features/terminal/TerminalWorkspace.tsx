import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type {
  ConnectionCapabilities,
  ConnectionSummary,
  ConnectionProfile,
  AppSettings,
  SerialProfile,
  SerialPortInfo,
  TerminalColorPalette,
  TerminalRightClickBehavior,
  TerminalSplitLayout,
  TerminalSplitOrientation,
  TerminalSize,
  WorkspaceSessionTab,
} from "../../shared/types";
import { Icon } from "../../shared/Icon";
import {
  detectWindowControlPlatform,
  WindowControls,
} from "../../shared/WindowControls";
import {
  maximumSshTerminalPanes,
  resolveTerminalSplitLayout,
  terminalPanesForTab,
} from "../../shared/terminalSplits";
import { SerialTerminalPanel } from "./SerialTerminalPanel";
import { SshTerminalGrid } from "./SshTerminalGrid";
import { SshTerminalWorkspace } from "./SshTerminalWorkspace";
import { useSavedSshCommands } from "./useSavedSshCommands";
import { TabContextMenu } from "./TabContextMenu";
import { TerminalPane } from "./TerminalPane";

interface TerminalWorkspaceProps {
  activeTabId?: string;
  capabilities: ConnectionCapabilities;
  connection: ConnectionSummary | null;
  sessionTabs: WorkspaceSessionTab[];
  profiles?: ConnectionProfile[];
  serialPorts?: SerialPortInfo[];
  customTabPanels?: Record<string, ReactNode>;
  fileTransferPanel?: ReactNode;
  sftpSidePanel?: (props: SftpSidePanelRenderProps) => ReactNode;
  emptyStateNotice?: string;
  keymap?: AppSettings["keymap"];
  terminalConfirmMultilinePaste?: boolean;
  terminalCopyRichText?: boolean;
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalRightClickBehavior?: TerminalRightClickBehavior;
  suppressInsecureWarning?: boolean;
  terminalTheme: TerminalColorPalette;
  tabBarPortalTarget?: HTMLDivElement | null;
  onSendTerminalBytes: (bytes: number[], terminalId?: string) => Promise<void> | void;
  onSendTerminalData: (data: string, terminalId?: string) => Promise<void> | void;
  onTerminalTitleChange?: (terminalId: string, title: string) => void;
  onTerminalWorkingDirectoryChange?: (terminalId: string, path: string) => void;
  onResizeTerminal: (size?: TerminalSize, terminalId?: string) => void;
  onResizeSshTerminalSplit: (tabId: string, path: number[], ratio: number) => void;
  onCloseSessionTab: (connectionId: string) => void;
  onCloseSshTerminalPane: (tabId: string, terminalId: string) => Promise<void> | void;
  onDetachSessionTab?: (connectionId: string) => void;
  onOpenFileTransferTab?: (connectionId: string, options?: { forceNew?: boolean }) => void;
  onOpenSessionWindow: (connectionId: string) => void;
  onCloseSerialTerminal: (terminalId: string) => Promise<void> | void;
  onOpenSerialTerminal: (terminalId: string, profile: SerialProfile) => Promise<void> | void;
  onReconfigureSerialTerminal: (terminalId: string, profile: SerialProfile) => Promise<void> | void;
  onRefreshSerialPorts?: () => Promise<SerialPortInfo[]> | Promise<void> | SerialPortInfo[] | void;
  onReconnectSessionTab: (connectionId: string) => void;
  onReorderSessionTabs: (
    sourceConnectionId: string,
    targetConnectionId: string,
    position: "before" | "after",
  ) => void;
  onSessionDragStateChange?: (isDragging: boolean, tabId: string) => void;
  onSelectSessionTab: (connectionId: string) => void;
  onSplitSshTerminal: (
    tabId: string,
    terminalId: string,
    orientation: TerminalSplitOrientation,
  ) => Promise<void> | void;
  onToggleFullscreen: () => void;
  reattachHintActive?: boolean;
  isDetachedWindow?: boolean;
  isFullscreen: boolean;
}

interface SftpSidePanelRenderProps {
  layoutSide: "left" | "right";
  onToggleLayoutSide: () => void;
}

const getSessionTabId = (tab: WorkspaceSessionTab) => tab.id ?? tab.connection.id;
const closedTerminalPanelVisibility = { command: false, status: false } as const;
const terminalActivityHoldMs = 700;
const tabPointerDragThresholdPx = 6;

interface TabPointerDragState {
  active: boolean;
  pointerId: number;
  position: "before" | "after";
  sourceTabId: string;
  startX: number;
  startY: number;
  targetTabId: string | null;
  selectOnRelease: boolean;
}

function resolveTabProtocolLabel(tab: WorkspaceSessionTab) {
  const kind = tab.kind ?? "terminal";

  if (kind === "http-console") {
    return "HTTP";
  }
  if (kind === "wsl-files") {
    return "WSL 文件";
  }
  if (kind === "settings") {
    return "设置";
  }
  if (kind === "network-scan") {
    return "网络扫描";
  }
  if (kind === "host-dashboard") {
    return "主机概览";
  }
  if (kind === "file-transfer") {
    switch (tab.fileTransferSession?.protocol) {
      case "wsl":
        return "WSL 文件";
      case "ftp":
        return "FTP";
      case "webdav":
        return "WebDAV";
      case "s3":
        return "S3";
      case "scp":
        return "SCP";
      case "sftp":
      default:
        return "SFTP";
    }
  }

  switch (tab.connection.transport?.kind) {
    case "ssh":
      return "SSH";
    case "wsl":
      return "WSL";
    case "serial":
      return "Serial";
    case "local-shell":
      return "本地终端";
    case "telnet":
      return "Telnet";
    case "raw-tcp":
      return "TCP";
    default:
      return "终端";
  }
}

function resolveConnectionLabel(connection: ConnectionSummary, savedName?: string) {
  const profileName = savedName?.trim() ?? "";
  const host = connection.transport?.host.trim() ?? "";
  const transportKind = connection.transport?.kind;
  const titleWithoutProtocol = connection.title
    .replace(/^\s*\[(?:SSH|SFTP|SERIAL|TELNET|RAW|TCP|HTTP|WSL)\]\s*/i, "")
    .replace(/^\s*(?:SSH|SFTP|SERIAL|TELNET|RAW|TCP|HTTP|WSL)\s*(?:\/|[-—:])\s*/i, "")
    .trim();

  if (transportKind === "local-shell" || connection.profileId === "local-shell") {
    return "本地终端";
  }

  if (transportKind === "serial" || /^\s*\[SERIAL\]/i.test(connection.title)) {
    return profileName || host || titleWithoutProtocol || "串口调试";
  }

  return profileName || host || titleWithoutProtocol || "终端";
}

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveTerminalTaskTitle(
  reportedTitle: string | null,
  connection: ConnectionSummary,
  connectionLabel: string,
) {
  const title = reportedTitle?.trim();
  if (!title) {
    return null;
  }

  const normalizedTitle = title.toLowerCase();
  const host = connection.transport?.host.trim() ?? "";
  if (
    normalizedTitle === connection.title.trim().toLowerCase() ||
    normalizedTitle === connectionLabel.toLowerCase() ||
    (host && normalizedTitle === host.toLowerCase()) ||
    /(?:^|[\\/\s])(?:bash|cmd|fish|nu|powershell|pwsh|sh|zsh)(?:\.exe)?(?:$|[\s:|\-—])/i.test(title) ||
    /^(?:[a-z]:[\\/]|~?[\\/])/.test(title) ||
    /^[^\s@]+@[^:\s]+(?::.*)?$/.test(title)
  ) {
    return null;
  }

  if (host) {
    const escapedHost = escapeRegularExpression(host);
    if (new RegExp(`^[^\\s@]+@${escapedHost}(?::|\\s|$)`, "i").test(title)) {
      return null;
    }
  }

  return title;
}
const isFileTransferTab = (tab: WorkspaceSessionTab | null | undefined) =>
  (tab?.kind ?? "terminal") === "file-transfer";
const isCustomTab = (tab: WorkspaceSessionTab | null | undefined) =>
  (tab?.kind ?? "terminal") === "settings" ||
  (tab?.kind ?? "terminal") === "http-console" ||
  (tab?.kind ?? "terminal") === "network-scan" ||
  (tab?.kind ?? "terminal") === "host-dashboard" ||
  (tab?.kind ?? "terminal") === "wsl-files";
const homeShortcutHints: Array<{
  fallback: string;
  key: keyof AppSettings["keymap"];
  label: string;
}> = [
  { fallback: "Ctrl+N", key: "newProfile", label: "新建连接" },
  { fallback: "Ctrl+Alt+T", key: "openLocalTerminal", label: "打开本地终端" },
  { fallback: "Ctrl+Alt+S", key: "openSerialTerminal", label: "打开串口终端" },
  { fallback: "Ctrl+W", key: "closeTab", label: "关闭当前标签" },
];
const isDisconnectedTerminalTab = (
  tab: WorkspaceSessionTab | null | undefined,
): tab is WorkspaceSessionTab => {
  if (!tab || (tab.kind ?? "terminal") !== "terminal") {
    return false;
  }

  return tab.terminal?.status === "closed" || tab.terminalSnapshot?.status === "closed";
};
const isTerminalShortcutEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.closest(".terminal-context-menu, .tab-context-menu")) {
    return true;
  }

  return Boolean(
    target.closest("input, textarea, select, button, [contenteditable='true']") &&
      !target.closest(".terminal-pane"),
  );
};

const scrollTabsHorizontally = (event: ReactWheelEvent<HTMLElement>) => {
  const tabs = event.currentTarget;

  if (tabs.scrollWidth <= tabs.clientWidth) {
    return;
  }

  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (!delta) {
    return;
  }

  event.preventDefault();
  tabs.scrollLeft += delta;
};
const shortcutParts = (shortcut: string) =>
  shortcut
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
const maximumCommandHistoryEntries = 200;

export function TerminalWorkspace({
  activeTabId,
  capabilities,
  connection,
  customTabPanels,
  emptyStateNotice,
  fileTransferPanel,
  keymap,
  sftpSidePanel,
  profiles = [],
  serialPorts = [],
  sessionTabs,
  terminalConfirmMultilinePaste = true,
  terminalCopyRichText = false,
  terminalFontFamily,
  terminalFontSize,
  terminalRightClickBehavior = "context-menu",
  suppressInsecureWarning = false,
  terminalTheme,
  tabBarPortalTarget,
  onCloseSessionTab,
  onCloseSshTerminalPane,
  onDetachSessionTab,
  onOpenFileTransferTab,
  onResizeTerminal,
  onResizeSshTerminalSplit,
  onOpenSessionWindow,
  onCloseSerialTerminal,
  onOpenSerialTerminal,
  onReconfigureSerialTerminal,
  onRefreshSerialPorts,
  onReconnectSessionTab,
  onReorderSessionTabs,
  onSessionDragStateChange,
  onSelectSessionTab,
  onSendTerminalBytes,
  onSendTerminalData,
  onSplitSshTerminal,
  onTerminalTitleChange,
  onTerminalWorkingDirectoryChange,
  onToggleFullscreen,
  reattachHintActive = false,
  isDetachedWindow = false,
  isFullscreen,
}: TerminalWorkspaceProps) {
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<"before" | "after">("before");
  const [focusedSshTerminalByTab, setFocusedSshTerminalByTab] = useState<Record<string, string>>({});
  const [activeOutputTerminalIds, setActiveOutputTerminalIds] = useState<Set<string>>(() => new Set());
  const [pendingSshSplitByTab, setPendingSshSplitByTab] = useState<Record<string, string>>({});
  const [sftpPanelRatio, setSftpPanelRatio] = useState(0.22);
  const [sftpPanelSide, setSftpPanelSide] = useState<"left" | "right">("left");
  const [sshSftpPanelVisible, setSshSftpPanelVisible] = useState(true);
  const [terminalPanelVisibilityByTab, setTerminalPanelVisibilityByTab] = useState<Record<
    string,
    { command: boolean; status: boolean }
  >>({});
  const [commandHistoryByTab, setCommandHistoryByTab] = useState<Record<string, string[]>>({});
  const savedSshCommands = useSavedSshCommands();
  const tabBarRef = useRef<HTMLDivElement>(null);
  const tabPointerDragRef = useRef<TabPointerDragState | null>(null);
  const suppressTabClickRef = useRef<string | null>(null);
  const terminalActivityTimersRef = useRef<Map<string, number>>(new Map());
  const sftpLayoutRef = useRef<HTMLDivElement>(null);
  const autoClosedLocalShellTabIdsRef = useRef(new Set<string>());
  const [tabContextMenu, setTabContextMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);
  const resolvedActiveTabId = activeTabId ?? connection?.id ?? sessionTabs[0]?.connection.id ?? null;
  const showDetachedWindowControls =
    isDetachedWindow && detectWindowControlPlatform() !== "macos";
  const activeTab = sessionTabs.find((tab) => getSessionTabId(tab) === resolvedActiveTabId);
  const activeCustomTabContent = activeTab ? customTabPanels?.[getSessionTabId(activeTab)] : null;
  const reportTerminalActivity = useCallback((terminalId: string) => {
    setActiveOutputTerminalIds((current) => {
      if (current.has(terminalId)) {
        return current;
      }

      const next = new Set(current);
      next.add(terminalId);
      return next;
    });

    const existingTimer = terminalActivityTimersRef.current.get(terminalId);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
    }

    const timer = window.setTimeout(() => {
      terminalActivityTimersRef.current.delete(terminalId);
      setActiveOutputTerminalIds((current) => {
        if (!current.has(terminalId)) {
          return current;
        }

        const next = new Set(current);
        next.delete(terminalId);
        return next;
      });
    }, terminalActivityHoldMs);
    terminalActivityTimersRef.current.set(terminalId, timer);
  }, []);
  const recordCommand = useCallback((tabId: string, value: string) => {
    const command = value.trim();
    if (!command) {
      return;
    }

    setCommandHistoryByTab((current) => {
      const history = current[tabId] ?? [];
      if (history[0] === command) {
        return current;
      }

      return {
        ...current,
        [tabId]: [command, ...history].slice(0, maximumCommandHistoryEntries),
      };
    });
  }, []);
  const profilesById = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile])),
    [profiles],
  );
  const isCustomTabActive = Boolean(activeCustomTabContent);
  const isFileTransferTabActive = (activeTab?.kind ?? "terminal") === "file-transfer";
  const isTerminalTabActive = (activeTab?.kind ?? "terminal") === "terminal";
  const isSerialTabActive = activeTab?.connection.transport?.kind === "serial";
  const terminalTabs = sessionTabs.filter(
    (tab) => (tab.kind ?? "terminal") === "terminal" && tab.terminal,
  );
  const hasSessionTabs = sessionTabs.length > 0;
  const activeSshPaneCount = activeTab?.connection.transport?.kind === "ssh"
    ? terminalPanesForTab(activeTab).length
    : 0;
  const isActiveSshGridSplit = activeSshPaneCount > 1;
  const disconnectedShortcutTabId = isDisconnectedTerminalTab(activeTab)
    ? getSessionTabId(activeTab)
    : null;
  const workspaceClassName = [
    "terminal-workspace",
    !hasSessionTabs ? "home-empty" : "",
    hasSessionTabs && tabBarPortalTarget && !isFullscreen ? "tabs-in-titlebar" : "",
    isActiveSshGridSplit ? "ssh-grid-active" : "",
    isFullscreen ? "fullscreen" : "",
    reattachHintActive ? "reattach-hint-active" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const hasVisibleSshTerminal = isTerminalTabActive && activeTab?.connection.transport?.kind === "ssh";
  const terminalBodyClassName = [
    "terminal-body",
    isSerialTabActive
      ? "terminal-body-serial-content"
      : isTerminalTabActive
        ? "terminal-body-terminal-content"
        : "terminal-body-app-content",
    hasVisibleSshTerminal ? "terminal-body-ssh-content" : "",
    activeTab?.kind === "http-console" ? "terminal-body-http-content" : "",
    activeTab?.kind === "network-scan" ? "terminal-body-network-scan-content" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const shouldShowRiskBanner =
    connection &&
    !isCustomTabActive &&
    !suppressInsecureWarning &&
    !capabilities.secureTransport &&
    connection.transport?.kind !== "serial";
  const homeShortcutRows = useMemo(
    () =>
      homeShortcutHints.map((item) => {
        const configuredShortcut = keymap?.[item.key]?.trim();
        const shortcut = configuredShortcut || item.fallback;
        return {
          ...item,
          parts: shortcutParts(shortcut),
          shortcut,
        };
      }),
    [keymap],
  );
  const selectSessionTab = (tabId: string) => {
    onSelectSessionTab(tabId);
  };
  const startSftpPanelResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const updatePanelRatio = (clientX: number) => {
      const layout = sftpLayoutRef.current;

      if (!layout) {
        return;
      }

      const bounds = layout.getBoundingClientRect();
      if (bounds.width <= 0) {
        return;
      }

      const nextRatio =
        sftpPanelSide === "right"
          ? (bounds.right - clientX) / bounds.width
          : (clientX - bounds.left) / bounds.width;
      setSftpPanelRatio(Math.min(0.55, Math.max(0.22, nextRatio)));
    };
    const onPointerMove = (moveEvent: PointerEvent) => updatePanelRatio(moveEvent.clientX);
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      document.body.classList.remove("terminal-sftp-resizing");
    };

    document.body.classList.add("terminal-sftp-resizing");
    updatePanelRatio(event.clientX);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };
  const toggleSftpPanelSide = () => {
    setSftpPanelSide((current) => (current === "right" ? "left" : "right"));
  };
  const serialProfileForTab = (tab: WorkspaceSessionTab): SerialProfile | null => {
    if (tab.connection.transport?.kind !== "serial") {
      return null;
    }

    const profile = profilesById.get(tab.connection.profileId);
    return profile?.type === "serial" ? profile : null;
  };
  const renderTerminalPane = (
    tab: WorkspaceSessionTab,
    isActivePane: boolean,
    reportSizeWhenVisible = false,
    ownerTabId = getSessionTabId(tab),
    paneCount = 1,
  ) => {
    const serialProfile = serialProfileForTab(tab);

    if (tab.connection.transport?.kind === "serial") {
      return (
        <SerialTerminalPanel
          isActive={isActivePane}
          profile={serialProfile}
          reportSizeWhenVisible={reportSizeWhenVisible}
          serialPorts={serialPorts}
          tab={tab}
          terminalConfirmMultilinePaste={terminalConfirmMultilinePaste}
          terminalCopyRichText={terminalCopyRichText}
          terminalRightClickBehavior={terminalRightClickBehavior}
          terminalTheme={terminalTheme}
	          onCloseSerialTerminal={onCloseSerialTerminal}
	          onOpenSerialTerminal={onOpenSerialTerminal}
	          onReconfigureSerialTerminal={onReconfigureSerialTerminal}
	          onRefreshSerialPorts={onRefreshSerialPorts}
          onResizeTerminal={onResizeTerminal}
          onSendBytes={onSendTerminalBytes}
          onSendData={onSendTerminalData}
        />
      );
    }

    return (
      <TerminalPane
        isActive={isActivePane}
        reportSizeWhenVisible={reportSizeWhenVisible}
        semanticHighlighting={tab.connection.transport?.kind === "ssh"}
        terminal={tab.terminal}
        terminalConfirmMultilinePaste={terminalConfirmMultilinePaste}
        terminalCopyRichText={terminalCopyRichText}
        terminalFontFamily={terminalFontFamily}
        terminalFontSize={terminalFontSize}
        terminalRightClickBehavior={terminalRightClickBehavior}
        terminalTheme={terminalTheme}
        terminalSnapshot={tab.terminalSnapshot}
        onActivity={reportTerminalActivity}
        onCloseDisconnected={() => {
          if (paneCount > 1 && tab.terminal) {
            void onCloseSshTerminalPane(ownerTabId, tab.terminal.id);
          } else {
            onCloseSessionTab(ownerTabId);
          }
        }}
        onCommandSubmitted={
          tab.connection.transport?.kind === "ssh" || tab.connection.transport?.kind === "wsl"
            ? (command) => recordCommand(
                tab.connection.transport?.kind === "ssh" ? ownerTabId : getSessionTabId(tab),
                command,
              )
            : undefined
        }
        onReconnectDisconnected={() => onReconnectSessionTab(ownerTabId)}
        onResizeTerminal={onResizeTerminal}
        onSendData={onSendTerminalData}
        onTitleChange={onTerminalTitleChange}
        onWorkingDirectoryChange={
          tab.connection.transport?.kind === "ssh"
            ? onTerminalWorkingDirectoryChange
            : undefined
        }
      />
    );
  };
  const renderWithSftpPanel = (primaryContent: ReactNode, showSftpPanel: boolean) => {
    const panelWidth = Math.round(sftpPanelRatio * 100);
    const terminalWidth = Math.round((1 - sftpPanelRatio) * 100);
    const gridTemplateColumns =
      sftpPanelSide === "right"
        ? `minmax(260px, calc(${terminalWidth}% - 4px)) 8px minmax(240px, calc(${panelWidth}% - 4px))`
        : `minmax(240px, calc(${panelWidth}% - 4px)) 8px minmax(260px, calc(${terminalWidth}% - 4px))`;
    const resizer = showSftpPanel ? (
      <div
        aria-label="调整文件面板宽度"
        className="terminal-sftp-resizer"
        onPointerDown={startSftpPanelResize}
        role="separator"
        style={{ gridColumn: "2", gridRow: "1" }}
        title="调整文件面板宽度"
      />
    ) : null;
    const resolvedSftpPanel = showSftpPanel && sftpSidePanel ? (
      <div
        className="terminal-sftp-side-pane"
        style={{ gridColumn: sftpPanelSide === "right" ? "3" : "1", gridRow: "1" }}
      >
        {sftpSidePanel({
          layoutSide: sftpPanelSide,
          onToggleLayoutSide: toggleSftpPanelSide,
        })}
      </div>
    ) : null;

    return (
      <div
        className={["terminal-content-shell", showSftpPanel ? "terminal-with-sftp" : ""]
          .filter(Boolean)
          .join(" ")}
        ref={showSftpPanel ? sftpLayoutRef : undefined}
        style={showSftpPanel ? { gridTemplateColumns } : undefined}
      >
        <div
          className="terminal-primary-pane"
          style={{
            gridColumn: showSftpPanel && sftpPanelSide === "left" ? "3" : "1",
            gridRow: "1",
          }}
        >
          {primaryContent}
        </div>
        {resizer}
        {resolvedSftpPanel}
      </div>
    );
  };
  const renderSingleTerminalContent = (
    tab: WorkspaceSessionTab,
    isActivePane: boolean,
    reportSizeWhenVisible = false,
    ownerTabId = getSessionTabId(tab),
    paneCount = 1,
    sftpAllowed = true,
    embedSftpPanel = true,
  ) => {
    // Vim/tmux 等全屏程序依赖连续解析控制序列；隐藏标签页也必须保持 xterm 状态同步。
    const terminalPane = renderTerminalPane(tab, isActivePane, reportSizeWhenVisible, ownerTabId, paneCount);
    const tabId = getSessionTabId(tab);
    const isSshTerminal = tab.connection.transport?.kind === "ssh";
    const isWslTerminal = tab.connection.transport?.kind === "wsl";
    // SSH 分屏共享一组页面级面板开关；面板只挂载在当前聚焦的终端上。
    const panelStateId = isSshTerminal ? ownerTabId : tabId;
    const panelVisibility = terminalPanelVisibilityByTab[panelStateId] ?? closedTerminalPanelVisibility;
    const renderSharedPanels = !isSshTerminal || isActivePane;
    const sftpPanelAvailable = Boolean(sftpSidePanel && isActivePane && sftpAllowed);
    const showSftpPanel = sftpPanelAvailable && sshSftpPanelVisible && embedSftpPanel;
    const primaryContent = isSshTerminal || isWslTerminal ? (
      <SshTerminalWorkspace
        commandHistory={commandHistoryByTab[tabId] ?? []}
        commandPanelVisible={renderSharedPanels && panelVisibility.command}
        compact={paneCount > 1}
        connectionId={tab.connection.id}
        distribution={isWslTerminal ? tab.connection.transport?.host : undefined}
        isActive={isActivePane}
        profileId={tab.connection.profileId}
        savedCommands={savedSshCommands.commands}
        sessionKind={isWslTerminal ? "wsl" : "ssh"}
        sftpPanelAvailable={sftpPanelAvailable}
        sftpPanelVisible={sshSftpPanelVisible}
        statusPanelVisible={renderSharedPanels && panelVisibility.status}
        terminalReady={Boolean(
          tab.terminal?.status === "attached" &&
          (isWslTerminal || tab.connection.transport?.authenticated)
        )}
        onAddSavedCommand={savedSshCommands.addCommand}
        onRemoveSavedCommand={savedSshCommands.removeCommand}
        onRunCommand={(command) => {
          if (!tab.terminal || tab.terminal.status === "closed") {
            return;
          }
          recordCommand(tabId, command);
          void onSendTerminalData(`${command}\r`, tab.terminal.id);
        }}
        onToggleCommandPanel={() => setTerminalPanelVisibilityByTab((current) => ({
          ...current,
          [panelStateId]: {
            command: !(current[panelStateId]?.command ?? false),
            status: current[panelStateId]?.status ?? false,
          },
        }))}
        onToggleSftpPanel={() => setSshSftpPanelVisible((current) => !current)}
        onToggleStatusPanel={() => setTerminalPanelVisibilityByTab((current) => ({
          ...current,
          [panelStateId]: {
            command: current[panelStateId]?.command ?? false,
            status: !(current[panelStateId]?.status ?? false),
          },
        }))}
        onUpdateSavedCommand={savedSshCommands.updateCommand}
      >
        {terminalPane}
      </SshTerminalWorkspace>
    ) : terminalPane;

    return renderWithSftpPanel(primaryContent, showSftpPanel);
  };
  const renderTerminalContent = (
    tab: WorkspaceSessionTab,
    isActivePane: boolean,
    reportSizeWhenVisible = false,
  ) => {
    if (tab.connection.transport?.kind !== "ssh" || !tab.terminal) {
      return renderSingleTerminalContent(tab, isActivePane, reportSizeWhenVisible);
    }

    const tabId = getSessionTabId(tab);
    const panes = terminalPanesForTab(tab).slice(0, maximumSshTerminalPanes);
    const layout: TerminalSplitLayout | null = resolveTerminalSplitLayout(tab);
    if (!layout || panes.length === 0) {
      return renderSingleTerminalContent(tab, isActivePane, reportSizeWhenVisible);
    }

    const rememberedTerminalId = focusedSshTerminalByTab[tabId];
    const activeTerminalId = panes.some((pane) => pane.terminal.id === rememberedTerminalId)
      ? rememberedTerminalId
      : panes[0].terminal.id;
    const activeTerminalPane = panes.find((pane) => pane.terminal.id === activeTerminalId) ?? panes[0];
    const panelVisibility = terminalPanelVisibilityByTab[tabId] ?? closedTerminalPanelVisibility;
    const pendingTerminalId = pendingSshSplitByTab[tabId] ?? null;

    const terminalGrid = (
      <SshTerminalGrid
        activeTerminalId={activeTerminalId}
        layout={layout}
        panes={panes}
        pendingTerminalId={pendingTerminalId}
        renderPane={(pane, paneIsActive, paneCount) => {
          const paneTab: WorkspaceSessionTab = {
            ...tab,
            id: `${tabId}:terminal:${pane.terminal.id}`,
            additionalTerminals: [],
            terminal: pane.terminal,
            terminalLayout: null,
            terminalSnapshot: pane.terminalSnapshot,
            terminalTitle: pane.terminalTitle,
            terminalWorkingDirectory: pane.terminalWorkingDirectory,
          };
          return renderTerminalPane(
            paneTab,
            isActivePane && paneIsActive,
            reportSizeWhenVisible || isActivePane,
            tabId,
            paneCount,
          );
        }}
        onActivate={(terminalId) => {
          setFocusedSshTerminalByTab((current) =>
            current[tabId] === terminalId ? current : { ...current, [tabId]: terminalId },
          );
        }}
        onClose={(terminalId) => {
          void Promise.resolve(onCloseSshTerminalPane(tabId, terminalId))
            .then(() => {
              setFocusedSshTerminalByTab((current) => {
                if (current[tabId] !== terminalId) {
                  return current;
                }
                const { [tabId]: _removed, ...rest } = current;
                return rest;
              });
            })
            .catch(() => undefined);
        }}
        onResize={(path, ratio) => onResizeSshTerminalSplit(tabId, path, ratio)}
        onSplit={(terminalId, orientation) => {
          setPendingSshSplitByTab((current) => ({ ...current, [tabId]: terminalId }));
          void Promise.resolve(onSplitSshTerminal(tabId, terminalId, orientation))
            .catch(() => undefined)
            .finally(() => {
              setPendingSshSplitByTab((current) => {
                const { [tabId]: _removed, ...rest } = current;
                return rest;
              });
            });
        }}
      />
    );
    const sftpPanelAvailable = Boolean(sftpSidePanel && isActivePane);
    const pageWorkspace = (
      <SshTerminalWorkspace
        commandHistory={commandHistoryByTab[tabId] ?? []}
        commandPanelVisible={panelVisibility.command}
        compact={panes.length > 1}
        connectionId={tab.connection.id}
        isActive={isActivePane}
        pageLevelPanels
        profileId={tab.connection.profileId}
        savedCommands={savedSshCommands.commands}
        sessionKind="ssh"
        sftpPanelAvailable={sftpPanelAvailable}
        sftpPanelVisible={sshSftpPanelVisible}
        statusPanelVisible={panelVisibility.status}
        terminalReady={Boolean(
          activeTerminalPane.terminal.status === "attached" && tab.connection.transport?.authenticated
        )}
        onAddSavedCommand={savedSshCommands.addCommand}
        onRemoveSavedCommand={savedSshCommands.removeCommand}
        onRunCommand={(command) => {
          if (activeTerminalPane.terminal.status === "closed") {
            return;
          }
          recordCommand(tabId, command);
          void onSendTerminalData(`${command}\r`, activeTerminalId);
        }}
        onToggleCommandPanel={() => setTerminalPanelVisibilityByTab((current) => ({
          ...current,
          [tabId]: {
            command: !(current[tabId]?.command ?? false),
            status: current[tabId]?.status ?? false,
          },
        }))}
        onToggleSftpPanel={() => setSshSftpPanelVisible((current) => !current)}
        onToggleStatusPanel={() => setTerminalPanelVisibilityByTab((current) => ({
          ...current,
          [tabId]: {
            command: current[tabId]?.command ?? false,
            status: !(current[tabId]?.status ?? false),
          },
        }))}
        onUpdateSavedCommand={savedSshCommands.updateCommand}
      >
        {terminalGrid}
      </SshTerminalWorkspace>
    );
    const showSftpPanel = sftpPanelAvailable && sshSftpPanelVisible;
    return renderWithSftpPanel(pageWorkspace, showSftpPanel);
  };
  const isPointerOutsideTabBar = (clientX: number, clientY: number) => {
    const tabBar = tabBarRef.current;

    if (!tabBar) {
      return false;
    }

    const bounds = tabBar.getBoundingClientRect();
    const detachThresholdPx = 18;

    return (
      clientX < bounds.left - detachThresholdPx ||
      clientX > bounds.right + detachThresholdPx ||
      clientY < bounds.top - detachThresholdPx ||
      clientY > bounds.bottom + detachThresholdPx
    );
  };
  const resolveTabPointerTarget = (
    sourceTabId: string,
    clientX: number,
    clientY: number,
  ): { tabId: string; position: "before" | "after" } | null => {
    const tabBar = tabBarRef.current;

    if (!tabBar) {
      return null;
    }

    const tabBarBounds = tabBar.getBoundingClientRect();
    if (
      clientX < tabBarBounds.left ||
      clientX > tabBarBounds.right ||
      clientY < tabBarBounds.top ||
      clientY > tabBarBounds.bottom
    ) {
      return null;
    }

    const tabElements = Array.from(
      tabBar.querySelectorAll<HTMLElement>("[data-session-tab-id]"),
    ).filter((element) => element.dataset.sessionTabId !== sourceTabId);

    if (tabElements.length === 0) {
      return null;
    }

    for (const element of tabElements) {
      const bounds = element.getBoundingClientRect();
      if (clientX < bounds.left + bounds.width / 2) {
        return {
          position: "before",
          tabId: element.dataset.sessionTabId ?? "",
        };
      }
    }

    const lastElement = tabElements[tabElements.length - 1];
    return {
      position: "after",
      tabId: lastElement.dataset.sessionTabId ?? "",
    };
  };
  const resetTabPointerDrag = (sourceTabId: string, notifyDragEnd: boolean) => {
    tabPointerDragRef.current = null;
    setDraggedTabId(null);
    setDragOverTabId(null);
    setDragOverPosition("before");

    if (notifyDragEnd) {
      onSessionDragStateChange?.(false, sourceTabId);
    }
  };
  const startTabPointerDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    sourceTabId: string,
  ) => {
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      (event.target instanceof Element && event.target.closest(".tab-close"))
    ) {
      return;
    }

    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    tabPointerDragRef.current = {
      active: false,
      pointerId: event.pointerId,
      position: "before",
      sourceTabId,
      startX: event.clientX,
      startY: event.clientY,
      targetTabId: null,
      selectOnRelease:
        event.target instanceof Element && Boolean(event.target.closest(".tab-main")),
    };
  };
  const updateTabPointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = tabPointerDragRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    if (!dragState.active) {
      const distance = Math.hypot(
        event.clientX - dragState.startX,
        event.clientY - dragState.startY,
      );
      if (distance < tabPointerDragThresholdPx) {
        return;
      }

      dragState.active = true;
      setDraggedTabId(dragState.sourceTabId);
      onSessionDragStateChange?.(true, dragState.sourceTabId);
    }

    event.preventDefault();
    event.stopPropagation();
    const target = resolveTabPointerTarget(
      dragState.sourceTabId,
      event.clientX,
      event.clientY,
    );
    dragState.targetTabId = target?.tabId || null;
    dragState.position = target?.position ?? "before";
    setDragOverTabId(dragState.targetTabId);
    setDragOverPosition(dragState.position);
  };
  const finishTabPointerDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    sourceTabId: string,
    cancelled = false,
  ) => {
    const dragState = tabPointerDragRef.current;

    if (
      !dragState ||
      dragState.sourceTabId !== sourceTabId ||
      dragState.pointerId !== event.pointerId
    ) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const wasActive = dragState.active;
    const targetTabId = dragState.targetTabId;
    const position = dragState.position;
    const shouldOpenWindow =
      wasActive &&
      !cancelled &&
      !targetTabId &&
      isPointerOutsideTabBar(event.clientX, event.clientY);
    const draggedTab = sessionTabs.find(
      (tab) => getSessionTabId(tab) === sourceTabId,
    ) ?? null;

    if (wasActive || (!cancelled && dragState.selectOnRelease)) {
      event.preventDefault();
      event.stopPropagation();
      suppressTabClickRef.current = sourceTabId;
      window.setTimeout(() => {
        if (suppressTabClickRef.current === sourceTabId) {
          suppressTabClickRef.current = null;
        }
      }, 0);
    }

    resetTabPointerDrag(sourceTabId, wasActive);

    if (!wasActive && !cancelled && dragState.selectOnRelease) {
      selectSessionTab(sourceTabId);
      return;
    }

    if (wasActive && !cancelled && targetTabId) {
      onReorderSessionTabs(sourceTabId, targetTabId, position);
    }

    if (shouldOpenWindow && !isCustomTab(draggedTab)) {
      (onDetachSessionTab ?? onOpenSessionWindow)(sourceTabId);
    }
  };

  useEffect(() => {
    if (!isFullscreen) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onToggleFullscreen();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isFullscreen, onToggleFullscreen]);

  useEffect(() => {
    if (!tabContextMenu) {
      return;
    }

    const closeMenu = () => setTabContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [tabContextMenu]);

  useEffect(() => {
    if (!disconnectedShortcutTabId || tabContextMenu) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isTerminalShortcutEditableTarget(event.target)) {
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        onCloseSessionTab(disconnectedShortcutTabId);
        return;
      }

      if (event.key.toLowerCase() === "r" && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        onReconnectSessionTab(disconnectedShortcutTabId);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    disconnectedShortcutTabId,
    onCloseSessionTab,
    onReconnectSessionTab,
    tabContextMenu,
  ]);

  useEffect(
    () => () => {
      document.body.classList.remove("terminal-grid-resizing-columns");
      document.body.classList.remove("terminal-grid-resizing-rows");
      document.body.classList.remove("terminal-sftp-resizing");
    },
    [],
  );

  useEffect(() => {
    const currentTabIds = new Set(sessionTabs.map(getSessionTabId));
    const currentTerminalPanelIds = new Set(currentTabIds);
    for (const tab of sessionTabs) {
      const tabId = getSessionTabId(tab);
      for (const pane of terminalPanesForTab(tab)) {
        currentTerminalPanelIds.add(`${tabId}:terminal:${pane.terminal.id}`);
      }
    }
    setCommandHistoryByTab((current) => {
      const entries = Object.entries(current).filter(([tabId]) => currentTerminalPanelIds.has(tabId));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
    setTerminalPanelVisibilityByTab((current) => {
      const entries = Object.entries(current).filter(([tabId]) => currentTerminalPanelIds.has(tabId));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
    setFocusedSshTerminalByTab((current) => {
      const entries = Object.entries(current).filter(([tabId, terminalId]) => {
        const tab = sessionTabs.find((item) => getSessionTabId(item) === tabId);
        return Boolean(tab && terminalPanesForTab(tab).some((pane) => pane.terminal.id === terminalId));
      });
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
    setPendingSshSplitByTab((current) => {
      const entries = Object.entries(current).filter(([tabId]) => currentTabIds.has(tabId));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
    for (const tabId of autoClosedLocalShellTabIdsRef.current) {
      if (!currentTabIds.has(tabId)) {
        autoClosedLocalShellTabIdsRef.current.delete(tabId);
      }
    }

    const closedLocalShellTab = sessionTabs.find(
      (tab) =>
        (tab.kind ?? "terminal") === "terminal" &&
        (tab.connection.transport?.kind === "local-shell" || tab.connection.transport?.kind === "wsl") &&
        isDisconnectedTerminalTab(tab),
    );

    if (!closedLocalShellTab) {
      return;
    }

    const tabId = getSessionTabId(closedLocalShellTab);
    if (autoClosedLocalShellTabIdsRef.current.has(tabId)) {
      return;
    }

    autoClosedLocalShellTabIdsRef.current.add(tabId);
    onCloseSessionTab(tabId);
  }, [onCloseSessionTab, sessionTabs]);

  useEffect(() => {
    return () => {
      terminalActivityTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      terminalActivityTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!resolvedActiveTabId) {
      return;
    }

    const activeTabElement = Array.from(
      tabBarRef.current?.querySelectorAll<HTMLElement>("[data-session-tab-id]") ?? [],
    ).find((element) => element.dataset.sessionTabId === resolvedActiveTabId);

    activeTabElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [resolvedActiveTabId, sessionTabs.length]);

  const renderSessionTab = (tab: WorkspaceSessionTab) => {
    const tabId = getSessionTabId(tab);
    const isFileTransferSessionTab = isFileTransferTab(tab);
    const isCustomSessionTab = isCustomTab(tab);
    const protocolLabel = resolveTabProtocolLabel(tab);
    const focusedTerminalId = focusedSshTerminalByTab[tabId];
    const terminalPanes = terminalPanesForTab(tab);
    const focusedTerminalPane =
      terminalPanes.find((pane) => pane.terminal.id === focusedTerminalId) ?? terminalPanes[0];
    const connectionTitle = resolveConnectionLabel(
      tab.connection,
      profilesById.get(tab.connection.profileId)?.name,
    );
    const reportedTitle = focusedTerminalPane?.terminal.status === "attached"
      ? focusedTerminalPane.terminalTitle?.trim() || null
      : null;
    const taskTitle = resolveTerminalTaskTitle(reportedTitle, tab.connection, connectionTitle);
    const displayTitle = taskTitle ?? connectionTitle;
    const terminalIsBusy = Boolean(
      focusedTerminalPane &&
      (activeOutputTerminalIds.has(focusedTerminalPane.terminal.id) || tab.connection.status === "connecting"),
    );
    const titleDescription = taskTitle
      ? `任务：${taskTitle}\n主机：${connectionTitle}\n类型：${protocolLabel}`
      : `主机：${connectionTitle}\n类型：${protocolLabel}`;
    const tabAriaLabel = taskTitle
      ? `切换到任务 ${taskTitle}，主机 ${connectionTitle}，类型 ${protocolLabel}`
      : `切换到主机 ${connectionTitle}，类型 ${protocolLabel}`;

    return (
      <div
        className={[
          "tab",
          tabId === resolvedActiveTabId ? "active" : "",
          tabId === draggedTabId ? "dragging" : "",
          tabId === dragOverTabId ? `drag-over drag-over-${dragOverPosition}` : "",
          isFileTransferSessionTab ? "file-transfer-tab" : "",
          isCustomSessionTab ? "custom-page-tab" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        data-session-tab-id={tabId}
        key={tabId}
        onPointerCancel={(event) => finishTabPointerDrag(event, tabId, true)}
        onPointerDown={(event) => startTabPointerDrag(event, tabId)}
        onPointerMove={updateTabPointerDrag}
        onPointerUp={(event) => finishTabPointerDrag(event, tabId)}
        onContextMenu={(event) => {
          event.preventDefault();
          if (isCustomTab(tab) && (tab.kind ?? "terminal") !== "http-console") {
            setTabContextMenu(null);
            return;
          }
          setTabContextMenu({ tabId, x: event.clientX, y: event.clientY });
        }}
        onMouseDown={(event) => {
          if (event.button === 0) {
            event.stopPropagation();
            return;
          }
          if (event.button !== 1) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();
          onCloseSessionTab(tabId);
        }}
      >
        <button
          aria-label={tabAriaLabel}
          className="tab-main"
          onClick={(event) => {
            if (suppressTabClickRef.current === tabId) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }

            selectSessionTab(tabId);
          }}
          title={titleDescription}
          type="button"
        >
          <span className="tab-title-line">
            <span className="tab-activity-title">{displayTitle}</span>
          </span>
        </button>
        <div className="tab-tools">
          <i
            aria-hidden="true"
            className={`tab-terminal-activity${terminalIsBusy ? " is-active" : ""}`}
          />
          <button
            aria-label={`关闭 ${tab.connection.title}`}
            className="tab-close"
            onClick={(event) => {
              event.stopPropagation();
              onCloseSessionTab(tabId);
            }}
            title="关闭"
            type="button"
          >
            <Icon name="x" />
          </button>
        </div>
      </div>
    );
  };
  const tabBar = hasSessionTabs ? (
    <div
      className={`tab-bar${showDetachedWindowControls ? " with-window-controls" : ""}`}
      data-tauri-drag-region={isDetachedWindow ? "deep" : undefined}
      ref={tabBarRef}
    >
      <nav
        aria-label="已打开会话"
        className="tabs"
        data-tauri-drag-region={isDetachedWindow ? "deep" : undefined}
        onWheel={scrollTabsHorizontally}
      >
        {sessionTabs.map(renderSessionTab)}
      </nav>
      {showDetachedWindowControls ? (
        <WindowControls className="detached-window-controls" />
      ) : null}
    </div>
  ) : null;

  return (
    <section className={workspaceClassName}>
      {tabBarPortalTarget && !isFullscreen && tabBar
        ? createPortal(tabBar, tabBarPortalTarget)
        : tabBar}
      {tabContextMenu ? (
        (() => {
          const menuTab = sessionTabs.find(
            (tab) => getSessionTabId(tab) === tabContextMenu.tabId,
          );

          return menuTab ? (
            <TabContextMenu
              isDetachedWindow={isDetachedWindow}
              position={{ x: tabContextMenu.x, y: tabContextMenu.y }}
              tab={menuTab}
              tabId={tabContextMenu.tabId}
              onClose={() => setTabContextMenu(null)}
              onCloseTab={onCloseSessionTab}
              onOpenFileTransfer={onOpenFileTransferTab}
              onOpenWindow={isDetachedWindow ? (onDetachSessionTab ?? onOpenSessionWindow) : onOpenSessionWindow}
              onReconnect={onReconnectSessionTab}
            />
          ) : null;
        })()
      ) : null}

      {hasSessionTabs ? (
        <div className={terminalBodyClassName}>
        {reattachHintActive ? (
          <div className="terminal-reattach-target" aria-hidden="true">
            <span>释放后合并到此窗口</span>
          </div>
        ) : null}

        {shouldShowRiskBanner ? (
          <div className="risk-banner">
            当前连接使用明文传输。用户名、密码、命令和输出可能被网络中间节点看到，仅建议在可信内网或实验环境使用。
          </div>
        ) : null}

        {terminalTabs.length > 0 ? (
          <div
            className={[
              "terminal-layout",
              "terminal-layout-stack",
              isTerminalTabActive ? "" : "inactive",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {terminalTabs.map((tab) => {
              const tabId = getSessionTabId(tab);
              const isActivePane = tabId === resolvedActiveTabId && isTerminalTabActive;

              return (
                <div
                  className={["terminal-layout-item", isActivePane ? "active" : ""]
                    .filter(Boolean)
                    .join(" ")}
                  key={tabId}
                >
                  {renderTerminalContent(tab, isActivePane)}
                </div>
              );
            })}
          </div>
        ) : null}

        {activeCustomTabContent ? (
          <div className="terminal-custom-tab">{activeCustomTabContent}</div>
        ) : isFileTransferTabActive && fileTransferPanel ? (
          <div className="terminal-file-tab">{fileTransferPanel}</div>
        ) : !isFileTransferTabActive && terminalTabs.length > 0 ? (
          null
        ) : emptyStateNotice ? (
          <div className="terminal-notice-page" role="status">
            <strong>连接已断开</strong>
            <span>{emptyStateNotice}</span>
          </div>
        ) : activeTab ? (
          <div className="terminal-blank-page" aria-label={isFileTransferTabActive ? "SFTP 文件管理加载中" : "空白终端页"} />
        ) : null}
        </div>
      ) : null}

      {!hasSessionTabs ? (
        <div className="terminal-home-page" aria-label="首页快捷键提示">
          <dl className="home-shortcut-list">
            {homeShortcutRows.map((item) => (
              <div className="home-shortcut-row" key={item.key}>
                <dt>{item.label}</dt>
                <dd aria-label={`${item.label}：${item.shortcut}`}>
                  {item.parts.map((part, index) => (
                    <span className="home-shortcut-key-group" key={`${item.key}-${part}-${index}`}>
                      {index > 0 ? <span className="home-shortcut-plus">+</span> : null}
                      <kbd>{part}</kbd>
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

    </section>
  );
}
