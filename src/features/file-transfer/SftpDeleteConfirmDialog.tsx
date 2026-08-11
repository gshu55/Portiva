import { Icon } from "../../shared/Icon";
import type { RemoteEntry } from "../../shared/types";

interface SftpDeleteConfirmDialogProps {
  entries: RemoteEntry[];
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}

export function SftpDeleteConfirmDialog({
  entries,
  onCancel,
  onConfirm,
}: SftpDeleteConfirmDialogProps) {
  if (entries.length === 0) {
    return null;
  }

  return (
    <div
      className="modal-backdrop simple-delete-confirm-backdrop"
      role="presentation"
      onMouseDown={onCancel}
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
          <button aria-label="关闭删除确认" onClick={onCancel} title="关闭" type="button">
            <Icon name="x" />
          </button>
        </header>
        <div className="simple-delete-confirm-content">
          <p>
            确定要删除选中的 {entries.length} 个远程条目吗？文件夹会递归删除，该操作会直接在服务器上执行。
          </p>
          <div className="simple-delete-confirm-list">
            {entries.slice(0, 6).map((entry) => (
              <code key={entry.path} title={entry.path}>{entry.path}</code>
            ))}
            {entries.length > 6 ? <small>另有 {entries.length - 6} 项</small> : null}
          </div>
        </div>
        <footer>
          <button onClick={onCancel} type="button">
            取消
          </button>
          <button className="danger-action" onClick={() => void onConfirm()} type="button">
            删除 {entries.length} 项
          </button>
        </footer>
      </section>
    </div>
  );
}
