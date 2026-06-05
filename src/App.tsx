import "./App.css";
import { type CSSProperties, type MouseEvent, useEffect, useMemo, useState } from "react";
import { useKeyboardShortcuts } from "./app/useKeyboardShortcuts";
import { usePortivaWorkspace } from "./app/usePortivaWorkspace";
import { ConnectionList } from "./features/connections/ConnectionList";
import {
  ConnectionProfileDialog,
  type ConnectionSecretInput,
} from "./features/connections/ConnectionProfileDialog";
import { FileTransferPanel } from "./features/file-transfer/FileTransferPanel";
import { SettingsPage } from "./features/settings/SettingsPage";
import { TerminalWorkspace } from "./features/terminal/TerminalWorkspace";
import { PortivaLogo } from "./shared/PortivaLogo";
import { Icon } from "./shared/Icon";
import { resolveTerminalPalette } from "./shared/terminalThemes";
import type { ConnectionCapabilities, ConnectionProfile, WorkspaceSessionTab } from "./shared/types";

const detachedReattachRequestEvent = "portiva://detached-reattach-request";
const detachedReattachCompleteEvent = "portiva://detached-reattach-complete";
const detachedReattachDragStartEvent = "portiva://detached-reattach-drag-start";
const detachedReattachDragEndEvent = "portiva://detached-reattach-drag-end";
const detachedWindowLabelPrefix = "portiva-tab-";
const legacyDetachedTerminalWindowLabelPrefix = "portiva-terminal-";
const mainWindowMinWidth = 560;
const mainWindowMinHeight = 640;
const detachedWindowMinWidth = 480;
const detachedWindowMinHeight = 480;
const settingsTabId = "portiva-settings";
const inactiveCapabilities: ConnectionCapabilities = {
  fileTransfer: false,
  localFileAccess: false,
  portForwarding: false,
  ptyResize: false,
  reconnect: false,
  requiresHostKeyVerification: false,
  scp: false,
  secureTransport: true,
  sftp: false,
  terminal: false,
  tunnel: false,
};
const settingsSessionTab: WorkspaceSessionTab = {
  id: settingsTabId,
  kind: "settings",
  connection: {
    capabilities: inactiveCapabilities,
    id: settingsTabId,
    profileId: settingsTabId,
    status: "ready",
    title: "设置",
  },
  terminal: null,
  terminalSnapshot: null,
};

type DetachedSessionTargetPayload = Omit<DetachedSessionReattachRequest, "sourceWindowLabel">;

interface DetachedSessionReattachRequest {
  connectionId: string;
  fileTransferSessionId?: string;
  kind?: "terminal" | "file-transfer";
  parentConnectionId?: string;
  remotePath?: string;
  sourceWindowLabel: string;
  tabId: string;
  terminalId?: string;
}

interface DetachedSessionReattachComplete {
  error?: string;
  ok: boolean;
  tabId: string;
}

interface DetachedSessionDragPayload {
  sourceWindowLabel: string;
  tabId: string;
}

interface HostTrustRequest {
  connectAfterTrust: boolean;
  input?: ConnectionSecretInput & { authenticate?: boolean };
  profile: ConnectionProfile;
  reconnectTabId?: string;
}

type WindowAction = "close" | "drag" | "minimize" | "toggle-maximize";

