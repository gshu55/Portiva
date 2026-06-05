import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { capabilitiesByType } from "../shared/capabilities";
import { transferStatusLabel } from "../shared/labels";
import {
  connectionClose,
  connectionGet,
  connectionOpen,
  fileTransferCancel,
  fileTransferClose,
  fileTransferDelete,
  fileTransferDownload,
  fileTransferList,
  fileTransferMkdir,
  fileTransferOpen,
  fileTransferPause,
  fileTransferRemove,
  fileTransferRename,
  fileTransferResume,
  fileTransferRetry,
  fileTransferSession,
  fileTransferUpload,
  localFileList,
  localFileMkdir,
  localFileRemove,
  localFileRename,
  localShellOpen,
  knownHostTrustPlaceholder,
  knownHostDelete,
  knownHostsList,
  logClear,
  logList,
  profileGroups,
  profileCreate,
  profileDelete,
  profileList,
  profileMarkRecent,
  profileRecent,
  profileTestConnection,
  profileUpdate,
  protocolList,
  secretGet,
  secretList,
  secretDelete,
  secretSet,
  serialListPorts,
  securityRedactPreview,
  settingsGet,
  settingsUpdate,
  sshAuthenticateAgent,
  sshAuthenticatePassword,
  sshAuthenticatePrivateKey,
  terminalAttach,
  terminalClose,
  terminalResize,
  terminalSession,
  terminalSnapshot,
  terminalWrite,
  transferList,
  tunnelList,
} from "../shared/ipc/commands";
import type { TestConnectionResult } from "../shared/ipc/commands";
import {
  sampleGroups,
  sampleKnownHosts,
  sampleLogs,
  sampleProfiles,
  sampleProtocolDescriptors,
  sampleRecentConnections,
  sampleSecrets,
  sampleSerialPorts,
  sampleTunnels,
  sampleTransfers,
} from "../shared/mockData";
import { defaultTerminalColors } from "../shared/terminalThemes";
import type {
  ConnectionSummary,
  FileTransferSession,
  KnownHostEntry,
  LogEntry,
  ProfileGroup,
  ProtocolDescriptor,
  RecentConnection,
  RemoteEntry,
  SecretMetadata,
  SerialPortInfo,
  AppSettings,
  TerminalSession,
  TerminalSize,
  TerminalSnapshot,
  TunnelRule,
  TransferTask,
  ConnectionProfile,
  WorkspaceSessionTab,
} from "../shared/types";

type DataSource = "loading" | "tauri" | "mock";
type OpenConnectionStatus = "opened" | "needs-trust" | "failed";
interface OpenConnectionResult {
  message: string;
  status: OpenConnectionStatus;
}
interface OpenConnectionOptions {
  authenticate?: boolean;
  rememberSecret?: boolean;
  secret?: string;
}
interface SaveProfileOptions {
  rememberSecret?: boolean;
  secret?: string;
}
interface TestConnectionOptions {
  secret?: string;
}
interface DetachedSessionTarget {
  connectionId: string;
  fileTransferSessionId?: string;
  kind?: WorkspaceSessionTab["kind"];
  parentConnectionId?: string;
  remotePath?: string;
  tabId: string;
  terminalId?: string;
}
interface DetachedSessionTabResult {
  fileTransferEntries?: RemoteEntry[];
  fileTransferMessage?: string;
  remotePath?: string;
  tab: WorkspaceSessionTab;
  terminalSnapshot: TerminalSnapshot | null;
}
const terminalSnapshotEvent = "portiva://terminal-snapshot";

const localRootsPath = "portiva://local-roots";
const remoteRootPath = "/";
const emptyRemoteEntries: RemoteEntry[] = [];
const connectionResult = (status: OpenConnectionStatus, message: string): OpenConnectionResult => ({
  message,
  status,
});
const defaultSettings: AppSettings = {
  theme: {
    mode: "dark",
    terminalFontFamily: "Cascadia Mono",
    terminalFontSize: 13,
    terminalColorPreset: "dark",
    terminalColors: defaultTerminalColors,
  },
  keymap: {
    commandPalette: "Ctrl+Shift+P",
    newProfile: "Ctrl+N",
    closeTab: "Ctrl+W",
  },
  security: {
    requireHostKeyVerification: true,
    redactSensitiveLogs: true,
    allowInsecureWithoutWarning: false,
  },
  terminal: {
    confirmMultilinePaste: true,
    copyRichText: false,
    rightClickBehavior: "context-menu",
  },
};
const defaultTerminalSize = {
  cols: 100,
  rows: 30,
  widthPx: 1200,
  heightPx: 720,
};
function newConnectionProfile(type: ConnectionProfile["type"]): ConnectionProfile {
  const now = new Date().toISOString();
  const id = `${type}-${Date.now()}`;
  const base = {
    id,
    name: "",
    type,
    createdAt: now,
    updatedAt: now,
  };

  if (type === "ssh") {
    return {
      ...base,
      type: "ssh",
      host: "",
      port: 22,
      username: "",
      authType: "password",
      enableSftp: false,
      groupId: "servers",
      tags: ["ssh"],
    };
  }

  if (type === "sftp") {
    return {
      ...base,
      type: "sftp",
      host: "",
      port: 22,
      username: "",
      authType: "password",
      enableSftp: true,
      groupId: "servers",
      tags: ["sftp"],
    };
  }

  if (type === "telnet") {
    return {
      ...base,
      type: "telnet",
      host: "",
      port: 23,
      username: "",
      terminalType: "vt100",
      lineEnding: "crlf",
      encoding: "utf-8",
      groupId: "network",
      tags: ["telnet"],
    };
  }

  if (type === "serial") {
    return {
      ...base,
      type: "serial",
      portName: "",
      baudRate: 115200,
      dataBits: 8,
      parity: "none",
      stopBits: 1,
      flowControl: "none",
      lineEnding: "crlf",
      encoding: "utf-8",
      groupId: "devices",
      tags: ["serial"],
    };
  }

  return {
    ...base,
    type: "raw-tcp",
    host: "",
    port: 9000,
    lineEnding: "lf",
    encoding: "utf-8",
    groupId: "network",
    tags: ["raw-tcp"],
  };
}

