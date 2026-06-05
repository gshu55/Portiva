import {
  type DragEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon, type IconName } from "../../shared/Icon";
import { transferDirectionLabel, transferStatusLabel } from "../../shared/labels";
import type { RemoteEntry, TransferTask } from "../../shared/types";
import { writeClipboardText } from "../../shared/clipboard";
import { localDownloadDirectory, localFileList, localRevealItemInDirectory } from "../../shared/ipc/commands";
import type { LocalFileListResult } from "../../shared/ipc/commands";
import type { usePortivaWorkspace } from "../../app/usePortivaWorkspace";
import { localRootsPath } from "./FileTransferPanel";

interface SimpleSftpPanelProps {
  layoutSide?: "left" | "right";
  onToggleLayoutSide?: () => void;
  workspace: ReturnType<typeof usePortivaWorkspace>;
}

export function SimpleSftpPanel({ layoutSide = "left", onToggleLayoutSide, workspace }: SimpleSftpPanelProps) {
  const [contextMenu, setContextMenu] = useState<{
    entry: RemoteEntry;
    x: number;
    y: number;
  } | null>(null);
  const [deleteConfirmEntry, setDeleteConfirmEntry] = useState<RemoteEntry | null>(null);
  const [downloadEntries, setDownloadEntries] = useState<RemoteEntry[]>([]);
  const [editingRemotePath, setEditingRemotePath] = useState<string | null>(null);
  const [editingRemoteName, setEditingRemoteName] = useState("");
  const [pendingCreatedDirectory, setPendingCreatedDirectory] = useState<{
    name: string;
    parentPath: string;
  } | null>(null);
  const [selectedRemotePaths, setSelectedRemotePaths] = useState<Set<string>>(new Set());
  const [selectionAnchorPath, setSelectionAnchorPath] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [transferPanelRatio, setTransferPanelRatio] = useState(0.34);
  const autoLoadedConnectionRef = useRef<string | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const remotePathRef = useRef(workspace.remotePath);
  const connectionId = workspace.activeConnection?.id ?? "";
  const canUseRemote = Boolean(
    workspace.activeSessionTabKind === "terminal" &&
      workspace.activeConnection?.capabilities.fileTransfer &&
      workspace.activeConnection.transport?.authenticated,
  );
  const visibleTransfers = useMemo(
    () =>
      workspace.transfers
        .filter((task) => !connectionId || task.connectionId === connectionId)
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 8),
    [connectionId, workspace.transfers],
  );

  useEffect(() => {
    if (!canUseRemote || !connectionId || autoLoadedConnectionRef.current === connectionId) {
      return;
    }

    autoLoadedConnectionRef.current = connectionId;
    void workspace.refreshRemoteFiles(workspace.remotePath || "/");
  }, [canUseRemote, connectionId, workspace]);

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

  useEffect(() => {
    if (remotePathRef.current !== workspace.remotePath) {
      remotePathRef.current = workspace.remotePath;
      setSelectedRemotePaths(new Set());
      setSelectionAnchorPath(null);
      return;
    }

    setSelectedRemotePaths((current) => {
      if (current.size === 0) {
        return current;
      }

      const availablePaths = new Set(workspace.remoteEntries.map((entry) => entry.path));
      const next = new Set([...current].filter((path) => availablePaths.has(path)));
      return next.size === current.size ? current : next;
    });
  }, [workspace.remoteEntries, workspace.remotePath]);

  useEffect(() => {
    if (!canUseRemote) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;
    const pointInsidePanel = (position: { x: number; y: number }) => {
      const panel = panelRef.current;

      if (!panel) {
        return false;
      }

      const x = position.x / window.devicePixelRatio;
      const y = position.y / window.devicePixelRatio;
      const target = document.elementFromPoint(x, y);

      return Boolean(target && panel.contains(target));
    };

    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;

          if (payload.type === "leave") {
            setDropActive(false);
            return;
          }

          if (payload.type === "enter" || payload.type === "over") {
            setDropActive(pointInsidePanel(payload.position));
            return;
          }

          if (payload.type === "drop") {
            const isPanelDrop = pointInsidePanel(payload.position);
            setDropActive(false);

            if (isPanelDrop && payload.paths.length > 0) {
              void workspace.uploadLocalPaths(payload.paths);
            }
          }
        }),
      )
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten();
          return;
        }

        unlisten = nextUnlisten;
      })
      .catch(() => {
        // Browser preview uses the HTML5 drop handler below.
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [canUseRemote, workspace.uploadLocalPaths]);

  useEffect(() => {
    if (!pendingCreatedDirectory) {
      return;
    }

    if (normalizeRemoteDisplayPath(workspace.remotePath) !== pendingCreatedDirectory.parentPath) {
      return;
    }

    const createdEntry = workspace.remoteEntries.find(
      (entry) => entry.kind === "directory" && entry.name === pendingCreatedDirectory.name,
    );

    if (!createdEntry) {
      return;
    }

    setPendingCreatedDirectory(null);
    startInlineRename(createdEntry);
  }, [pendingCreatedDirectory, workspace.remoteEntries, workspace.remotePath]);

  useEffect(
    () => () => {
      document.body.classList.remove("simple-sftp-transfer-resizing");
    },
    [],
  );

  if (!canUseRemote) {
    return null;
  }

  const openDownloadPicker = (entry: RemoteEntry) => {
    const selectedEntries = workspace.remoteEntries.filter(
      (item) => selectedRemotePaths.has(item.path) && isTransferableEntry(item),
    );

    setContextMenu(null);
    setDownloadEntries(selectedRemotePaths.has(entry.path) && selectedEntries.length > 0 ? selectedEntries : [entry]);
  };
  const copyRemoteText = async (text: string, label: string) => {
    setContextMenu(null);

    try {
      await writeClipboardText(text);
      workspace.reportWorkspaceMessage(`已复制${label}。`);
    } catch (error) {
      workspace.reportWorkspaceMessage(`复制${label}失败：${String(error)}`);
    }
  };
  const deleteRemoteEntry = (entry: RemoteEntry) => {
    setContextMenu(null);
    setDeleteConfirmEntry(entry);
  };
  const confirmDeleteRemoteEntry = async () => {
    if (!deleteConfirmEntry) {
      return;
    }

    const entry = deleteConfirmEntry;
    setDeleteConfirmEntry(null);
    await workspace.removeRemoteEntry(entry);
  };
  function startInlineRename(entry: RemoteEntry) {
    setContextMenu(null);
    setSelectedRemotePaths(new Set([entry.path]));
    setSelectionAnchorPath(entry.path);
    workspace.setSelectedRemoteEntry(entry);
    setEditingRemotePath(entry.path);
    setEditingRemoteName(entry.name);
  }
  const cancelInlineRename = () => {
    setEditingRemotePath(null);
    setEditingRemoteName("");
  };
  const createDirectoryInline = async () => {
    const selectedDirectory = workspace.remoteEntries.find(
      (entry) => selectedRemotePaths.has(entry.path) && entry.kind === "directory",
    );
    const targetParentPath = normalizeRemoteDisplayPath(selectedDirectory?.path ?? workspace.remotePath);
    const isCurrentDirectory = targetParentPath === normalizeRemoteDisplayPath(workspace.remotePath);
    const nextName = isCurrentDirectory
      ? uniqueEntryName(workspace.remoteEntries, "新建文件夹")
      : "新建文件夹";

    setContextMenu(null);
    setPendingCreatedDirectory({ name: nextName, parentPath: targetParentPath });

    const created = await workspace.createRemoteDirectory(nextName, targetParentPath);

    if (created === false) {
      setPendingCreatedDirectory(null);
    }
  };
  const commitInlineRename = async (entry: RemoteEntry) => {
    const requestedName = sanitizeEntryName(editingRemoteName).trim();
    const invalidReason = entryNameInvalidReason(requestedName);

    if (invalidReason) {
      setEditingRemoteName(requestedName);
      workspace.reportWorkspaceMessage(invalidReason);
      return;
    }

    cancelInlineRename();

    if (requestedName === entry.name) {
      return;
    }

    const nextName = uniqueEntryName(workspace.remoteEntries, requestedName, entry.path);

    await workspace.renameRemoteEntry(entry, nextName);
  };
  const syncRemotePathFromTerminal = async () => {
    const snapshot = await workspace.refreshTerminalSnapshot();
    const terminalText = snapshot?.bufferPreview ?? workspace.terminalSnapshot?.bufferPreview ?? "";
    const username = "username" in workspace.activeProfile ? workspace.activeProfile.username ?? "" : "";
    const remotePath = inferRemotePathFromTerminalText(terminalText, username);

    if (!remotePath) {
      workspace.reportWorkspaceMessage("未能从终端输出中识别当前 SSH 目录。可以先在终端执行 pwd，再点击同步。");
      return;
    }

    await workspace.refreshRemoteFiles(remotePath);
  };
  const openTransferLocalFolder = async (localPath: string) => {
    try {
      await localRevealItemInDirectory(localPath);
    } catch (error) {
      workspace.reportWorkspaceMessage(`打开所在文件夹失败：${String(error)}`);
    }
  };
  const selectEntry = (
    event: Pick<MouseEvent<HTMLElement>, "ctrlKey" | "metaKey" | "shiftKey">,
    entry: RemoteEntry,
    entryIndex: number,
  ) => {
    if (event.shiftKey && selectionAnchorPath) {
      const anchorIndex = workspace.remoteEntries.findIndex((item) => item.path === selectionAnchorPath);

      if (anchorIndex >= 0) {
        const startIndex = Math.min(anchorIndex, entryIndex);
        const endIndex = Math.max(anchorIndex, entryIndex);
        const nextPaths = new Set(
          workspace.remoteEntries.slice(startIndex, endIndex + 1).map((item) => item.path),
        );

        setSelectedRemotePaths(nextPaths);
        workspace.setSelectedRemoteEntry(entry);
        return;
      }
    }

    if (event.ctrlKey || event.metaKey) {
      setSelectedRemotePaths((current) => {
        const next = new Set(current);

        if (next.has(entry.path)) {
          next.delete(entry.path);
        } else {
          next.add(entry.path);
        }

        return next;
      });
      setSelectionAnchorPath(entry.path);
      workspace.setSelectedRemoteEntry(entry);
      return;
    }

    setSelectedRemotePaths(new Set([entry.path]));
    setSelectionAnchorPath(entry.path);
    workspace.setSelectedRemoteEntry(entry);
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
      document.body.classList.remove("simple-sftp-transfer-resizing");
    };

    document.body.classList.add("simple-sftp-transfer-resizing");
    updateTransferRatio(event.clientY);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };
  const transferPanelPercent = Math.round(transferPanelRatio * 100);

  return (
    <aside
      className={[
        "simple-sftp-panel",
        layoutSide === "left" ? "simple-sftp-panel-left" : "simple-sftp-panel-right",
        dropActive ? "simple-sftp-drop-active" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      ref={panelRef}
      style={{
        gridTemplateRows: `auto auto minmax(0, 1fr) 6px minmax(96px, ${transferPanelPercent}%)`,
      }}
      onDragEnter={(event) => {
        event.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDropActive(false);
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDropActive(true);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDropActive(false);
        void workspace.uploadLocalPaths(extractLocalFilePaths(event));
      }}
    >
      <div className="simple-sftp-heading">
        <strong>SFTP</strong>
        <div className="simple-sftp-tools">
          <button
            aria-label="回到远程根目录"
            onClick={() => void workspace.refreshRemoteFiles("/")}
            title="回到远程根目录"
            type="button"
          >
            <Icon name="home" />
          </button>
          <button
            aria-label="在当前选择的目录中新建文件夹"
            onClick={() => void createDirectoryInline()}
            title="在当前选择的目录中新建文件夹"
            type="button"
          >
            <Icon name="folder-plus" />
          </button>
          {onToggleLayoutSide ? (
            <button
              aria-label={layoutSide === "right" ? "切换 SFTP 到左侧" : "切换 SFTP 到右侧"}
              onClick={onToggleLayoutSide}
              title={layoutSide === "right" ? "切换 SFTP 到左侧" : "切换 SFTP 到右侧"}
              type="button"
            >
              <Icon name={layoutSide === "right" ? "chevron-left" : "chevron-right"} />
            </button>
          ) : null}
          <button
            aria-label="同步 SSH 当前目录"
            onClick={() => void syncRemotePathFromTerminal()}
            title="同步 SSH 当前目录"
            type="button"
          >
            <Icon name="terminal" />
          </button>
          <button
            aria-label="刷新远程目录"
            onClick={() => void workspace.refreshRemoteFiles()}
            title="刷新远程目录"
            type="button"
          >
            <Icon name="refresh-ccw" />
          </button>
        </div>
      </div>

      <div className="simple-sftp-path" title={workspace.remotePath}>
        <button
          aria-label="上级目录"
          disabled={!canGoRemoteParent(workspace.remotePath)}
          onClick={() => void workspace.refreshRemoteFiles(parentRemotePath(workspace.remotePath))}
          title="上级目录"
          type="button"
        >
          <Icon name="folder-open" />
        </button>
        <span>{workspace.remotePath}</span>
      </div>

      <div className="simple-sftp-list" role="table" aria-label="远程目录">
        <div
          className="simple-sftp-row is-directory parent-directory-row"
          aria-disabled={!canGoRemoteParent(workspace.remotePath)}
          onDoubleClick={() => void workspace.refreshRemoteFiles(parentRemotePath(workspace.remotePath))}
          onKeyDown={(event) => {
            if (event.key === "Enter" && canGoRemoteParent(workspace.remotePath)) {
              void workspace.refreshRemoteFiles(parentRemotePath(workspace.remotePath));
            }
          }}
          role="row"
          tabIndex={canGoRemoteParent(workspace.remotePath) ? 0 : -1}
        >
          <span className="simple-sftp-entry-name" role="cell">
            <Icon className="simple-sftp-entry-icon" name="folder-open" />
            <strong>...</strong>
          </span>
          <small role="cell">上级目录</small>
          <small className="simple-sftp-permissions" role="cell">-</small>
        </div>

        {workspace.remoteEntries.length > 0 ? (
          workspace.remoteEntries.map((entry, entryIndex) => (
            <div
              className={[
                "simple-sftp-row",
                `is-${entry.kind}`,
                selectedRemotePaths.has(entry.path) ? "active" : "",
                editingRemotePath === entry.path ? "is-editing" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              key={entry.path}
              onClick={(event) => {
                if (editingRemotePath === entry.path) {
                  return;
                }

                selectEntry(event, entry, entryIndex);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!selectedRemotePaths.has(entry.path)) {
                  setSelectedRemotePaths(new Set([entry.path]));
                  setSelectionAnchorPath(entry.path);
                }
                workspace.setSelectedRemoteEntry(entry);
                setContextMenu({ entry, x: event.clientX, y: event.clientY });
              }}
              onDoubleClick={() => {
                if (editingRemotePath === entry.path) {
                  return;
                }

                if (entry.kind === "directory") {
                  setSelectedRemotePaths(new Set());
                  setSelectionAnchorPath(null);
                  void workspace.refreshRemoteFiles(entry.path);
                }
              }}
              onKeyDown={(event) => {
                if (editingRemotePath === entry.path) {
                  return;
                }

                if (event.key === "Enter") {
                  if (entry.kind === "directory") {
                    setSelectedRemotePaths(new Set());
                    setSelectionAnchorPath(null);
                    void workspace.refreshRemoteFiles(entry.path);
                  } else {
                    selectEntry(event, entry, entryIndex);
                  }
                }

                if (event.key === " ") {
                  event.preventDefault();
                  setSelectedRemotePaths((current) => {
                    const next = new Set(current);

                    if (next.has(entry.path)) {
                      next.delete(entry.path);
                    } else {
                      next.add(entry.path);
                    }

                    return next;
                  });
                  setSelectionAnchorPath(entry.path);
                  workspace.setSelectedRemoteEntry(entry);
                }
              }}
              role="row"
              tabIndex={0}
              title={entry.path}
            >
              <span className="simple-sftp-entry-name" role="cell">
                <Icon
                  className={[
                    "simple-sftp-entry-icon",
                    `is-${entry.kind === "directory" ? "folder" : fileIconKind(entry.name)}`,
                  ].join(" ")}
                  name={remoteEntryIconName(entry)}
                />
                {editingRemotePath === entry.path ? (
                  <input
                    autoFocus
                    className="simple-sftp-inline-name-input"
                    spellCheck={false}
                    value={editingRemoteName}
                    onBlur={cancelInlineRename}
                    onChange={(event) => setEditingRemoteName(event.currentTarget.value)}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      event.stopPropagation();

                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelInlineRename();
                        return;
                      }

                      if (event.key === "Enter") {
                        event.preventDefault();
                        void commitInlineRename(entry);
                      }
                    }}
                  />
                ) : (
                  <strong>{entry.name}</strong>
                )}
              </span>
              <small role="cell">{entry.kind === "directory" ? "" : formatBytes(entry.size)}</small>
              <small className="simple-sftp-permissions" role="cell">{formatPermissions(entry)}</small>
            </div>
          ))
        ) : (
          <span className="simple-sftp-empty">当前目录为空或尚未刷新。</span>
        )}
      </div>

      <div
        aria-label="调整传输模块高度"
        className="simple-sftp-transfer-resizer"
        onPointerDown={startTransferPanelResize}
        role="separator"
        title="调整传输模块高度"
      />

      <SimpleTransferQueue
        tasks={visibleTransfers}
        onCancel={(transferId) => workspace.updateTransferTask(transferId, "cancel")}
        onDelete={(transferId) => workspace.updateTransferTask(transferId, "delete")}
        onPause={(transferId) => workspace.updateTransferTask(transferId, "pause")}
        onOpenLocalFolder={(localPath) => void openTransferLocalFolder(localPath)}
        onResume={(transferId) => workspace.updateTransferTask(transferId, "resume")}
        onRetry={(transferId) => workspace.updateTransferTask(transferId, "retry")}
      />

      {contextMenu ? (
        <div
          className="file-context-menu simple-sftp-context-menu"
          onPointerDown={(event) => event.stopPropagation()}
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            disabled={!isTransferableEntry(contextMenu.entry)}
            onClick={() => openDownloadPicker(contextMenu.entry)}
            role="menuitem"
            title="下载到本地目录"
            type="button"
          >
            <Icon name="download" />
            <span>下载</span>
          </button>
          <button
            onClick={() => startInlineRename(contextMenu.entry)}
            role="menuitem"
            title="重命名远程条目"
            type="button"
          >
            <Icon name="edit" />
            <span>重命名</span>
          </button>
          <button
            onClick={() => void copyRemoteText(contextMenu.entry.path, "路径")}
            role="menuitem"
            title="复制远程路径"
            type="button"
          >
            <Icon name="copy" />
            <span>复制路径</span>
          </button>
          <button
            onClick={() => void copyRemoteText(contextMenu.entry.name, "名称")}
            role="menuitem"
            title="复制名称"
            type="button"
          >
            <Icon name="copy" />
            <span>复制名称</span>
          </button>
          <button
            className="danger-action"
            onClick={() => deleteRemoteEntry(contextMenu.entry)}
            role="menuitem"
            title="删除远程条目"
            type="button"
          >
            <Icon name="trash" />
            <span>删除</span>
          </button>
        </div>
      ) : null}

      {downloadEntries.length > 0 ? (
        <LocalDirectoryPicker
          entries={downloadEntries}
          onCancel={() => setDownloadEntries([])}
          onSelect={(directory) => {
            const entries = downloadEntries;
            setDownloadEntries([]);
            void (async () => {
              for (const entry of entries) {
                await workspace.downloadRemoteEntryToDirectory(entry, directory);
              }
            })();
          }}
        />
      ) : null}

      {deleteConfirmEntry ? (
        <div
          className="modal-backdrop simple-delete-confirm-backdrop"
          role="presentation"
          onMouseDown={() => setDeleteConfirmEntry(null)}
        >
          <section
            aria-label="确认删除远程条目"
            aria-modal="true"
            className="modal-card simple-delete-confirm"
            role="dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <strong>确认删除</strong>
              <button aria-label="关闭删除确认" onClick={() => setDeleteConfirmEntry(null)} title="关闭" type="button">
                <Icon name="x" />
              </button>
            </header>
            <div className="simple-delete-confirm-content">
              <p>确定要删除这个远程条目吗？该操作会直接在服务器上执行。</p>
              <code title={deleteConfirmEntry.path}>{deleteConfirmEntry.path}</code>
            </div>
            <footer>
              <button onClick={() => setDeleteConfirmEntry(null)} type="button">
                取消
              </button>
              <button className="danger-action" onClick={() => void confirmDeleteRemoteEntry()} type="button">
                删除
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      <div className="simple-sftp-drop-overlay" aria-hidden={!dropActive}>
        <Icon name="upload" />
        <span>释放上传到当前目录</span>
      </div>
    </aside>
  );
}

interface LocalDirectoryPickerProps {
  entries: RemoteEntry[];
  onCancel: () => void;
  onSelect: (directory: string) => void;
}

function LocalDirectoryPicker({ entries, onCancel, onSelect }: LocalDirectoryPickerProps) {
  const [result, setResult] = useState<LocalFileListResult | null>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const directories = useMemo(
    () => (result?.entries ?? []).filter((item) => item.kind === "directory"),
    [result?.entries],
  );
  const canSelectCurrent = Boolean(result?.path && result.path !== localRootsPath);

  useEffect(() => {
    let cancelled = false;

    setBusy(true);
    setError("");
    void (async () => {
      const targetPath = path || await localDownloadDirectory().catch(() => localRootsPath);

      try {
        return await localFileList(targetPath);
      } catch (loadError) {
        if (targetPath === localRootsPath) {
          throw loadError;
        }

        return localFileList(localRootsPath);
      }
    })()
      .then((nextResult) => {
        if (cancelled) {
          return;
        }

        setResult(nextResult);
        setPath(nextResult.path);
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(`读取目录失败：${String(loadError)}`);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBusy(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <div className="modal-backdrop simple-directory-picker-backdrop" role="presentation">
      <div
        aria-label="选择下载目录"
        aria-modal="true"
        className="modal-card simple-directory-picker"
        role="dialog"
      >
        <header>
          <strong>选择下载目录</strong>
          <button aria-label="关闭目录选择" onClick={onCancel} title="关闭" type="button">
            <Icon name="x" />
          </button>
        </header>
        <div className="simple-directory-target" title={entries.map((entry) => entry.path).join("\n")}>
          {entries.length === 1 ? entries[0].name : `已选择 ${entries.length} 个条目`}
        </div>
        <div className="simple-directory-path" title={result?.path ?? path}>
          <button
            aria-label="上级目录"
            disabled={!result?.path || !canGoLocalParent(result.path)}
            onClick={() => setPath(parentLocalPath(result?.path ?? path))}
            title="上级目录"
            type="button"
          >
            <Icon name="folder-open" />
          </button>
          <button
            aria-label="查看本地磁盘"
            onClick={() => setPath(localRootsPath)}
            title="查看本地磁盘"
            type="button"
          >
            <Icon name="hard-drive" />
          </button>
          <span>{result?.path ?? path}</span>
        </div>
        <div className="simple-directory-list" role="listbox">
          {busy ? <span className="simple-sftp-empty">正在加载...</span> : null}
          {!busy && error ? <span className="simple-directory-error">{error}</span> : null}
          {!busy && !error && directories.length === 0 ? (
            <span className="simple-sftp-empty">没有可进入的子目录。</span>
          ) : null}
          {!busy && !error
            ? directories.map((directory) => (
                <button
                  key={directory.path}
                  onDoubleClick={() => setPath(directory.path)}
                  onClick={() => setPath(directory.path)}
                  role="option"
                  title={directory.path}
                  type="button"
                >
                  <Icon className="simple-sftp-entry-icon" name="folder" />
                  <strong>{directory.name}</strong>
                </button>
              ))
            : null}
        </div>
        <footer>
          <button onClick={onCancel} type="button">
            取消
          </button>
          <button
            disabled={!canSelectCurrent}
            onClick={() => {
              if (result?.path) {
                onSelect(result.path);
              }
            }}
            type="button"
          >
            选择此目录
          </button>
        </footer>
      </div>
    </div>
  );
}

interface SimpleTransferQueueProps {
  tasks: TransferTask[];
  onCancel: (transferId: string) => void;
  onDelete: (transferId: string) => void;
  onOpenLocalFolder: (localPath: string) => void;
  onPause: (transferId: string) => void;
  onResume: (transferId: string) => void;
  onRetry: (transferId: string) => void;
}

function SimpleTransferQueue({
  onCancel,
  onDelete,
  onOpenLocalFolder,
  onPause,
  onResume,
  onRetry,
  tasks,
}: SimpleTransferQueueProps) {
  return (
    <section className="simple-sftp-transfers">
      <div className="simple-sftp-transfer-heading">
        <strong>传输</strong>
        <span>{tasks.length}</span>
      </div>
      <div className="simple-sftp-transfer-list">
        {tasks.length > 0 ? (
          tasks.map((task) => {
            const progress = task.totalBytes
              ? Math.min(100, Math.round((task.transferredBytes / task.totalBytes) * 100))
              : task.status === "completed"
                ? 100
                : 0;
            const active = task.status === "running" || task.status === "paused";
            const canOpenLocalFolder = task.status === "completed" && Boolean(task.localPath.trim());

            return (
              <div className="simple-sftp-transfer-item" key={task.id} title={`${task.remotePath}\n${task.localPath}`}>
                <div>
                  <strong>{transferDirectionLabel(task.direction)}</strong>
                  <span>{pathBaseName(task.direction === "download" ? task.remotePath : task.localPath)}</span>
                  <small>{task.error ? `失败：${task.error}` : transferStatusLabel(task.status)}</small>
                </div>
                <progress max="100" value={progress} />
                <div className="simple-sftp-transfer-actions">
                  {canOpenLocalFolder ? (
                    <button
                      aria-label="打开所在文件夹"
                      onClick={() => onOpenLocalFolder(task.localPath)}
                      title="打开所在文件夹"
                      type="button"
                    >
                      <Icon name="folder-open" />
                    </button>
                  ) : null}
                  {task.status === "paused" ? (
                    <button aria-label="继续传输" onClick={() => onResume(task.id)} title="继续传输" type="button">
                      <Icon name="play" />
                    </button>
                  ) : (
                    <button aria-label="暂停传输" onClick={() => onPause(task.id)} title="暂停传输" type="button">
                      <Icon name="pause" />
                    </button>
                  )}
                  <button aria-label="重试传输" onClick={() => onRetry(task.id)} title="重试传输" type="button">
                    <Icon name="rotate-ccw" />
                  </button>
                  <button aria-label="取消传输" onClick={() => onCancel(task.id)} title="取消传输" type="button">
                    <Icon name="ban" />
                  </button>
                  <button
                    aria-label="删除传输记录"
                    disabled={active}
                    onClick={() => onDelete(task.id)}
                    title={active ? "请先取消正在传输的任务" : "删除传输记录"}
                    type="button"
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              </div>
            );
          })
        ) : (
          <span className="simple-sftp-empty">暂无传输任务。</span>
        )}
      </div>
    </section>
  );
}

function extractLocalFilePaths(event: DragEvent<HTMLElement>) {
  const paths: string[] = [];

  for (const file of Array.from(event.dataTransfer.files)) {
    const path = (file as File & { path?: string }).path;

    if (path) {
      paths.push(path);
    }
  }

  for (const item of Array.from(event.dataTransfer.items)) {
    const file = item.kind === "file" ? item.getAsFile() : null;
    const path = (file as (File & { path?: string }) | null)?.path;

    if (path) {
      paths.push(path);
    }
  }

  return [...new Set(paths)];
}

function isTransferableEntry(entry: RemoteEntry | null) {
  return entry?.kind === "file" || entry?.kind === "directory";
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

function remoteEntryIconName(entry: RemoteEntry): IconName {
  if (entry.kind === "directory") {
    return "folder";
  }

  if (entry.kind === "symlink") {
    return "external-link";
  }

  const iconKind = fileIconKind(entry.name);
  const iconNames: Record<string, IconName> = {
    archive: "file-archive",
    audio: "file-audio",
    binary: "file-binary",
    code: "file-code",
    image: "file-image",
    text: "file-text",
    video: "file-video",
    file: "file",
  };

  return iconNames[iconKind] ?? "file";
}

function fileIconKind(name: string) {
  const extension = fileExtension(name);

  if (imageExtensions.has(extension)) {
    return "image";
  }

  if (videoExtensions.has(extension)) {
    return "video";
  }

  if (audioExtensions.has(extension)) {
    return "audio";
  }

  if (archiveExtensions.has(extension)) {
    return "archive";
  }

  if (codeExtensions.has(extension)) {
    return "code";
  }

  if (textExtensions.has(extension)) {
    return "text";
  }

  if (binaryExtensions.has(extension)) {
    return "binary";
  }

  return "file";
}

function fileExtension(name: string) {
  const cleanName = name.trim().toLowerCase();
  const compoundMatch = /\.(tar\.gz|tar\.bz2|tar\.xz|d\.ts)$/.exec(cleanName);

  if (compoundMatch) {
    return compoundMatch[1];
  }

  const dotIndex = cleanName.lastIndexOf(".");
  return dotIndex >= 0 ? cleanName.slice(dotIndex + 1) : "";
}

const imageExtensions = new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"]);
const videoExtensions = new Set(["avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm", "wmv"]);
const audioExtensions = new Set(["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "wma"]);
const archiveExtensions = new Set(["7z", "bz2", "gz", "jar", "rar", "tar", "tar.bz2", "tar.gz", "tar.xz", "tgz", "war", "xz", "zip"]);
const codeExtensions = new Set([
  "bat",
  "c",
  "cmd",
  "cpp",
  "cs",
  "css",
  "d.ts",
  "go",
  "h",
  "html",
  "java",
  "js",
  "jsx",
  "kt",
  "php",
  "ps1",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "swift",
  "ts",
  "tsx",
  "vue",
]);
const textExtensions = new Set(["conf", "csv", "env", "ini", "json", "log", "md", "properties", "text", "toml", "txt", "xml", "yaml", "yml"]);
const binaryExtensions = new Set(["bin", "dll", "dmg", "exe", "msi", "o", "obj", "so"]);

function canGoRemoteParent(path: string) {
  const trimmed = path.trim();
  return Boolean(trimmed && trimmed !== "/");
}

function parentRemotePath(path: string) {
  const normalized = normalizeRemoteDisplayPath(path);

  if (normalized === "/") {
    return "/";
  }

  const parent = normalized.slice(0, normalized.lastIndexOf("/"));
  return parent || "/";
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

function inferRemotePathFromTerminalText(text: string, username: string) {
  const lines = stripAnsiSequences(text)
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines.slice().reverse()) {
    const path = inferRemotePathFromTerminalLine(line, username);

    if (path) {
      return path;
    }
  }

  return "";
}

function inferRemotePathFromTerminalLine(line: string, username: string) {
  const normalizedLine = line.replace(/\s+/g, " ").trim();
  const promptPath =
    matchLastPath(normalizedLine, /(?:^|\s|:)(~|\/[^\s$#>%\]]+)(?=[$#>%\]]?\s*$)/) ??
    matchLastPath(normalizedLine, /\[[^\]]*?(~|\/[^\s\]]+)\][$#>%]?\s*$/) ??
    matchLastPath(normalizedLine, /(?:^|\s)(~|\/[^\s]+)$/);

  return promptPath ? expandRemoteHomePath(promptPath, username) : "";
}

function matchLastPath(line: string, pattern: RegExp) {
  const match = pattern.exec(line);
  return match?.[1] ?? "";
}

function expandRemoteHomePath(path: string, username: string) {
  if (path === "~" || path.startsWith("~/")) {
    const home = username.trim() === "root" ? "/root" : username.trim() ? `/home/${username.trim()}` : "";

    if (!home) {
      return "";
    }

    return normalizeRemoteDisplayPath(path === "~" ? home : `${home}/${path.slice(2)}`);
  }

  return normalizeRemoteDisplayPath(path);
}

function stripAnsiSequences(text: string) {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function canGoLocalParent(path: string) {
  const trimmed = path.trim();
  return Boolean(trimmed && trimmed !== localRootsPath);
}

function parentLocalPath(path: string) {
  const trimmed = path.trim();

  if (!trimmed || trimmed === localRootsPath) {
    return localRootsPath;
  }

  if (/^[a-zA-Z]:[\\/]?$/.test(trimmed)) {
    return localRootsPath;
  }

  const normalized = trimmed.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));

  if (separatorIndex <= 0) {
    return localRootsPath;
  }

  if (/^[a-zA-Z]:$/.test(normalized.slice(0, separatorIndex))) {
    return normalized.slice(0, separatorIndex + 1);
  }

  return normalized.slice(0, separatorIndex);
}

function pathBaseName(path: string) {
  const normalized = path.trim().replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized;
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