function isSessionWindowLabel(label: string) {
  return (
    label === "main" ||
    label.startsWith(detachedWindowLabelPrefix) ||
    label.startsWith(legacyDetachedTerminalWindowLabelPrefix)
  );
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

interface AppTitlebarProps {
  savedConnectionsOpen: boolean;
  settingsTabActive: boolean;
  onCreateProfile: () => void;
  onOpenLocalShell: () => void;
  onOpenSavedConnections: () => void;
  onOpenSettings: () => void;
}

function AppTitlebar({
  savedConnectionsOpen,
  settingsTabActive,
  onCreateProfile,
  onOpenLocalShell,
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

function App() {
  const workspace = usePortivaWorkspace();
  const [profileDialog, setProfileDialog] = useState<{
    mode: "create" | "edit";
    profile: ConnectionProfile;
  } | null>(null);
  const [hostTrustRequest, setHostTrustRequest] = useState<HostTrustRequest | null>(null);
  const [hostTrustBusy, setHostTrustBusy] = useState(false);
  const [reconnectTabId, setReconnectTabId] = useState<string | null>(null);
  const [settingsTabOpen, setSettingsTabOpen] = useState(false);
  const [activeShellTabId, setActiveShellTabId] = useState<string | null>(null);
  const [savedConnectionsOpen, setSavedConnectionsOpen] = useState(false);
  const detachedTarget = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const tabId = params.get("detachedSession");
    const fileTransferSessionId = params.get("fileTransferSessionId") ?? undefined;
    const kind: DetachedSessionReattachRequest["kind"] =
      params.get("tabKind") === "file-transfer" || fileTransferSessionId
        ? "file-transfer"
        : "terminal";

    if (!tabId) {
      return null;
    }

    return {
      connectionId: params.get("connectionId") ?? tabId,
      fileTransferSessionId,
      kind,
      parentConnectionId: params.get("parentConnectionId") ?? undefined,
      remotePath: params.get("remotePath") ?? undefined,
      tabId,
      terminalId: params.get("terminalId") ?? undefined,
    };
  }, []);
  const detachedSessionId = detachedTarget?.tabId ?? null;
  const [terminalFullscreen, setTerminalFullscreen] = useState(Boolean(detachedSessionId));
  const [detachedActivated, setDetachedActivated] = useState(false);
  const [detachedReattachHint, setDetachedReattachHint] = useState(false);
  const openCreateProfileDialog = () => {
    setProfileDialog({ mode: "create", profile: workspace.createProfileDraft("ssh") });
  };
  const terminalPalette = useMemo(
    () => resolveTerminalPalette(workspace.settings.theme),
    [workspace.settings.theme],
  );
  const themeStyle = useMemo(
    () =>
      ({
        "--terminal-font-family": workspace.settings.theme.terminalFontFamily,
        "--terminal-font-size": `${workspace.settings.theme.terminalFontSize}px`,
        "--terminal-bg": terminalPalette.background,
        "--terminal-fg": terminalPalette.foreground,
        "--terminal-cursor": terminalPalette.cursor,
        "--terminal-selection-bg": terminalPalette.selectionBackground,
      }) as CSSProperties,
    [
      terminalPalette,
      workspace.settings.theme.terminalFontFamily,
      workspace.settings.theme.terminalFontSize,
    ],
  );
  const shortcutHandlers = useMemo(
    () => ({
      onCloseTab: workspace.closeActiveConnection,
      onNewProfile: openCreateProfileDialog,
    }),
    [
      workspace.closeActiveConnection,
      openCreateProfileDialog,
    ],
  );

  useKeyboardShortcuts(workspace.settings, shortcutHandlers);

  useEffect(() => {
    const suppressNativeContextMenu = (event: Event) => {
      event.preventDefault();
    };

    window.addEventListener("contextmenu", suppressNativeContextMenu, { capture: true });
    return () => {
      window.removeEventListener("contextmenu", suppressNativeContextMenu, { capture: true });
    };
  }, []);

  useEffect(() => {
    if (workspace.dataSource !== "tauri") {
      return;
    }

    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().setSizeConstraints(
          detachedSessionId
            ? {
                minHeight: detachedWindowMinHeight,
                minWidth: detachedWindowMinWidth,
              }
            : {
                minHeight: mainWindowMinHeight,
                minWidth: mainWindowMinWidth,
              },
        );
      } catch {
        // Browser preview and mocked mode do not have native window constraints.
      }
    })();
  }, [detachedSessionId, workspace.dataSource]);

  useEffect(() => {
    if (
      !detachedTarget ||
      detachedActivated ||
      workspace.dataSource === "loading"
    ) {
      return;
    }

    void workspace.restoreDetachedSessionTab(detachedTarget).finally(() => {
      setTerminalFullscreen(true);
      setDetachedActivated(true);
    });
  }, [detachedActivated, detachedTarget, workspace.dataSource, workspace.restoreDetachedSessionTab]);

  useEffect(() => {
    if (workspace.dataSource !== "tauri") {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      try {
        const { emitTo, listen } = await import("@tauri-apps/api/event");
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const currentWindow = getCurrentWindow();
        const dispose = await listen<DetachedSessionReattachRequest>(
          detachedReattachRequestEvent,
          (event) => {
            const target = event.payload;

            if (target.sourceWindowLabel === currentWindow.label) {
              return;
            }

            setDetachedReattachHint(false);
            setActiveShellTabId(null);
            setSavedConnectionsOpen(false);
            void workspace.attachDetachedSessionTab(target)
              .then(async () => {
                try {
                  await currentWindow.show();
                  await currentWindow.setFocus();
                } catch {
                  // Reattaching the backend session is the important part; focus is best-effort.
                }

                await emitTo<DetachedSessionReattachComplete>(
                  target.sourceWindowLabel,
                  detachedReattachCompleteEvent,
                  {
                    ok: true,
                    tabId: target.tabId,
                  },
                );
              })
              .catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                workspace.reportWorkspaceMessage(`接回单独窗口失败：${message}`);
                void emitTo<DetachedSessionReattachComplete>(
                  target.sourceWindowLabel,
                  detachedReattachCompleteEvent,
                  {
                    error: message,
                    ok: false,
                    tabId: target.tabId,
                  },
                ).catch(() => undefined);
              });
          },
        );

        if (disposed) {
          dispose();
          return;
        }

        unlisten = dispose;
      } catch {
        // Browser preview and mocked mode do not have the Tauri event bridge.
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [
    workspace.attachDetachedSessionTab,
    workspace.dataSource,
    workspace.reportWorkspaceMessage,
  ]);

  useEffect(() => {
    if (workspace.dataSource !== "tauri") {
      return;
    }

    let disposed = false;
    let unlistenDragStart: (() => void) | null = null;
    let unlistenDragEnd: (() => void) | null = null;

    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const currentWindowLabel = getCurrentWindow().label;
        const [disposeDragStart, disposeDragEnd] = await Promise.all([
          listen<DetachedSessionDragPayload>(detachedReattachDragStartEvent, (event) => {
            if (event.payload.sourceWindowLabel !== currentWindowLabel) {
              setDetachedReattachHint(true);
            }
          }),
          listen<DetachedSessionDragPayload>(detachedReattachDragEndEvent, (event) => {
            if (event.payload.sourceWindowLabel !== currentWindowLabel) {
              setDetachedReattachHint(false);
            }
          }),
        ]);

        if (disposed) {
          disposeDragStart();
          disposeDragEnd();
          return;
        }

        unlistenDragStart = disposeDragStart;
        unlistenDragEnd = disposeDragEnd;
      } catch {
        // Browser preview and mocked mode do not have the Tauri event bridge.
      }
    })();

    return () => {
      disposed = true;
      unlistenDragStart?.();
      unlistenDragEnd?.();
    };
  }, [workspace.dataSource]);

  const createDetachedSessionTarget = (tabId: string): DetachedSessionTargetPayload | null => {
    const tab = workspace.sessionTabs.find((item) => (item.id ?? item.connection.id) === tabId);
    const tabKind = tab?.kind ?? "terminal";
    const terminal = tab?.terminal;
    const fileTransferSession = tab?.fileTransferSession;

    if (!tab) {
      return null;
    }

    if (tabKind === "settings") {
      workspace.reportWorkspaceMessage("设置标签不支持单独窗口。");
      return null;
    }

    if (tabKind === "terminal" && !terminal) {
      workspace.reportWorkspaceMessage("当前标签还没有可分离的终端会话。");
      return null;
    }

    if (tabKind === "file-transfer" && !fileTransferSession) {
      workspace.reportWorkspaceMessage("当前文件管理标签还没有可分离的 SFTP 会话。");
      return null;
    }

    const backendConnectionId =
      tabKind === "file-transfer"
        ? tab.parentConnectionId ?? fileTransferSession?.connectionId ?? tab.connection.id
        : tab.connection.id;
    const params = new URLSearchParams({
      connectionId: backendConnectionId,
      detachedSession: tabId,
      tabKind,
    });
    if (terminal) {
      params.set("terminalId", terminal.id);
    }
    if (fileTransferSession) {
      params.set("fileTransferSessionId", fileTransferSession.id);
    }
    if (tab.parentConnectionId) {
      params.set("parentConnectionId", tab.parentConnectionId);
    }
    if (tabKind === "file-transfer") {
      params.set("remotePath", workspace.activeSessionTabId === tabId ? workspace.remotePath : "/");
    }

    return {
      connectionId: params.get("connectionId") ?? backendConnectionId,
      fileTransferSessionId: params.get("fileTransferSessionId") ?? undefined,
      kind: tabKind,
      parentConnectionId: params.get("parentConnectionId") ?? undefined,
      remotePath: params.get("remotePath") ?? undefined,
      tabId,
      terminalId: params.get("terminalId") ?? undefined,
    };
  };

  const createDetachedSessionUrl = (target: DetachedSessionTargetPayload) => {
    const params = new URLSearchParams({
      connectionId: target.connectionId,
      detachedSession: target.tabId,
      tabKind: target.kind ?? "terminal",
    });

    if (target.terminalId) {
      params.set("terminalId", target.terminalId);
    }
    if (target.fileTransferSessionId) {
      params.set("fileTransferSessionId", target.fileTransferSessionId);
    }
    if (target.parentConnectionId) {
      params.set("parentConnectionId", target.parentConnectionId);
    }
    if (target.remotePath) {
      params.set("remotePath", target.remotePath);
    }

    return `${window.location.pathname}?${params.toString()}`;
  };

  const resolveMergeTargetWindowLabel = async (sourceWindowLabel: string) => {
    try {
      const { cursorPosition, getAllWindows } = await import("@tauri-apps/api/window");
      const position = await cursorPosition();
      const windows = await getAllWindows();
      const candidates = await Promise.all(
        windows
          .filter((window) => window.label !== sourceWindowLabel && isSessionWindowLabel(window.label))
          .map(async (window) => {
            const [windowPosition, windowSize] = await Promise.all([
              window.outerPosition(),
              window.outerSize(),
            ]);

            return {
              label: window.label,
              position: windowPosition,
              size: windowSize,
            };
          }),
      );
      const target = candidates.find(
        (window) =>
          position.x >= window.position.x &&
          position.x <= window.position.x + window.size.width &&
          position.y >= window.position.y &&
          position.y <= window.position.y + window.size.height,
      );

      if (target) {
        return target.label;
      }
    } catch {
      // Fall back to the main window when pointer-based target detection is unavailable.
    }

    return sourceWindowLabel === "main" ? null : "main";
  };

  const openSessionWindow = (tabId: string) => {
    const tab = workspace.sessionTabs.find((item) => (item.id ?? item.connection.id) === tabId);
    const target = createDetachedSessionTarget(tabId);

    if (!tab || !target) {
      return;
    }

    const url = createDetachedSessionUrl(target);
    const detachFromCurrentWindow = () => workspace.detachSessionTab(tabId);
    const reportOpenFailure = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      workspace.reportWorkspaceMessage(`单独窗口打开失败：${message}`);
      console.warn("单独窗口打开失败", error);
    };

    void (async () => {
      try {
        const [{ WebviewWindow }, { getCurrentWindow }] = await Promise.all([
          import("@tauri-apps/api/webviewWindow"),
          import("@tauri-apps/api/window"),
        ]);
        const currentWindow = getCurrentWindow();
        const detachedLabelId = (target.terminalId ?? target.fileTransferSessionId ?? tabId)
          .replace(/[^a-zA-Z0-9_-]/g, "-");
        const label = `${detachedWindowLabelPrefix}${detachedLabelId}`;
        const existingWindow = await WebviewWindow.getByLabel(label);

        if (existingWindow) {
          if (existingWindow.label === currentWindow.label) {
            return;
          }

          await existingWindow.setSizeConstraints({
            minHeight: detachedWindowMinHeight,
            minWidth: detachedWindowMinWidth,
          });
          await existingWindow.show();
          await existingWindow.setFocus();
          detachFromCurrentWindow();
          if (detachedSessionId && workspace.sessionTabs.length <= 1) {
            await currentWindow.destroy();
          }
          return;
        }

        const webview = new WebviewWindow(label, {
          decorations: true,
          height: 760,
          minHeight: detachedWindowMinHeight,
          minWidth: detachedWindowMinWidth,
          resizable: true,
          title: tab.connection.title,
          url,
          width: 1120,
        });

        await new Promise<void>((resolve, reject) => {
          void webview.once("tauri://created", () => resolve());
          void webview.once("tauri://error", (event) => reject(event.payload));
        });
        detachFromCurrentWindow();
        if (detachedSessionId && workspace.sessionTabs.length <= 1) {
          await currentWindow.destroy();
        }
      } catch (error) {
        reportOpenFailure(error);
      }
    })();
  };

  const moveDetachedSessionToWindow = (tabId: string) => {
    if (!detachedSessionId) {
      return;
    }

    const target = createDetachedSessionTarget(tabId);

    if (!target) {
      return;
    }

    void (async () => {
      let timeoutId: number | null = null;
      let unlisten: (() => void) | null = null;

      const cleanup = () => {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
          timeoutId = null;
        }

        unlisten?.();
        unlisten = null;
      };

      try {
        const [{ emitTo, listen }, { getCurrentWindow }] = await Promise.all([
          import("@tauri-apps/api/event"),
          import("@tauri-apps/api/window"),
        ]);
        const currentWindow = getCurrentWindow();
        const targetWindowLabel = await resolveMergeTargetWindowLabel(currentWindow.label);

        if (!targetWindowLabel || targetWindowLabel === currentWindow.label) {
          return;
        }

        let resolveCompletion: () => void = () => undefined;
        let rejectCompletion: (error: Error) => void = () => undefined;
        const completion = new Promise<void>((resolve, reject) => {
          resolveCompletion = resolve;
          rejectCompletion = reject;
        });
        timeoutId = window.setTimeout(() => {
          rejectCompletion(new Error("主窗口未确认接回请求"));
        }, 5000);
        unlisten = await listen<DetachedSessionReattachComplete>(
          detachedReattachCompleteEvent,
          (event) => {
            const result = event.payload;

            if (result.tabId !== tabId) {
              return;
            }

            cleanup();

            if (result.ok) {
              resolveCompletion();
              return;
            }

            rejectCompletion(new Error(result.error ?? "主窗口接回失败"));
          },
        );

        await emitTo<DetachedSessionReattachRequest>(targetWindowLabel, detachedReattachRequestEvent, {
          ...target,
          remotePath:
            workspace.activeSessionTabKind === "file-transfer"
              ? workspace.remotePath
              : target.remotePath,
          sourceWindowLabel: currentWindow.label,
        });
        await completion;
        workspace.detachSessionTab(tabId);

        if (workspace.sessionTabs.length <= 1) {
          await currentWindow.destroy();
        }
      } catch (error) {
        cleanup();
        const message = error instanceof Error ? error.message : String(error);
        workspace.reportWorkspaceMessage(`合并单独窗口失败：${message}`);
      }
    })();
  };

  const notifyDetachedDragState = (isDragging: boolean, tabId: string) => {
    if (!detachedSessionId) {
      return;
    }

    void (async () => {
      try {
        const [{ emit }, { getCurrentWindow }] = await Promise.all([
          import("@tauri-apps/api/event"),
          import("@tauri-apps/api/window"),
        ]);
        await emit<DetachedSessionDragPayload>(
          isDragging ? detachedReattachDragStartEvent : detachedReattachDragEndEvent,
          {
            sourceWindowLabel: getCurrentWindow().label,
            tabId,
          },
        );
      } catch {
        // The drag hint is visual-only and should never block dragging.
      }
    })();
  };

  const registerHostTrustRequest = (
    result: { status?: string; requiresFingerprintConfirmation?: boolean },
    request: HostTrustRequest,
  ) => {
    if (result.status === "needs-trust" || result.requiresFingerprintConfirmation) {
      setHostTrustRequest(request);
      return true;
    }

    return false;
  };

  const cancelHostTrust = () => {
    setHostTrustRequest(null);
    setHostTrustBusy(false);
    workspace.clearPendingKnownHost();
  };

  const confirmHostTrust = async () => {
    if (!hostTrustRequest || !workspace.pendingKnownHost || hostTrustBusy) {
      return;
    }

    setHostTrustBusy(true);
    const request = hostTrustRequest;
    const trusted = await workspace.trustProfileHost(request.profile);

    if (!trusted) {
      setHostTrustBusy(false);
      return;
    }

    setHostTrustRequest(null);

    if (request.connectAfterTrust) {
      const result = request.reconnectTabId
        ? await workspace.reconnectSessionTab(
            request.reconnectTabId,
            request.input,
            request.profile,
          )
        : await workspace.openProfileConnection(request.profile, request.input);

      if (result.status === "opened") {
        setActiveShellTabId(null);
        setProfileDialog(null);
        setReconnectTabId(null);
      } else if (result.status === "needs-trust") {
        setHostTrustRequest(request);
      }
    }

    setHostTrustBusy(false);
  };

  const reconnectSessionTab = (tabId: string) => {
    const tab = workspace.sessionTabs.find((item) => (item.id ?? item.connection.id) === tabId);
    const profile = tab
      ? workspace.profiles.find((item) => item.id === tab.connection.profileId)
      : null;

    if (
      profile &&
      (profile.type === "ssh" || profile.type === "sftp") &&
      profile.authType === "password" &&
      !workspace.secrets.some(
        (secret) =>
          secret.profileId === profile.id &&
          secret.purpose === "password" &&
          secret.hasValue,
      )
    ) {
      setReconnectTabId(tabId);
      setProfileDialog({ mode: "edit", profile });
      return;
    }

    void (async () => {
      const result = await workspace.reconnectSessionTab(tabId);
      if (profile) {
        registerHostTrustRequest(result, {
          connectAfterTrust: true,
          profile,
          reconnectTabId: tabId,
        });
      }
    })();
  };

  const openSavedConnection = (profile: ConnectionProfile) => {
    if (
      (profile.type === "ssh" || profile.type === "sftp") &&
      profile.authType === "password" &&
      !workspace.secrets.some(
        (secret) =>
          secret.profileId === profile.id &&
          secret.purpose === "password" &&
          secret.hasValue,
      )
    ) {
      setProfileDialog({ mode: "edit", profile });
      return;
    }

    const input = {
      authenticate: profile.type === "ssh" || profile.type === "sftp",
    };

    void (async () => {
      const result = await workspace.openProfileConnection(profile, input);
      registerHostTrustRequest(result, {
        connectAfterTrust: true,
        input,
        profile,
      });
    })();
  };
  const connectSavedConnection = (profile: ConnectionProfile) => {
    setSavedConnectionsOpen(false);
    setActiveShellTabId(null);
    openSavedConnection(profile);
  };
  const editSavedConnection = (profile: ConnectionProfile) => {
    setSavedConnectionsOpen(false);
    setProfileDialog({ mode: "edit", profile });
  };
  const closeSettingsTab = () => {
    setSettingsTabOpen(false);
    setActiveShellTabId((current) => (current === settingsTabId ? null : current));
  };
  const openSettingsTab = () => {
    setSavedConnectionsOpen(false);
    setSettingsTabOpen(true);
    setActiveShellTabId(settingsTabId);
  };
  const appSessionTabs = settingsTabOpen
    ? [...workspace.sessionTabs, settingsSessionTab]
    : workspace.sessionTabs;
  const activeAppTabId =
    settingsTabOpen && (activeShellTabId === settingsTabId || !workspace.activeSessionTabId)
      ? settingsTabId
      : workspace.activeSessionTabId || undefined;
  const settingsTabActive = activeAppTabId === settingsTabId;
  const selectAppSessionTab = (tabId: string) => {
    if (tabId === settingsTabId) {
      setSettingsTabOpen(true);
      setActiveShellTabId(settingsTabId);
      return;
    }

    setActiveShellTabId(null);
    workspace.switchSessionTab(tabId);
  };
  const closeAppSessionTab = (tabId: string) => {
    if (tabId === settingsTabId) {
      closeSettingsTab();
      return;
    }

    void workspace.closeConnection(tabId);
  };
  const openAppSessionWindow = (tabId: string) => {
    if (tabId === settingsTabId) {
      return;
    }

    openSessionWindow(tabId);
  };
  const reconnectAppSessionTab = (tabId: string) => {
    if (tabId === settingsTabId) {
      return;
    }

    reconnectSessionTab(tabId);
  };
  const reorderAppSessionTabs = (sourceTabId: string, targetTabId: string) => {
    if (sourceTabId === settingsTabId || targetTabId === settingsTabId) {
      return;
    }

    workspace.reorderSessionTabs(sourceTabId, targetTabId);
  };
  const fileTransferPanel =
    workspace.activeSessionTabKind === "file-transfer" ? (
      <FileTransferPanel
        capabilities={workspace.capabilities}
        sftpConnectionOptions={workspace.sftpConnectionOptions}
        localEntries={workspace.localEntries}
        localPath={workspace.localPath}
        remoteEntries={workspace.remoteEntries}
        remotePath={workspace.remotePath}
        selectedLocalEntry={workspace.selectedLocalEntry}
        selectedRemoteEntry={workspace.selectedRemoteEntry}
        transfers={workspace.transfers}
        onCancelTransfer={(transferId) => workspace.updateTransferTask(transferId, "cancel")}
        onDeleteTransfer={(transferId) => workspace.updateTransferTask(transferId, "delete")}
        onOpenConnectionFileTransfer={workspace.openFileTransferTab}
        onCreateLocalDirectory={workspace.createLocalDirectory}
        onCreateRemoteDirectory={workspace.createRemoteDirectory}
        onDownloadEntry={workspace.downloadRemoteEntry}
        onDownloadSelected={workspace.downloadSelectedRemoteEntry}
        onRefreshLocal={workspace.refreshLocalFiles}
        onRefreshRemote={workspace.refreshRemoteFiles}
        onRemoveLocal={workspace.removeLocalEntry}
        onRemoveRemote={workspace.removeRemoteEntry}
        onPauseTransfer={(transferId) => workspace.updateTransferTask(transferId, "pause")}
        onRenameLocal={workspace.renameLocalEntry}
        onRenameRemote={workspace.renameRemoteEntry}
        onResumeTransfer={(transferId) => workspace.updateTransferTask(transferId, "resume")}
        onRetryTransfer={(transferId) => workspace.updateTransferTask(transferId, "retry")}
        onSelectLocalEntry={workspace.setSelectedLocalEntry}
        onSelectRemoteEntry={workspace.setSelectedRemoteEntry}
        onUploadEntry={workspace.uploadLocalEntry}
        onUploadSelected={workspace.uploadSelectedLocalEntry}
        onUploadLocalPaths={workspace.uploadLocalPaths}
      />
    ) : null;
  const pendingHostTrust =
    hostTrustRequest &&
    workspace.pendingKnownHost &&
    (hostTrustRequest.profile.type === "ssh" || hostTrustRequest.profile.type === "sftp") &&
    hostTrustRequest.profile.host === workspace.pendingKnownHost.host
      ? workspace.pendingKnownHost
      : null;
  const activeHostTrustRequest = pendingHostTrust ? hostTrustRequest : null;
  const globalHostTrustDialog = pendingHostTrust && activeHostTrustRequest ? (
    <HostTrustDialog
      busy={hostTrustBusy}
      connectAfterTrust={activeHostTrustRequest.connectAfterTrust}
      fingerprint={pendingHostTrust.fingerprint}
      host={pendingHostTrust.host}
      onCancel={cancelHostTrust}
      onConfirm={() => void confirmHostTrust()}
    />
  ) : null;

  useEffect(() => {
    if (!pendingHostTrust) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !hostTrustBusy) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        cancelHostTrust();
      }
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [hostTrustBusy, pendingHostTrust]);

  if (detachedSessionId) {
    return (
      <main className="app-shell detached-shell" data-theme={workspace.settings.theme.mode} style={themeStyle}>
        <TerminalWorkspace
          activeTabId={workspace.activeSessionTabId}
          connection={workspace.activeConnection}
          capabilities={workspace.capabilities}
          emptyStateNotice={workspace.workspaceMessage}
          fileTransferPanel={fileTransferPanel}
          isFullscreen={terminalFullscreen}
          reattachHintActive={detachedReattachHint}
          profiles={workspace.profiles}
          sessionTabs={workspace.sessionTabs}
          terminalConfirmMultilinePaste={workspace.settings.terminal.confirmMultilinePaste}
          terminalCopyRichText={workspace.settings.terminal.copyRichText}
          terminalRightClickBehavior={workspace.settings.terminal.rightClickBehavior}
          terminalTheme={terminalPalette}
          onCloseSessionTab={workspace.closeConnection}
          onDetachSessionTab={moveDetachedSessionToWindow}
          onSessionDragStateChange={notifyDetachedDragState}
          onOpenSessionWindow={openSessionWindow}
          onReconnectSessionTab={reconnectSessionTab}
          onReorderSessionTabs={workspace.reorderSessionTabs}
          onSendTerminalData={workspace.sendTerminalData}
          onResizeTerminal={workspace.resizeActiveTerminal}
          onSelectSessionTab={workspace.switchSessionTab}
          onToggleFullscreen={() => setTerminalFullscreen((current) => !current)}
        />
        {globalHostTrustDialog}
      </main>
    );
  }

  return (
    <main className="app-shell" data-theme={workspace.settings.theme.mode} style={themeStyle}>
      <AppTitlebar
        savedConnectionsOpen={savedConnectionsOpen}
        settingsTabActive={settingsTabActive}
        onCreateProfile={openCreateProfileDialog}
        onOpenLocalShell={() => {
          setSavedConnectionsOpen(false);
          setActiveShellTabId(null);
          void workspace.openLocalShellTab();
        }}
        onOpenSavedConnections={() => setSavedConnectionsOpen(true)}
        onOpenSettings={openSettingsTab}
      />
      <section className="workspace">
        {savedConnectionsOpen ? (
          <ConnectionList
            activeProfileId={workspace.activeProfileId}
            profiles={workspace.profiles}
            onClose={() => setSavedConnectionsOpen(false)}
            onConnectProfile={connectSavedConnection}
            onCreateProfile={() => {
              setSavedConnectionsOpen(false);
              openCreateProfileDialog();
            }}
            onDeleteProfile={workspace.deleteProfile}
            onEditProfile={editSavedConnection}
            onSelectProfile={workspace.setActiveProfileId}
          />
        ) : null}

        <div className="content-grid without-file-manager">
          <TerminalWorkspace
            activeTabId={activeAppTabId}
            capabilities={settingsTabActive ? inactiveCapabilities : workspace.capabilities}
            connection={settingsTabActive ? null : workspace.activeConnection}
            customTabPanels={{
              [settingsTabId]: (
                <SettingsPage
                  capabilities={workspace.capabilities}
                  connection={workspace.activeConnection}
                  groups={workspace.groups}
                  knownHosts={workspace.knownHosts}
                  logs={workspace.logs}
                  message={workspace.workspaceMessage}
                  protocolDescriptors={workspace.protocolDescriptors}
                  recentConnections={workspace.recentConnections}
                  redactionInput={workspace.redactionInput}
                  redactionPreview={workspace.redactionPreview}
                  secrets={workspace.secrets}
                  settings={workspace.settings}
                  tunnels={workspace.tunnels}
                  onClearLogs={workspace.clearLogs}
                  onDeleteKnownHost={workspace.deleteKnownHost}
                  onDeleteSecretMetadata={workspace.deleteSecretMetadata}
                  onPreviewRedaction={workspace.previewRedaction}
                  onRedactionInputChange={workspace.setRedactionInput}
                  onSaveSettings={workspace.saveSettings}
                />
              ),
            }}
            emptyStateNotice={workspace.sessionNotice}
            fileTransferPanel={fileTransferPanel}
            isFullscreen={terminalFullscreen}
            reattachHintActive={detachedReattachHint}
            profiles={workspace.profiles}
            sessionTabs={appSessionTabs}
            terminalConfirmMultilinePaste={workspace.settings.terminal.confirmMultilinePaste}
            terminalCopyRichText={workspace.settings.terminal.copyRichText}
            terminalRightClickBehavior={workspace.settings.terminal.rightClickBehavior}
            terminalTheme={terminalPalette}
            onCloseSessionTab={closeAppSessionTab}
            onDetachSessionTab={openAppSessionWindow}
            onOpenSessionWindow={openAppSessionWindow}
            onReconnectSessionTab={reconnectAppSessionTab}
            onReorderSessionTabs={reorderAppSessionTabs}
            onSendTerminalData={workspace.sendTerminalData}
            onResizeTerminal={workspace.resizeActiveTerminal}
            onSelectSessionTab={selectAppSessionTab}
            onToggleFullscreen={() => setTerminalFullscreen((current) => !current)}
          />
        </div>
      </section>
      {profileDialog ? (
        <ConnectionProfileDialog
          mode={profileDialog.mode}
          profile={profileDialog.profile}
          rememberedSecret={workspace.secrets.some(
            (secret) =>
              secret.profileId === profileDialog.profile.id &&
              secret.purpose === "password" &&
              secret.hasValue,
          )}
          serialPorts={workspace.serialPorts}
          onCreateDraft={workspace.createProfileDraft}
          onClose={() => {
            setProfileDialog(null);
            setReconnectTabId(null);
          }}
          onConnect={async (profile, input) => {
              const saved = await workspace.saveProfile(profile);

              if (!saved) {
                return {
                  ok: false,
                  message: "保存配置失败，未发起连接。",
                };
              }

              const connectOptions = {
                authenticate: profile.type === "ssh" || profile.type === "sftp",
                rememberSecret: input?.rememberSecret,
                secret: input?.secret,
              };
              const result = reconnectTabId
                ? await workspace.reconnectSessionTab(reconnectTabId, connectOptions, saved)
                : await workspace.openProfileConnection(saved, connectOptions);
              registerHostTrustRequest(result, {
                connectAfterTrust: true,
                input: connectOptions,
                profile: saved,
                reconnectTabId: reconnectTabId ?? undefined,
              });
              if (result.status === "opened") {
                setActiveShellTabId(null);
                setProfileDialog(null);
                setReconnectTabId(null);
              }
              return {
                ok: result.status === "opened",
                needsTrust: result.status === "needs-trust",
                message: result.message,
              };
          }}
          onDelete={(profileId) => {
            void workspace.deleteProfile(profileId);
            setProfileDialog(null);
            setReconnectTabId(null);
          }}
          onRefreshSerialPorts={workspace.refreshWorkspace}
          onSave={async (profile, input) => {
            const saved = await workspace.saveProfile(profile, input);
            if (!saved) {
              return {
                ok: false,
                message: "保存配置失败。",
              };
            }

            setReconnectTabId(null);
            setProfileDialog({ mode: "edit", profile: saved });
            return {
              ok: true,
              message: "已保存配置。",
            };
          }}
          onTest={async (profile, input) => {
            const result = await workspace.testProfile(profile, input);
            registerHostTrustRequest(result, {
              connectAfterTrust: false,
              input,
              profile,
            });
            return result;
          }}
        />
      ) : null}
      {globalHostTrustDialog}
    </main>
  );
}

