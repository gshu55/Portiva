import {
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "../../shared/Icon";
import { Button, IconButton, TextInput } from "../../shared/ui";
import type { ConnectionCapabilities, RemoteEntry, TransferTask } from "../../shared/types";
import { isAdditiveDesktopSelection } from "./desktopSelection";
import { FileEntryContextMenu } from "./FileEntryContextMenu";
import { fileIconKind, remoteEntryIconName } from "./fileEntryIcons";
import { SftpDeleteConfirmDialog } from "./SftpDeleteConfirmDialog";
import { SftpDropOverlay } from "./SftpDropOverlay";
import { TransferQueue } from "./TransferQueue";
import { useSftpDropUpload } from "./useSftpDropUpload";

export const localRootsPath = "portiva://local-roots";

interface FileTransferPanelProps {
  capabilities: ConnectionCapabilities;
  openSshPending?: boolean;
  localEntries: RemoteEntry[];
  localPath: string;
  remoteEntries: RemoteEntry[];
  remotePath: string;
  selectedLocalEntry: RemoteEntry | null;
  selectedRemoteEntry: RemoteEntry | null;
  transfers: TransferTask[];
  onCancelTransfer: (transferId: string) => void;
  onDeleteTransfer: (transferId: string) => void;
  onOpenSsh: () => void;
  onCreateLocalDirectory: (name: string) => boolean | void | Promise<boolean | void>;
  onCreateRemoteDirectory: (name: string) => boolean | void | Promise<boolean | void>;
  onDownloadEntry: (entry: RemoteEntry) => void | Promise<void>;
  onRefreshLocal: (path?: string) => boolean | void | Promise<boolean | void>;
  onRefreshRemote: (path?: string) => boolean | void | Promise<boolean | void>;
  onRemoveLocal: (entry?: RemoteEntry | null) => void | Promise<void>;
  onRemoveRemote: (entry?: RemoteEntry | null) => void | Promise<void>;
  onRemoveRemoteEntries: (entries: RemoteEntry[]) => unknown | Promise<unknown>;
  onPauseTransfer: (transferId: string) => void;
  onRenameLocal: (entry: RemoteEntry, name: string) => boolean | void | Promise<boolean | void>;
  onRenameRemote: (entry: RemoteEntry, name: string) => boolean | void | Promise<boolean | void>;
  onResumeTransfer: (transferId: string) => void;
  onRetryTransfer: (transferId: string) => void;
  onSelectLocalEntry: (entry: RemoteEntry) => void;
  onSelectRemoteEntry: (entry: RemoteEntry | null) => void;
  onUploadEntry: (entry: RemoteEntry) => void | Promise<void>;
  onUploadLocalPaths: (localPaths: string[]) => void | Promise<void>;
  onUploadSelected: () => void | Promise<void>;
}

export function FileTransferPanel({
  capabilities,
  openSshPending = false,
  localEntries,
  localPath,
  onCancelTransfer,
  onDeleteTransfer,
  onOpenSsh,
  onCreateLocalDirectory,
  onCreateRemoteDirectory,
  onDownloadEntry,
  onRefreshLocal,
  onRefreshRemote,
  onRemoveLocal,
  onRemoveRemote,
  onRemoveRemoteEntries,
  onPauseTransfer,
  onRenameLocal,
  onRenameRemote,
  onResumeTransfer,
  onRetryTransfer,
  onSelectLocalEntry,
  onSelectRemoteEntry,
  onUploadEntry,
  onUploadLocalPaths,
  onUploadSelected,
  remoteEntries,
  remotePath,
  selectedLocalEntry,
  selectedRemoteEntry,
  transfers,
}: FileTransferPanelProps) {
  const [transferPanelRatio, setTransferPanelRatio] = useState(0.34);
  const [selectedRemotePaths, setSelectedRemotePaths] = useState<Set<string>>(
    () => new Set(selectedRemoteEntry ? [selectedRemoteEntry.path] : []),
  );
  const [selectionAnchorPath, setSelectionAnchorPath] = useState<string | null>(null);
  const [deleteConfirmEntries, setDeleteConfirmEntries] = useState<RemoteEntry[]>([]);
  const panelRef = useRef<HTMLElement | null>(null);
  const remotePathRef = useRef(remotePath);
  const selectedLocalLabel = useMemo(
    () => selectedLocalEntry?.name ?? "未选择",
    [selectedLocalEntry],
  );
  const selectedRemoteEntries = useMemo(
    () => remoteEntries.filter((entry) => selectedRemotePaths.has(entry.path)),
    [remoteEntries, selectedRemotePaths],
  );
  const selectedTransferableEntries = useMemo(
    () => selectedRemoteEntries.filter(isTransferableEntry),
    [selectedRemoteEntries],
  );
  const selectedRemoteLabel = selectedRemoteEntries.length > 1
    ? `已选择 ${selectedRemoteEntries.length} 项`
    : selectedRemoteEntries[0]?.name ?? "未选择";
  const canUseRemote = capabilities.fileTransfer;
  const transferPanelPercent = Math.round(transferPanelRatio * 100);

  useEffect(
    () => () => {
      document.body.classList.remove("file-manager-transfer-resizing");
    },
    [],
  );

  useEffect(() => {
    if (remotePathRef.current !== remotePath) {
      remotePathRef.current = remotePath;
      setSelectedRemotePaths(new Set());
      setSelectionAnchorPath(null);
      onSelectRemoteEntry(null);
      return;
    }

    const availablePaths = new Set(remoteEntries.map((entry) => entry.path));
    setSelectedRemotePaths((current) => {
      const next = new Set([...current].filter((path) => availablePaths.has(path)));
      return next.size === current.size ? current : next;
    });
  }, [onSelectRemoteEntry, remoteEntries, remotePath]);

  const clearRemoteSelection = () => {
    setSelectedRemotePaths(new Set());
    setSelectionAnchorPath(null);
    onSelectRemoteEntry(null);
  };

  const selectRemoteEntry = (
    event: Pick<MouseEvent<HTMLElement>, "ctrlKey" | "metaKey" | "shiftKey">,
    entry: RemoteEntry,
    entryIndex: number,
  ) => {
    const additiveSelection = isAdditiveDesktopSelection(event);

    if (event.shiftKey && selectionAnchorPath) {
      const anchorIndex = remoteEntries.findIndex((item) => item.path === selectionAnchorPath);

      if (anchorIndex >= 0) {
        const startIndex = Math.min(anchorIndex, entryIndex);
        const endIndex = Math.max(anchorIndex, entryIndex);
        setSelectedRemotePaths((current) => {
          const next = additiveSelection ? new Set(current) : new Set<string>();
          remoteEntries.slice(startIndex, endIndex + 1).forEach((item) => next.add(item.path));
          return next;
        });
        onSelectRemoteEntry(entry);
        return;
      }
    }

    if (additiveSelection) {
      setSelectedRemotePaths((current) => {
        const next = new Set(current);
        next.has(entry.path) ? next.delete(entry.path) : next.add(entry.path);
        return next;
      });
      setSelectionAnchorPath(entry.path);
      onSelectRemoteEntry(entry);
      return;
    }

    setSelectedRemotePaths(new Set([entry.path]));
    setSelectionAnchorPath(entry.path);
    onSelectRemoteEntry(entry);
  };

  const selectOnlyRemoteEntry = (entry: RemoteEntry) => {
    setSelectedRemotePaths(new Set([entry.path]));
    setSelectionAnchorPath(entry.path);
    onSelectRemoteEntry(entry);
  };

  const downloadRemoteEntries = async () => {
    for (const entry of selectedTransferableEntries) {
      await onDownloadEntry(entry);
    }
  };

  const confirmDeleteRemoteEntries = async () => {
    const entries = deleteConfirmEntries;
    setDeleteConfirmEntries([]);
    await onRemoveRemoteEntries(entries);
    clearRemoteSelection();
  };

  const startTransferPanelResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const updateTransferRatio = (clientY: number) => {
      const panel = panelRef.current;

      if (!panel) {
        return;
      }

      const bounds = panel.getBoundingClientRect();
      if (bounds.height <= 0) {
        return;
      }

      const nextRatio = (bounds.bottom - clientY) / bounds.height;
      setTransferPanelRatio(Math.min(0.6, Math.max(0.18, nextRatio)));
    };
    const onPointerMove = (moveEvent: PointerEvent) => updateTransferRatio(moveEvent.clientY);
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      document.body.classList.remove("file-manager-transfer-resizing");
    };

    document.body.classList.add("file-manager-transfer-resizing");
    updateTransferRatio(event.clientY);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  return (
    <section
      className="panel file-manager"
      ref={panelRef}
      style={{
        gridTemplateRows: `minmax(0, 1fr) 6px minmax(72px, ${transferPanelPercent}%)`,
      }}
    >
      <div className="file-manager-grid">
        <FilePane
          entries={localEntries}
          path={localPath}
          selectedEntry={selectedLocalEntry}
          pathKind="local"
          title="本地"
          onCreateDirectory={(name) => onCreateLocalDirectory(name)}
          onOpenDirectory={(path) => onRefreshLocal(path)}
          onOpenRoots={() => {
            onRefreshLocal(localRootsPath);
          }}
          onRefresh={() => onRefreshLocal()}
          copyLabel="上传"
          onCopyToPeer={(entry) => onUploadEntry(entry)}
          onRemove={onRemoveLocal}
          onRename={(entry, name) => onRenameLocal(entry, name)}
          onSelectEntry={onSelectLocalEntry}
        />

        <div className="file-copy-actions" aria-label="传输操作">
          <IconButton
            disabled={!canUseRemote || !isTransferableEntry(selectedLocalEntry)}
            icon="upload"
            onClick={onUploadSelected}
            aria-label="上传选中的本地文件或文件夹"
            title="上传选中的本地文件或文件夹"
          />
          <IconButton
            disabled={!canUseRemote || selectedTransferableEntries.length === 0}
            icon="download"
            onClick={() => void downloadRemoteEntries()}
            aria-label="下载选中的远程文件或文件夹"
            title="下载选中的远程文件或文件夹"
          />
          <span title={selectedLocalLabel}>本地</span>
          <span title={selectedRemoteLabel}>远程</span>
        </div>

        <FilePane
          disabled={!canUseRemote}
          dropUploadEnabled={canUseRemote}
          entries={remoteEntries}
          path={remotePath}
          selectedEntry={selectedRemoteEntry}
          pathKind="remote"
          title="远程 SFTP"
          openSshPending={openSshPending}
          onDropUploadLocalPaths={onUploadLocalPaths}
          onCreateDirectory={(name) => onCreateRemoteDirectory(name)}
          onOpenDirectory={(path) => onRefreshRemote(path)}
          onOpenRoot={() => {
            onRefreshRemote("/");
          }}
          onOpenSsh={onOpenSsh}
          onRefresh={() => onRefreshRemote()}
          copyLabel="下载"
          onCopyToPeer={(entry) => onDownloadEntry(entry)}
          onRemove={onRemoveRemote}
          onRename={(entry, name) => onRenameRemote(entry, name)}
          onSelectEntry={onSelectRemoteEntry}
          multiSelection={{
            selectedPaths: selectedRemotePaths,
            count: selectedRemoteEntries.length,
            canDownload: selectedTransferableEntries.length > 0,
            onClear: clearRemoteSelection,
            onDelete: () => setDeleteConfirmEntries(selectedRemoteEntries),
            onDownload: downloadRemoteEntries,
            onSelect: selectRemoteEntry,
            onSelectOnly: selectOnlyRemoteEntry,
          }}
        />
      </div>
      <div
        aria-label="调整传输队列高度"
        aria-orientation="horizontal"
        className="file-manager-transfer-resizer"
        onPointerDown={startTransferPanelResize}
        role="separator"
        title="拖动调整传输队列高度"
      />
      <TransferQueue
        tasks={transfers}
        onCancel={onCancelTransfer}
        onDelete={onDeleteTransfer}
        onPause={onPauseTransfer}
        onResume={onResumeTransfer}
        onRetry={onRetryTransfer}
      />
      <SftpDeleteConfirmDialog
        entries={deleteConfirmEntries}
        onCancel={() => setDeleteConfirmEntries([])}
        onConfirm={confirmDeleteRemoteEntries}
      />
    </section>
  );
}

