import { useEffect, useState, type MouseEvent } from "react";
import { Icon, type IconName } from "../shared/Icon";
import { PortivaLogo } from "../shared/PortivaLogo";

type WindowAction = "close" | "drag" | "minimize" | "toggle-maximize";
type WindowControlPlatform = "linux" | "macos" | "windows";

interface AppTitlebarProps {
  httpConsoleActive: boolean;
  savedConnectionsOpen: boolean;
  settingsTabActive: boolean;
  onCreateProfile: () => void;
  onOpenHttpConsole: () => void;
  onOpenLocalShell: () => void;
  onOpenSerialTerminal: () => void;
  onOpenSavedConnections: () => void;
  onOpenSettings: () => void;
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

export function AppTitlebar({
  httpConsoleActive,
  savedConnectionsOpen,
  settingsTabActive,
  onCreateProfile,
  onOpenHttpConsole,
  onOpenLocalShell,
  onOpenSerialTerminal,
  onOpenSavedConnections,
  onOpenSettings,
}: AppTitlebarProps) {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    void readWindowMaximized().then(setIsMaximized);
  }, []);

  const toggleWindowMaximize = async () => {
    await runWindowAction("toggle-maximize");
    setIsMaximized(await readWindowMaximized());
  };

  const startTitlebarDrag = (event: MouseEvent<HTMLElement>) => {
    if (
      event.button !== 0 ||
      event.detail > 1 ||
      (event.target instanceof HTMLElement && event.target.closest("button"))
    ) {
      return;
    }

    void runWindowAction("drag");
  };
  const toggleTitlebarMaximize = (event: MouseEvent<HTMLElement>) => {
    if (event.target instanceof HTMLElement && event.target.closest("button")) {
      return;
    }

    void toggleWindowMaximize();
  };
  const windowControlPlatform = detectWindowControlPlatform();
  const maximizeIcon: IconName = isMaximized ? "restore" : "maximize";
  const maximizeLabel = isMaximized ? "还原" : "最大化";
  const windowControls =
    windowControlPlatform === "macos"
      ? [
          { action: "close" as const, className: "close", icon: "x" as const, label: "关闭", title: "关闭" },
          { action: "minimize" as const, className: "minimize", icon: "minus" as const, label: "最小化", title: "最小化" },
          { action: "toggle-maximize" as const, className: "maximize", icon: maximizeIcon, label: maximizeLabel, title: maximizeLabel },
        ]
      : [
          { action: "minimize" as const, className: "minimize", icon: "minus" as const, label: "最小化", title: "最小化" },
          { action: "toggle-maximize" as const, className: "maximize", icon: maximizeIcon, label: maximizeLabel, title: maximizeLabel },
          { action: "close" as const, className: "close", icon: "x" as const, label: "关闭", title: "关闭" },
        ];

  return (
    <header
      className={`app-titlebar window-controls-${windowControlPlatform}`}
      data-tauri-drag-region
      onDoubleClick={toggleTitlebarMaximize}
      onMouseDown={startTitlebarDrag}
    >
      <div className="app-titlebar-brand" data-tauri-drag-region>
        <PortivaLogo className="app-titlebar-logo" />
        <strong>Portiva</strong>
      </div>
      <div className="app-titlebar-drag-region" data-tauri-drag-region />
      <nav className="app-titlebar-actions" aria-label="主页工具栏">
        <button
          type="button"
          className={savedConnectionsOpen ? "active" : ""}
          title="已保存连接"
          aria-label="已保存连接"
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
          className={httpConsoleActive ? "active" : ""}
          title="HTTP/API 调试"
          aria-label="HTTP/API 调试"
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
      <div className={`window-controls ${windowControlPlatform}`} aria-label="窗口控制">
        {windowControls.map((control) => (
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
    </header>
  );
}
