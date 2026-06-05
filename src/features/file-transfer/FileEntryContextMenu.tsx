import { Button } from "../../shared/ui";
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
      <Button disabled={!canAct} icon="folder-plus" onClick={() => void runAction(onCreateDirectory)} role="menuitem" title="新建目录" tone="muted">
        <span>新建目录</span>
      </Button>
      <Button
        disabled={!canAct || !isTransferableEntry(entry)}
        icon="copy"
        onClick={() => void runAction(onCopyToPeer)}
        role="menuitem"
        title={isTransferableEntry(entry) ? copyLabel : "当前仅支持传输普通文件或文件夹"}
        tone="muted"
      >
        <span>{copyLabel}</span>
      </Button>
      <Button disabled={!canAct || !entry} icon="edit" onClick={() => void runAction(onRename)} role="menuitem" title="重命名" tone="muted">
        <span>重命名</span>
      </Button>
      <Button
        className="danger-action"
        disabled={!canAct || !entry}
        icon="trash"
        onClick={() => void runAction(onRemove)}
        role="menuitem"
        title="删除"
        tone="danger"
      >
        <span>删除</span>
      </Button>
    </div>
  );
}

function isTransferableEntry(entry: RemoteEntry | null) {
  return entry?.kind === "file" || entry?.kind === "directory";
}
