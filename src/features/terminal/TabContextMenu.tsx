import { Icon } from "../../shared/Icon";
import type { WorkspaceSessionTab } from "../../shared/types";

interface TabContextMenuProps {
  isDetachedWindow?: boolean;
  position: {
    x: number;
    y: number;
  };
  tab: WorkspaceSessionTab;
  tabId: string;
  onClose: () => void;
  onCloseTab: (tabId: string) => void;
  onOpenFileTransfer?: (connectionId: string, options?: { forceNew?: boolean }) => void;
  onOpenWindow: (tabId: string) => void;
  onReconnect: (tabId: string) => void;
}

export function TabContextMenu({
  isDetachedWindow = false,
  onClose,
  onCloseTab,
  onOpenFileTransfer,
  onOpenWindow,
  onReconnect,
  position,
  tab,
  tabId,
}: TabContextMenuProps) {
  const tabKind = tab.kind ?? "terminal";
  const isTerminalTab = tabKind === "terminal";
  const isFileTransferTab = tabKind === "file-transfer";
  const isCustomPageTab = [
    "settings",
    "http-console",
    "host-dashboard",
    "network-scan",
    "wsl-files",
  ].includes(tabKind);
  const isSshTerminalTab = isTerminalTab && tab.connection.transport?.kind === "ssh";
  const isSerialTerminalTab = isTerminalTab && tab.connection.transport?.kind === "serial";
  const reconnectTargetId = isCustomPageTab ? undefined : isFileTransferTab ? tab.parentConnectionId : tabId;
  const canReconnect =
    !isSshTerminalTab &&
    !isSerialTerminalTab &&
    Boolean(reconnectTargetId) &&
    tab.connection.capabilities.reconnect;
  const canOpenFileTransfer =
    isTerminalTab &&
    tab.connection.capabilities.sftp &&
    tab.connection.capabilities.fileTransfer &&
    Boolean(onOpenFileTransfer);
  const canMoveWindow = !isCustomPageTab || tabKind === "http-console";

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
      <div className="tab-context-actions">
        {canReconnect ? (
          <button
            onClick={() => runAction(() => reconnectTargetId ? onReconnect(reconnectTargetId) : undefined)}
            role="menuitem"
            title={isFileTransferTab ? "重连所属 SSH" : "重连"}
            type="button"
          >
            <Icon name="rotate-ccw" />
            <span>{isFileTransferTab ? "重连 SSH" : "重连"}</span>
          </button>
        ) : null}
        {canOpenFileTransfer ? (
          <button
            onClick={() => runAction(() => onOpenFileTransfer?.(tab.connection.id, { forceNew: true }))}
            role="menuitem"
            title="打开 SFTP 文件管理"
            type="button"
          >
            <Icon name="folder-open" />
            <span>打开 SFTP</span>
          </button>
        ) : null}
        {canMoveWindow ? (
          <button
            onClick={() => runAction(() => onOpenWindow(tabId))}
            role="menuitem"
            title={isDetachedWindow ? "合并窗口" : "单独窗口"}
            type="button"
          >
            <Icon name={isDetachedWindow ? "restore" : "external-link"} />
            <span>{isDetachedWindow ? "合并窗口" : "单独窗口"}</span>
          </button>
        ) : null}
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
