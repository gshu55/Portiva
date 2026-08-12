import "./App.css";
import "./styles/appWallpaper.css";
import "./styles/componentGeometry.css";
import { type CSSProperties, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { WslFileTransferPanel } from "./features/file-transfer/WslFileTransferPanel";
import type { ConnectionSecretInput } from "./features/connections/ConnectionProfileDialog";
import { TerminalWorkspace } from "./features/terminal/TerminalWorkspace";
import { Button, ConfirmDialog } from "./shared/ui";
import {
  defaultAppBackground,
  resolveAppBackgroundCssVariables,
  resolveAppBackgroundTerminalColor,
} from "./shared/appBackgrounds";
import { resolveTerminalPalette } from "./shared/terminalThemes";
import type { ConnectionCapabilities, ConnectionProfile, WorkspaceSessionTab } from "./shared/types";
import { sshCollectHostOverview, wslCollectHostOverview } from "./shared/ipc/commands";

const detachedReattachRequestEvent = "portiva://detached-reattach-request";
const detachedReattachCompleteEvent = "portiva://detached-reattach-complete";
const detachedReattachDragStartEvent = "portiva://detached-reattach-drag-start";
const detachedReattachDragEndEvent = "portiva://detached-reattach-drag-end";
const detachedWindowLabelPrefix = "portiva-tab-";
const legacyDetachedTerminalWindowLabelPrefix = "portiva-terminal-";
const mainWindowMinWidth = 900;
const mainWindowMinHeight = 640;
const detachedWindowMinWidth = 900;
const detachedWindowMinHeight = 640;
const settingsTabId = "portiva-settings";
const httpConsoleTabId = "portiva-http-console";
const networkScannerTabId = "portiva-network-scanner";
const hostDashboardTabId = "portiva-host-dashboard";
const wslFilesTabPrefix = "portiva-wsl-files:";
const HttpConsolePanel = lazy(() =>
  import("./features/http/HttpConsolePanel").then((module) => ({ default: module.HttpConsolePanel })),
);
const NetworkScannerPanel = lazy(() =>
  import("./features/network-scan/NetworkScannerPanel").then((module) => ({ default: module.NetworkScannerPanel })),
);
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
const networkScannerSessionTab: WorkspaceSessionTab = {
  id: networkScannerTabId,
  kind: "network-scan",
  connection: {
    capabilities: inactiveCapabilities,
    id: networkScannerTabId,
    profileId: networkScannerTabId,
    status: "ready",
    title: "局域网扫描",
  },
  terminal: null,
  terminalSnapshot: null,
};
const hostDashboardSessionTab: WorkspaceSessionTab = {
  id: hostDashboardTabId,
  kind: "host-dashboard",
  connection: {
    capabilities: inactiveCapabilities,
    id: hostDashboardTabId,
    profileId: hostDashboardTabId,
    status: "ready",
    title: "主机概览",
  },
  terminal: null,
  terminalSnapshot: null,
};

const getAppSessionTabId = (tab: WorkspaceSessionTab) => tab.id ?? tab.connection.id;
const wslFilesTabId = (distribution: string) => `${wslFilesTabPrefix}${encodeURIComponent(distribution)}`;
const isWslFilesTabId = (tabId: string | null | undefined) => Boolean(tabId?.startsWith(wslFilesTabPrefix));

function wslFilesDistribution(tabId: string) {
  try {
    return decodeURIComponent(tabId.slice(wslFilesTabPrefix.length));
  } catch {
    return tabId.slice(wslFilesTabPrefix.length);
  }
}

function createWslFilesSessionTab(distribution: string): WorkspaceSessionTab {
  const id = wslFilesTabId(distribution);
  return {
    id,
    kind: "wsl-files",
    connection: {
      capabilities: inactiveCapabilities,
      id,
      profileId: `wsl:${distribution}`,
      status: "ready",
      title: `${distribution} / 文件`,
    },
    terminal: null,
    terminalSnapshot: null,
  };
}

function areStringArraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function appendMissingTabIds(currentOrder: string[], availableIds: string[]) {
  const availableIdSet = new Set(availableIds);
  const retainedIds = currentOrder.filter((id) => availableIdSet.has(id));
  const retainedIdSet = new Set(retainedIds);
  return [...retainedIds, ...availableIds.filter((id) => !retainedIdSet.has(id))];
}

function moveTabIdBefore(currentOrder: string[], sourceTabId: string, targetTabId: string) {
  if (sourceTabId === targetTabId) {
    return currentOrder;
  }

  const sourceIndex = currentOrder.indexOf(sourceTabId);
  const targetIndex = currentOrder.indexOf(targetTabId);

  if (sourceIndex < 0 || targetIndex < 0) {
    return currentOrder;
  }

  const nextOrder = [...currentOrder];
  const [movedTabId] = nextOrder.splice(sourceIndex, 1);
  const nextTargetIndex = nextOrder.indexOf(targetTabId);
  nextOrder.splice(nextTargetIndex, 0, movedTabId);
  return nextOrder;
}

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

function requiresSavedCredentialRecovery(message: string) {
  return (
    message.includes("系统凭据库读取凭据失败") ||
    message.includes("系统凭据库任务执行失败") ||
    message.includes("读取已保存的 SSH 凭据超时") ||
    message.includes("未找到已保存的 SSH 密码")
  );
}

function App() {
  const workspace = usePortivaWorkspace();
  const [profileDialog, setProfileDialog] = useState<{
    forceSecretEntry?: boolean;
    mode: "create" | "edit";
    profile: ConnectionProfile;
  } | null>(null);
  const [hostTrustRequest, setHostTrustRequest] = useState<HostTrustRequest | null>(null);
  const [hostTrustBusy, setHostTrustBusy] = useState(false);
  const [reconnectTabId, setReconnectTabId] = useState<string | null>(null);
  const [settingsTabOpen, setSettingsTabOpen] = useState(false);
  const [httpConsoleOpen, setHttpConsoleOpen] = useState(false);
  const [networkScannerOpen, setNetworkScannerOpen] = useState(false);
  const [wslFileDistributions, setWslFileDistributions] = useState<string[]>([]);
  const [appTabOrder, setAppTabOrder] = useState<string[]>([]);
  const [activeShellTabId, setActiveShellTabId] = useState<string | null>(null);
  const [savedConnectionsOpen, setSavedConnectionsOpen] = useState(false);
  const [connectingProfileId, setConnectingProfileId] = useState<string | null>(null);
  const [titlebarTabSlot, setTitlebarTabSlot] = useState<HTMLDivElement | null>(null);
  const connectingProfileIdRef = useRef<string | null>(null);
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
  const openDiscoveredProfileDialog = useCallback((host: string, port: number) => {
    const profileType = port === 23 ? "telnet" : port === 22 ? "ssh" : "raw-tcp";
    const draft = workspace.createProfileDraft(profileType);
    if (draft.type === "serial") {
      return;
    }
    const name = port === 22 || port === 23 ? host : `${host}:${port}`;
    setProfileDialog({
      mode: "create",
      profile: { ...draft, host, name, port } as ConnectionProfile,
    });
  }, [workspace]);
  const openLocalTerminalTab = useCallback(() => {
    setActiveShellTabId(null);
    void workspace.openLocalShellTab();
  }, [workspace]);
  const openSerialTerminalTab = useCallback(() => {
    setActiveShellTabId(null);
    void workspace.openSerialTerminalTab();
  }, [workspace]);
  const appBackground = workspace.settings.theme.background ?? defaultAppBackground;
  const terminalPalette = useMemo(() => {
    const palette = resolveTerminalPalette(workspace.settings.theme);
    return {
      ...palette,
      background: resolveAppBackgroundTerminalColor(appBackground, palette.background),
    };
  }, [appBackground, workspace.settings.theme]);
  const themeStyle = useMemo(
    () =>
      ({
        "--terminal-font-family": workspace.settings.theme.terminalFontFamily,
        "--terminal-font-size": `${workspace.settings.theme.terminalFontSize}px`,
        "--terminal-bg": terminalPalette.background,
        "--terminal-fg": terminalPalette.foreground,
        "--terminal-cursor": terminalPalette.cursor,
        "--terminal-selection-bg": terminalPalette.selectionBackground,
        ...resolveAppBackgroundCssVariables(appBackground),
      }) as CSSProperties,
    [
      appBackground,
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
      } else if (requiresSavedCredentialRecovery(result.message)) {
        setReconnectTabId(request.reconnectTabId ?? null);
        setProfileDialog({
          forceSecretEntry: true,
          mode: "edit",
          profile: request.profile,
        });
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
        if (requiresSavedCredentialRecovery(result.message)) {
          setReconnectTabId(tabId);
          setProfileDialog({ forceSecretEntry: true, mode: "edit", profile });
        }
      }
    })();
  };

  const openSavedConnection = async (
    profile: ConnectionProfile,
    credentialProfile: ConnectionProfile = profile,
  ) => {
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
      setProfileDialog({ mode: "edit", profile: credentialProfile });
      return null;
    }

    const input = {
      authenticate: profile.type === "ssh" || profile.type === "sftp",
    };

    const result = await workspace.openProfileConnection(profile, input);
    registerHostTrustRequest(result, {
      connectAfterTrust: true,
      input,
      profile,
    });
    return result;
  };
  const connectSavedConnection = async (
    profile: ConnectionProfile,
    target: "terminal" | "file-transfer" = "terminal",
  ) => {
    if (connectingProfileIdRef.current) {
      return;
    }

    connectingProfileIdRef.current = profile.id;
    setConnectingProfileId(profile.id);
    try {
      const connectionProfile: ConnectionProfile =
        target === "file-transfer" && profile.type === "ssh"
          ? { ...profile, type: "sftp" }
          : target === "terminal" && profile.type === "sftp"
          ? { ...profile, type: "ssh" }
          : profile;
      const result = await openSavedConnection(connectionProfile, profile);
      if (!result) {
        return;
      }

      if (result.status === "opened" || result.status === "needs-trust") {
        setActiveShellTabId(null);
        return;
      }

      if (requiresSavedCredentialRecovery(result.message)) {
        setProfileDialog({ forceSecretEntry: true, mode: "edit", profile });
        workspace.reportWorkspaceMessage(
          `${result.message} 请重新输入密码；需要继续记住时，请重新勾选“记住密码”。`,
        );
      }
    } finally {
      connectingProfileIdRef.current = null;
      setConnectingProfileId(null);
    }
  };
  const openSshFromActiveFileTransfer = () => {
    const fileTab = workspace.sessionTabs.find(
      (tab) =>
        (tab.id ?? tab.connection.id) === workspace.activeSessionTabId &&
        (tab.kind ?? "terminal") === "file-transfer",
    );

    if (!fileTab) {
      workspace.reportWorkspaceMessage("当前未打开 SFTP 文件管理标签。");
      return;
    }

    const parentTerminal = fileTab.parentConnectionId
      ? workspace.sessionTabs.find(
          (tab) =>
            (tab.id ?? tab.connection.id) === fileTab.parentConnectionId &&
            (tab.kind ?? "terminal") === "terminal" &&
            tab.connection.transport?.authenticated,
        )
      : null;
    const matchingTerminal =
      parentTerminal ??
      workspace.sessionTabs.find(
        (tab) =>
          (tab.kind ?? "terminal") === "terminal" &&
          tab.connection.profileId === fileTab.connection.profileId &&
          tab.connection.transport?.authenticated,
      );

    setActiveShellTabId(null);
    if (matchingTerminal) {
      workspace.switchSessionTab(matchingTerminal.id ?? matchingTerminal.connection.id);
      return;
    }

    const profile = workspace.profiles.find(
      (item) => item.id === fileTab.connection.profileId,
    );
    if (!profile) {
      workspace.reportWorkspaceMessage(
        `未找到 SFTP 对应的连接配置：${fileTab.connection.profileId}。`,
      );
      return;
    }

    void connectSavedConnection(profile, "terminal");
  };
  const editSavedConnection = (profile: ConnectionProfile) => {
    setProfileDialog({ mode: "edit", profile });
  };
  const openHostDashboardTab = () => {
    setSavedConnectionsOpen(true);
    setActiveShellTabId(hostDashboardTabId);
  };
  const closeHostDashboardTab = () => {
    setSavedConnectionsOpen(false);
    setActiveShellTabId((current) => (current === hostDashboardTabId ? null : current));
  };
  const closeSettingsTab = () => {
    setSettingsTabOpen(false);
    setActiveShellTabId((current) => (current === settingsTabId ? null : current));
  };
  const closeHttpConsoleTab = () => {
    setHttpConsoleOpen(false);
    setActiveShellTabId((current) => (current === httpConsoleTabId ? null : current));
  };
  const closeNetworkScannerTab = () => {
    setNetworkScannerOpen(false);
    setActiveShellTabId((current) => (current === networkScannerTabId ? null : current));
  };
  const openSettingsTab = () => {
    setSettingsTabOpen(true);
    setActiveShellTabId(settingsTabId);
  };
  const openHttpConsoleTab = () => {
    setHttpConsoleOpen(true);
    setActiveShellTabId(httpConsoleTabId);
  };
  const openNetworkScannerTab = () => {
    setNetworkScannerOpen(true);
    setActiveShellTabId(networkScannerTabId);
  };
  const openWslFilesTab = useCallback((distribution: string) => {
    setWslFileDistributions((current) => current.includes(distribution) ? current : [...current, distribution]);
    setActiveShellTabId(wslFilesTabId(distribution));
  }, []);
  const appTabSourceIds = useMemo(
    () => [
      ...workspace.sessionTabs.map(getAppSessionTabId),
      ...(savedConnectionsOpen ? [hostDashboardTabId] : []),
      ...(httpConsoleOpen ? [httpConsoleTabId] : []),
      ...(networkScannerOpen ? [networkScannerTabId] : []),
      ...(settingsTabOpen ? [settingsTabId] : []),
      ...wslFileDistributions.map(wslFilesTabId),
    ],
    [httpConsoleOpen, networkScannerOpen, savedConnectionsOpen, settingsTabOpen, workspace.sessionTabs, wslFileDistributions],
  );

  useEffect(() => {
    setAppTabOrder((current) => {
      const nextOrder = appendMissingTabIds(current, appTabSourceIds);
      return areStringArraysEqual(current, nextOrder) ? current : nextOrder;
    });
  }, [appTabSourceIds]);

  const appSessionTabs = useMemo(() => {
    const tabById = new Map<string, WorkspaceSessionTab>();

    workspace.sessionTabs.forEach((tab) => {
      tabById.set(getAppSessionTabId(tab), tab);
    });

    if (savedConnectionsOpen) {
      tabById.set(hostDashboardTabId, hostDashboardSessionTab);
    }

    if (httpConsoleOpen) {
      tabById.set(httpConsoleTabId, httpConsoleSessionTab);
    }

    if (networkScannerOpen) {
      tabById.set(networkScannerTabId, networkScannerSessionTab);
    }

    if (settingsTabOpen) {
      tabById.set(settingsTabId, settingsSessionTab);
    }

    wslFileDistributions.forEach((distribution) => {
      tabById.set(wslFilesTabId(distribution), createWslFilesSessionTab(distribution));
    });

    return appendMissingTabIds(appTabOrder, appTabSourceIds)
      .map((tabId) => tabById.get(tabId))
      .filter((tab): tab is WorkspaceSessionTab => Boolean(tab));
  }, [appTabOrder, appTabSourceIds, httpConsoleOpen, networkScannerOpen, savedConnectionsOpen, settingsTabOpen, workspace.sessionTabs, wslFileDistributions]);
  const activeToolTabId =
    activeShellTabId === hostDashboardTabId && savedConnectionsOpen
      ? hostDashboardTabId
      : activeShellTabId === settingsTabId && settingsTabOpen
        ? settingsTabId
        : activeShellTabId === httpConsoleTabId && httpConsoleOpen
          ? httpConsoleTabId
          : activeShellTabId === networkScannerTabId && networkScannerOpen
            ? networkScannerTabId
            : isWslFilesTabId(activeShellTabId) && wslFileDistributions.includes(wslFilesDistribution(activeShellTabId ?? ""))
              ? activeShellTabId
            : null;
  const fallbackAppTabId = !workspace.activeSessionTabId
    ? savedConnectionsOpen
      ? hostDashboardTabId
      : httpConsoleOpen
        ? httpConsoleTabId
        : networkScannerOpen
          ? networkScannerTabId
          : settingsTabOpen
            ? settingsTabId
            : wslFileDistributions[0]
              ? wslFilesTabId(wslFileDistributions[0])
              : undefined
    : workspace.activeSessionTabId;
  const activeAppTabId = activeToolTabId ?? fallbackAppTabId;
  const hostDashboardActive = activeAppTabId === hostDashboardTabId;
  const settingsTabActive = activeAppTabId === settingsTabId;
  const httpConsoleActive = activeAppTabId === httpConsoleTabId;
  const networkScannerActive = activeAppTabId === networkScannerTabId;
  const wslFilesActive = isWslFilesTabId(activeAppTabId);
  const selectAppSessionTab = (tabId: string) => {
    if (tabId === hostDashboardTabId) {
      setSavedConnectionsOpen(true);
      setActiveShellTabId(hostDashboardTabId);
      return;
    }
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
    if (tabId === networkScannerTabId) {
      setNetworkScannerOpen(true);
      setActiveShellTabId(networkScannerTabId);
      return;
    }
    if (isWslFilesTabId(tabId)) {
      setActiveShellTabId(tabId);
      return;
    }

    setActiveShellTabId(null);
    workspace.switchSessionTab(tabId);
  };
  const closeAppSessionTab = (tabId: string) => {
    if (tabId === hostDashboardTabId) {
      closeHostDashboardTab();
      return;
    }
    if (tabId === settingsTabId) {
      closeSettingsTab();
      return;
    }
    if (tabId === httpConsoleTabId) {
      closeHttpConsoleTab();
      return;
    }
    if (tabId === networkScannerTabId) {
      closeNetworkScannerTab();
      return;
    }
    if (isWslFilesTabId(tabId)) {
      const distribution = wslFilesDistribution(tabId);
      const remaining = wslFileDistributions.filter((item) => item !== distribution);
      setWslFileDistributions(remaining);
      setActiveShellTabId((active) => {
        if (active !== tabId) return active;
        if (workspace.activeSessionTabId) return null;
        return remaining[0] ? wslFilesTabId(remaining[0]) : null;
      });
      return;
    }

    void workspace.closeConnection(tabId);
  };
  const openAppSessionWindow = (tabId: string) => {
    if (tabId === hostDashboardTabId || tabId === settingsTabId || tabId === httpConsoleTabId || tabId === networkScannerTabId || isWslFilesTabId(tabId)) {
      return;
    }

    openSessionWindow(tabId);
  };
  const reconnectAppSessionTab = (tabId: string) => {
    if (tabId === hostDashboardTabId || tabId === settingsTabId || tabId === httpConsoleTabId || tabId === networkScannerTabId || isWslFilesTabId(tabId)) {
      return;
    }

    reconnectSessionTab(tabId);
  };
  const reorderAppSessionTabs = (sourceTabId: string, targetTabId: string) => {
    if (
      sourceTabId === settingsTabId ||
      targetTabId === settingsTabId ||
      sourceTabId === httpConsoleTabId ||
      targetTabId === httpConsoleTabId ||
      sourceTabId === networkScannerTabId ||
      targetTabId === networkScannerTabId ||
      sourceTabId === hostDashboardTabId ||
      targetTabId === hostDashboardTabId ||
      isWslFilesTabId(sourceTabId) ||
      isWslFilesTabId(targetTabId)
    ) {
      return;
    }

    setAppTabOrder((current) => {
      const normalizedOrder = appendMissingTabIds(current, appTabSourceIds);
      const nextOrder = moveTabIdBefore(normalizedOrder, sourceTabId, targetTabId);
      return areStringArraysEqual(current, nextOrder) ? current : nextOrder;
    });
    workspace.reorderSessionTabs(sourceTabId, targetTabId);
  };
  const fileTransferPanel = (
    <ActiveFileTransferPanel
      onOpenSsh={openSshFromActiveFileTransfer}
      openSshPending={Boolean(connectingProfileId)}
      workspace={workspace}
    />
  );
  const shouldShowInlineSftpPanel = Boolean(
    workspace.activeSessionTabKind === "terminal" &&
      workspace.activeConnection?.capabilities.fileTransfer &&
      workspace.activeConnection.transport?.kind === "ssh" &&
      workspace.activeConnection.transport.authenticated,
  );
  const activeWslDistribution = workspace.activeSessionTabKind === "terminal" &&
    workspace.activeConnection?.transport?.kind === "wsl"
      ? workspace.activeConnection.transport.host
      : null;
  const renderInlineFilePanel = shouldShowInlineSftpPanel
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
    : activeWslDistribution
      ? ({
          layoutSide,
          onToggleLayoutSide,
        }: {
          layoutSide: "left" | "right";
          onToggleLayoutSide: () => void;
        }) => (
          <WslFileTransferPanel
            compact
            distribution={activeWslDistribution}
            key={activeWslDistribution}
            layoutSide={layoutSide}
            onOpenTerminal={(distribution) => workspace.openWslShellTab(distribution)}
            onReportMessage={workspace.reportWorkspaceMessage}
            onToggleLayoutSide={onToggleLayoutSide}
          />
        )
      : undefined;
  const pendingHostTrust =
    hostTrustRequest &&
    workspace.pendingKnownHost &&
    (hostTrustRequest.profile.type === "ssh" || hostTrustRequest.profile.type === "sftp") &&
    hostTrustRequest.profile.host?.trim().toLowerCase() === workspace.pendingKnownHost.host.toLowerCase() &&
    (hostTrustRequest.profile.port ?? 22) === workspace.pendingKnownHost.port
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
  const pendingTransferConflict = workspace.transfers.find(
    (task) => task.status === "waiting-conflict" && task.conflictPolicy === "ask",
  );
  const globalTransferConflictDialog = pendingTransferConflict ? (
    <ConfirmDialog
      actions={
        <>
          <Button
            onClick={() => void workspace.resolveTransferConflict(pendingTransferConflict.id, "skip")}
            tone="muted"
          >
            跳过
          </Button>
          <Button
            onClick={() => void workspace.resolveTransferConflict(pendingTransferConflict.id, "skip-all")}
            tone="muted"
          >
            全部跳过
          </Button>
          <Button
            onClick={() => void workspace.resolveTransferConflict(pendingTransferConflict.id, "overwrite")}
          >
            覆盖
          </Button>
          <Button
            onClick={() => void workspace.resolveTransferConflict(pendingTransferConflict.id, "overwrite-all")}
            tone="primary"
          >
            全部覆盖
          </Button>
        </>
      }
      description={
        <>
          远端目标已经存在：
          <br />
          <code>{pendingTransferConflict.conflictPath ?? pendingTransferConflict.remotePath}</code>
          <br />
          “全部”仅应用于当前传输任务的后续冲突。
        </>
      }
      dismissible={false}
      open
      title="文件冲突"
      onCancel={() => void workspace.resolveTransferConflict(pendingTransferConflict.id, "skip")}
      onConfirm={() => void workspace.resolveTransferConflict(pendingTransferConflict.id, "overwrite")}
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
      <main
        className="app-shell detached-shell"
        data-background={appBackground.enabled ? "true" : "false"}
        data-theme={workspace.settings.theme.mode}
        style={themeStyle}
      >
        <TerminalWorkspace
          activeTabId={workspace.activeSessionTabId}
          connection={workspace.activeConnection}
          capabilities={workspace.capabilities}
          emptyStateNotice={workspace.workspaceMessage}
          fileTransferPanel={fileTransferPanel}
          sftpSidePanel={renderInlineFilePanel}
          isFullscreen={terminalFullscreen}
          keymap={workspace.settings.keymap}
          reattachHintActive={detachedReattachHint}
          profiles={workspace.profiles}
          serialPorts={workspace.serialPorts}
          sessionTabs={workspace.sessionTabs}
          terminalConfirmMultilinePaste={workspace.settings.terminal.confirmMultilinePaste}
          terminalCopyRichText={workspace.settings.terminal.copyRichText}
          terminalRightClickBehavior={workspace.settings.terminal.rightClickBehavior}
          suppressInsecureWarning={workspace.settings.security.allowInsecureWithoutWarning}
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
          onTerminalWorkingDirectoryChange={workspace.reportTerminalWorkingDirectory}
          onResizeTerminal={workspace.resizeActiveTerminal}
          onSelectSessionTab={workspace.switchSessionTab}
          onToggleFullscreen={() => setTerminalFullscreen((current) => !current)}
	        />
	        <GlobalNotice message={workspace.workspaceMessage} />
	        {globalHostTrustDialog}
	        {globalTransferConflictDialog}
	      </main>
    );
  }

  return (
    <main
      className="app-shell"
      data-background={appBackground.enabled ? "true" : "false"}
      data-theme={workspace.settings.theme.mode}
      style={themeStyle}
    >
      <AppTitlebar
        httpConsoleActive={httpConsoleActive}
        networkScannerActive={networkScannerActive}
        savedConnectionsOpen={hostDashboardActive}
        settingsTabActive={settingsTabActive}
        onCreateProfile={openCreateProfileDialog}
        onOpenHttpConsole={openHttpConsoleTab}
        onOpenNetworkScanner={openNetworkScannerTab}
        onOpenLocalShell={openLocalTerminalTab}
        onOpenSerialTerminal={openSerialTerminalTab}
        onOpenSavedConnections={openHostDashboardTab}
        onOpenSettings={openSettingsTab}
        tabSlotRef={setTitlebarTabSlot}
      />
      <section className="workspace">
        <div className="content-grid without-file-manager">
          <TerminalWorkspace
            activeTabId={activeAppTabId}
            capabilities={hostDashboardActive || settingsTabActive || httpConsoleActive || networkScannerActive || wslFilesActive ? inactiveCapabilities : workspace.capabilities}
            connection={hostDashboardActive || settingsTabActive || httpConsoleActive || networkScannerActive || wslFilesActive ? null : workspace.activeConnection}
            customTabPanels={{
              [hostDashboardTabId]: (
                <ConnectionList
                  activeProfileId={workspace.activeProfileId}
                  connectingProfileId={connectingProfileId}
                  profiles={workspace.profiles}
                  sessionTabs={workspace.sessionTabs}
                  onConnectProfile={connectSavedConnection}
                  onCreateProfile={openCreateProfileDialog}
                  onDeleteProfile={workspace.deleteProfile}
                  onEditProfile={editSavedConnection}
                  onOpenFileTransfer={(profile, connectionId) => {
                    setActiveShellTabId(null);
                    if (connectionId) {
                      void workspace.openFileTransferTab(connectionId);
                      return;
                    }

                    void connectSavedConnection(profile, "file-transfer");
                  }}
                  onOpenSession={(tabId) => {
                    setActiveShellTabId(null);
                    workspace.switchSessionTab(tabId);
                  }}
                  onOpenWslDistribution={(distribution) => {
                    setActiveShellTabId(null);
                    return workspace.openWslShellTab(distribution);
                  }}
                  onOpenWslFiles={openWslFilesTab}
                  onRefreshHostOverview={sshCollectHostOverview}
                  onRefreshWslHostOverview={wslCollectHostOverview}
                  onRefreshWslDistributions={workspace.refreshWslDistributions}
                  onSelectProfile={workspace.setActiveProfileId}
                  wslDiscovery={workspace.wslDiscovery}
                />
              ),
              [httpConsoleTabId]: (
                <Suspense fallback={null}>
                  <HttpConsolePanel />
                </Suspense>
              ),
              [networkScannerTabId]: (
                <Suspense fallback={null}>
                  <NetworkScannerPanel onCreateProfile={openDiscoveredProfileDialog} />
                </Suspense>
              ),
              [settingsTabId]: <SettingsTabPanel workspace={workspace} />,
              ...Object.fromEntries(wslFileDistributions.map((distribution) => [
                wslFilesTabId(distribution),
                <WslFileTransferPanel
                  distribution={distribution}
                  key={distribution}
                  onOpenTerminal={(targetDistribution) => {
                    setActiveShellTabId(null);
                    return workspace.openWslShellTab(targetDistribution);
                  }}
                  onReportMessage={workspace.reportWorkspaceMessage}
                />,
              ])),
            }}
            emptyStateNotice={workspace.sessionNotice}
            fileTransferPanel={fileTransferPanel}
            sftpSidePanel={hostDashboardActive || settingsTabActive || httpConsoleActive || networkScannerActive || wslFilesActive ? undefined : renderInlineFilePanel}
            isFullscreen={terminalFullscreen}
            keymap={workspace.settings.keymap}
            reattachHintActive={detachedReattachHint}
            profiles={workspace.profiles}
            serialPorts={workspace.serialPorts}
            sessionTabs={appSessionTabs}
            terminalConfirmMultilinePaste={workspace.settings.terminal.confirmMultilinePaste}
            terminalCopyRichText={workspace.settings.terminal.copyRichText}
            terminalRightClickBehavior={workspace.settings.terminal.rightClickBehavior}
            suppressInsecureWarning={workspace.settings.security.allowInsecureWithoutWarning}
            terminalTheme={terminalPalette}
            tabBarPortalTarget={titlebarTabSlot}
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
            onTerminalWorkingDirectoryChange={workspace.reportTerminalWorkingDirectory}
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
      {globalTransferConflictDialog}
    </main>
  );
}

export default App;
