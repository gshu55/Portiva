import type { MouseEvent } from "react";
import { Icon } from "../shared/Icon";
import { PortivaLogo } from "../shared/PortivaLogo";

type WindowAction = "close" | "drag" | "minimize" | "toggle-maximize";

interface AppTitlebarProps {
  savedConnectionsOpen: boolean;
  settingsTabActive: boolean;
  onCreateProfile: () => void;
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

export function AppTitlebar({
  savedConnectionsOpen,
  settingsTabActive,
  onCreateProfile,
  onOpenLocalShell,
  onOpenSerialTerminal,
  onOpenSavedConnections,
  onOpenSettings,
}: AppTitlebarProps) {
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

    void runWindowAction("toggle-maximize");
  };

  return (
    <header
      className="app-titlebar"
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
          className={settingsTabActive ? "active" : ""}
          title="设置"
          aria-label="设置"
          onClick={onOpenSettings}
        >
          <Icon name="settings" />
        </button>
      </nav>
      <div className="window-controls" aria-label="窗口控制">
        <button
          type="button"
          className="window-control"
          title="最小化"
          aria-label="最小化"
          onClick={() => void runWindowAction("minimize")}
        >
          <Icon name="minus" />
        </button>
        <button
          type="button"
          className="window-control"
          title="最大化"
          aria-label="最大化"
          onClick={() => void runWindowAction("toggle-maximize")}
        >
          <Icon name="maximize" />
        </button>
        <button
          type="button"
          className="window-control close"
          title="关闭"
          aria-label="关闭"
          onClick={() => void runWindowAction("close")}
        >
          <Icon name="x" />
        </button>
      </div>
    </header>
  );
}
