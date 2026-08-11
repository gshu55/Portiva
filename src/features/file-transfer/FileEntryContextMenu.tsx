import { Button } from "../../shared/ui";
import type { RemoteEntry } from "../../shared/types";

interface FileEntryContextMenuProps {
  canAct: boolean;
  canCopySelection?: boolean;
  copyLabel: string;
  entry: RemoteEntry | null;
  selectionCount?: number;
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
  canCopySelection,
  copyLabel,
  entry,
  selectionCount,
  onClose,
  onCopyToPeer,
  onCreateDirectory,
  onRemove,
  onRename,
  position,
}: FileEntryContextMenuProps) {
  const selectedCount = selectionCount ?? (entry ? 1 : 0);
  const canCopy = canCopySelection ?? isTransferableEntry(entry);
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
        disabled={!canAct || !canCopy}
        icon="copy"
        onClick={() => void runAction(onCopyToPeer)}
        role="menuitem"
        title={canCopy ? copyLabel : "当前仅支持传输普通文件或文件夹"}
        tone="muted"
      >
        <span>{selectedCount > 1 ? `${copyLabel} ${selectedCount} 项` : copyLabel}</span>
      </Button>
      <Button disabled={!canAct || !entry || selectedCount > 1} icon="edit" onClick={() => void runAction(onRename)} role="menuitem" title={selectedCount > 1 ? "多选时不能重命名" : "重命名"} tone="muted">
        <span>重命名</span>
      </Button>
      <Button
        className="danger-action"
        disabled={!canAct || selectedCount === 0}
        icon="trash"
        onClick={() => void runAction(onRemove)}
        role="menuitem"
        title={selectedCount > 1 ? `删除 ${selectedCount} 项` : "删除"}
        tone="danger"
      >
        <span>{selectedCount > 1 ? `删除 ${selectedCount} 项` : "删除"}</span>
      </Button>
    </div>
  );
}

function isTransferableEntry(entry: RemoteEntry | null) {
  return entry?.kind === "file" || entry?.kind === "directory";
}
