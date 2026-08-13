import {
  type CSSProperties,
  type DragEvent,
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
  TerminalSize,
  WorkspaceSessionTab,
} from "../../shared/types";
import { Icon } from "../../shared/Icon";
import { SerialTerminalPanel } from "./SerialTerminalPanel";
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
  onTerminalWorkingDirectoryChange?: (terminalId: string, path: string) => void;
  onResizeTerminal: (size?: TerminalSize, terminalId?: string) => void;
  onCloseSessionTab: (connectionId: string) => void;
  onDetachSessionTab?: (connectionId: string) => void;
  onOpenFileTransferTab?: (connectionId: string, options?: { forceNew?: boolean }) => void;
  onOpenSessionWindow: (connectionId: string) => void;
  onCloseSerialTerminal: (terminalId: string) => Promise<void> | void;
  onOpenSerialTerminal: (terminalId: string, profile: SerialProfile) => Promise<void> | void;
  onReconfigureSerialTerminal: (terminalId: string, profile: SerialProfile) => Promise<void> | void;
  onRefreshSerialPorts?: () => Promise<SerialPortInfo[]> | Promise<void> | SerialPortInfo[] | void;
  onReconnectSessionTab: (connectionId: string) => void;
  onReorderSessionTabs: (sourceConnectionId: string, targetConnectionId: string) => void;
  onSessionDragStateChange?: (isDragging: boolean, tabId: string) => void;
  onSelectSessionTab: (connectionId: string) => void;
  onToggleFullscreen: () => void;
  reattachHintActive?: boolean;
  isFullscreen: boolean;
}

interface SftpSidePanelRenderProps {
  layoutSide: "left" | "right";
  onToggleLayoutSide: () => void;
}