interface FilePaneProps {
  disabled?: boolean;
  openSshPending?: boolean;
  entries: RemoteEntry[];
  path: string;
  pathKind: "local" | "remote";
  selectedEntry: RemoteEntry | null;
  title: string;
  copyLabel: string;
  onCreateDirectory: (name: string) => boolean | void | Promise<boolean | void>;
  onCopyToPeer: (entry: RemoteEntry) => void | Promise<void>;
  onOpenDirectory: (path: string) => boolean | void | Promise<boolean | void>;
  onOpenRoot?: () => void;
  onOpenRoots?: () => void;
  onOpenSsh?: () => void;
  onRefresh: () => boolean | void | Promise<boolean | void>;
  onRemove: (entry?: RemoteEntry | null) => void | Promise<void>;
  onRename: (entry: RemoteEntry, name: string) => boolean | void | Promise<boolean | void>;
  onSelectEntry: (entry: RemoteEntry) => void;
  dropUploadEnabled?: boolean;
  onDropUploadLocalPaths?: (localPaths: string[]) => void;
  multiSelection?: FilePaneMultiSelection;
}

interface FilePaneMultiSelection {
  selectedPaths: ReadonlySet<string>;
  count: number;
  canDownload: boolean;
  onClear: () => void;
  onDelete: () => void;
  onDownload: () => void | Promise<void>;
  onSelect: (
    event: Pick<MouseEvent<HTMLElement>, "ctrlKey" | "metaKey" | "shiftKey">,
    entry: RemoteEntry,
    entryIndex: number,
  ) => void;
  onSelectOnly: (entry: RemoteEntry) => void;
}

