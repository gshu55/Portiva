import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionCapabilities, RemoteEntry, TransferTask } from "../../shared/types";
import {
  fileTransferResolveConflict,
  localDownloadDirectory,
  localFileList,
  localFileMkdir,
  localFileRemove,
  localFileRename,
  wslFileHome,
  wslFileList,
  wslFileMkdir,
  wslFileRemove,
  wslFileRename,
  wslTransferAction,
  wslTransferDownload,
  wslTransferList,
  wslTransferUpload,
} from "../../shared/ipc/commands";
import { Button, ConfirmDialog } from "../../shared/ui";
import { FileTransferPanel, localRootsPath } from "./FileTransferPanel";

const wslFileCapabilities: ConnectionCapabilities = {
  fileTransfer: true,
  localFileAccess: true,
  portForwarding: false,
  ptyResize: false,
  reconnect: true,
  requiresHostKeyVerification: false,
  scp: false,
  secureTransport: true,
  sftp: false,
  terminal: false,
  tunnel: false,
};

interface WslFileTransferPanelProps {
  compact?: boolean;
  distribution: string;
  layoutSide?: "left" | "right";
  onOpenTerminal: (distribution: string) => void | Promise<unknown>;
  onReportMessage?: (message: string) => void;
  onToggleLayoutSide?: () => void;
}

