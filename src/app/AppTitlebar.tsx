import { useEffect, useRef, useState, type MouseEvent, type Ref } from "react";
import { Icon, type IconName } from "../shared/Icon";

type WindowAction = "close" | "drag" | "minimize" | "toggle-maximize";
type WindowControlPlatform = "linux" | "macos" | "windows";

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

async function runWindowAction(action: WindowAction) {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const currentWindow = getCurrentWindow();

    if (action === "drag") {
      await currentWindow.startDragging();
    } else if (action === "minimize") {
      await currentWindow.minimize();
    } else if (action === "toggle-maximize") {
      await currentWindow.toggleMaximize();
    } else {
      await currentWindow.close();
    }
  } catch {
    // Browser preview and mocked mode do not have native window controls.
  }
}

async function readWindowMaximized() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return await getCurrentWindow().isMaximized();
  } catch {
    return false;
  }
}

function detectWindowControlPlatform(): WindowControlPlatform {
  const platform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();

  if (platform.includes("mac") || userAgent.includes("mac os")) {
    return "macos";
  }

  if (platform.includes("linux") || userAgent.includes("linux")) {
    return "linux";
  }

  return "windows";
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
  const [isMaximized, setIsMaximized] = useState(false);
  const suppressNextDoubleClickRef = useRef(false);

  useEffect(() => {
    void readWindowMaximized().then(setIsMaximized);
  }, []);

  const toggleWindowMaximize = async () => {
    await runWindowAction("toggle-maximize");
    setIsMaximized(await readWindowMaximized());
  };

  const startTitlebarDrag = (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || isTitlebarInteractiveTarget(event.target)) {
      return;
    }

    if (event.detail === 2) {
      suppressNextDoubleClickRef.current = true;
      event.preventDefault();
      event.stopPropagation();
      void toggleWindowMaximize();
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

    void toggleWindowMaximize();
  };
  const windowControlPlatform = detectWindowControlPlatform();
  const isMacWindow = windowControlPlatform === "macos";
  const maximizeIcon: IconName = isMaximized ? "restore" : "maximize";
  const maximizeLabel = isMaximized ? "还原" : "最大化";
  const nonMacWindowControls = [
    { action: "minimize" as const, className: "minimize", icon: "minus" as const, label: "最小化", title: "最小化" },
    { action: "toggle-maximize" as const, className: "maximize", icon: maximizeIcon, label: maximizeLabel, title: maximizeLabel },
    { action: "close" as const, className: "close", icon: "x" as const, label: "后台运行", title: "关闭到系统托盘" },
  ];

  return (
    <header
      className={`app-titlebar window-controls-${windowControlPlatform}`}
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
      {!isMacWindow ? (
        <div className={`window-controls ${windowControlPlatform}`} aria-label="窗口控制">
          {nonMacWindowControls.map((control) => (
            <button
              type="button"
              className={`window-control ${control.className}`}
              title={control.title}
              aria-label={control.label}
              key={control.action}
              onClick={() => {
                if (control.action === "toggle-maximize") {
                  void toggleWindowMaximize();
                  return;
                }

                void runWindowAction(control.action);
              }}
            >
              <Icon name={control.icon} />
            </button>
          ))}
        </div>
      ) : null}
    </header>
  );
}