export function usePortivaWorkspace() {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>(sampleProfiles);
  const [groups, setGroups] = useState<ProfileGroup[]>(sampleGroups);
  const [recentConnections, setRecentConnections] = useState<RecentConnection[]>(sampleRecentConnections);
  const [protocolDescriptors, setProtocolDescriptors] = useState<ProtocolDescriptor[]>(sampleProtocolDescriptors);
  const [transfers, setTransfers] = useState<TransferTask[]>(sampleTransfers);
  const [logs, setLogs] = useState<LogEntry[]>(sampleLogs);
  const [secrets, setSecrets] = useState<SecretMetadata[]>(sampleSecrets);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [redactionInput, setRedactionInput] = useState("host=prod\npassword=hunter2\nuser=deploy");
  const [redactionPreview, setRedactionPreview] = useState("");
  const [pendingKnownHost, setPendingKnownHost] = useState<{ fingerprint: string; host: string } | null>(null);
  const [knownHosts, setKnownHosts] = useState<KnownHostEntry[]>(sampleKnownHosts);
  const [serialPorts, setSerialPorts] = useState<SerialPortInfo[]>(sampleSerialPorts);
  const [tunnels, setTunnels] = useState<TunnelRule[]>(sampleTunnels);
  const [remoteEntries, setRemoteEntries] = useState<RemoteEntry[]>(emptyRemoteEntries);
  const [localEntries, setLocalEntries] = useState<RemoteEntry[]>(emptyRemoteEntries);
  const [sessionTabs, setSessionTabs] = useState<WorkspaceSessionTab[]>([]);
  const [activeSessionTabId, setActiveSessionTabId] = useState("");
  const [activeConnection, setActiveConnection] = useState<ConnectionSummary | null>(null);
  const [activeFileTransferSession, setActiveFileTransferSession] = useState<FileTransferSession | null>(null);
  const [activeTerminal, setActiveTerminal] = useState<TerminalSession | null>(null);
  const activeTerminalIdRef = useRef<string | null>(null);
  const [terminalSnapshotState, setTerminalSnapshotState] = useState<TerminalSnapshot | null>(null);
  const [remotePath, setRemotePathState] = useState(remoteRootPath);
  const [localPath, setLocalPathState] = useState("");
  const [selectedRemoteEntry, setSelectedRemoteEntry] = useState<RemoteEntry | null>(null);
  const [selectedLocalEntry, setSelectedLocalEntry] = useState<RemoteEntry | null>(null);
  const [activeProfileId, setActiveProfileId] = useState(sampleProfiles[0]?.id ?? "");
  const [terminalSearchQuery, setTerminalSearchQuery] = useState("");
  const [dataSource, setDataSource] = useState<DataSource>("loading");
  const [sessionNotice, setSessionNotice] = useState("");
  const [workspaceMessage, setWorkspaceMessage] = useState("正在加载 Tauri 工作区状态...");
  const [sshPassword, setSshPassword] = useState("");
  const transferStatusRef = useRef<Map<string, TransferTask["status"]>>(new Map());

  const fallbackProfile = useMemo(() => newConnectionProfile("ssh"), []);
  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0] ?? fallbackProfile,
    [activeProfileId, fallbackProfile, profiles],
  );
  const activeSessionTab = useMemo(
    () => sessionTabs.find((tab) => (tab.id ?? tab.connection.id) === activeSessionTabId) ?? null,
    [activeSessionTabId, sessionTabs],
  );
  const activeSessionTerminalSnapshot = activeSessionTab?.terminal
    ? activeSessionTab.terminal.id === activeSessionTab.terminalSnapshot?.terminalId
      ? activeSessionTab.terminalSnapshot
      : activeSessionTab.terminal.id === terminalSnapshotState?.terminalId
      ? terminalSnapshotState
      : null
    : null;

  const capabilities = capabilitiesByType[activeProfile.type];
  const activeConnectionCapabilities = activeConnection?.capabilities ?? capabilities;
  const activeFileTransferConnectionId =
    activeSessionTab && (activeSessionTab.kind ?? "terminal") === "file-transfer"
      ? activeSessionTab.parentConnectionId ?? activeFileTransferSession?.connectionId ?? null
      : activeConnection?.id ?? null;
  const sftpConnectionOptions = useMemo(
    () =>
      sessionTabs
        .filter(
          (tab) =>
            (tab.kind ?? "terminal") === "terminal" &&
            tab.connection.capabilities.sftp &&
            tab.connection.transport?.authenticated,
        )
        .map((tab) => {
          const connectionId = tab.connection.id;
          return {
            connectionId,
            title: tab.connection.title,
            active: connectionId === activeFileTransferConnectionId,
          };
        }),
    [activeFileTransferConnectionId, sessionTabs],
  );

  const clearFileTransferView = useCallback(() => {
    setActiveFileTransferSession(null);
    setSelectedRemoteEntry(null);
    setRemoteEntries(emptyRemoteEntries);
    setRemotePathState(remoteRootPath);
  }, []);

  const attachTerminalWithSnapshot = useCallback(async (connectionId: string) => {
    const terminal = await terminalAttach(connectionId, defaultTerminalSize);
    let snapshot: TerminalSnapshot | null = null;

    try {
      snapshot = await terminalSnapshot(terminal.id);
    } catch {
      snapshot = null;
    }

    return { snapshot, terminal };
  }, []);

  const resolveHostTrustFailure = useCallback(async (
    profile: ConnectionProfile,
    error: unknown,
  ): Promise<OpenConnectionResult | null> => {
    const message = String(error);
    const normalized = message.toLowerCase();

    if (
      (profile.type !== "ssh" && profile.type !== "sftp") ||
      (!normalized.includes("host key") && !normalized.includes("fingerprint"))
    ) {
      return null;
    }

    try {
      const result = await profileTestConnection(profile);
      if (result.requiresFingerprintConfirmation) {
        if (result.host && result.fingerprint) {
          setPendingKnownHost({ host: result.host, fingerprint: result.fingerprint });
        }
        setWorkspaceMessage(result.message);
        return connectionResult("needs-trust", result.message);
      }

      if (!result.ok) {
        setWorkspaceMessage(result.message);
        return connectionResult("failed", result.message);
      }
    } catch {
      // Fall through to the original connection error.
    }

    return null;
  }, []);

  const activateSessionTab = useCallback(
    (tab: WorkspaceSessionTab) => {
      setSessionNotice("");
      setActiveSessionTabId(tab.id ?? tab.connection.id);
      setActiveConnection(tab.connection);
      setActiveTerminal(tab.terminal);
      setTerminalSnapshotState(tab.terminalSnapshot);
      setActiveProfileId(tab.connection.profileId);
      if ((tab.kind ?? "terminal") === "file-transfer" && tab.fileTransferSession) {
        setActiveFileTransferSession(tab.fileTransferSession);
        setWorkspaceMessage(`已切换到 ${tab.connection.title} 文件管理。`);
      } else {
        clearFileTransferView();
        setWorkspaceMessage(`已切换到 ${tab.connection.title}。`);
      }
    },
    [clearFileTransferView],
  );

  const updateActiveSessionTab = useCallback(
    (
      patch: Partial<Pick<WorkspaceSessionTab, "terminal" | "terminalSnapshot">>,
    ) => {
      if (!activeConnection) {
        return;
      }

      setSessionTabs((current) =>
        current.map((tab) =>
          tab.connection.id === activeConnection.id
            ? {
                ...tab,
                ...patch,
              }
            : tab,
        ),
      );
    },
    [activeConnection],
  );

  const resolveDetachedSessionTab = useCallback(async (
    target: DetachedSessionTarget,
  ): Promise<DetachedSessionTabResult> => {
    const kind = target.kind ?? (target.fileTransferSessionId ? "file-transfer" : "terminal");

    if (kind === "file-transfer") {
      if (!target.fileTransferSessionId) {
        throw new Error("缺少文件传输会话 ID");
      }

      const [connection, transferSession] = await Promise.all([
        connectionGet(target.connectionId),
        fileTransferSession(target.fileTransferSessionId),
      ]);

      if (transferSession.connectionId !== connection.id) {
        throw new Error(`文件传输会话 ${transferSession.id} 不属于连接 ${connection.id}`);
      }

      const restoredTabId =
        target.tabId ||
        (target.parentConnectionId ? `${connection.id}:sftp:${transferSession.id}` : connection.id);
      const restoredConnection: ConnectionSummary = target.parentConnectionId
        ? {
            ...connection,
            id: restoredTabId,
            title: `${connection.title} / SFTP`,
            capabilities: {
              ...connection.capabilities,
              terminal: false,
              fileTransfer: true,
              sftp: true,
            },
            transport: connection.transport
              ? {
                  ...connection.transport,
                  fileTransferReady: true,
                }
              : connection.transport,
          }
        : {
            ...connection,
            transport: connection.transport
              ? {
                  ...connection.transport,
                  fileTransferReady: true,
                }
              : connection.transport,
          };
      const restoredTab: WorkspaceSessionTab = {
        id: restoredTabId,
        kind: "file-transfer",
        connection: restoredConnection,
        fileTransferSession: transferSession,
        parentConnectionId: target.parentConnectionId,
        restored: true,
        terminal: null,
        terminalSnapshot: null,
      };
      const targetPath = normalizeRemotePathInput(target.remotePath ?? remoteRootPath);
      let entries: RemoteEntry[] = emptyRemoteEntries;
      let message = "";

      try {
        entries = await fileTransferList(transferSession.id, targetPath);
        message = `已加载 ${entries.length} 个远程条目。`;
      } catch (error) {
        message = `读取远程目录失败：${String(error)}`;
      }

      return {
        fileTransferEntries: entries,
        fileTransferMessage: message,
        remotePath: targetPath,
        tab: restoredTab,
        terminalSnapshot: null,
      };
    }

    if (!target.terminalId) {
      throw new Error("缺少终端会话 ID");
    }

    const [connection, terminal] = await Promise.all([
      connectionGet(target.connectionId),
      terminalSession(target.terminalId),
    ]);

    if (terminal.connectionId !== connection.id) {
      throw new Error(`终端 ${terminal.id} 不属于连接 ${connection.id}`);
    }

    let snapshot: TerminalSnapshot | null = null;
    try {
      snapshot = await terminalSnapshot(terminal.id);
    } catch {
      snapshot = null;
    }

    const restoredTab: WorkspaceSessionTab = {
      id: target.tabId || connection.id,
      kind: "terminal",
      connection,
      restored: true,
      terminal,
      terminalSnapshot: snapshot,
    };

    return {
      tab: restoredTab,
      terminalSnapshot: snapshot,
    };
  }, []);

  const restoreDetachedSessionTab = useCallback(async (target: DetachedSessionTarget) => {
    try {
      const restored = await resolveDetachedSessionTab(target);
      const restoredTab = restored.tab;
      const restoredTabId = restoredTab.id ?? restoredTab.connection.id;

      setSessionNotice("");
      setSessionTabs([restoredTab]);
      setActiveSessionTabId(restoredTabId);
      setActiveConnection(restoredTab.connection);
      setActiveTerminal(restoredTab.terminal);
      setTerminalSnapshotState(restored.terminalSnapshot);
      setActiveProfileId(restoredTab.connection.profileId);

      if ((restoredTab.kind ?? "terminal") === "file-transfer" && restoredTab.fileTransferSession) {
        setActiveFileTransferSession(restoredTab.fileTransferSession);
        setRemotePathState(restored.remotePath ?? remoteRootPath);
        setRemoteEntries(restored.fileTransferEntries ?? emptyRemoteEntries);
        setSelectedRemoteEntry(null);
      } else {
        clearFileTransferView();
      }

      setDataSource("tauri");
      setWorkspaceMessage(
        (restoredTab.kind ?? "terminal") === "file-transfer"
          ? `已在单独窗口接管 ${restoredTab.connection.title} 文件管理。${restored.fileTransferMessage ?? ""}`
          : `已在单独窗口接管 ${restoredTab.connection.title}。`,
      );
    } catch (error) {
      setSessionTabs([]);
      setActiveSessionTabId("");
      setActiveConnection(null);
      setActiveTerminal(null);
      setTerminalSnapshotState(null);
      clearFileTransferView();
      setWorkspaceMessage(`恢复单独窗口失败：${String(error)}`);
    }
  }, [clearFileTransferView, resolveDetachedSessionTab]);

  const attachDetachedSessionTab = useCallback(async (target: DetachedSessionTarget) => {
    try {
      const restored = await resolveDetachedSessionTab(target);
      const restoredTab = restored.tab;
      const restoredTabId = restoredTab.id ?? restoredTab.connection.id;

      setSessionNotice("");
      setSessionTabs((current) => [
        ...current.filter((tab) => (tab.id ?? tab.connection.id) !== restoredTabId),
        restoredTab,
      ]);
      setActiveSessionTabId(restoredTabId);
      setActiveConnection(restoredTab.connection);
      setActiveTerminal(restoredTab.terminal);
      setTerminalSnapshotState(restored.terminalSnapshot);
      setActiveProfileId(restoredTab.connection.profileId);

      if ((restoredTab.kind ?? "terminal") === "file-transfer" && restoredTab.fileTransferSession) {
        setActiveFileTransferSession(restoredTab.fileTransferSession);
        setRemotePathState(restored.remotePath ?? remoteRootPath);
        setRemoteEntries(restored.fileTransferEntries ?? emptyRemoteEntries);
        setSelectedRemoteEntry(null);
      } else {
        clearFileTransferView();
      }

      setDataSource("tauri");
      setWorkspaceMessage(
        (restoredTab.kind ?? "terminal") === "file-transfer"
          ? `已将 ${restoredTab.connection.title} 文件管理合并到当前窗口。${restored.fileTransferMessage ?? ""}`
          : `已将 ${restoredTab.connection.title} 合并到当前窗口。`,
      );
    } catch (error) {
      setWorkspaceMessage(`接回单独窗口失败：${String(error)}`);
      throw error;
    }
  }, [clearFileTransferView, resolveDetachedSessionTab]);

  const detachSessionTab = useCallback(
    (tabId: string) => {
      const detachIndex = sessionTabs.findIndex((tab) => (tab.id ?? tab.connection.id) === tabId);
      const detachedTab = detachIndex >= 0 ? sessionTabs[detachIndex] : null;

      if (!detachedTab) {
        setWorkspaceMessage(`未找到可分离的标签：${tabId}。`);
        return;
      }

      const remainingTabs = sessionTabs.filter((tab) => (tab.id ?? tab.connection.id) !== tabId);
      const nextTab =
        remainingTabs[detachIndex - 1] ??
        remainingTabs[detachIndex] ??
        remainingTabs[remainingTabs.length - 1] ??
        null;
      const isDetachingActive = activeSessionTabId === tabId;

      setSessionTabs(remainingTabs);
      setWorkspaceMessage(`${detachedTab.connection.title} 已移到单独窗口。`);

      if (!isDetachingActive) {
        return;
      }

      if (nextTab) {
        activateSessionTab(nextTab);
        return;
      }

      setSessionNotice("");
      setActiveSessionTabId("");
      setActiveConnection(null);
      setActiveTerminal(null);
      setTerminalSnapshotState(null);
      clearFileTransferView();
    },
    [
      activeSessionTabId,
      activateSessionTab,
      clearFileTransferView,
      sessionTabs,
    ],
  );

  const refreshWorkspace = useCallback(async () => {
    try {
      const [
        nextProfiles,
        nextGroups,
        nextRecentConnections,
        nextProtocolDescriptors,
        nextTransfers,
        nextLogs,
        nextSecrets,
        nextSettings,
        nextKnownHosts,
        nextSerialPorts,
        nextTunnels,
      ] = await Promise.all([
        profileList(),
        profileGroups(),
        profileRecent(),
        protocolList(),
        transferList(),
        logList(),
        secretList(),
        settingsGet(),
        knownHostsList(),
        serialListPorts().catch(() => []),
        tunnelList(),
      ]);

      setProfiles(nextProfiles);
      setGroups(nextGroups);
      setRecentConnections(nextRecentConnections);
      setProtocolDescriptors(nextProtocolDescriptors);
      setTransfers(nextTransfers);
      setLogs(nextLogs);
      setSecrets(nextSecrets);
      setSettings(nextSettings);
      setKnownHosts(nextKnownHosts);
      setSerialPorts(nextSerialPorts);
      setTunnels(nextTunnels);
      setActiveProfileId((current) =>
        nextProfiles.some((profile) => profile.id === current) ? current : nextProfiles[0]?.id ?? current,
      );
      setDataSource("tauri");
      setWorkspaceMessage("已从 Rust 服务加载工作区状态。");
    } catch (error) {
      setDataSource("mock");
      setWorkspaceMessage(`Tauri IPC 不可用，正在显示演示数据。${String(error)}`);
    }
  }, []);

  useEffect(() => {
    const hasRunningTransfer = transfers.some((task) => task.status === "running");
    if (dataSource !== "tauri" || !hasRunningTransfer) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void transferList()
        .then(setTransfers)
        .catch(() => {
          // Keep the current queue visible; command-level actions surface detailed IPC errors.
        });
    }, 750);

    return () => window.clearInterval(intervalId);
  }, [dataSource, transfers]);

  useEffect(() => {
    activeTerminalIdRef.current = activeTerminal?.id ?? null;
  }, [activeTerminal?.id]);

  useEffect(() => {
    if (dataSource !== "tauri") {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listen<TerminalSnapshot>(terminalSnapshotEvent, (event) => {
      const snapshot = event.payload;

      setSessionTabs((current) =>
        current.map((tab) => {
          const nextTab = { ...tab };
          let changed = false;

          if (tab.terminal?.id === snapshot.terminalId) {
            nextTab.terminalSnapshot = snapshot;
            if (tab.terminal.status !== snapshot.status) {
              nextTab.terminal = {
                ...tab.terminal,
                status: snapshot.status,
              };
            }
            changed = true;
          }

          return changed ? nextTab : tab;
        }),
      );

      if (activeTerminalIdRef.current === snapshot.terminalId) {
        setTerminalSnapshotState(snapshot);
        setActiveTerminal((current) =>
          current && current.id === snapshot.terminalId && current.status !== snapshot.status
            ? {
                ...current,
                status: snapshot.status,
              }
            : current,
        );
      }

    })
      .then((dispose) => {
        if (disposed) {
          void dispose();
          return;
        }

        unlisten = dispose;
      })
      .catch(() => {
        // Browser preview and mocked mode do not have the Tauri event bridge.
      });

    return () => {
      disposed = true;
      if (unlisten) {
        void unlisten();
      }
    };
  }, [dataSource]);

  const saveSettings = useCallback(async (nextSettings: AppSettings) => {
    if (dataSource === "mock") {
      setSettings(nextSettings);
      setWorkspaceMessage("设置已应用到演示模式。");
      return;
    }

    try {
      const saved = await settingsUpdate(nextSettings);
      setSettings(saved);
      setWorkspaceMessage("设置已保存。");
    } catch (error) {
      setWorkspaceMessage(`保存设置失败：${String(error)}`);
    }
  }, [dataSource]);

  const previewRedaction = useCallback(async () => {
    try {
      const preview = await securityRedactPreview(redactionInput);
      setRedactionPreview(preview);
      setWorkspaceMessage("脱敏预览已刷新。");
    } catch (error) {
      setWorkspaceMessage(`脱敏预览失败：${String(error)}`);
    }
  }, [redactionInput]);

  const deleteSecretMetadata = useCallback(
    async (secretId: string) => {
      try {
        await secretDelete(secretId);
        setSecrets(await secretList());
        setWorkspaceMessage(`已删除密钥元数据 ${secretId}。`);
      } catch (error) {
        setWorkspaceMessage(`删除密钥元数据失败：${String(error)}`);
      }
    },
    [],
  );

  const deleteKnownHost = useCallback(async (host: string) => {
    try {
      await knownHostDelete(host);
      setKnownHosts(await knownHostsList());
      setWorkspaceMessage(`已删除已知主机 ${host}。`);
    } catch (error) {
      setWorkspaceMessage(`删除已知主机失败：${String(error)}`);
    }
  }, []);

  const clearLogs = useCallback(async () => {
    try {
      if (dataSource === "mock") {
        setLogs([]);
        setWorkspaceMessage("已清除演示日志。");
        return;
      }

      const nextLogs = await logClear();
      setLogs(nextLogs);
      setWorkspaceMessage("已清除工作区日志。");
    } catch (error) {
      setWorkspaceMessage(`清除日志失败：${String(error)}`);
    }
  }, [dataSource]);

  useEffect(() => {
    void refreshWorkspace();
  }, [refreshWorkspace]);

  const openProfileConnection = useCallback(async (
    profile: ConnectionProfile,
    options: OpenConnectionOptions = {},
  ): Promise<OpenConnectionResult> => {
    try {
      setSessionNotice("");
      const passwordForAuth =
        (profile.type === "ssh" || profile.type === "sftp") &&
        profile.authType === "password"
          ? options.secret || (await secretGet(profile.id, "password")) || ""
          : "";
      let session = await connectionOpen(profile);
      setPendingKnownHost(null);
      let authenticatedByDialog = false;

      if (
        options.authenticate &&
        (profile.type === "ssh" || profile.type === "sftp") &&
        profile.authType === "password"
      ) {
        const password = passwordForAuth;

        if (!password) {
          const message = "密码认证需要填写 SSH 密码。";
          setWorkspaceMessage(message);
          return connectionResult("failed", message);
        }

        session = await sshAuthenticatePassword(session.id, password);
        if (options.rememberSecret && options.secret) {
          const metadata = await secretSet(profile.id, "password", options.secret);
          setSecrets((current) => [
            metadata,
            ...current.filter((item) => item.id !== metadata.id),
          ]);
        }
        authenticatedByDialog = true;
      }

      if (
        options.authenticate &&
        (profile.type === "ssh" || profile.type === "sftp") &&
        profile.authType === "private-key"
      ) {
        session = await sshAuthenticatePrivateKey(
          session.id,
          profile.privateKeyPath ?? "",
          options.secret || undefined,
        );
        authenticatedByDialog = true;
      }

      if (
        options.authenticate &&
        (profile.type === "ssh" || profile.type === "sftp") &&
        profile.authType === "agent"
      ) {
        session = await sshAuthenticateAgent(session.id);
        authenticatedByDialog = true;
      }

      clearFileTransferView();
      let fileTransferMessage = "";
      let openedFileTransferSession: FileTransferSession | null = null;

      if (profile.type === "sftp") {
        const transferSession = await fileTransferOpen(session.id);
        openedFileTransferSession = transferSession;
        setActiveFileTransferSession(transferSession);
        session = {
          ...session,
          transport: session.transport
            ? {
                ...session.transport,
                fileTransferReady: true,
              }
            : session.transport,
        };

        try {
          setRemotePathState(remoteRootPath);
          const entries = await fileTransferList(transferSession.id, remoteRootPath);
          setRemoteEntries(entries);
          fileTransferMessage = `已加载 ${entries.length} 个远程条目。`;
        } catch (error) {
          fileTransferMessage = `SFTP 已打开，读取目录失败：${String(error)}`;
        }
      }

      let terminal: TerminalSession | null = null;
      let initialTerminalSnapshot: TerminalSnapshot | null = null;
      let attachMessage = "";

      if (session.capabilities.terminal) {
        try {
          const attached = await attachTerminalWithSnapshot(session.id);
          terminal = attached.terminal;
          initialTerminalSnapshot = attached.snapshot;
        } catch (error) {
          if (profile.type === "serial") {
            await connectionClose(session.id).catch(() => undefined);
            throw error;
          }
          attachMessage = ` 终端附加待处理：${String(error)}`;
        }
      }

      const nextTab: WorkspaceSessionTab = {
        id: session.id,
        kind: profile.type === "sftp" ? "file-transfer" : "terminal",
        connection: session,
        fileTransferSession: openedFileTransferSession,
        terminal,
        terminalSnapshot: initialTerminalSnapshot,
      };

	      setSessionTabs((current) => [
	        ...current.filter((tab) => tab.connection.id !== session.id),
	        nextTab,
	      ]);
      setActiveConnection(session);
      setActiveSessionTabId(session.id);
      setActiveTerminal(terminal);
      setTerminalSnapshotState(initialTerminalSnapshot);
      const message =
        authenticatedByDialog && terminal
          ? `${session.title} 已认证，并附加终端 ${terminal.id}。`
          : authenticatedByDialog && profile.type === "sftp"
          ? `${session.title} 已认证，SFTP 文件传输已打开。${fileTransferMessage}`
          : authenticatedByDialog
          ? `${session.title} 已认证。${attachMessage}`
          : terminal
          ? `${session.title} 已打开，并附加终端 ${terminal.id}。`
          : `${session.title} 传输已打开。${attachMessage}`;
      setWorkspaceMessage(message);
      setActiveProfileId(profile.id);

      try {
        await profileMarkRecent(profile.id);
        await refreshWorkspace();
      } catch {
        // Recent list refresh is not required for the live connection to stay usable.
      }

      return connectionResult("opened", message);
    } catch (error) {
      const trustResult = await resolveHostTrustFailure(profile, error);
      if (trustResult) {
        return trustResult;
      }

      const message = `连接失败：${String(error)}`;
      setWorkspaceMessage(message);
      return connectionResult("failed", message);
    }
  }, [attachTerminalWithSnapshot, clearFileTransferView, refreshWorkspace, remotePath, resolveHostTrustFailure]);

  const openActiveConnection = useCallback(
    () => openProfileConnection(activeProfile),
    [activeProfile, openProfileConnection],
  );
  const openLocalShellTab = useCallback(async (): Promise<OpenConnectionResult> => {
    if (dataSource === "mock") {
      const message = "本地终端需要在 Tauri 桌面环境中运行。";
      setWorkspaceMessage(message);
      return connectionResult("failed", message);
    }

    try {
      setSessionNotice("");
      const opened = await localShellOpen(defaultTerminalSize);
      const nextTab: WorkspaceSessionTab = {
        id: opened.connection.id,
        kind: "terminal",
        connection: opened.connection,
        terminal: opened.terminal,
        terminalSnapshot: opened.terminalSnapshot,
      };

      setSessionTabs((current) => [
        ...current.filter((tab) => (tab.id ?? tab.connection.id) !== opened.connection.id),
        nextTab,
      ]);
      setActiveConnection(opened.connection);
      setActiveSessionTabId(opened.connection.id);
      setActiveTerminal(opened.terminal);
      setTerminalSnapshotState(opened.terminalSnapshot);
      clearFileTransferView();

      const message = `${opened.connection.title} 已打开。`;
      setWorkspaceMessage(message);
      return connectionResult("opened", message);
    } catch (error) {
      const message = `本地终端打开失败：${String(error)}`;
      setWorkspaceMessage(message);
      return connectionResult("failed", message);
    }
  }, [clearFileTransferView, dataSource]);
  const reportWorkspaceMessage = useCallback((message: string) => {
    setWorkspaceMessage(message);
  }, []);

  const reconnectSessionTab = useCallback(async (
    tabId: string,
    options: OpenConnectionOptions = {},
    profileOverride?: ConnectionProfile,
  ): Promise<OpenConnectionResult> => {
    const reconnectIndex = sessionTabs.findIndex((tab) => (tab.id ?? tab.connection.id) === tabId);
    const reconnectTab = reconnectIndex >= 0 ? sessionTabs[reconnectIndex] : null;

    if (!reconnectTab) {
      const message = `未找到可重连的标签：${tabId}。`;
      setWorkspaceMessage(message);
      return connectionResult("failed", message);
    }

    if ((reconnectTab.kind ?? "terminal") === "file-transfer") {
      const message = "SFTP 文件标签不支持直接重连，请重连它所属的 SSH 标签。";
      setWorkspaceMessage(message);
      return connectionResult("failed", message);
    }

    if (reconnectTab.connection.transport?.kind === "local-shell") {
      if (dataSource === "mock") {
        const message = "本地终端需要在 Tauri 桌面环境中运行。";
        setWorkspaceMessage(message);
        return connectionResult("failed", message);
      }

      try {
        if (reconnectTab.terminal) {
          await terminalClose(reconnectTab.terminal.id).catch(() => undefined);
        }

        await connectionClose(reconnectTab.connection.id).catch(() => undefined);

        const opened = await localShellOpen(defaultTerminalSize);
        const nextTab: WorkspaceSessionTab = {
          id: opened.connection.id,
          kind: "terminal",
          connection: opened.connection,
          terminal: opened.terminal,
          terminalSnapshot: opened.terminalSnapshot,
        };

        setSessionTabs((current) => {
          const filtered = current.filter((tab) => (tab.id ?? tab.connection.id) !== tabId);
          const nextIndex = Math.min(reconnectIndex, filtered.length);
          const nextTabs = [...filtered];
          nextTabs.splice(nextIndex, 0, nextTab);
          return nextTabs;
        });
        clearFileTransferView();
        setActiveConnection(opened.connection);
        setActiveSessionTabId(opened.connection.id);
        setActiveTerminal(opened.terminal);
        setTerminalSnapshotState(opened.terminalSnapshot);

        const message = `${opened.connection.title} 已重连。`;
        setWorkspaceMessage(message);
        return connectionResult("opened", message);
      } catch (error) {
        const message = `本地终端重连失败：${String(error)}`;
        setWorkspaceMessage(message);
        return connectionResult("failed", message);
      }
    }

    const profile = profileOverride ?? profiles.find((item) => item.id === reconnectTab.connection.profileId);

    if (!profile) {
      const message = `未找到标签对应的连接配置：${reconnectTab.connection.profileId}。`;
      setWorkspaceMessage(message);
      return connectionResult("failed", message);
    }

    const savedPassword =
      (profile.type === "ssh" || profile.type === "sftp") &&
      profile.authType === "password" &&
      !options.secret
        ? await secretGet(profile.id, "password")
        : null;
    const needsSecret =
      (profile.type === "ssh" || profile.type === "sftp") &&
      profile.authType === "password" &&
      !options.secret &&
      !savedPassword;

    if (needsSecret) {
      const message = "密码认证需要重新输入密码。";
      setWorkspaceMessage(message);
      return connectionResult("failed", message);
    }

    try {
      if (reconnectTab.terminal) {
        await terminalClose(reconnectTab.terminal.id).catch(() => undefined);
      }

      await connectionClose(reconnectTab.connection.id).catch(() => undefined);

      let session = await connectionOpen(profile);
      setPendingKnownHost(null);

      if (
        (profile.type === "ssh" || profile.type === "sftp") &&
        profile.authType === "password"
      ) {
        const password = options.secret || savedPassword || "";

        session = await sshAuthenticatePassword(session.id, password);
        if (options.rememberSecret && options.secret) {
          const metadata = await secretSet(profile.id, "password", options.secret);
          setSecrets((current) => [
            metadata,
            ...current.filter((item) => item.id !== metadata.id),
          ]);
        }
      }

      if (
        (profile.type === "ssh" || profile.type === "sftp") &&
        profile.authType === "private-key"
      ) {
        session = await sshAuthenticatePrivateKey(
          session.id,
          profile.privateKeyPath ?? "",
          options.secret || undefined,
        );
      }

      if (
        (profile.type === "ssh" || profile.type === "sftp") &&
        profile.authType === "agent"
      ) {
        session = await sshAuthenticateAgent(session.id);
      }

      let terminal: TerminalSession | null = null;
      let initialTerminalSnapshot: TerminalSnapshot | null = null;
      let attachMessage = "";

      if (session.capabilities.terminal) {
        try {
          const attached = await attachTerminalWithSnapshot(session.id);
          terminal = attached.terminal;
          initialTerminalSnapshot = attached.snapshot;
        } catch (error) {
          if (profile.type === "serial") {
            await connectionClose(session.id).catch(() => undefined);
            throw error;
          }
          attachMessage = ` 终端附加待处理：${String(error)}`;
        }
      }

      const nextTab: WorkspaceSessionTab = {
        id: session.id,
        kind: "terminal",
        connection: session,
        terminal,
        terminalSnapshot: initialTerminalSnapshot,
      };

      setSessionTabs((current) => {
        const filtered = current.filter(
          (tab) =>
            (tab.id ?? tab.connection.id) !== tabId &&
            tab.parentConnectionId !== reconnectTab.connection.id,
        );
        const nextIndex = Math.min(reconnectIndex, filtered.length);
        const nextTabs = [...filtered];
        nextTabs.splice(nextIndex, 0, nextTab);
        return nextTabs;
      });
      clearFileTransferView();
      setActiveConnection(session);
      setActiveSessionTabId(session.id);
      setActiveTerminal(terminal);
      setTerminalSnapshotState(initialTerminalSnapshot);
      setActiveProfileId(profile.id);
      const message = terminal
          ? `${session.title} 已重连，并附加终端 ${terminal.id}。`
          : `${session.title} 已重连。${attachMessage}`;
      setWorkspaceMessage(message);

      try {
        await profileMarkRecent(profile.id);
        await refreshWorkspace();
      } catch {
        // Recent list refresh is not required for the live connection to stay usable.
      }

      return connectionResult("opened", message);
    } catch (error) {
      const trustResult = await resolveHostTrustFailure(profile, error);
      if (trustResult) {
        return trustResult;
      }

      const message = `重连失败：${String(error)}`;
      setWorkspaceMessage(message);
      return connectionResult("failed", message);
    }
  }, [attachTerminalWithSnapshot, clearFileTransferView, dataSource, profiles, refreshWorkspace, resolveHostTrustFailure, sessionTabs]);

  const authenticateActiveSshPassword = useCallback(async () => {
    if (!activeConnection) {
      setWorkspaceMessage("请先打开 SSH 连接再进行认证。");
      return;
    }

    if (
      (activeProfile.type === "ssh" || activeProfile.type === "sftp") &&
      activeProfile.authType === "password" &&
      !sshPassword
    ) {
      setWorkspaceMessage("密码认证需要填写 SSH 密码。");
      return;
    }

    try {
      let session =
        (activeProfile.type === "ssh" || activeProfile.type === "sftp") &&
        activeProfile.authType === "private-key"
          ? await sshAuthenticatePrivateKey(
              activeConnection.id,
              activeProfile.privateKeyPath ?? "",
              sshPassword || undefined,
            )
          : (activeProfile.type === "ssh" || activeProfile.type === "sftp") &&
            activeProfile.authType === "agent"
          ? await sshAuthenticateAgent(activeConnection.id)
          : await sshAuthenticatePassword(activeConnection.id, sshPassword);
      let fileTransferMessage = "";

      if (activeProfile.type === "sftp") {
        clearFileTransferView();
        const transferSession = await fileTransferOpen(session.id);
        setActiveFileTransferSession(transferSession);
        session = {
          ...session,
          transport: session.transport
            ? {
                ...session.transport,
                fileTransferReady: true,
              }
            : session.transport,
        };

        try {
          setRemotePathState(remoteRootPath);
          const entries = await fileTransferList(transferSession.id, remoteRootPath);
          setRemoteEntries(entries);
          fileTransferMessage = `已加载 ${entries.length} 个远程条目。`;
        } catch (error) {
          fileTransferMessage = `SFTP 已打开，读取目录失败：${String(error)}`;
        }
      }
      let terminal: TerminalSession | null = null;
      let initialTerminalSnapshot: TerminalSnapshot | null = null;
      let attachMessage = "";

      if (session.capabilities.terminal) {
        try {
          const attached = await attachTerminalWithSnapshot(session.id);
          terminal = attached.terminal;
          initialTerminalSnapshot = attached.snapshot;
        } catch (error) {
          attachMessage = ` PTY 附加待处理：${String(error)}`;
        }
      }

      setActiveConnection(session);
      setActiveSessionTabId(session.id);
      setSessionTabs((current) =>
        current.map((tab) =>
          tab.connection.id === session.id
            ? {
                ...tab,
                id: tab.id ?? session.id,
                kind: "terminal",
                connection: session,
                terminal,
                terminalSnapshot: initialTerminalSnapshot,
              }
            : tab,
        ),
      );
      setActiveTerminal(terminal);
      setTerminalSnapshotState(initialTerminalSnapshot);
      setSshPassword("");
      setWorkspaceMessage(
        activeProfile.type === "sftp"
          ? `${session.title} 已认证，SFTP 文件传输已打开。${fileTransferMessage}`
          : terminal
          ? `${session.title} 已认证，并附加 PTY ${terminal.id}。`
          : `${session.title} 已认证。${attachMessage}`,
      );
      await refreshWorkspace();
    } catch (error) {
      setWorkspaceMessage(`SSH 认证失败：${String(error)}`);
    }
  }, [activeConnection, activeProfile, attachTerminalWithSnapshot, clearFileTransferView, refreshWorkspace, remotePath, sshPassword]);

  const createProfileDraft = useCallback(
    (type: ConnectionProfile["type"] = "ssh") => newConnectionProfile(type),
    [],
  );

  const saveProfile = useCallback(
    async (profile: ConnectionProfile, options: SaveProfileOptions = {}) => {
      const isExistingProfile = profiles.some((item) => item.id === profile.id);
      const duplicateProfile = isExistingProfile
        ? null
        : profiles.find((item) => profileDedupKey(item) === profileDedupKey(profile));
      const updatedProfile = {
        ...profile,
        id: duplicateProfile?.id ?? profile.id,
        createdAt: duplicateProfile?.createdAt ?? profile.createdAt,
        updatedAt: new Date().toISOString(),
      } as ConnectionProfile;

      try {
        if (isExistingProfile || duplicateProfile) {
          await profileUpdate(updatedProfile.id, updatedProfile);
        } else {
          await profileCreate(updatedProfile);
        }
        let passwordMessage = "";
        if (
          options.rememberSecret &&
          options.secret &&
          (updatedProfile.type === "ssh" || updatedProfile.type === "sftp") &&
          updatedProfile.authType === "password"
        ) {
          const metadata = await secretSet(updatedProfile.id, "password", options.secret);
          setSecrets((current) => [
            metadata,
            ...current.filter((item) => item.id !== metadata.id),
          ]);
          passwordMessage = "，已保存密码";
        } else if (
          options.rememberSecret &&
          (updatedProfile.type === "ssh" || updatedProfile.type === "sftp") &&
          updatedProfile.authType === "password"
        ) {
          passwordMessage = "，未输入新密码，密码未更新";
        }
        await refreshWorkspace();
        setActiveProfileId(updatedProfile.id);
        setWorkspaceMessage(`已保存配置 ${updatedProfile.name}${passwordMessage}。`);
        return updatedProfile;
      } catch (error) {
        if (dataSource === "mock") {
          setProfiles((current) => [
            updatedProfile,
            ...current.filter((item) => item.id !== updatedProfile.id),
          ]);
          setActiveProfileId(updatedProfile.id);
          setWorkspaceMessage(`已在演示数据中保存配置 ${updatedProfile.name}。`);
          return updatedProfile;
        }

        setWorkspaceMessage(`保存配置失败：${String(error)}`);
        return null;
      }
    },
    [dataSource, profiles, refreshWorkspace],
  );

  const deleteProfile = useCallback(
    async (profileId: string) => {
      try {
        await profileDelete(profileId);
        await refreshWorkspace();
        setSessionTabs((current) => current.filter((tab) => tab.connection.profileId !== profileId));
        setActiveConnection(null);
        setActiveSessionTabId("");
        setActiveTerminal(null);
        setTerminalSnapshotState(null);
        setRemoteEntries(emptyRemoteEntries);
        setSelectedRemoteEntry(null);
        setActiveFileTransferSession(null);
        setWorkspaceMessage(`已删除配置 ${profileId}。`);
      } catch (error) {
        if (dataSource === "mock") {
          setProfiles((current) => {
            const remaining = current.filter((item) => item.id !== profileId);
            setActiveProfileId(remaining[0]?.id ?? "");
            return remaining.length > 0 ? remaining : sampleProfiles;
          });
          setSessionTabs((current) => current.filter((tab) => tab.connection.profileId !== profileId));
          setActiveConnection(null);
          setActiveSessionTabId("");
          setActiveTerminal(null);
          setTerminalSnapshotState(null);
          setRemoteEntries(emptyRemoteEntries);
          setSelectedRemoteEntry(null);
          setActiveFileTransferSession(null);
          setWorkspaceMessage(`已从演示数据中删除配置 ${profileId}。`);
          return;
        }

        setWorkspaceMessage(`删除配置失败：${String(error)}`);
      }
    },
    [dataSource, refreshWorkspace],
  );

  const testProfile = useCallback(async (
    profile: ConnectionProfile,
    options: TestConnectionOptions = {},
  ): Promise<TestConnectionResult> => {
    try {
      const result = await profileTestConnection(profile, options.secret);
      if (result.requiresFingerprintConfirmation && result.host && result.fingerprint) {
        setPendingKnownHost({ host: result.host, fingerprint: result.fingerprint });
      } else {
        setPendingKnownHost(null);
      }
      setWorkspaceMessage(result.message);
      return result;
    } catch (error) {
      const result = {
        ok: false,
        message: `测试配置失败：${String(error)}`,
        requiresFingerprintConfirmation: false,
      };
      setWorkspaceMessage(result.message);
      return result;
    }
  }, []);

  const closeConnection = useCallback(async (connectionId: string) => {
    const closingTabIndex = sessionTabs.findIndex((tab) => (tab.id ?? tab.connection.id) === connectionId);
    const closingTab = closingTabIndex >= 0 ? sessionTabs[closingTabIndex] : null;

    if (!closingTab) {
      setWorkspaceMessage(`未找到可关闭的连接：${connectionId}。`);
      return;
    }

    if ((closingTab.kind ?? "terminal") === "file-transfer") {
      try {
        if (closingTab.fileTransferSession) {
          await fileTransferClose(closingTab.fileTransferSession.id);
        }

        if (!closingTab.parentConnectionId) {
          await connectionClose(closingTab.connection.id);
        }
      } catch (error) {
        setWorkspaceMessage(`断开 SFTP 连接失败：${String(error)}`);
        return;
      }

      const remainingTabs = sessionTabs.filter((tab) => (tab.id ?? tab.connection.id) !== connectionId);
      const nextTab =
        remainingTabs[closingTabIndex - 1] ??
        remainingTabs[closingTabIndex] ??
        remainingTabs[remainingTabs.length - 1] ??
        null;
	      setSessionTabs(remainingTabs);
	      setWorkspaceMessage("");

      if (activeSessionTabId === connectionId) {
        if (nextTab) {
          activateSessionTab(nextTab);
        } else {
	          setSessionNotice("");
	          setActiveSessionTabId("");
	          setActiveConnection(null);
          setActiveTerminal(null);
          setTerminalSnapshotState(null);
          clearFileTransferView();
        }
      }
      return;
    }

    try {
      if (closingTab.terminal) {
        await terminalClose(closingTab.terminal.id);
      }

      await connectionClose(connectionId);
	      const remainingTabs = sessionTabs.filter(
        (tab) =>
          (tab.id ?? tab.connection.id) !== connectionId &&
          tab.parentConnectionId !== closingTab.connection.id,
      );
      const isClosingActive =
        activeSessionTabId === connectionId ||
        activeConnection?.id === connectionId ||
        activeConnection?.id === `${closingTab.connection.id}:sftp`;
      const nextTab =
        remainingTabs[closingTabIndex - 1] ??
        remainingTabs[closingTabIndex] ??
        remainingTabs[remainingTabs.length - 1] ??
        null;

	      setSessionTabs(remainingTabs);
	      setWorkspaceMessage("");
	      setSshPassword("");

      if (isClosingActive) {
        if (nextTab) {
          activateSessionTab(nextTab);
        } else {
	          setSessionNotice("");
	          setActiveSessionTabId("");
          setActiveConnection(null);
          setActiveTerminal(null);
          setTerminalSnapshotState(null);
          clearFileTransferView();
        }
      }
    } catch (error) {
      setWorkspaceMessage(`断开连接失败：${String(error)}`);
    }
  }, [activeConnection?.id, activeSessionTabId, activateSessionTab, clearFileTransferView, sessionTabs]);

  const closeActiveConnection = useCallback(async () => {
    if (!activeConnection) {
      setWorkspaceMessage("没有可断开的活动连接。");
      return;
    }

    await closeConnection(activeConnection.id);
  }, [activeConnection, closeConnection]);

  const selectActiveProfile = useCallback((profileId: string) => {
    setActiveProfileId(profileId);
    setWorkspaceMessage("已选择保存的连接。");
    setSshPassword("");
  }, []);

  const sendTerminalData = useCallback(
    async (data: string, terminalId?: string) => {
      const targetTerminal = terminalId
        ? activeTerminal?.id === terminalId
          ? activeTerminal
          : sessionTabs.find((tab) => tab.terminal?.id === terminalId)?.terminal ?? null
        : activeTerminal;

      if (!targetTerminal) {
        setWorkspaceMessage(
          terminalId
            ? `终端会话不存在，无法写入输入：${terminalId}。`
            : "请先打开连接再写入终端输入。",
        );
        return;
      }

      try {
        await terminalWrite(targetTerminal.id, data);
      } catch (error) {
        setWorkspaceMessage(`终端写入失败：${String(error)}`);
      }
    },
    [activeTerminal, sessionTabs],
  );

  const resizeActiveTerminal = useCallback(async (size?: TerminalSize, terminalId?: string) => {
    const targetTerminal = terminalId
      ? activeTerminal?.id === terminalId
        ? activeTerminal
        : sessionTabs.find((tab) => tab.terminal?.id === terminalId)?.terminal ?? null
      : activeTerminal;

    if (!targetTerminal) {
      setWorkspaceMessage(
        terminalId
          ? `终端会话不存在，无法调整尺寸：${terminalId}。`
          : "请先打开连接再调整终端尺寸。",
      );
      return;
    }

    const nextSize = size ?? {
      ...targetTerminal.size,
      cols: targetTerminal.size.cols === 100 ? 120 : 100,
      rows: targetTerminal.size.rows === 30 ? 36 : 30,
      widthPx: targetTerminal.size.widthPx === 1200 ? 1440 : 1200,
      heightPx: targetTerminal.size.heightPx === 720 ? 864 : 720,
    };

    if (
      targetTerminal.size.cols === nextSize.cols &&
      targetTerminal.size.rows === nextSize.rows &&
      targetTerminal.size.widthPx === nextSize.widthPx &&
      targetTerminal.size.heightPx === nextSize.heightPx
    ) {
      return;
    }

    try {
      const resizedTerminal = { ...targetTerminal, size: nextSize };
      await terminalResize(targetTerminal.id, nextSize);
      setSessionTabs((current) =>
        current.map((tab) =>
          tab.terminal?.id === targetTerminal.id
            ? {
                ...tab,
                terminal: resizedTerminal,
              }
            : tab,
        ),
      );

      if (activeTerminal?.id === targetTerminal.id) {
        setActiveTerminal(resizedTerminal);
      }

      if (!size) {
        setWorkspaceMessage(`已将 ${targetTerminal.id} 调整为 ${nextSize.cols}x${nextSize.rows}。`);
      }
    } catch (error) {
      setWorkspaceMessage(`终端尺寸调整失败：${String(error)}`);
    }
  }, [activeTerminal, sessionTabs]);

  const refreshTerminalSnapshot = useCallback(async () => {
    if (!activeTerminal) {
      setWorkspaceMessage("请先打开连接再读取终端快照。");
      return;
    }

    try {
      const snapshot = await terminalSnapshot(activeTerminal.id);
      setTerminalSnapshotState(snapshot);
      updateActiveSessionTab({ terminalSnapshot: snapshot });
      setWorkspaceMessage(`终端缓冲区：${snapshot.bufferedBytes} 字节。`);
    } catch (error) {
      setWorkspaceMessage(`读取终端快照失败：${String(error)}`);
    }
  }, [activeTerminal, updateActiveSessionTab]);

  const trustProfileHost = useCallback(async (profile: ConnectionProfile) => {
    if (profile.type !== "ssh" && profile.type !== "sftp") {
      setWorkspaceMessage("known_hosts 仅适用于 SSH/SFTP 配置。");
      return false;
    }

    try {
      const pending =
        pendingKnownHost && pendingKnownHost.host === profile.host
          ? pendingKnownHost
          : null;

      if (!pending) {
        setWorkspaceMessage("请先运行测试或连接，以读取待确认的 SSH 指纹。");
        return false;
      }

      const trusted = await knownHostTrustPlaceholder(pending.host, pending.fingerprint);
      setPendingKnownHost(null);
      setWorkspaceMessage(`已信任 ${trusted.host} 的待确认 SSH 指纹：${trusted.fingerprint}。`);
      await refreshWorkspace();
      return true;
    } catch (error) {
      setWorkspaceMessage(`更新 known_hosts 失败：${String(error)}`);
      return false;
    }
  }, [pendingKnownHost, refreshWorkspace]);

  const trustActiveHostPlaceholder = useCallback(
    () => trustProfileHost(activeProfile),
    [activeProfile, trustProfileHost],
  );

  const ensureFileTransferSession = useCallback(async () => {
    if (!activeConnection || !activeConnectionCapabilities.fileTransfer) {
      throw new Error("请先打开支持 SSH/SFTP 的连接再执行文件传输操作。");
    }

    if (activeFileTransferSession) {
      return activeFileTransferSession;
    }

    const session = await fileTransferOpen(activeConnection.id);
    setActiveFileTransferSession(session);
    return session;
  }, [activeConnection, activeConnectionCapabilities.fileTransfer, activeFileTransferSession]);

  const refreshLocalFiles = useCallback(async (pathOverride?: string) => {
    try {
      const result = await localFileList(pathOverride ?? localPath);
      setLocalPathState(result.path);
      setLocalEntries(result.entries);
      setSelectedLocalEntry((current) =>
        current ? result.entries.find((entry) => entry.path === current.path) ?? null : null,
      );
      setWorkspaceMessage(`已加载本地目录 ${result.path}，共 ${result.entries.length} 个条目。`);
      return true;
    } catch (error) {
      setWorkspaceMessage(`读取本地目录失败：${String(error)}`);
      return false;
    }
  }, [localPath]);

  useEffect(() => {
    if (dataSource !== "tauri") {
      return;
    }

    void refreshLocalFiles();
    // 本地文件列表只需要在进入 Tauri 数据源后自动加载一次；路径切换由面板显式刷新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSource]);

  const reconnectActiveFileTransfer = useCallback(async (targetPath: string) => {
    const fileTab =
      activeSessionTab && (activeSessionTab.kind ?? "terminal") === "file-transfer"
        ? activeSessionTab
        : null;

    if (!fileTab) {
      setWorkspaceMessage("当前不是 SFTP 文件管理标签，无法从刷新按钮重连。");
      return null;
    }

    const fileTabId = fileTab.id ?? fileTab.connection.id;
    const sourceTab = fileTab.parentConnectionId
      ? sessionTabs.find((tab) => (tab.id ?? tab.connection.id) === fileTab.parentConnectionId) ?? null
      : fileTab;

    if (!sourceTab) {
      setWorkspaceMessage("未找到 SFTP 所属的 SSH 连接标签，无法重连。");
      return null;
    }

    const sourceTabId = sourceTab.id ?? sourceTab.connection.id;
    const profile = profiles.find((item) => item.id === sourceTab.connection.profileId);

    if (!profile) {
      setWorkspaceMessage(`未找到 SFTP 对应的连接配置：${sourceTab.connection.profileId}。`);
      return null;
    }

    let savedPassword: string | null = null;

    if (
      (profile.type === "ssh" || profile.type === "sftp") &&
      profile.authType === "password"
    ) {
      try {
        savedPassword = await secretGet(profile.id, "password");
      } catch {
        savedPassword = null;
      }
    }

    if (
      (profile.type === "ssh" || profile.type === "sftp") &&
      profile.authType === "password" &&
      !savedPassword
    ) {
      setWorkspaceMessage("SFTP 重连需要重新输入 SSH 密码。");
      return null;
    }

    try {
      setSessionNotice("");
      setWorkspaceMessage("SFTP 刷新失败，正在重连...");

      if (sourceTab.terminal) {
        await terminalClose(sourceTab.terminal.id).catch(() => undefined);
      }
      await connectionClose(sourceTab.connection.id).catch(() => undefined);

      let session = await connectionOpen(profile);
      setPendingKnownHost(null);

      if (
        (profile.type === "ssh" || profile.type === "sftp") &&
        profile.authType === "password"
      ) {
        session = await sshAuthenticatePassword(session.id, savedPassword || "");
      }

      if (
        (profile.type === "ssh" || profile.type === "sftp") &&
        profile.authType === "private-key"
      ) {
        session = await sshAuthenticatePrivateKey(session.id, profile.privateKeyPath ?? "");
      }

      if (
        (profile.type === "ssh" || profile.type === "sftp") &&
        profile.authType === "agent"
      ) {
        session = await sshAuthenticateAgent(session.id);
      }

      const transferSession = await fileTransferOpen(session.id);
      const entries = await fileTransferList(transferSession.id, targetPath);
      const readySession: ConnectionSummary = {
        ...session,
        transport: session.transport
          ? {
              ...session.transport,
              fileTransferReady: true,
            }
          : session.transport,
      };
      let terminal: TerminalSession | null = null;
      let initialTerminalSnapshot: TerminalSnapshot | null = null;

      if (fileTab.parentConnectionId && readySession.capabilities.terminal) {
        try {
          const attached = await attachTerminalWithSnapshot(readySession.id);
          terminal = attached.terminal;
          initialTerminalSnapshot = attached.snapshot;
        } catch {
          terminal = null;
          initialTerminalSnapshot = null;
        }
      }

      const nextFileTabId = fileTab.parentConnectionId
        ? `${readySession.id}:sftp:${transferSession.id}`
        : readySession.id;
      const nextFileConnection: ConnectionSummary = fileTab.parentConnectionId
        ? {
            ...readySession,
            id: nextFileTabId,
            title: `${readySession.title} / SFTP`,
            capabilities: {
              ...readySession.capabilities,
              terminal: false,
              fileTransfer: true,
              sftp: true,
            },
          }
        : readySession;
      const nextFileTab: WorkspaceSessionTab = {
        id: nextFileTabId,
        kind: "file-transfer",
        connection: nextFileConnection,
        fileTransferSession: transferSession,
        parentConnectionId: fileTab.parentConnectionId ? readySession.id : undefined,
        terminal: null,
        terminalSnapshot: null,
      };

      setSessionTabs((current) => {
        if (!fileTab.parentConnectionId) {
          return current.map((tab) => ((tab.id ?? tab.connection.id) === fileTabId ? nextFileTab : tab));
        }

        const nextSourceTab: WorkspaceSessionTab = {
          ...sourceTab,
            id: readySession.id,
            kind: "terminal",
            connection: readySession,
            terminal,
            terminalSnapshot: initialTerminalSnapshot,
          };

        return current.map((tab) => {
          const currentTabId = tab.id ?? tab.connection.id;

          if (currentTabId === sourceTabId) {
            return nextSourceTab;
          }

          if (currentTabId === fileTabId) {
            return nextFileTab;
          }

          return tab;
        });
      });
      setActiveSessionTabId(nextFileTabId);
      setActiveConnection(nextFileConnection);
      setActiveTerminal(null);
      setTerminalSnapshotState(null);
      setActiveFileTransferSession(transferSession);
      setRemotePathState(targetPath);
      setRemoteEntries(entries);
      setSelectedRemoteEntry((current) =>
        current ? entries.find((entry) => entry.path === current.path) ?? null : null,
      );
      setWorkspaceMessage(`SFTP 已重连并刷新 ${targetPath}，共 ${entries.length} 个远程条目。`);
      await refreshWorkspace().catch(() => undefined);
      return transferSession;
    } catch (error) {
      const trustResult = await resolveHostTrustFailure(profile, error);
      if (trustResult) {
        return null;
      }

      setWorkspaceMessage(`SFTP 重连失败：${String(error)}`);
      return null;
    }
  }, [activeSessionTab, attachTerminalWithSnapshot, profiles, refreshWorkspace, resolveHostTrustFailure, sessionTabs]);

  const refreshRemoteFiles = useCallback(async (pathOverride?: string) => {
    const targetPath = normalizeRemotePathInput(pathOverride ?? remotePath);

    try {
      const session = await ensureFileTransferSession();
      const entries = await fileTransferList(session.id, targetPath);
      setRemotePathState(targetPath);
      setRemoteEntries(entries);
      setSelectedRemoteEntry((current) =>
        current ? entries.find((entry) => entry.path === current.path) ?? null : null,
      );
      setWorkspaceMessage(`已从 ${session.protocol} 加载 ${entries.length} 个远程条目。`);
      return true;
    } catch (error) {
      setWorkspaceMessage(`文件传输失败，正在尝试重连 SFTP：${String(error)}`);
      return Boolean(await reconnectActiveFileTransfer(targetPath));
    }
  }, [ensureFileTransferSession, reconnectActiveFileTransfer, remotePath]);

  useEffect(() => {
    const previousStatuses = transferStatusRef.current;
    const completedTasks = transfers.filter((task) => {
      const previousStatus = previousStatuses.get(task.id);
      return task.status === "completed" && Boolean(previousStatus) && previousStatus !== "completed";
    });

    transferStatusRef.current = new Map(transfers.map((task) => [task.id, task.status]));

    if (dataSource !== "tauri" || completedTasks.length === 0) {
      return;
    }

    const localRefreshPaths = new Set<string>();
    const remoteRefreshPaths = new Set<string>();
    const activeRemoteConnectionId = activeFileTransferSession?.connectionId ?? null;

    for (const task of completedTasks) {
      if (task.direction === "download") {
        const targetDirectory = localDirectoryName(task.localPath);
        if (targetDirectory && !isVirtualLocalPath(targetDirectory)) {
          localRefreshPaths.add(targetDirectory);
        }
        continue;
      }

      if (!activeRemoteConnectionId || task.connectionId !== activeRemoteConnectionId) {
        continue;
      }

      remoteRefreshPaths.add(remoteDirectoryName(task.remotePath));
    }

    if (localRefreshPaths.size === 0 && remoteRefreshPaths.size === 0) {
      return;
    }

    void (async () => {
      let refreshedLocalCount = 0;
      let refreshedRemoteCount = 0;

      for (const targetPath of localRefreshPaths) {
        if (await refreshLocalFiles(targetPath)) {
          refreshedLocalCount += 1;
        }
      }

      for (const targetPath of remoteRefreshPaths) {
        if (await refreshRemoteFiles(targetPath)) {
          refreshedRemoteCount += 1;
        }
      }

      const refreshedParts = [
        refreshedLocalCount ? `${refreshedLocalCount} 个本地目录` : "",
        refreshedRemoteCount ? `${refreshedRemoteCount} 个远程目录` : "",
      ].filter(Boolean);

      if (refreshedParts.length > 0) {
        setWorkspaceMessage(`传输完成，已刷新 ${refreshedParts.join("、")}。`);
      }
    })();
  }, [activeFileTransferSession?.connectionId, dataSource, refreshLocalFiles, refreshRemoteFiles, transfers]);

  const openFileTransferTab = useCallback(async (connectionId?: string) => {
    const requestedTab =
      sessionTabs.find((tab) => (tab.id ?? tab.connection.id) === connectionId) ??
      sessionTabs.find((tab) => (tab.id ?? tab.connection.id) === activeSessionTabId) ??
      null;
    const sourceTab =
      requestedTab && (requestedTab.kind ?? "terminal") === "file-transfer"
        ? sessionTabs.find((tab) => (tab.id ?? tab.connection.id) === requestedTab.parentConnectionId) ?? null
        : requestedTab;
    const sourceConnection = sourceTab?.connection ?? activeConnection;

    if (!sourceConnection || !sourceConnection.capabilities.fileTransfer) {
      setWorkspaceMessage("请先打开支持 SFTP 的 SSH 连接。");
      return;
    }

    if (!sourceConnection.transport?.authenticated) {
      setWorkspaceMessage("请先完成 SSH 认证，再打开 SFTP 文件管理。");
      return;
    }

    const existingFileTab = sessionTabs.find(
      (tab) =>
        (tab.kind ?? "terminal") === "file-transfer" &&
        (tab.parentConnectionId === sourceConnection.id ||
          tab.fileTransferSession?.connectionId === sourceConnection.id),
    );

    if (existingFileTab?.fileTransferSession) {
      const existingTabId = existingFileTab.id ?? existingFileTab.connection.id;
      const targetPath = activeSessionTabId === existingTabId ? remotePath : remoteRootPath;

      setActiveSessionTabId(existingTabId);
      setActiveConnection(existingFileTab.connection);
      setActiveTerminal(null);
      setTerminalSnapshotState(null);
      setActiveFileTransferSession(existingFileTab.fileTransferSession);
      setRemotePathState(targetPath);

      try {
        const entries = await fileTransferList(existingFileTab.fileTransferSession.id, targetPath);
        setRemoteEntries(entries);
        setSelectedRemoteEntry((current) =>
          current ? entries.find((entry) => entry.path === current.path) ?? null : null,
        );
        setWorkspaceMessage(`已切换到 ${sourceConnection.title} 的 SFTP 文件管理，刷新 ${entries.length} 个远程条目。`);
      } catch (error) {
        setWorkspaceMessage(`切换 SFTP 文件管理失败：${String(error)}`);
      }
      return;
    }

    try {
      const session = await fileTransferOpen(sourceConnection.id);
      const tabId = `${sourceConnection.id}:sftp:${session.id}`;
      const nextConnection: ConnectionSummary = {
        ...sourceConnection,
        id: tabId,
        title: `${sourceConnection.title} / SFTP`,
        capabilities: {
          ...sourceConnection.capabilities,
          terminal: false,
          fileTransfer: true,
          sftp: true,
        },
        transport: sourceConnection.transport
          ? {
              ...sourceConnection.transport,
              fileTransferReady: true,
            }
          : sourceConnection.transport,
      };
      const nextTab: WorkspaceSessionTab = {
        id: tabId,
        kind: "file-transfer",
        connection: nextConnection,
        fileTransferSession: session,
        parentConnectionId: sourceConnection.id,
        terminal: null,
        terminalSnapshot: null,
      };

      setSessionTabs((current) => {
        const updated = current.map((tab) =>
          (tab.id ?? tab.connection.id) === sourceConnection.id
            ? {
                ...tab,
                connection: {
                  ...tab.connection,
                  transport: tab.connection.transport
                    ? {
                        ...tab.connection.transport,
                        fileTransferReady: true,
                      }
                    : tab.connection.transport,
                },
              }
            : tab,
        );

        return [
          ...updated,
          nextTab,
        ];
      });
      setActiveSessionTabId(tabId);
      setActiveConnection(nextConnection);
      setActiveTerminal(null);
      setTerminalSnapshotState(null);
      setActiveFileTransferSession(session);
      setRemotePathState(remoteRootPath);
      const entries = await fileTransferList(session.id, remoteRootPath);
      setRemoteEntries(entries);
      setSelectedRemoteEntry((current) =>
        current ? entries.find((entry) => entry.path === current.path) ?? null : null,
      );
      setWorkspaceMessage(`已打开 ${sourceConnection.title} 的 SFTP 文件管理，加载 ${entries.length} 个远程条目。`);
    } catch (error) {
      setWorkspaceMessage(`打开 SFTP 文件管理失败：${String(error)}`);
    }
  }, [activeConnection, activeSessionTabId, remotePath, sessionTabs]);

  const createLocalDirectory = useCallback(
    async (name: string) => {
      if (!name.trim()) {
        setWorkspaceMessage("需要填写本地目录名。");
        return false;
      }

      try {
        const targetPath = joinLocalPath(localPath, name.trim());
        await localFileMkdir(targetPath);
        setWorkspaceMessage(`已创建本地目录 ${targetPath}。`);
        await refreshLocalFiles();
        return true;
      } catch (error) {
        setWorkspaceMessage(`创建本地目录失败：${String(error)}`);
        return false;
      }
    },
    [localPath, refreshLocalFiles],
  );

  const createRemoteDirectory = useCallback(
    async (name: string) => {
      if (!name.trim()) {
        setWorkspaceMessage("需要填写远程目录名。");
        return false;
      }

      try {
        const session = await ensureFileTransferSession();
        const targetPath = `${remotePath.replace(/\/$/, "")}/${name.trim()}`;
        await fileTransferMkdir(session.id, targetPath);
        setWorkspaceMessage(`已创建远程目录 ${targetPath}。`);
        await refreshRemoteFiles();
        return true;
      } catch (error) {
        setWorkspaceMessage(`创建目录失败：${String(error)}`);
        return false;
      }
    },
    [ensureFileTransferSession, refreshRemoteFiles, remotePath],
  );

  const renameLocalEntry = useCallback(
    async (entry: RemoteEntry, nextName: string) => {
      if (!entry) {
        setWorkspaceMessage("请先选择本地条目再重命名。");
        return false;
      }

      if (!nextName.trim()) {
        setWorkspaceMessage("需要填写新的本地名称。");
        return false;
      }

      try {
        const targetPath = joinLocalPath(localPath, nextName.trim());
        await localFileRename(entry.path, targetPath);
        setSelectedLocalEntry(null);
        setWorkspaceMessage(`已将 ${entry.path} 重命名为 ${targetPath}。`);
        await refreshLocalFiles();
        return true;
      } catch (error) {
        setWorkspaceMessage(`本地重命名失败：${String(error)}`);
        return false;
      }
    },
    [localPath, refreshLocalFiles],
  );

  const renameRemoteEntry = useCallback(
    async (entry: RemoteEntry, nextName: string) => {
      if (!entry) {
        setWorkspaceMessage("请先选择远程条目再重命名。");
        return false;
      }

      if (!nextName.trim()) {
        setWorkspaceMessage("需要填写新的远程名称。");
        return false;
      }

      try {
        const session = await ensureFileTransferSession();
        const targetPath = `${remotePath.replace(/\/$/, "")}/${nextName.trim()}`;
        await fileTransferRename(session.id, entry.path, targetPath);
        setSelectedRemoteEntry(null);
        setWorkspaceMessage(`已将 ${entry.path} 重命名为 ${targetPath}。`);
        await refreshRemoteFiles();
        return true;
      } catch (error) {
        setWorkspaceMessage(`重命名失败：${String(error)}`);
        return false;
      }
    },
    [ensureFileTransferSession, refreshRemoteFiles, remotePath],
  );

  const removeRemoteEntry = useCallback(async (entryOverride?: RemoteEntry | null) => {
    const targetEntry = entryOverride ?? selectedRemoteEntry;

    if (!targetEntry) {
      setWorkspaceMessage("请先选择远程条目再删除。");
      return;
    }

    try {
      const session = await ensureFileTransferSession();
      const refreshPath = remoteDirectoryName(targetEntry.path);
      await fileTransferRemove(session.id, targetEntry.path);
      setWorkspaceMessage(`已删除远程条目 ${targetEntry.path}。`);
      setSelectedRemoteEntry(null);
      await refreshRemoteFiles(refreshPath);
    } catch (error) {
      setWorkspaceMessage(`删除失败：${String(error)}`);
    }
  }, [ensureFileTransferSession, refreshRemoteFiles, selectedRemoteEntry]);

  const removeLocalEntry = useCallback(async (entryOverride?: RemoteEntry | null) => {
    const targetEntry = entryOverride ?? selectedLocalEntry;

    if (!targetEntry) {
      setWorkspaceMessage("请先选择本地条目再删除。");
      return;
    }

    try {
      const refreshPath = localDirectoryName(targetEntry.path) || localPath;
      await localFileRemove(targetEntry.path);
      setWorkspaceMessage(`已删除本地条目 ${targetEntry.path}。`);
      setSelectedLocalEntry(null);
      await refreshLocalFiles(refreshPath);
    } catch (error) {
      setWorkspaceMessage(`删除本地条目失败：${String(error)}`);
    }
  }, [localPath, refreshLocalFiles, selectedLocalEntry]);

  const queueUpload = useCallback(
    async (localPath: string, remoteTargetPath: string) => {
      if (!localPath.trim() || !remoteTargetPath.trim()) {
        setWorkspaceMessage("上传需要本地路径和远程路径。");
        return;
      }

      try {
        const session = await ensureFileTransferSession();
        await fileTransferUpload(session.id, localPath.trim(), remoteTargetPath.trim());
        setTransfers(await transferList());
        setWorkspaceMessage(`已加入上传队列：${remoteTargetPath.trim()}。`);
      } catch (error) {
        setWorkspaceMessage(`加入上传队列失败：${String(error)}`);
      }
    },
    [ensureFileTransferSession],
  );

  const queueUploadDirectory = useCallback(
    async (sessionId: string, localRootPath: string, remoteRootPath: string) => {
      let directoryCount = 0;
      let fileCount = 0;
      let skippedCount = 0;

      const ensureRemoteDirectory = async (targetPath: string) => {
        await fileTransferMkdir(sessionId, targetPath).catch((error) => {
          if (!isAlreadyExistsError(error)) {
            throw error;
          }
          return fileTransferList(sessionId, targetPath).catch(() => {
            throw new Error(`远程目标已存在但不是可读取的目录：${targetPath}`);
          });
        });
      };

      const visit = async (sourceDirectory: string, targetDirectory: string) => {
        const result = await localFileList(sourceDirectory);

        for (const entry of result.entries) {
          if (entry.kind === "directory") {
            const nextTargetDirectory = joinRemotePath(targetDirectory, entry.name);
            await ensureRemoteDirectory(nextTargetDirectory);
            directoryCount += 1;
            await visit(entry.path, nextTargetDirectory);
            continue;
          }

          if (entry.kind === "file") {
            await fileTransferUpload(sessionId, entry.path, joinRemotePath(targetDirectory, entry.name));
            fileCount += 1;
            continue;
          }

          skippedCount += 1;
        }
      };

      const normalizedRemoteRoot = normalizeRemotePathInput(remoteRootPath);
      await ensureRemoteDirectory(normalizedRemoteRoot);
      directoryCount += 1;
      await visit(localRootPath, normalizedRemoteRoot);

      return { directoryCount, fileCount, skippedCount };
    },
    [],
  );

  const queueDownloadDirectory = useCallback(
    async (sessionId: string, remoteRootPath: string, localRootPath: string) => {
      let directoryCount = 0;
      let fileCount = 0;
      let skippedCount = 0;

      const ensureLocalDirectory = async (targetPath: string) => {
        await localFileMkdir(targetPath).catch((error) => {
          if (!isAlreadyExistsError(error)) {
            throw error;
          }
          return localFileList(targetPath).catch(() => {
            throw new Error(`本地目标已存在但不是可读取的目录：${targetPath}`);
          });
        });
      };

      const visit = async (sourceDirectory: string, targetDirectory: string) => {
        const entries = await fileTransferList(sessionId, sourceDirectory);

        for (const entry of entries) {
          if (entry.kind === "directory") {
            const nextTargetDirectory = joinLocalPath(targetDirectory, safeLocalDownloadName(entry.name));
            await ensureLocalDirectory(nextTargetDirectory);
            directoryCount += 1;
            await visit(entry.path, nextTargetDirectory);
            continue;
          }

          if (entry.kind === "file") {
            await fileTransferDownload(
              sessionId,
              entry.path,
              joinLocalPath(targetDirectory, safeLocalDownloadName(entry.name)),
            );
            fileCount += 1;
            continue;
          }

          skippedCount += 1;
        }
      };

      await ensureLocalDirectory(localRootPath);
      directoryCount += 1;
      await visit(normalizeRemotePathInput(remoteRootPath), localRootPath);

      return { directoryCount, fileCount, skippedCount };
    },
    [],
  );

  const uploadLocalEntry = useCallback(async (entry: RemoteEntry | null) => {
    if (!entry) {
      setWorkspaceMessage("请先选择本地文件再上传。");
      return;
    }

    if (entry.kind === "directory") {
      try {
        const session = await ensureFileTransferSession();
        const remoteTargetPath = joinRemotePath(remotePath, entry.name);
        setWorkspaceMessage(`正在扫描本地文件夹并加入上传队列：${entry.path}`);
        const summary = await queueUploadDirectory(session.id, entry.path, remoteTargetPath);
        setTransfers(await transferList());
        setWorkspaceMessage(
          `已加入递归上传队列：${entry.name}，${summary.directoryCount} 个文件夹、${summary.fileCount} 个文件${
            summary.skippedCount ? `，跳过 ${summary.skippedCount} 个特殊条目` : ""
          }。`,
        );
      } catch (error) {
        setWorkspaceMessage(`递归上传文件夹失败：${String(error)}`);
      }
      return;
    }

    if (entry.kind !== "file") {
      setWorkspaceMessage("当前仅支持上传普通文件或文件夹。");
      return;
    }

    await queueUpload(entry.path, joinRemotePath(remotePath, entry.name));
  }, [ensureFileTransferSession, queueUpload, queueUploadDirectory, remotePath]);

  const uploadSelectedLocalEntry = useCallback(async () => {
    await uploadLocalEntry(selectedLocalEntry);
  }, [selectedLocalEntry, uploadLocalEntry]);

  const uploadLocalPaths = useCallback(
    async (localPaths: string[]) => {
      const paths = [...new Set(localPaths.map((path) => path.trim()).filter(Boolean))];

      if (paths.length === 0) {
        setWorkspaceMessage("未识别到可上传的本地文件路径。");
        return;
      }

      try {
        const session = await ensureFileTransferSession();

        for (const localPath of paths) {
          const targetName = localPathBaseName(localPath);
          const directory = await localFileList(localPath).catch(() => null);

          if (directory) {
            const summary = await queueUploadDirectory(session.id, localPath, joinRemotePath(remotePath, targetName));
            if (summary.skippedCount) {
              setWorkspaceMessage(`拖拽上传跳过 ${summary.skippedCount} 个特殊条目。`);
            }
          } else {
            await fileTransferUpload(
              session.id,
              localPath,
              joinRemotePath(remotePath, targetName),
            );
          }
        }

        setTransfers(await transferList());
        setWorkspaceMessage(
          paths.length === 1
            ? `已加入拖拽上传队列：${localPathBaseName(paths[0])}。`
            : `已加入拖拽上传队列：${paths.length} 个文件。`,
        );
      } catch (error) {
        try {
          setTransfers(await transferList());
        } catch {
          // Keep the last visible queue if refreshing fails after a partial batch.
        }
        setWorkspaceMessage(`拖拽上传失败：${String(error)}`);
      }
    },
    [ensureFileTransferSession, queueUploadDirectory, remotePath],
  );

  const queueDownload = useCallback(
    async (remoteSourcePath: string, localPath: string) => {
      if (!remoteSourcePath.trim() || !localPath.trim()) {
        setWorkspaceMessage("下载需要远程路径和本地路径。");
        return;
      }

      try {
        const session = await ensureFileTransferSession();
        await fileTransferDownload(session.id, remoteSourcePath.trim(), localPath.trim());
        setTransfers(await transferList());
        setWorkspaceMessage(`已加入下载队列：${remoteSourcePath.trim()} -> ${localPath.trim()}。`);
      } catch (error) {
        setWorkspaceMessage(`加入下载队列失败：${String(error)}`);
      }
    },
    [ensureFileTransferSession],
  );

  const downloadRemoteEntry = useCallback(async (entry: RemoteEntry | null) => {
    if (!entry) {
      setWorkspaceMessage("请先选择远程文件再下载。");
      return;
    }

    const localTargetDirectory = downloadTargetDirectory(localPath, selectedLocalEntry);

    if (isVirtualLocalPath(localTargetDirectory)) {
      setWorkspaceMessage("请先在本地面板选择或进入一个磁盘目录，再下载远程文件。");
      return;
    }

    if (entry.kind === "directory") {
      try {
        const session = await ensureFileTransferSession();
        const localTargetPath = joinLocalPath(localTargetDirectory, safeLocalDownloadName(entry.name));
        setWorkspaceMessage(`正在扫描远程文件夹并加入下载队列：${entry.path}`);
        const summary = await queueDownloadDirectory(session.id, entry.path, localTargetPath);
        setTransfers(await transferList());
        setWorkspaceMessage(
          `已加入递归下载队列：${entry.name}，${summary.directoryCount} 个文件夹、${summary.fileCount} 个文件${
            summary.skippedCount ? `，跳过 ${summary.skippedCount} 个特殊条目` : ""
          }。`,
        );
      } catch (error) {
        setWorkspaceMessage(`递归下载文件夹失败：${String(error)}`);
      }
      return;
    }

    if (entry.kind !== "file") {
      setWorkspaceMessage("当前仅支持下载普通文件或文件夹。");
      return;
    }

    await queueDownload(entry.path, joinLocalPath(localTargetDirectory, safeLocalDownloadName(entry.name)));
  }, [ensureFileTransferSession, localPath, queueDownload, queueDownloadDirectory, selectedLocalEntry]);

  const downloadSelectedRemoteEntry = useCallback(async () => {
    await downloadRemoteEntry(selectedRemoteEntry);
  }, [downloadRemoteEntry, selectedRemoteEntry]);

  const updateTransferTask = useCallback(
    async (transferId: string, action: "pause" | "resume" | "retry" | "cancel" | "delete") => {
      try {
        if (action === "delete") {
          await fileTransferDelete(transferId);
          setTransfers((current) => current.filter((task) => task.id !== transferId));
          setWorkspaceMessage(`传输任务 ${transferId} 已删除。`);
          return;
        }

        if (action === "retry") {
          const failedTask = transfers.find((task) => task.id === transferId);

          if (failedTask?.error && isConnectionClosedTransferError(failedTask.error)) {
            setWorkspaceMessage("传输连接已断开，正在重连 SFTP 并重新入队...");
            const session = await reconnectActiveFileTransfer(remotePath);

            if (!session) {
              return;
            }

            await fileTransferDelete(failedTask.id).catch(() => undefined);
            if (failedTask.direction === "download") {
              await fileTransferDownload(session.id, failedTask.remotePath, failedTask.localPath);
            } else {
              await fileTransferUpload(session.id, failedTask.localPath, failedTask.remotePath);
            }
            setTransfers(await transferList());
            setWorkspaceMessage(`SFTP 已重连，传输任务 ${transferId} 已重新入队。`);
            return;
          }
        }

        const updated =
          action === "pause"
            ? await fileTransferPause(transferId)
            : action === "resume"
              ? await fileTransferResume(transferId)
              : action === "retry"
                ? await fileTransferRetry(transferId)
                : await fileTransferCancel(transferId);

        setTransfers((current) =>
          current.map((task) => (task.id === updated.id ? updated : task)),
        );
        setWorkspaceMessage(
          `传输任务 ${transferId} 已执行 ${transferActionLabel(action)}：${transferStatusLabel(updated.status)}。`,
        );
      } catch (error) {
        setWorkspaceMessage(`传输任务 ${transferActionLabel(action)} 失败：${String(error)}`);
      }
    },
    [reconnectActiveFileTransfer, remotePath, transfers],
  );

  const changeRemotePath = useCallback((path: string) => {
    setRemotePathState(path.trim() || remoteRootPath);
    setSelectedRemoteEntry(null);
    setRemoteEntries(emptyRemoteEntries);
  }, []);

  const changeLocalPath = useCallback((path: string) => {
    setLocalPathState(path);
    setSelectedLocalEntry(null);
    setLocalEntries(emptyRemoteEntries);
  }, []);

  const switchSessionTab = useCallback(
    (connectionId: string) => {
      const tab = sessionTabs.find((item) => (item.id ?? item.connection.id) === connectionId);

      if (!tab) {
        setWorkspaceMessage(`未找到会话标签：${connectionId}。`);
        return;
      }

      activateSessionTab(tab);
    },
    [activateSessionTab, sessionTabs],
  );

  const reorderSessionTabs = useCallback((sourceConnectionId: string, targetConnectionId: string) => {
    if (sourceConnectionId === targetConnectionId) {
      return;
    }

    setSessionTabs((current) => {
      const sourceIndex = current.findIndex((tab) => (tab.id ?? tab.connection.id) === sourceConnectionId);
      const targetIndex = current.findIndex((tab) => (tab.id ?? tab.connection.id) === targetConnectionId);

      if (sourceIndex < 0 || targetIndex < 0) {
        return current;
      }

      const nextTabs = [...current];
      const [movedTab] = nextTabs.splice(sourceIndex, 1);
      nextTabs.splice(targetIndex, 0, movedTab);
      return nextTabs;
    });
    setWorkspaceMessage("已调整标签顺序。");
  }, []);

  return {
    activeConnection,
    activeProfile,
    activeProfileId,
    activeSessionTabId,
    activeSessionTabKind: activeSessionTab?.kind ?? "terminal",
    activeTerminal,
    capabilities: activeConnectionCapabilities,
    dataSource,
    fileManagerOpen: Boolean(activeFileTransferSession),
    groups,
    logs,
    localEntries,
    localPath,
    profiles,
    protocolDescriptors,
    pendingKnownHost,
    recentConnections,
    remoteEntries,
    remotePath,
    redactionInput,
    redactionPreview,
    selectedLocalEntry,
    selectedRemoteEntry,
    sessionTabs,
    sessionNotice,
    sftpConnectionOptions,
    secrets,
    serialPorts,
    settings,
    knownHosts,
    terminalSearchQuery,
    terminalSnapshot: activeSessionTerminalSnapshot,
    tunnels,
    transfers,
    workspaceMessage,
    sshPassword,
    attachDetachedSessionTab,
    authenticateActiveSshPassword,
    closeActiveConnection,
    closeConnection,
    clearLogs,
    createLocalDirectory,
    createRemoteDirectory,
    createProfileDraft,
    deleteProfile,
    deleteSecretMetadata,
    deleteKnownHost,
    detachSessionTab,
    openActiveConnection,
    openFileTransferTab,
    openLocalShellTab,
    openProfileConnection,
    previewRedaction,
    downloadSelectedRemoteEntry,
    downloadRemoteEntry,
    queueDownload,
    queueUpload,
    refreshLocalFiles,
    removeLocalEntry,
    removeRemoteEntry,
    refreshRemoteFiles,
    refreshWorkspace,
    refreshTerminalSnapshot,
    reconnectSessionTab,
    renameLocalEntry,
    renameRemoteEntry,
    reorderSessionTabs,
    reportWorkspaceMessage,
    restoreDetachedSessionTab,
    resizeActiveTerminal,
    saveProfile,
    saveSettings,
    sendTerminalData,
    setActiveProfileId: selectActiveProfile,
    setLocalPath: changeLocalPath,
    setSelectedLocalEntry,
    setRemotePath: changeRemotePath,
    setRedactionInput,
    setSelectedRemoteEntry,
    setSshPassword,
    setTerminalSearchQuery,
    switchSessionTab,
    testProfile,
    trustActiveHostPlaceholder,
    trustProfileHost,
    updateTransferTask,
    uploadLocalEntry,
    uploadLocalPaths,
    uploadSelectedLocalEntry,
  };
}

function transferActionLabel(action: "pause" | "resume" | "retry" | "cancel" | "delete") {
  const labels = {
    pause: "暂停",
    resume: "继续",
    retry: "重试",
    cancel: "取消",
    delete: "删除",
  };

  return labels[action];
}

function profileDedupKey(profile: ConnectionProfile) {
  if (profile.type === "serial") {
    return `${profile.type}:${profile.portName.trim().toLowerCase()}`;
  }

  const username = "username" in profile ? profile.username ?? "" : "";
  return `${profile.type}:${username.trim().toLowerCase()}@${profile.host.trim().toLowerCase()}:${profile.port}`;
}

function normalizeRemotePathInput(path: string) {
  const parts: string[] = [];

  for (const part of path.trim().replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") {
      continue;
    }

    if (part === "..") {
      parts.pop();
      continue;
    }

    parts.push(part);
  }

  return parts.length ? `/${parts.join("/")}` : remoteRootPath;
}

function joinRemotePath(basePath: string, name: string) {
  const base = normalizeRemotePathInput(basePath);
  const cleanName = name.trim();

  if (base === remoteRootPath || base.endsWith("/")) {
    return `${base}${cleanName}`;
  }

  return `${base}/${cleanName}`;
}

function remoteDirectoryName(path: string) {
  const normalized = normalizeRemotePathInput(path);

  if (normalized === remoteRootPath) {
    return remoteRootPath;
  }

  const separatorIndex = normalized.lastIndexOf("/");
  return separatorIndex <= 0 ? remoteRootPath : normalized.slice(0, separatorIndex);
}

function joinLocalPath(basePath: string, name: string) {
  const base = basePath.trim();
  const cleanName = name.trim();

  if (!base) {
    return cleanName;
  }

  const separator = base.includes("\\") ? "\\" : "/";

  if (base.endsWith("\\") || base.endsWith("/")) {
    return `${base}${cleanName}`;
  }

  return `${base}${separator}${cleanName}`;
}

function localDirectoryName(path: string) {
  const normalized = path.trim().replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));

  if (separatorIndex < 0) {
    return "";
  }

  const parent = normalized.slice(0, separatorIndex);

  if (/^[A-Za-z]:$/.test(parent)) {
    return `${parent}\\`;
  }

  if (!parent && normalized.startsWith("/")) {
    return "/";
  }

  if (!parent && normalized.startsWith("\\")) {
    return "\\";
  }

  return parent;
}