function FilePane({
  disabled = false,
  dropUploadEnabled = false,
  entries,
  copyLabel,
  onCreateDirectory,
  onCopyToPeer,
  onOpenDirectory,
  onOpenRoot,
  onOpenRoots,
  onOpenSsh,
  onRefresh,
  onRemove,
  onRename,
  onDropUploadLocalPaths,
  onSelectEntry,
  multiSelection,
  path,
  pathKind,
  selectedEntry,
  title,
  openSshPending = false,
}: FilePaneProps) {
  const fileListRef = useRef<HTMLDivElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [pathInput, setPathInput] = useState(path);
  const [editingEntryPath, setEditingEntryPath] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [pendingEditName, setPendingEditName] = useState<string | null>(null);
  const [inlineNotice, setInlineNotice] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    entry: RemoteEntry | null;
    x: number;
    y: number;
  } | null>(null);
  const { dropActive, dropZoneProps } = useSftpDropUpload({
    enabled: dropUploadEnabled && !disabled,
    onUploadPaths: onDropUploadLocalPaths ?? (() => undefined),
    targetRef: paneRef,
  });

  useEffect(() => {
    setPathInput(path);
    if (fileListRef.current) {
      fileListRef.current.scrollLeft = 0;
      fileListRef.current.scrollTop = 0;
    }
  }, [path]);

  useEffect(() => {
    if (!pendingEditName) {
      return;
    }

    const createdEntry = entries.find((entry) => entry.name === pendingEditName);

    if (!createdEntry) {
      return;
    }

    setPendingEditName(null);
    startInlineRename(createdEntry);
  }, [entries, pendingEditName]);

  useEffect(() => {
    if (!inlineNotice) {
      return;
    }

    const timeoutId = window.setTimeout(() => setInlineNotice(""), 2600);
    return () => window.clearTimeout(timeoutId);
  }, [inlineNotice]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const closeMenu = () => setContextMenu(null);
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
  }, [contextMenu]);

  const startInlineRename = (entry: RemoteEntry) => {
    onSelectEntry(entry);
    setEditingEntryPath(entry.path);
    setEditingName(entry.name);
  };

  const cancelInlineRename = () => {
    setEditingEntryPath(null);
    setEditingName("");
  };

  const createDirectoryInline = () => {
    const baseName = "新建文件夹";
    const nextName = uniqueEntryName(entries, baseName);

    if (nextName !== baseName) {
      setInlineNotice(`已存在同名文件夹，自动创建为 ${nextName}`);
    }

    void Promise.resolve(onCreateDirectory(nextName)).then((created) => {
      if (created !== false) {
        setPendingEditName(nextName);
      }
    });
  };

  const openPathInput = () => {
    const nextPath = pathInput.trim();

    if (nextPath && nextPath !== path) {
      void Promise.resolve(onOpenDirectory(nextPath))
        .then((changed) => {
          if (changed === false) {
            setPathInput(path);
          }
        })
        .catch(() => setPathInput(path));
      return;
    }

    onRefresh();
  };

  const commitInlineRename = (entry: RemoteEntry) => {
    const requestedName = sanitizeEntryName(editingName).trim();
    const invalidReason = entryNameInvalidReason(requestedName);

    if (invalidReason) {
      setEditingName(requestedName);
      setInlineNotice(invalidReason);
      return;
    }

    if (!requestedName || requestedName === entry.name) {
      cancelInlineRename();
      return;
    }

    const nextName = uniqueEntryName(entries, requestedName, entry.path);

    if (nextName !== requestedName) {
      setInlineNotice(`已存在同名条目，自动重命名为 ${nextName}`);
    }

    cancelInlineRename();
    void Promise.resolve(onRename(entry, nextName));
  };

  return (
    <div
      className={[
        "file-pane",
        dropUploadEnabled ? "file-pane-drop-target" : "",
        dropActive ? "file-pane-drop-active" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      ref={paneRef}
      {...dropZoneProps}
    >
      <div className="file-pane-heading">
        <strong>{title}</strong>
        <div className="file-pane-tools">
          {onOpenSsh ? (
            <IconButton
              aria-label="打开此主机的 SSH 终端"
              disabled={openSshPending}
              icon="terminal"
              onClick={onOpenSsh}
              title={openSshPending ? "正在打开 SSH 终端" : "快速打开 SSH 终端"}
            />
          ) : null}
          {onOpenRoot ? (
            <IconButton aria-label="回到远程根目录" disabled={disabled} icon="home" onClick={onOpenRoot} title="回到远程根目录" />
          ) : null}
          {onOpenRoots ? (
            <IconButton aria-label="查看本地磁盘" icon="hard-drive" onClick={onOpenRoots} title="查看本地磁盘" />
          ) : null}
          <IconButton
            aria-label={pathKind === "remote" ? "刷新或重连目录" : "刷新目录"}
            disabled={disabled}
            icon="refresh-ccw"
            onClick={onRefresh}
            title={pathKind === "remote" ? "刷新或重连目录" : "刷新目录"}
          />
        </div>
      </div>
      <div className={["file-path-bar", pathKind === "remote" ? "has-path-submit" : ""].filter(Boolean).join(" ")}>
        <IconButton
          aria-label="上级目录"
          disabled={disabled || !canGoParent(path)}
          icon="folder-open"
          onClick={() => onOpenDirectory(parentPath(path, pathKind))}
          title="上级目录"
        />
        <label>
          <span>路径</span>
          <TextInput
            aria-label={pathKind === "remote" ? "远程 SFTP 路径" : "本地路径"}
            disabled={disabled}
            title={path}
            value={pathInput}
            onBlur={() => setPathInput(path)}
            onChange={(event) => setPathInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                openPathInput();
              }

              if (event.key === "Escape") {
                setPathInput(path);
                event.currentTarget.blur();
              }
            }}
          />
        </label>
        {pathKind === "remote" ? (
          <IconButton
            aria-label="打开输入的远程路径"
            disabled={disabled || !pathInput.trim()}
            icon="chevron-right"
            onMouseDown={(event) => event.preventDefault()}
            onClick={openPathInput}
            title="打开输入的远程路径"
          />
        ) : null}
      </div>
      <div
        className="file-list file-browser-list"
        ref={fileListRef}
        onContextMenu={(event) => {
          event.preventDefault();
          setContextMenu({
            entry: selectedEntry,
            x: event.clientX,
            y: event.clientY,
          });
        }}
        onClick={(event) => {
          if (multiSelection && event.target === event.currentTarget) {
            multiSelection.onClear();
          }
        }}
        role="table"
        aria-multiselectable={multiSelection ? true : undefined}
        aria-label={`${title} 目录`}
      >
        <div className="file-browser-header" role="row">
          <span role="columnheader">名称</span>
          <span role="columnheader">类型</span>
          <span role="columnheader">大小</span>
          <span role="columnheader">修改时间</span>
          <span role="columnheader">权限</span>
        </div>
        <Button
          className="file-browser-row is-directory parent-directory-row"
          disabled={disabled || !canGoParent(path)}
          onDoubleClick={() => onOpenDirectory(parentPath(path, pathKind))}
          title="上级目录"
          role="row"
          tone="muted"
        >
          <span className="file-browser-name" role="cell">
            <Icon className="simple-sftp-entry-icon" name="folder-open" />
            <strong>...</strong>
          </span>
          <span role="cell">上级目录</span>
          <small role="cell">-</small>
          <small role="cell">-</small>
          <small role="cell">-</small>
        </Button>
        {entries.length > 0 ? (
          entries.map((entry, entryIndex) =>
            editingEntryPath === entry.path ? (
              <div
                className={[
                  "file-browser-row",
                  "active",
                  "is-editing",
                  `is-${entry.kind}`,
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={entry.path}
                role="row"
              >
                <span className="file-browser-name" role="cell">
                  <Icon
                    className={[
                      "simple-sftp-entry-icon",
                      `is-${entry.kind === "directory" ? "folder" : fileIconKind(entry.name)}`,
                    ].join(" ")}
                    name={remoteEntryIconName(entry)}
                  />
                  <TextInput
                    autoFocus
                    className="file-inline-name-input"
                    value={editingName}
                    onBlur={() => commitInlineRename(entry)}
                    onChange={(event) => {
                      const nextName = event.currentTarget.value;
                      const sanitizedName = sanitizeEntryName(nextName);

                      if (nextName !== sanitizedName) {
                        setInlineNotice("名称不能包含特殊符号：\\ / : * ? \" < > |");
                      }

                      setEditingName(sanitizedName);
                    }}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        commitInlineRename(entry);
                      }

                      if (event.key === "Escape") {
                        cancelInlineRename();
                      }
                    }}
                  />
                </span>
                <span role="cell">{kindLabel(entry.kind)}</span>
                <small role="cell">{entry.kind === "directory" ? "-" : formatBytes(entry.size)}</small>
                <small role="cell">{formatModifiedAt(entry.modifiedAt)}</small>
                <small role="cell">{formatPermissions(entry)}</small>
              </div>
            ) : (
              <Button
                className={[
                  "file-browser-row",
                  (multiSelection?.selectedPaths.has(entry.path) ?? entry.path === selectedEntry?.path) ? "active" : "",
                  `is-${entry.kind}`,
                ]
                  .filter(Boolean)
                  .join(" ")}
                disabled={disabled}
                key={entry.path}
                onClick={(event) => {
                  if (multiSelection) {
                    multiSelection.onSelect(event, entry, entryIndex);
                    return;
                  }

                  onSelectEntry(entry);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (multiSelection) {
                    if (!multiSelection.selectedPaths.has(entry.path)) {
                      multiSelection.onSelectOnly(entry);
                    }
                  } else {
                    onSelectEntry(entry);
                  }
                  setContextMenu({ entry, x: event.clientX, y: event.clientY });
                }}
                onDoubleClick={() => {
                  if (entry.kind === "directory") {
                    onOpenDirectory(resolveEntryDirectoryPath(path, entry, pathKind));
                  }
                }}
                role="row"
                aria-selected={multiSelection?.selectedPaths.has(entry.path)}
                title={entry.kind === "directory" ? `打开 ${entry.name}` : `选择 ${entry.name}`}
                tone="muted"
              >
                <span className="file-browser-name" role="cell">
                  <Icon
                    className={[
                      "simple-sftp-entry-icon",
                      `is-${entry.kind === "directory" ? "folder" : fileIconKind(entry.name)}`,
                    ].join(" ")}
                    name={remoteEntryIconName(entry)}
                  />
                  <strong>{entry.name}</strong>
                </span>
                <span role="cell">{kindLabel(entry.kind)}</span>
                <small role="cell">{entry.kind === "directory" ? "-" : formatBytes(entry.size)}</small>
                <small role="cell">{formatModifiedAt(entry.modifiedAt)}</small>
                <small role="cell">{formatPermissions(entry)}</small>
              </Button>
            ),
          )
        ) : (
          <span className="file-browser-empty">
            {disabled ? "远程文件需要先打开 SFTP 连接。" : "当前目录为空或尚未刷新。"}
          </span>
        )}
      </div>
      {contextMenu ? (
        <FileEntryContextMenu
          canAct={!disabled}
          canCopySelection={multiSelection?.canDownload}
          copyLabel={copyLabel}
          entry={contextMenu.entry}
          selectionCount={multiSelection?.count}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
          onCopyToPeer={() => {
            if (multiSelection) {
              return multiSelection.onDownload();
            }

            if (contextMenu.entry) {
              return onCopyToPeer(contextMenu.entry);
            }
          }}
          onCreateDirectory={createDirectoryInline}
          onRemove={() => multiSelection ? multiSelection.onDelete() : onRemove(contextMenu.entry)}
          onRename={() => {
            if (contextMenu.entry) {
              startInlineRename(contextMenu.entry);
            }
          }}
        />
      ) : null}
      {inlineNotice ? <div className="file-inline-notice">{inlineNotice}</div> : null}
      {dropUploadEnabled ? (
        <SftpDropOverlay active={dropActive} className="file-drop-overlay" />
      ) : null}
    </div>
  );
}