function HostTrustDialog({
  busy,
  connectAfterTrust,
  fingerprint,
  host,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  connectAfterTrust: boolean;
  fingerprint: string;
  host: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="host-trust-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        event.stopPropagation();
        if (!busy) {
          onCancel();
        }
      }}
    >
      <section
        aria-label="确认信任主机"
        aria-modal="true"
        className="host-trust-dialog"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="host-trust-heading">
          <strong>确认信任 SSH 主机</strong>
          <button
            aria-label="关闭确认弹窗"
            disabled={busy}
            onClick={onCancel}
            title="关闭确认弹窗"
            type="button"
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="host-trust-content">
          <p>请核对该主机指纹。确认后会写入 known_hosts，之后同一主机将自动校验。</p>
          <dl>
            <div>
              <dt>主机</dt>
              <dd>{host}</dd>
            </div>
            <div>
              <dt>指纹</dt>
              <dd>{fingerprint}</dd>
            </div>
          </dl>
        </div>
        <div className="host-trust-actions">
          <button disabled={busy} onClick={onCancel} type="button">
            取消
          </button>
          <button className="primary-action" disabled={busy} onClick={onConfirm} type="button">
            {busy ? "处理中..." : connectAfterTrust ? "信任并连接" : "信任"}
          </button>
        </div>
      </section>
    </div>
  );
}

export default App;