function isVirtualLocalPath(path: string) {
  return path.trim().toLowerCase() === localRootsPath;
}

function downloadTargetDirectory(localPath: string, selectedLocalEntry: RemoteEntry | null) {
  if (selectedLocalEntry?.kind === "directory") {
    return selectedLocalEntry.path;
  }

  return localPath;
}

const invalidLocalFileNamePattern = /[<>:"/\\|?*\x00-\x1F]/g;
const windowsReservedLocalFileNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function safeLocalDownloadName(name: string) {
  const sanitized = name
    .trim()
    .replace(invalidLocalFileNamePattern, "_")
    .replace(/[ .]+$/g, "");

  if (!sanitized || sanitized === "." || sanitized === "..") {
    return "download";
  }

  if (windowsReservedLocalFileNames.test(sanitized)) {
    return `_${sanitized}`;
  }

  return sanitized;
}

function isConnectionClosedTransferError(error: string) {
  const normalized = error.toLowerCase();
  return normalized.includes("automatic reopen failed")
    || normalized.includes("failed to open ssh session channel")
    || normalized.includes("channel send error")
    || normalized.includes("session closed")
    || normalized.includes("connection closed");
}

function isAlreadyExistsError(error: unknown) {
  const normalized = String(error).toLowerCase();
  return normalized.includes("already exists")
    || normalized.includes("file exists")
    || normalized.includes("os error 17")
    || normalized.includes("os error 183");
}

function localPathBaseName(path: string) {
  const normalized = path.trim().replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));

  return separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized;
}
