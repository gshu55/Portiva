import { Icon } from "../../shared/Icon";
import type { RemoteEntry } from "../../shared/types";

interface FileEntryContextMenuProps {
  canAct: boolean;
  copyLabel: string;
  entry: RemoteEntry | null;
  position: {
    x: number;
    y: number;
  };
  onClose: () => void;
  onCopyToPeer: () => void | Promise<void>;
  onCreateDirectory: () => void | Promise<void>;
  onRemove: () => void | Promise<void>;
  onRename: () => void | Promise<void>;
}

export function FileEntryContextMenu({
  canAct,
  copyLabel,
  entry,
  onClose,
  onCopyToPeer,
  onCreateDirectory,
  onRemove,
  onRename,
  position,
}: FileEntryContextMenuProps) {
  const runAction = async (action: () => void | Promise<void>) => {
    await action();
    onClose();
  };

  return (
    <div
      className="file-context-menu"
      onPointerDown={(event) => event.stopPropagation()}
      role="menu"
      style={{ left: position.x, top: position.y }}
    >
      <button disabled={!canAct} onClick={() => void runAction(onCreateDirectory)} role="menuitem" title="新建目录" type="button">
        <Icon name="folder-plus" />
        <span>新建目录</span>
      </button>
      <button
        disabled={!canAct || !isTransferableEntry(entry)}
        onClick={() => void runAction(onCopyToPeer)}
        role="menuitem"
        title={isTransferableEntry(entry) ? copyLabel : "当前仅支持传输普通文件或文件夹"}
        type="button"
      >
        <Icon name="copy" />
        <span>{copyLabel}</span>
      </button>
      <button disabled={!canAct || !entry} onClick={() => void runAction(onRename)} role="menuitem" title="重命名" type="button">
        <Icon name="edit" />
        <span>重命名</span>
      </button>
      <button
        className="danger-action"
        disabled={!canAct || !entry}
        onClick={() => void runAction(onRemove)}
        role="menuitem"
        title="删除"
        type="button"
      >
        <Icon name="trash" />
        <span>删除</span>
      </button>
    </div>
  );
}

function isTransferableEntry(entry: RemoteEntry | null) {
  return entry?.kind === "file" || entry?.kind === "directory";
}