export function WslFileTransferPanel({
  compact = false,
  distribution,
  layoutSide,
  onOpenTerminal,
  onReportMessage,
  onToggleLayoutSide,
}: WslFileTransferPanelProps) {
  const [localEntries, setLocalEntries] = useState<RemoteEntry[]>([]);
  const [localPath, setLocalPath] = useState("");
  const [wslEntries, setWslEntries] = useState<RemoteEntry[]>([]);
  const [wslPath, setWslPath] = useState("/");
  const [selectedLocalEntry, setSelectedLocalEntry] = useState<RemoteEntry | null>(null);
  const [selectedWslEntry, setSelectedWslEntry] = useState<RemoteEntry | null>(null);
  const [transfers, setTransfers] = useState<TransferTask[]>([]);
  const previousStatusesRef = useRef(new Map<string, TransferTask["status"]>());

  const report = useCallback((message: string) => {
    onReportMessage?.(message);
  }, [onReportMessage]);

  const refreshLocal = useCallback(async (pathOverride?: string) => {
    try {
      const result = await localFileList(pathOverride ?? (localPath || localRootsPath));
      setLocalPath(result.path);
      setLocalEntries(result.entries);
      setSelectedLocalEntry((current) =>
        current ? result.entries.find((entry) => entry.path === current.path) ?? null : null,
      );
      return true;
    } catch (error) {
      report(`读取 Windows 目录失败：${String(error)}`);
      return false;
    }
  }, [localPath, report]);

  const refreshWsl = useCallback(async (pathOverride?: string) => {
    try {
      const result = await wslFileList(distribution, pathOverride ?? wslPath);
      setWslPath(result.path);
      setWslEntries(result.entries);
      setSelectedWslEntry((current) =>
        current ? result.entries.find((entry) => entry.path === current.path) ?? null : null,
      );
      return true;
    } catch (error) {
      report(`读取 ${distribution} 目录失败：${String(error)}`);
      return false;
    }
  }, [distribution, report, wslPath]);

  const refreshTransfers = useCallback(async () => {
    const nextTransfers = await wslTransferList(distribution);
    setTransfers(nextTransfers);
    return nextTransfers;
  }, [distribution]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      localDownloadDirectory().catch(() => localRootsPath),
      wslFileHome(distribution).catch(() => "/"),
    ]).then(async ([initialLocalPath, initialWslPath]) => {
      if (cancelled) return;
      const [localResult, wslResult, nextTransfers] = await Promise.all([
        localFileList(initialLocalPath),
        wslFileList(distribution, initialWslPath),
        wslTransferList(distribution),
      ]);
      if (cancelled) return;
      setLocalPath(localResult.path);
      setLocalEntries(localResult.entries);
      setWslPath(wslResult.path);
      setWslEntries(wslResult.entries);
      setTransfers(nextTransfers);
      previousStatusesRef.current = new Map(nextTransfers.map((task) => [task.id, task.status]));
      report(`已打开 ${distribution} 文件管理：${wslResult.path}`);
    }).catch((error) => {
      if (!cancelled) report(`打开 ${distribution} 文件管理失败：${String(error)}`);
    });

    return () => {
      cancelled = true;
    };
  }, [distribution, report]);

  const hasActiveTransfer = transfers.some((task) =>
    task.status === "pending"
    || task.status === "running"
    || task.status === "paused"
    || task.status === "waiting-conflict",
  );

  useEffect(() => {
    if (!hasActiveTransfer) return;
    const timer = window.setInterval(() => {
      void refreshTransfers().catch(() => undefined);
    }, 500);
    return () => window.clearInterval(timer);
  }, [hasActiveTransfer, refreshTransfers]);

  useEffect(() => {
    const previous = previousStatusesRef.current;
    const justFinished = transfers.some((task) => {
      const oldStatus = previous.get(task.id);
      return (task.status === "completed" || task.status === "partial")
        && oldStatus !== "completed"
        && oldStatus !== "partial";
    });
    previousStatusesRef.current = new Map(transfers.map((task) => [task.id, task.status]));
    if (justFinished) {
      void Promise.all([refreshLocal(), refreshWsl()]);
    }
  }, [refreshLocal, refreshWsl, transfers]);

  const createLocalDirectory = useCallback(async (name: string) => {
    try {
      await localFileMkdir(joinLocalPath(localPath, name));
      await refreshLocal();
      return true;
    } catch (error) {
      report(`创建 Windows 目录失败：${String(error)}`);
      return false;
    }
  }, [localPath, refreshLocal, report]);

  const createWslDirectory = useCallback(async (name: string) => {
    try {
      await wslFileMkdir(distribution, joinLinuxPath(wslPath, name));
      await refreshWsl();
      return true;
    } catch (error) {
      report(`创建 WSL 目录失败：${String(error)}`);
      return false;
    }
  }, [distribution, refreshWsl, report, wslPath]);

  const renameLocal = useCallback(async (entry: RemoteEntry, name: string) => {
    try {
      await localFileRename(entry.path, joinLocalPath(localPath, name));
      setSelectedLocalEntry(null);
      await refreshLocal();
      return true;
    } catch (error) {
      report(`Windows 重命名失败：${String(error)}`);
      return false;
    }
  }, [localPath, refreshLocal, report]);

  const renameWsl = useCallback(async (entry: RemoteEntry, name: string) => {
    try {
      await wslFileRename(distribution, entry.path, joinLinuxPath(wslPath, name));
      setSelectedWslEntry(null);
      await refreshWsl();
      return true;
    } catch (error) {
      report(`WSL 重命名失败：${String(error)}`);
      return false;
    }
  }, [distribution, refreshWsl, report, wslPath]);

  const removeLocal = useCallback(async (entry?: RemoteEntry | null) => {
    const target = entry ?? selectedLocalEntry;
    if (!target) return;
    try {
      await localFileRemove(target.path);
      setSelectedLocalEntry(null);
      await refreshLocal();
    } catch (error) {
      report(`删除 Windows 条目失败：${String(error)}`);
    }
  }, [refreshLocal, report, selectedLocalEntry]);

  const removeWsl = useCallback(async (entry?: RemoteEntry | null) => {
    const target = entry ?? selectedWslEntry;
    if (!target) return;
    try {
      await wslFileRemove(distribution, target.path);
      setSelectedWslEntry(null);
      await refreshWsl();
    } catch (error) {
      report(`删除 WSL 条目失败：${String(error)}`);
    }
  }, [distribution, refreshWsl, report, selectedWslEntry]);

  const removeWslEntries = useCallback(async (entries: RemoteEntry[]) => {
    const failures: string[] = [];
    for (const entry of entries) {
      try {
        await wslFileRemove(distribution, entry.path);
      } catch (error) {
        failures.push(`${entry.name}：${String(error)}`);
      }
    }
    setSelectedWslEntry(null);
    await refreshWsl();
    report(failures.length
      ? `WSL 批量删除完成，${failures.length} 项失败：${failures[0]}`
      : `已删除 ${entries.length} 个 WSL 条目。`);
  }, [distribution, refreshWsl, report]);

  const uploadEntry = useCallback(async (entry: RemoteEntry) => {
    try {
      await wslTransferUpload(distribution, entry.path, joinLinuxPath(wslPath, entry.name));
      await refreshTransfers();
      report(`已加入 Windows → ${distribution} 传输队列：${entry.name}`);
    } catch (error) {
      report(`加入 WSL 传输队列失败：${String(error)}`);
    }
  }, [distribution, refreshTransfers, report, wslPath]);

  const uploadPaths = useCallback(async (paths: string[]) => {
    const uniquePaths = [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
    try {
      for (const path of uniquePaths) {
        await wslTransferUpload(distribution, path, joinLinuxPath(wslPath, pathBaseName(path)));
      }
      await refreshTransfers();
      report(`已加入 ${uniquePaths.length} 个 Windows → ${distribution} 传输任务。`);
    } catch (error) {
      await refreshTransfers().catch(() => undefined);
      report(`加入 WSL 传输队列失败：${String(error)}`);
    }
  }, [distribution, refreshTransfers, report, wslPath]);

  const downloadEntry = useCallback(async (entry: RemoteEntry) => {
    const targetDirectory = selectedLocalEntry?.kind === "directory" ? selectedLocalEntry.path : localPath;
    if (!targetDirectory || targetDirectory === localRootsPath) {
      report("请先在 Windows 面板进入目标目录。");
      return;
    }
    try {
      await wslTransferDownload(
        distribution,
        entry.path,
        joinLocalPath(targetDirectory, safeWindowsFileName(entry.name)),
      );
      await refreshTransfers();
      report(`已加入 ${distribution} → Windows 传输队列：${entry.name}`);
    } catch (error) {
      report(`加入 WSL 下载队列失败：${String(error)}`);
    }
  }, [distribution, localPath, refreshTransfers, report, selectedLocalEntry]);

  const updateTransfer = useCallback(async (
    transferId: string,
    action: "pause" | "resume" | "retry" | "cancel" | "delete",
  ) => {
    try {
      await wslTransferAction(transferId, action);
      await refreshTransfers();
    } catch (error) {
      report(`WSL 传输任务操作失败：${String(error)}`);
    }
  }, [refreshTransfers, report]);

  const pendingConflict = useMemo(
    () => transfers.find((task) => task.status === "waiting-conflict") ?? null,
    [transfers],
  );
  const resolveConflict = useCallback(async (policy: "overwrite" | "skip") => {
    if (!pendingConflict) return;
    try {
      await fileTransferResolveConflict(pendingConflict.id, policy);
      await refreshTransfers();
    } catch (error) {
      report(`处理 WSL 文件冲突失败：${String(error)}`);
    }
  }, [pendingConflict, refreshTransfers, report]);

  return (
    <div className={["wsl-file-transfer-page", compact ? "compact" : ""].filter(Boolean).join(" ")}>
      <FileTransferPanel
        capabilities={wslFileCapabilities}
        compact={compact}
        deleteTargetLabel={`${distribution} Linux 文件系统`}
        localEntries={localEntries}
        localPath={localPath}
        layoutSide={layoutSide}
        openTerminalLabel={`打开 ${distribution} Linux 终端`}
        remoteEmptyMessage="当前 Linux 目录为空或尚未刷新。"
        remoteEntries={wslEntries}
        remoteNameRules="wsl"
        remotePath={wslPath}
        remoteTitle={`WSL / ${distribution}`}
        selectedLocalEntry={selectedLocalEntry}
        selectedRemoteEntry={selectedWslEntry}
        transfers={transfers}
        onCancelTransfer={(id) => void updateTransfer(id, "cancel")}
        onCreateLocalDirectory={createLocalDirectory}
        onCreateRemoteDirectory={createWslDirectory}
        onDeleteTransfer={(id) => void updateTransfer(id, "delete")}
        onDownloadEntry={downloadEntry}
        onOpenSsh={() => void onOpenTerminal(distribution)}
        onPauseTransfer={(id) => void updateTransfer(id, "pause")}
        onRefreshLocal={refreshLocal}
        onRefreshRemote={refreshWsl}
        onRemoveLocal={removeLocal}
        onRemoveRemote={removeWsl}
        onRemoveRemoteEntries={removeWslEntries}
        onRenameLocal={renameLocal}
        onRenameRemote={renameWsl}
        onResumeTransfer={(id) => void updateTransfer(id, "resume")}
        onRetryTransfer={(id) => void updateTransfer(id, "retry")}
        onSelectLocalEntry={setSelectedLocalEntry}
        onSelectRemoteEntry={setSelectedWslEntry}
        onToggleLayoutSide={onToggleLayoutSide}
        onUploadEntry={uploadEntry}
        onUploadLocalPaths={uploadPaths}
        onUploadSelected={() => selectedLocalEntry ? uploadEntry(selectedLocalEntry) : undefined}
      />
      <ConfirmDialog
        actions={(
          <>
            <Button onClick={() => void resolveConflict("skip")} tone="muted">跳过</Button>
            <Button onClick={() => void resolveConflict("overwrite")} tone="primary">覆盖</Button>
          </>
        )}
        description={pendingConflict ? `目标已存在：${pendingConflict.conflictPath ?? pendingConflict.remotePath}` : undefined}
        dismissible={false}
        onCancel={() => void resolveConflict("skip")}
        onConfirm={() => void resolveConflict("overwrite")}
        open={Boolean(pendingConflict)}
        title="WSL 文件冲突"
      />
    </div>
  );
}

function joinLinuxPath(parent: string, name: string) {
  return parent === "/" ? `/${name}` : `${parent.replace(/\/$/, "")}/${name}`;
}

function joinLocalPath(parent: string, name: string) {
  if (parent.endsWith("\\") || parent.endsWith("/")) return `${parent}${name}`;
  return `${parent}${parent.includes("\\") ? "\\" : "/"}${name}`;
}

function pathBaseName(path: string) {
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.slice(Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/")) + 1);
}

function safeWindowsFileName(name: string) {
  const normalized = name.trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[ .]+$/, "");
  return normalized && normalized !== "." && normalized !== ".." ? normalized : "download";
}