function uniqueEntryName(entries: RemoteEntry[], baseName: string, ignorePath?: string) {
  const names = new Set(
    entries
      .filter((entry) => entry.path !== ignorePath)
      .map((entry) => entry.name.trim().toLocaleLowerCase()),
  );
  const normalizedBase = safeEntryBaseName(baseName);

  if (!names.has(normalizedBase.toLocaleLowerCase())) {
    return normalizedBase;
  }

  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${normalizedBase} (${index})`;

    if (!names.has(candidate.toLocaleLowerCase())) {
      return candidate;
    }
  }

  return `${normalizedBase}-${Date.now()}`;
}

const invalidEntryNamePattern = /[<>:"/\\|?*\x00-\x1F]/g;
const invalidEntryNameTestPattern = /[<>:"/\\|?*\x00-\x1F]/;
const windowsReservedEntryNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function sanitizeEntryName(name: string) {
  return name.replace(invalidEntryNamePattern, "");
}

function safeEntryBaseName(name: string) {
  const sanitized = sanitizeEntryName(name).trim();
  const invalidReason = entryNameInvalidReason(sanitized);

  if (!invalidReason) {
    return sanitized;
  }

  return "新建文件夹";
}

function entryNameInvalidReason(name: string) {
  if (!name) {
    return "名称不能为空。";
  }

  if (name === "." || name === "..") {
    return "名称不能是 . 或 ..。";
  }

  if (/[ .]$/.test(name)) {
    return "名称不能以空格或点结尾。";
  }

  if (windowsReservedEntryNames.test(name)) {
    return "名称不能使用系统保留名。";
  }

  if (invalidEntryNameTestPattern.test(name)) {
    return "名称不能包含特殊符号：\\ / : * ? \" < > |";
  }

  return "";
}

function kindLabel(kind: RemoteEntry["kind"]) {
  const labels = {
    directory: "文件夹",
    file: "文件",
    other: "其它",
    symlink: "链接",
  };

  return labels[kind];
}

function isTransferableEntry(entry: RemoteEntry | null) {
  return entry?.kind === "file" || entry?.kind === "directory";
}

function formatModifiedAt(value?: string) {
  if (!value) {
    return "-";
  }

  if (value.startsWith("unix:")) {
    const seconds = Number.parseInt(value.slice("unix:".length), 10);

    if (Number.isFinite(seconds)) {
      return new Date(seconds * 1000).toLocaleString();
    }
  }

  return value;
}

function formatBytes(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatPermissions(entry: RemoteEntry) {
  const permissions = entry.permissions?.trim();

  if (!permissions) {
    return "-";
  }

  if (/^[dl-][rwxstST-]{9}$/.test(permissions)) {
    return permissions;
  }

  if (!/^[0-7]+$/.test(permissions)) {
    return permissions;
  }

  const mode = Number.parseInt(permissions, 8);

  if (!Number.isFinite(mode)) {
    return permissions;
  }

  const typePrefix = entry.kind === "directory" ? "d" : entry.kind === "symlink" ? "l" : "-";
  const permissionBits = mode & 0o777;
  const specialBits = mode & 0o7000;
  const triplets = [
    permissionTriplet(permissionBits, 6, Boolean(specialBits & 0o4000), "s", "S"),
    permissionTriplet(permissionBits, 3, Boolean(specialBits & 0o2000), "s", "S"),
    permissionTriplet(permissionBits, 0, Boolean(specialBits & 0o1000), "t", "T"),
  ];

  return `${typePrefix}${triplets.join("")}`;
}

function permissionTriplet(
  permissionBits: number,
  shift: number,
  special: boolean,
  executableSpecial: string,
  nonExecutableSpecial: string,
) {
  const value = (permissionBits >> shift) & 0b111;
  const readable = value & 0b100 ? "r" : "-";
  const writable = value & 0b010 ? "w" : "-";
  const executable = value & 0b001 ? "x" : "-";

  if (!special) {
    return `${readable}${writable}${executable}`;
  }

  return `${readable}${writable}${executable === "x" ? executableSpecial : nonExecutableSpecial}`;
}

function parentPath(path: string, pathKind: "local" | "remote" = "local") {
  const trimmed = path.trim();

  if (!trimmed || trimmed === "." || trimmed === "/" || trimmed === localRootsPath) {
    return trimmed === "/" || trimmed === localRootsPath ? trimmed : "";
  }

  if (pathKind === "remote") {
    const normalized = normalizeRemoteDisplayPath(trimmed);

    if (normalized === "/") {
      return "/";
    }

    const parent = normalized.slice(0, normalized.lastIndexOf("/"));
    return parent || "/";
  }

  if (/^[a-zA-Z]:[\\/]?$/.test(trimmed)) {
    return localRootsPath;
  }

  const normalized = trimmed.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));

  if (separatorIndex <= 0) {
    return ".";
  }

  if (/^[a-zA-Z]:$/.test(normalized.slice(0, separatorIndex))) {
    return normalized.slice(0, separatorIndex + 1);
  }

  return normalized.slice(0, separatorIndex);
}

function canGoParent(path: string) {
  const trimmed = path.trim();

  return Boolean(trimmed && trimmed !== "." && trimmed !== "/" && trimmed !== localRootsPath);
}

function resolveEntryDirectoryPath(
  currentPath: string,
  entry: RemoteEntry,
  pathKind: "local" | "remote",
) {
  if (pathKind === "local") {
    return entry.path;
  }

  const entryPath = entry.path.trim();

  if (entryPath.startsWith("/")) {
    return normalizeRemoteDisplayPath(entryPath);
  }

  return joinRemoteDisplayPath(currentPath, entryPath || entry.name);
}

function normalizeRemoteDisplayPath(path: string) {
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

  return parts.length ? `/${parts.join("/")}` : "/";
}

function joinRemoteDisplayPath(basePath: string, name: string) {
  const base = normalizeRemoteDisplayPath(basePath);
  const cleanName = name.trim().replace(/^\/+/, "");

  return normalizeRemoteDisplayPath(base === "/" ? `/${cleanName}` : `${base}/${cleanName}`);
}
