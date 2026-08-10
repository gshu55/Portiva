import { connectionStatusLabel } from "../../shared/labels";
import { Icon } from "../../shared/Icon";
import type { WorkspaceSessionTab } from "../../shared/types";

interface TabContextMenuProps {
  position: {
    x: number;
    y: number;
  };
  tab: WorkspaceSessionTab;
  tabId: string;
  canSplitRight?: boolean;
  onClose: () => void;
  onCloseTab: (tabId: string) => void;
  onOpenFileTransfer?: (connectionId: string, options?: { forceNew?: boolean }) => void;
  onOpenWindow: (tabId: string) => void;
  onReconnect: (tabId: string) => void;
  onSplitRight?: (tabId: string) => void;
}

export function TabContextMenu({
  canSplitRight = false,
  onClose,
  onCloseTab,
  onOpenFileTransfer,
  onOpenWindow,
  onReconnect,
  onSplitRight,
  position,
  tab,
  tabId,
}: TabContextMenuProps) {
  const isFileTransferTab = (tab.kind ?? "terminal") === "file-transfer";
  const isCustomPageTab = ["settings", "http-console", "host-dashboard", "network-scan"].includes(tab.kind ?? "terminal");
  const status = isCustomPageTab
    ? "页面"
    : isFileTransferTab
    ? "文件管理"
    : tab.restored
      ? "已恢复"
      : connectionStatusLabel(tab.connection.status);
  const reconnectTargetId = isCustomPageTab ? undefined : isFileTransferTab ? tab.parentConnectionId : tabId;
  const canOpenFileTransfer =
    !isCustomPageTab &&
    !isFileTransferTab &&
    tab.connection.capabilities.sftp &&
    tab.connection.capabilities.fileTransfer;

  const runAction = (action: () => void) => {
    action();
    onClose();
  };

  return (
    <div
      className="tab-context-menu"
      onPointerDown={(event) => event.stopPropagation()}
      role="menu"
      style={{ left: position.x, top: position.y }}
    >
      <div className="tab-context-summary">
        <strong>{tab.connection.title}</strong>
        <span>{status}</span>
      </div>
      <div className="tab-context-actions">
        <button
          disabled={!reconnectTargetId}
          onClick={() => runAction(() => reconnectTargetId ? onReconnect(reconnectTargetId) : undefined)}
          role="menuitem"
          title="重连"
          type="button"
        >
          <Icon name="rotate-ccw" />
          <span>重连</span>
        </button>
        <button
          disabled={!canOpenFileTransfer || !onOpenFileTransfer}
          onClick={() => runAction(() => onOpenFileTransfer?.(tab.connection.id, { forceNew: true }))}
          role="menuitem"
          title={canOpenFileTransfer ? "打开 SFTP 文件管理" : "当前标签不支持 SFTP"}
          type="button"
        >
          <Icon name="folder-open" />
          <span>打开 SFTP</span>
        </button>
        <button
          disabled={isCustomPageTab || !canSplitRight}
          onClick={() => runAction(() => onSplitRight?.(tabId))}
          role="menuitem"
          title={!isCustomPageTab && canSplitRight ? "右侧分屏" : "当前标签不支持分屏"}
          type="button"
        >
          <Icon name="columns-2" />
          <span>右侧分屏</span>
        </button>
        <button
          disabled={isCustomPageTab}
          onClick={() => runAction(() => onOpenWindow(tabId))}
          role="menuitem"
          title={isCustomPageTab ? "应用页面标签不支持单独窗口" : "单独窗口"}
          type="button"
        >
          <Icon name="external-link" />
          <span>单独窗口</span>
        </button>
        <button
          className="danger-action"
          onClick={() => runAction(() => onCloseTab(tabId))}
          role="menuitem"
          title="关闭标签"
          type="button"
        >
          <Icon name="x" />
          <span>关闭标签</span>
        </button>
      </div>
    </div>
  );
}
