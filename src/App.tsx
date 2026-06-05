import "./App.css";
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { ActiveFileTransferPanel } from "./app/ActiveFileTransferPanel";
import { AppTitlebar } from "./app/AppTitlebar";
import { GlobalNotice } from "./app/GlobalNotice";
import { HostTrustDialog } from "./app/HostTrustDialog";
import { ProfileDialogHost } from "./app/ProfileDialogHost";
import { SettingsTabPanel } from "./app/SettingsTabPanel";
import { useKeyboardShortcuts } from "./app/useKeyboardShortcuts";
import { usePortivaWorkspace } from "./app/usePortivaWorkspace";
import { ConnectionList } from "./features/connections/ConnectionList";
import { SimpleSftpPanel } from "./features/file-transfer/SimpleSftpPanel";
import type { ConnectionSecretInput } from "./features/connections/ConnectionProfileDialog";
import { HttpConsolePanel } from "./features/http/HttpConsolePanel";
import { TerminalWorkspace } from "./features/terminal/TerminalWorkspace";
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
const httpConsoleTabId = "portiva-http-console";
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
const httpConsoleSessionTab: WorkspaceSessionTab = {
  id: httpConsoleTabId,
  kind: "http-console",
  connection: {
    capabilities: inactiveCapabilities,
    id: httpConsoleTabId,
    profileId: httpConsoleTabId,
    status: "ready",
    title: "HTTP Console",
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

function isSessionWindowLabel(label: string) {
  return (
    label === "main" ||
    label.startsWith(detachedWindowLabelPrefix) ||
    label.startsWith(legacyDetachedTerminalWindowLabelPrefix)
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
  const [httpConsoleOpen, setHttpConsoleOpen] = useState(false);
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
  const openCreateProfileDialog = useCallback(() => {
    setProfileDialog({ mode: "create", profile: workspace.createProfileDraft("ssh") });
  }, [workspace]);
  const openLocalTerminalTab = useCallback(() => {
    setSavedConnectionsOpen(false);
    setActiveShellTabId(null);
    void workspace.openLocalShellTab();
  }, [workspace]);
  const openSerialTerminalTab = useCallback(() => {
    setSavedConnectionsOpen(false);
    setActiveShellTabId(null);
    void workspace.openSerialTerminalTab();
  }, [workspace]);
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
      onOpenLocalTerminal: openLocalTerminalTab,
      onOpenSerialTerminal: openSerialTerminalTab,
    }),
    [
      workspace.closeActiveConnection,
      openCreateProfileDialog,
      openLocalTerminalTab,
      openSerialTerminalTab,
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

    if (tabKind !== "terminal" && tabKind !== "file-transfer") {
      workspace.reportWorkspaceMessage("当前工具标签不支持单独窗口。");
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
  const closeHttpConsoleTab = () => {
    setHttpConsoleOpen(false);
    setActiveShellTabId((current) => (current === httpConsoleTabId ? null : current));
  };
  const openSettingsTab = () => {
    setSavedConnectionsOpen(false);
    setSettingsTabOpen(true);
    setActiveShellTabId(settingsTabId);
  };
  const openHttpConsoleTab = () => {
    setSavedConnectionsOpen(false);
    setHttpConsoleOpen(true);
    setActiveShellTabId(httpConsoleTabId);
  };
  const appSessionTabs = [
    ...workspace.sessionTabs,
    ...(httpConsoleOpen ? [httpConsoleSessionTab] : []),
    ...(settingsTabOpen ? [settingsSessionTab] : []),
  ];
  const activeToolTabId =
    activeShellTabId === settingsTabId && settingsTabOpen
      ? settingsTabId
      : activeShellTabId === httpConsoleTabId && httpConsoleOpen
        ? httpConsoleTabId
        : null;
  const fallbackAppTabId = !workspace.activeSessionTabId
    ? httpConsoleOpen
      ? httpConsoleTabId
      : settingsTabOpen
        ? settingsTabId
        : undefined
    : workspace.activeSessionTabId;
  const activeAppTabId = activeToolTabId ?? fallbackAppTabId;
  const settingsTabActive = activeAppTabId === settingsTabId;
  const httpConsoleActive = activeAppTabId === httpConsoleTabId;
  const selectAppSessionTab = (tabId: string) => {
    if (tabId === settingsTabId) {
      setSettingsTabOpen(true);
      setActiveShellTabId(settingsTabId);
      return;
    }
    if (tabId === httpConsoleTabId) {
      setHttpConsoleOpen(true);
      setActiveShellTabId(httpConsoleTabId);
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
    if (tabId === httpConsoleTabId) {
      closeHttpConsoleTab();
      return;
    }

    void workspace.closeConnection(tabId);
  };
  const openAppSessionWindow = (tabId: string) => {
    if (tabId === settingsTabId || tabId === httpConsoleTabId) {
      return;
    }

    openSessionWindow(tabId);
  };
  const reconnectAppSessionTab = (tabId: string) => {
    if (tabId === settingsTabId || tabId === httpConsoleTabId) {
      return;
    }

    reconnectSessionTab(tabId);
  };
  const reorderAppSessionTabs = (sourceTabId: string, targetTabId: string) => {
    if (
      sourceTabId === settingsTabId ||
      targetTabId === settingsTabId ||
      sourceTabId === httpConsoleTabId ||
      targetTabId === httpConsoleTabId
    ) {
      return;
    }

    workspace.reorderSessionTabs(sourceTabId, targetTabId);
  };
  const fileTransferPanel = <ActiveFileTransferPanel workspace={workspace} />;
  const shouldShowInlineSftpPanel = Boolean(
    workspace.activeSessionTabKind === "terminal" &&
      workspace.activeConnection?.capabilities.fileTransfer &&
      workspace.activeConnection.transport?.kind === "ssh" &&
      workspace.activeConnection.transport.authenticated,
  );
  const renderInlineSftpPanel = shouldShowInlineSftpPanel
    ? ({
        layoutSide,
        onToggleLayoutSide,
      }: {
        layoutSide: "left" | "right";
        onToggleLayoutSide: () => void;
      }) => (
        <SimpleSftpPanel
          layoutSide={layoutSide}
          workspace={workspace}
          onToggleLayoutSide={onToggleLayoutSide}
        />
      )
    : undefined;
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
          sftpSidePanel={renderInlineSftpPanel}
          isFullscreen={terminalFullscreen}
          reattachHintActive={detachedReattachHint}
          profiles={workspace.profiles}
          serialPorts={workspace.serialPorts}
          sessionTabs={workspace.sessionTabs}
          terminalConfirmMultilinePaste={workspace.settings.terminal.confirmMultilinePaste}
          terminalCopyRichText={workspace.settings.terminal.copyRichText}
          terminalRightClickBehavior={workspace.settings.terminal.rightClickBehavior}
          terminalTheme={terminalPalette}
          onCloseSessionTab={workspace.closeConnection}
          onCloseSerialTerminal={workspace.closeSerialTerminal}
          onDetachSessionTab={moveDetachedSessionToWindow}
          onSessionDragStateChange={notifyDetachedDragState}
          onOpenFileTransferTab={workspace.openFileTransferTab}
          onOpenSessionWindow={openSessionWindow}
	          onOpenSerialTerminal={workspace.openSerialTerminal}
	          onReconfigureSerialTerminal={workspace.reconfigureSerialTerminal}
	          onReconnectSessionTab={reconnectSessionTab}
	          onRefreshSerialPorts={workspace.refreshSerialPorts}
          onReorderSessionTabs={workspace.reorderSessionTabs}
          onSendTerminalBytes={workspace.sendTerminalBytes}
          onSendTerminalData={workspace.sendTerminalData}
          onResizeTerminal={workspace.resizeActiveTerminal}
          onSelectSessionTab={workspace.switchSessionTab}
          onToggleFullscreen={() => setTerminalFullscreen((current) => !current)}
	        />
	        <GlobalNotice message={workspace.workspaceMessage} />
	        {globalHostTrustDialog}
	      </main>
    );
  }

  return (
    <main className="app-shell" data-theme={workspace.settings.theme.mode} style={themeStyle}>
      <AppTitlebar
        httpConsoleActive={httpConsoleActive}
        savedConnectionsOpen={savedConnectionsOpen}
        settingsTabActive={settingsTabActive}
        onCreateProfile={openCreateProfileDialog}
        onOpenHttpConsole={openHttpConsoleTab}
        onOpenLocalShell={openLocalTerminalTab}
        onOpenSerialTerminal={openSerialTerminalTab}
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
            capabilities={settingsTabActive || httpConsoleActive ? inactiveCapabilities : workspace.capabilities}
            connection={settingsTabActive || httpConsoleActive ? null : workspace.activeConnection}
            customTabPanels={{
              [httpConsoleTabId]: <HttpConsolePanel />,
              [settingsTabId]: <SettingsTabPanel workspace={workspace} />,
            }}
            emptyStateNotice={workspace.sessionNotice}
            fileTransferPanel={fileTransferPanel}
            sftpSidePanel={settingsTabActive || httpConsoleActive ? undefined : renderInlineSftpPanel}
            isFullscreen={terminalFullscreen}
            reattachHintActive={detachedReattachHint}
            profiles={workspace.profiles}
            serialPorts={workspace.serialPorts}
            sessionTabs={appSessionTabs}
            terminalConfirmMultilinePaste={workspace.settings.terminal.confirmMultilinePaste}
            terminalCopyRichText={workspace.settings.terminal.copyRichText}
            terminalRightClickBehavior={workspace.settings.terminal.rightClickBehavior}
            terminalTheme={terminalPalette}
            onCloseSessionTab={closeAppSessionTab}
            onCloseSerialTerminal={workspace.closeSerialTerminal}
            onDetachSessionTab={openAppSessionWindow}
            onOpenFileTransferTab={workspace.openFileTransferTab}
            onOpenSessionWindow={openAppSessionWindow}
	            onOpenSerialTerminal={workspace.openSerialTerminal}
	            onReconfigureSerialTerminal={workspace.reconfigureSerialTerminal}
	            onReconnectSessionTab={reconnectAppSessionTab}
	            onRefreshSerialPorts={workspace.refreshSerialPorts}
            onReorderSessionTabs={reorderAppSessionTabs}
            onSendTerminalBytes={workspace.sendTerminalBytes}
            onSendTerminalData={workspace.sendTerminalData}
            onResizeTerminal={workspace.resizeActiveTerminal}
            onSelectSessionTab={selectAppSessionTab}
            onToggleFullscreen={() => setTerminalFullscreen((current) => !current)}
	          />
	        </div>
	      </section>
	      <GlobalNotice message={workspace.workspaceMessage} />
	      <ProfileDialogHost
        dialog={profileDialog}
        reconnectTabId={reconnectTabId}
        workspace={workspace}
        onActiveShellTabChange={setActiveShellTabId}
        onDialogChange={setProfileDialog}
        onHostTrustRequired={registerHostTrustRequest}
        onReconnectTabChange={setReconnectTabId}
      />
      {globalHostTrustDialog}
    </main>
  );
}

export default App;
