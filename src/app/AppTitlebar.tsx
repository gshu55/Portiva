import { useRef, type MouseEvent, type Ref } from "react";
import { Icon } from "../shared/Icon";
import {
  detectWindowControlPlatform,
  runWindowAction,
  WindowControls,
} from "../shared/WindowControls";

interface AppTitlebarProps {
  httpConsoleActive: boolean;
  networkScannerActive: boolean;
  savedConnectionsOpen: boolean;
  settingsTabActive: boolean;
  onCreateProfile: () => void;
  onOpenHttpConsole: () => void;
  onOpenNetworkScanner: () => void;
  onOpenLocalShell: () => void;
  onOpenSerialTerminal: () => void;
  onOpenSavedConnections: () => void;
  onOpenSettings: () => void;
  tabSlotRef: Ref<HTMLDivElement>;
}

function isTitlebarInteractiveTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    Boolean(
      target.closest(
        ".tab, button, a, input, select, textarea, [contenteditable='true'], [draggable='true']",
      ),
    )
  );
}

export function AppTitlebar({
  httpConsoleActive,
  networkScannerActive,
  savedConnectionsOpen,
  settingsTabActive,
  onCreateProfile,
  onOpenHttpConsole,
  onOpenNetworkScanner,
  onOpenLocalShell,
  onOpenSerialTerminal,
  onOpenSavedConnections,
  onOpenSettings,
  tabSlotRef,
}: AppTitlebarProps) {
  const suppressNextDoubleClickRef = useRef(false);

  const startTitlebarDrag = (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || isTitlebarInteractiveTarget(event.target)) {
      return;
    }

    if (event.detail === 2) {
      suppressNextDoubleClickRef.current = true;
      event.preventDefault();
      event.stopPropagation();
      void runWindowAction("toggle-maximize");
      return;
    }

    if (event.detail > 2) {
      return;
    }

    void runWindowAction("drag");
  };
  const toggleTitlebarMaximize = (event: MouseEvent<HTMLElement>) => {
    if (isTitlebarInteractiveTarget(event.target)) {
      return;
    }

    if (suppressNextDoubleClickRef.current) {
      suppressNextDoubleClickRef.current = false;
      return;
    }

    void runWindowAction("toggle-maximize");
  };
  const windowControlPlatform = detectWindowControlPlatform();
  const isMacWindow = windowControlPlatform === "macos";

  return (
    <header
      className={`app-titlebar window-controls-${windowControlPlatform}`}
      data-tauri-drag-region={isMacWindow ? "deep" : undefined}
      onDoubleClick={toggleTitlebarMaximize}
      onMouseDown={startTitlebarDrag}
    >
      {isMacWindow ? <div className="native-window-spacer" aria-hidden="true" /> : null}
      <div className="app-titlebar-tab-slot" ref={tabSlotRef} />
      <div className="app-titlebar-drag-handle" aria-hidden="true" />
      <nav className="app-titlebar-actions" aria-label="主页工具栏">
        <button
          type="button"
          className={savedConnectionsOpen ? "active" : ""}
          title="主机概览"
          aria-label="主机概览"
          onClick={onOpenSavedConnections}
        >
          <Icon name="server" />
        </button>
        <button type="button" title="新建连接" aria-label="新建连接" onClick={onCreateProfile}>
          <Icon name="plus" />
        </button>
        <button type="button" title="本地终端" aria-label="本地终端" onClick={onOpenLocalShell}>
          <Icon name="terminal" />
        </button>
        <button type="button" title="串口终端" aria-label="串口终端" onClick={onOpenSerialTerminal}>
          <Icon name="plug" />
        </button>
        <button
          type="button"
          className={networkScannerActive ? "active" : ""}
          title="局域网扫描"
          aria-label="局域网扫描"
          onClick={onOpenNetworkScanner}
        >
          <Icon name="activity" />
        </button>
        <button
          type="button"
          className={httpConsoleActive ? "active" : ""}
          title="Post"
          aria-label="Post"
          onClick={onOpenHttpConsole}
        >
          <Icon name="network" />
        </button>
        <button
          type="button"
          className={settingsTabActive ? "active" : ""}
          title="设置"
          aria-label="设置"
          onClick={onOpenSettings}
        >
          <Icon name="settings" />
        </button>
      </nav>
      <WindowControls closeLabel="后台运行" closeTitle="关闭到系统托盘" />
    </header>
  );
}