const getSessionTabId = (tab: WorkspaceSessionTab) => tab.id ?? tab.connection.id;
const closedTerminalPanelVisibility = { command: false, status: false } as const;
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
  onDetachSessionTab,
  onOpenFileTransferTab,
  onResizeTerminal,
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
  onTerminalWorkingDirectoryChange,
  onToggleFullscreen,
  reattachHintActive = false,
  isFullscreen,
}: TerminalWorkspaceProps) {
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const [rightSplitTabId, setRightSplitTabId] = useState<string | null>(null);
  const [leftSplitActiveTabId, setLeftSplitActiveTabId] = useState<string | null>(null);
  const [splitFocusedPane, setSplitFocusedPane] = useState<"left" | "right">("left");
  const [splitDragOverPane, setSplitDragOverPane] = useState<"left" | "right" | null>(null);
  const [splitRatio, setSplitRatio] = useState(0.5);
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
  const splitLayoutRef = useRef<HTMLDivElement>(null);
  const sftpLayoutRef = useRef<HTMLDivElement>(null);
  const tabDropHandledRef = useRef(false);
  const autoClosedLocalShellTabIdsRef = useRef(new Set<string>());
  const lastDragPositionRef = useRef<{ x: number; y: number } | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);
  const resolvedActiveTabId = activeTabId ?? connection?.id ?? sessionTabs[0]?.connection.id ?? null;
  const activeTab = sessionTabs.find((tab) => getSessionTabId(tab) === resolvedActiveTabId);
  const activeCustomTabContent = activeTab ? customTabPanels?.[getSessionTabId(activeTab)] : null;
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
  const splitRightTab =
    rightSplitTabId
      ? sessionTabs.find((tab) => getSessionTabId(tab) === rightSplitTabId) ?? null
      : null;
  const leftSplitTabs = splitRightTab
    ? sessionTabs.filter((tab) => getSessionTabId(tab) !== rightSplitTabId)
    : sessionTabs;
  const leftSplitTabIds = new Set(leftSplitTabs.map(getSessionTabId));
  const leftResolvedActiveTabId =
    splitRightTab && resolvedActiveTabId && leftSplitTabIds.has(resolvedActiveTabId)
      ? resolvedActiveTabId
      : splitRightTab && leftSplitActiveTabId && leftSplitTabIds.has(leftSplitActiveTabId)
        ? leftSplitActiveTabId
        : splitRightTab
          ? leftSplitTabs[0]
            ? getSessionTabId(leftSplitTabs[0])
            : null
          : resolvedActiveTabId;
  const leftActiveTab = leftResolvedActiveTabId
    ? leftSplitTabs.find((tab) => getSessionTabId(tab) === leftResolvedActiveTabId) ?? null
    : null;
  const isLeftFileTransferTabActive = isFileTransferTab(leftActiveTab);
  const isLeftTerminalTabActive = (leftActiveTab?.kind ?? "terminal") === "terminal";
  const isLeftSerialTabActive = leftActiveTab?.connection.transport?.kind === "serial";
  const isRightFileTransferTabActive = isFileTransferTab(splitRightTab);
  const isRightTerminalTabActive = Boolean(splitRightTab) && !isRightFileTransferTabActive;
  const isRightSerialTabActive = splitRightTab?.connection.transport?.kind === "serial";
  const leftTerminalTabs = leftSplitTabs.filter(
    (tab) => (tab.kind ?? "terminal") === "terminal" && tab.terminal,
  );
  const isTerminalSplitActive = Boolean(splitRightTab && leftSplitTabs.length > 0 && !isCustomTabActive);
  const disconnectedShortcutTab = isTerminalSplitActive
    ? splitFocusedPane === "right"
      ? splitRightTab
      : leftActiveTab
    : activeTab;
  const disconnectedShortcutTabId = isDisconnectedTerminalTab(disconnectedShortcutTab)
    ? getSessionTabId(disconnectedShortcutTab)
    : null;
  const splitLayoutStyle = {
    gridTemplateColumns: `minmax(220px, calc(${Math.round(splitRatio * 100)}% - 4px)) 8px minmax(220px, 1fr)`,
  } as CSSProperties;
  const workspaceClassName = [
    "terminal-workspace",
    !hasSessionTabs ? "home-empty" : "",
    hasSessionTabs && tabBarPortalTarget && !isFullscreen ? "tabs-in-titlebar" : "",
    isTerminalSplitActive ? "split-active" : "",
    isFullscreen ? "fullscreen" : "",
    reattachHintActive ? "reattach-hint-active" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const hasVisibleSshTerminal = isTerminalSplitActive
    ? (isLeftTerminalTabActive && leftActiveTab?.connection.transport?.kind === "ssh") ||
      (isRightTerminalTabActive && splitRightTab?.connection.transport?.kind === "ssh")
    : isTerminalTabActive && activeTab?.connection.transport?.kind === "ssh";
  const terminalBodyClassName = [
    "terminal-body",
    isSerialTabActive
      ? "terminal-body-serial-content"
      : isTerminalSplitActive || isTerminalTabActive
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
    if (isTerminalSplitActive && tabId === rightSplitTabId) {
      setSplitFocusedPane("right");
      if (isRightFileTransferTabActive) {
        onSelectSessionTab(tabId);
      } else if (leftResolvedActiveTabId && !leftSplitTabIds.has(resolvedActiveTabId ?? "")) {
        onSelectSessionTab(leftResolvedActiveTabId);
      }
      return;
    }

    if (isTerminalSplitActive) {
      setLeftSplitActiveTabId(tabId);
      setSplitFocusedPane("left");
    }

    onSelectSessionTab(tabId);
  };
  const splitTabToRight = (tabId: string) => {
    const target = sessionTabs.find((tab) => getSessionTabId(tab) === tabId) ?? null;
    const targetId = target ? getSessionTabId(target) : null;

    if (!target || !targetId || isCustomTab(target) || sessionTabs.length < 2) {
      return;
    }

    const fallbackTab = sessionTabs.find((tab) => getSessionTabId(tab) !== targetId);
    const leftFallbackId =
      leftSplitActiveTabId && leftSplitActiveTabId !== targetId
        ? leftSplitActiveTabId
        : resolvedActiveTabId && resolvedActiveTabId !== targetId
          ? resolvedActiveTabId
          : fallbackTab
            ? getSessionTabId(fallbackTab)
            : null;

    setRightSplitTabId(targetId);
    setLeftSplitActiveTabId(leftFallbackId);
    setSplitFocusedPane("right");

    if (!leftFallbackId) {
      closeActiveSplit();
    } else {
      onSelectSessionTab(isFileTransferTab(target) ? targetId : leftFallbackId);
    }
  };
  const closeActiveSplit = () => {
    setRightSplitTabId(null);
    setSplitFocusedPane("left");
  };
  const moveTabToSplitPane = (tabId: string, pane: "left" | "right") => {
    const target = sessionTabs.find((tab) => getSessionTabId(tab) === tabId);

    if (!target || isCustomTab(target)) {
      return;
    }

    if (pane === "right") {
      if (sessionTabs.length < 2) {
        return;
      }

      const fallbackTab = sessionTabs.find((tab) => getSessionTabId(tab) !== tabId);
      setRightSplitTabId(tabId);
      setLeftSplitActiveTabId(fallbackTab ? getSessionTabId(fallbackTab) : null);
      setSplitFocusedPane("right");
      onSelectSessionTab(isFileTransferTab(target) ? tabId : fallbackTab ? getSessionTabId(fallbackTab) : tabId);
      return;
    }

    if (tabId === rightSplitTabId) {
      const fallbackTab = sessionTabs.find((tab) => getSessionTabId(tab) !== tabId);
      setRightSplitTabId(null);
      setLeftSplitActiveTabId(fallbackTab ? getSessionTabId(fallbackTab) : tabId);
      setSplitFocusedPane("left");
      onSelectSessionTab(fallbackTab ? getSessionTabId(fallbackTab) : tabId);
      return;
    }

    setLeftSplitActiveTabId(tabId);
    setSplitFocusedPane("left");
    onSelectSessionTab(tabId);
  };
  const dragTabOverSplitPane = (event: DragEvent<HTMLElement>, pane: "left" | "right") => {
    if (!draggedTabId) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setSplitDragOverPane(pane);
  };
  const dropTabOnSplitPane = (event: DragEvent<HTMLElement>, pane: "left" | "right") => {
    event.preventDefault();
    tabDropHandledRef.current = true;
    const sourceId = event.dataTransfer.getData("text/plain") || draggedTabId;

    if (sourceId) {
      moveTabToSplitPane(sourceId, pane);
      onSessionDragStateChange?.(false, sourceId);
    }

    setSplitDragOverPane(null);
    setDraggedTabId(null);
    setDragOverTabId(null);
  };
  const startSplitResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const updateSplitRatio = (clientX: number) => {
      const layout = splitLayoutRef.current;

      if (!layout) {
        return;
      }

      const bounds = layout.getBoundingClientRect();
      if (bounds.width <= 0) {
        return;
      }

      const nextRatio = (clientX - bounds.left) / bounds.width;
      setSplitRatio(Math.min(0.75, Math.max(0.25, nextRatio)));
    };
    const onPointerMove = (moveEvent: PointerEvent) => updateSplitRatio(moveEvent.clientX);
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      document.body.classList.remove("terminal-split-resizing");
    };

    document.body.classList.add("terminal-split-resizing");
    updateSplitRatio(event.clientX);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
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
  const updateLastDragPosition = (event: DragEvent<HTMLElement>) => {
    if (event.clientX !== 0 || event.clientY !== 0) {
      lastDragPositionRef.current = { x: event.clientX, y: event.clientY };
    }
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
        terminal={tab.terminal}
        terminalConfirmMultilinePaste={terminalConfirmMultilinePaste}
        terminalCopyRichText={terminalCopyRichText}
        terminalFontFamily={terminalFontFamily}
        terminalFontSize={terminalFontSize}
        terminalRightClickBehavior={terminalRightClickBehavior}
        terminalTheme={terminalTheme}
        terminalSnapshot={tab.terminalSnapshot}
        onCloseDisconnected={() => onCloseSessionTab(getSessionTabId(tab))}
        onCommandSubmitted={
          tab.connection.transport?.kind === "ssh" || tab.connection.transport?.kind === "wsl"
            ? (command) => recordCommand(getSessionTabId(tab), command)
            : undefined
        }
        onReconnectDisconnected={() => onReconnectSessionTab(getSessionTabId(tab))}
        onResizeTerminal={onResizeTerminal}
        onSendData={onSendTerminalData}
        onWorkingDirectoryChange={
          tab.connection.transport?.kind === "ssh"
            ? onTerminalWorkingDirectoryChange
            : undefined
        }
      />
    );
  };
  const renderTerminalContent = (
    tab: WorkspaceSessionTab,
    isActivePane: boolean,
    reportSizeWhenVisible = false,
  ) => {
    // Vim/tmux 等全屏程序依赖连续解析控制序列；隐藏标签页也必须保持 xterm 状态同步。
    const terminalPane = renderTerminalPane(tab, isActivePane, reportSizeWhenVisible);
    const tabId = getSessionTabId(tab);
    const panelVisibility = terminalPanelVisibilityByTab[tabId] ?? closedTerminalPanelVisibility;
    const isSshTerminal = tab.connection.transport?.kind === "ssh";
    const isWslTerminal = tab.connection.transport?.kind === "wsl";
    const sftpPanelAvailable = Boolean(sftpSidePanel && isActivePane && !isTerminalSplitActive);
    const showSftpPanel = sftpPanelAvailable && sshSftpPanelVisible;
    const primaryContent = isSshTerminal || isWslTerminal ? (
      <SshTerminalWorkspace
        commandHistory={commandHistoryByTab[tabId] ?? []}
        commandPanelVisible={panelVisibility.command}
        compact={isTerminalSplitActive}
        connectionId={tab.connection.id}
        distribution={isWslTerminal ? tab.connection.transport?.host : undefined}
        isActive={isActivePane}
        profileId={tab.connection.profileId}
        savedCommands={savedSshCommands.commands}
        sessionKind={isWslTerminal ? "wsl" : "ssh"}
        sftpPanelAvailable={sftpPanelAvailable}
        sftpPanelVisible={sshSftpPanelVisible}
        statusPanelVisible={panelVisibility.status}
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
        {terminalPane}
      </SshTerminalWorkspace>
    ) : terminalPane;

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
        className={[
          "terminal-content-shell",
          showSftpPanel ? "terminal-with-sftp" : "",
        ]
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
  const isDragOutsideTabBar = (event: DragEvent<HTMLElement>) => {
    const tabBar = tabBarRef.current;
    const position =
      event.clientX !== 0 || event.clientY !== 0
        ? { x: event.clientX, y: event.clientY }
        : lastDragPositionRef.current;

    if (!tabBar || !position) {
      return false;
    }

    const bounds = tabBar.getBoundingClientRect();
    const detachThresholdPx = 18;

    return (
      position.x < bounds.left - detachThresholdPx ||
      position.x > bounds.right + detachThresholdPx ||
      position.y < bounds.top - detachThresholdPx ||
      position.y > bounds.bottom + detachThresholdPx
    );
  };
  const finishTabDrag = (event: DragEvent<HTMLElement>, tabId: string) => {
    const wasDroppedOnTab = tabDropHandledRef.current;
    const shouldOpenWindow = !wasDroppedOnTab && isDragOutsideTabBar(event);
    const draggedTab = sessionTabs.find((tab) => getSessionTabId(tab) === tabId) ?? null;
    tabDropHandledRef.current = false;
    lastDragPositionRef.current = null;
    setDraggedTabId(null);
    setDragOverTabId(null);
    setSplitDragOverPane(null);
    onSessionDragStateChange?.(false, tabId);

    if (shouldOpenWindow && !isCustomTab(draggedTab)) {
      (onDetachSessionTab ?? onOpenSessionWindow)(tabId);
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
      document.body.classList.remove("terminal-split-resizing");
      document.body.classList.remove("terminal-sftp-resizing");
    },
    [],
  );

  useEffect(() => {
    if (!isTerminalSplitActive && splitFocusedPane !== "left") {
      setSplitFocusedPane("left");
    }
  }, [isTerminalSplitActive, splitFocusedPane]);

  useEffect(() => {
    const currentTabIds = new Set(sessionTabs.map(getSessionTabId));
    setCommandHistoryByTab((current) => {
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
    const sessionTabIds = new Set(sessionTabs.map(getSessionTabId));

    setRightSplitTabId((current) =>
      current && sessionTabs.length > 1 && sessionTabIds.has(current) ? current : null,
    );
    setLeftSplitActiveTabId((current) => {
      if (current && sessionTabIds.has(current) && current !== rightSplitTabId) {
        return current;
      }

      const fallbackTab = sessionTabs.find((tab) => getSessionTabId(tab) !== rightSplitTabId);
      const fallback =
        resolvedActiveTabId && resolvedActiveTabId !== rightSplitTabId && sessionTabIds.has(resolvedActiveTabId)
          ? resolvedActiveTabId
          : fallbackTab
            ? getSessionTabId(fallbackTab)
            : null;

      return fallback;
    });
  }, [resolvedActiveTabId, rightSplitTabId, sessionTabs]);

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

    return (
      <div
        className={[
          "tab",
          tabId === resolvedActiveTabId ? "active" : "",
          tabId === rightSplitTabId ? "split-right-tab" : "",
          tabId === dragOverTabId ? "drag-over" : "",
          isFileTransferSessionTab ? "file-transfer-tab" : "",
          isCustomSessionTab ? "custom-page-tab" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        data-session-tab-id={tabId}
        draggable={!isCustomSessionTab}
        key={tabId}
        onDrag={updateLastDragPosition}
        onDragEnd={(event) => finishTabDrag(event, tabId)}
        onDragEnter={() => {
          if (draggedTabId && draggedTabId !== tabId) {
            setDragOverTabId(tabId);
            setSplitDragOverPane(tabId === rightSplitTabId ? "right" : "left");
          }
        }}
        onDragOver={(event) => {
          if (draggedTabId && draggedTabId !== tabId) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }
        }}
        onDragStart={(event) => {
          tabDropHandledRef.current = false;
          updateLastDragPosition(event);
          setDraggedTabId(tabId);
          onSessionDragStateChange?.(true, tabId);
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", tabId);
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          tabDropHandledRef.current = true;
          const sourceId = event.dataTransfer.getData("text/plain") || draggedTabId;

          if (sourceId) {
            if (isTerminalSplitActive) {
              const sourcePane = sourceId === rightSplitTabId ? "right" : "left";
              const targetPane = tabId === rightSplitTabId ? "right" : "left";

              if (sourcePane !== targetPane) {
                moveTabToSplitPane(sourceId, targetPane);
              } else {
                onReorderSessionTabs(sourceId, tabId);
              }
            } else {
              onReorderSessionTabs(sourceId, tabId);
            }

            onSessionDragStateChange?.(false, sourceId);
          }

          setDraggedTabId(null);
          setDragOverTabId(null);
          setSplitDragOverPane(null);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setTabContextMenu({ tabId, x: event.clientX, y: event.clientY });
        }}
        onMouseDown={(event) => {
          if (event.button !== 1) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();
          onCloseSessionTab(tabId);
        }}
      >
        <button
          aria-label={`切换到 ${tab.connection.title}`}
          className="tab-main"
          onClick={() => selectSessionTab(tabId)}
          title={tab.connection.title}
          type="button"
        >
          <span>{tab.connection.title}</span>
        </button>
        <div className="tab-tools">
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
          className={["tab-bar", isTerminalSplitActive ? "split-tab-bar" : ""]
            .filter(Boolean)
            .join(" ")}
          ref={tabBarRef}
          style={isTerminalSplitActive ? splitLayoutStyle : undefined}
        >
          {isTerminalSplitActive && splitRightTab ? (
            <>
              <nav
                className={[
                  "tabs",
                  "split-tabs-left",
                  splitDragOverPane === "left" ? "split-drop-over" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-label="左侧标签页"
                onDragLeave={() => setSplitDragOverPane(null)}
                onDragOver={(event) => dragTabOverSplitPane(event, "left")}
                onDrop={(event) => dropTabOnSplitPane(event, "left")}
                onWheel={scrollTabsHorizontally}
              >
                {leftSplitTabs.map(renderSessionTab)}
              </nav>
              <div className="tab-bar-split-spacer" aria-hidden="true" />
              <div
                className={[
                  "split-tab-group",
                  "split-tabs-right",
                  splitDragOverPane === "right" ? "split-drop-over" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onDragLeave={() => setSplitDragOverPane(null)}
                onDragOver={(event) => dragTabOverSplitPane(event, "right")}
                onDrop={(event) => dropTabOnSplitPane(event, "right")}
              >
                <nav className="tabs" aria-label="右侧标签页" onWheel={scrollTabsHorizontally}>
                  {renderSessionTab(splitRightTab)}
                </nav>
                <button
                  aria-label="取消右侧分屏"
                  className="terminal-icon-button split-tab-close"
                  onClick={closeActiveSplit}
                  title="取消右侧分屏"
                  type="button"
                >
                  <Icon name="columns-2" />
                </button>
              </div>
            </>
          ) : (
            <nav className="tabs" aria-label="已打开会话" onWheel={scrollTabsHorizontally}>
              {sessionTabs.map(renderSessionTab)}
            </nav>
          )}
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
              position={{ x: tabContextMenu.x, y: tabContextMenu.y }}
              tab={menuTab}
              tabId={tabContextMenu.tabId}
              canSplitRight={!isCustomTab(menuTab) && sessionTabs.length > 1}
              onClose={() => setTabContextMenu(null)}
              onCloseTab={onCloseSessionTab}
              onOpenFileTransfer={onOpenFileTransferTab}
              onOpenWindow={onOpenSessionWindow}
              onReconnect={onReconnectSessionTab}
              onSplitRight={splitTabToRight}
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

        {isTerminalSplitActive && splitRightTab ? (
          <div
            className="terminal-layout terminal-split-layout"
            ref={splitLayoutRef}
            style={splitLayoutStyle}
          >
            <div
              className={[
                "terminal-split-pane",
                isLeftSerialTabActive ? "terminal-split-pane-serial-content" : "",
                splitDragOverPane === "left" ? "split-drop-over" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onDragLeave={() => setSplitDragOverPane(null)}
              onDragOver={(event) => dragTabOverSplitPane(event, "left")}
              onDrop={(event) => dropTabOnSplitPane(event, "left")}
              onMouseDownCapture={() => {
                setSplitFocusedPane("left");
                if (leftResolvedActiveTabId && resolvedActiveTabId !== leftResolvedActiveTabId) {
                  onSelectSessionTab(leftResolvedActiveTabId);
                }
              }}
            >
              {leftTerminalTabs.length > 0 ? (
                <div
                  className={[
                    "terminal-layout",
                    "terminal-layout-stack",
                    isLeftTerminalTabActive ? "" : "inactive",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {leftTerminalTabs.map((tab) => {
                    const tabId = getSessionTabId(tab);
                    const isActivePane = tabId === leftResolvedActiveTabId && isLeftTerminalTabActive;

                    return (
                      <div
                        className={["terminal-layout-item", isActivePane ? "active" : ""]
                          .filter(Boolean)
                          .join(" ")}
                        key={tabId}
                      >
                        {renderTerminalContent(
                          tab,
                          isActivePane && splitFocusedPane === "left",
                          true,
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : null}
              {isLeftFileTransferTabActive && fileTransferPanel ? (
                <div className="terminal-file-tab">{fileTransferPanel}</div>
              ) : !isLeftTerminalTabActive && leftActiveTab ? (
                <div className="terminal-blank-page" aria-label="空白标签页" />
              ) : null}
            </div>
            <div
              aria-label="调整分屏宽度"
              className="terminal-split-resizer"
              onPointerDown={startSplitResize}
              role="separator"
              title="调整分屏宽度"
            />
            <div
              className={[
                "terminal-split-pane",
                isRightSerialTabActive ? "terminal-split-pane-serial-content" : "",
                splitDragOverPane === "right" ? "split-drop-over" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onDragLeave={() => setSplitDragOverPane(null)}
              onDragOver={(event) => dragTabOverSplitPane(event, "right")}
              onDrop={(event) => dropTabOnSplitPane(event, "right")}
              onMouseDownCapture={() => {
                setSplitFocusedPane("right");
              }}
            >
              {isRightTerminalTabActive ? (
                renderTerminalContent(splitRightTab, splitFocusedPane === "right", true)
              ) : isRightFileTransferTabActive && resolvedActiveTabId === rightSplitTabId && fileTransferPanel ? (
                <div className="terminal-file-tab">{fileTransferPanel}</div>
              ) : (
                <div className="terminal-blank-page" aria-label="空白标签页" />
              )}
            </div>
          </div>
        ) : terminalTabs.length > 0 ? (
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

        {!isTerminalSplitActive ? (
          activeCustomTabContent ? (
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
          ) : null
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
