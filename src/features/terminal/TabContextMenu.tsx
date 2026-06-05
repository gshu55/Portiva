import { connectionStatusLabel } from "../../shared/labels";
import { Icon } from "../../shared/Icon";
import type { WorkspaceSessionTab } from "../../shared/types";

interface TabContextMenuProps {
  activeTabId?: string;
  position: {
    x: number;
    y: number;
  };
  isFullscreen: boolean;
  tab: WorkspaceSessionTab;
  tabId: string;
  canSplitRight?: boolean;
  onClose: () => void;
  onCloseTab: (tabId: string) => void;
  onOpenWindow: (tabId: string) => void;
  onReconnect: (tabId: string) => void;
  onSplitRight?: (tabId: string) => void;
  onToggleFullscreen: (tabId: string) => void;
}

export function TabContextMenu({
  activeTabId,
  isFullscreen,
  canSplitRight = false,
  onClose,
  onCloseTab,
  onOpenWindow,
  onReconnect,
  onSplitRight,
  onToggleFullscreen,
  position,
  tab,
  tabId,
}: TabContextMenuProps) {
  const isFileTransferTab = (tab.kind ?? "terminal") === "file-transfer";
  const isSettingsTab = (tab.kind ?? "terminal") === "settings";
  const status = isSettingsTab
    ? "页面"
    : isFileTransferTab
    ? "文件管理"
    : tab.restored
      ? "已恢复"
      : connectionStatusLabel(tab.connection.status);
  const reconnectTargetId = isSettingsTab ? undefined : isFileTransferTab ? tab.parentConnectionId : tabId;
  const isActiveTab = tabId === activeTabId;
  const fullscreenLabel = isFullscreen && isActiveTab ? "退出全屏" : "全屏显示";

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
        <button onClick={() => runAction(() => onToggleFullscreen(tabId))} role="menuitem" title={fullscreenLabel} type="button">
          <Icon name={isFullscreen && isActiveTab ? "minimize" : "maximize"} />
          <span>{fullscreenLabel}</span>
        </button>
        <button
          disabled={isSettingsTab || !canSplitRight}
          onClick={() => runAction(() => onSplitRight?.(tabId))}
          role="menuitem"
          title={!isSettingsTab && canSplitRight ? "右侧分屏" : "当前标签不支持分屏"}
          type="button"
        >
          <Icon name="columns-2" />
          <span>右侧分屏</span>
        </button>
        <button
          disabled={isSettingsTab}
          onClick={() => runAction(() => onOpenWindow(tabId))}
          role="menuitem"
          title={isSettingsTab ? "设置标签不支持单独窗口" : "单独窗口"}
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
