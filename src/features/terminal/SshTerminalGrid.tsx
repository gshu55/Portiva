import { memo, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Icon } from "../../shared/Icon";
import type {
  TerminalSplitLayout,
  TerminalSplitOrientation,
  WorkspaceTerminalPane,
} from "../../shared/types";
import { maximumSshTerminalPanes } from "../../shared/terminalSplits";

interface SshTerminalGridProps {
  activeTerminalId: string;
  layout: TerminalSplitLayout;
  panes: WorkspaceTerminalPane[];
  pendingTerminalId?: string | null;
  renderPane: (pane: WorkspaceTerminalPane, isActive: boolean, paneCount: number) => ReactNode;
  onActivate: (terminalId: string) => void;
  onClose: (terminalId: string) => void;
  onResize: (path: number[], ratio: number) => void;
  onSplit: (terminalId: string, orientation: TerminalSplitOrientation) => void;
}

interface SplitNodeProps extends SshTerminalGridProps {
  node: TerminalSplitLayout;
  paneById: Map<string, WorkspaceTerminalPane>;
  paneIndexById: Map<string, number>;
  path: number[];
}

export const SshTerminalGrid = memo(function SshTerminalGrid({
  activeTerminalId,
  layout,
  panes,
  pendingTerminalId,
  renderPane,
  onActivate,
  onClose,
  onResize,
  onSplit,
}: SshTerminalGridProps) {
  const paneById = new Map(panes.map((pane) => [pane.terminal.id, pane]));
  const paneIndexById = new Map(panes.map((pane, index) => [pane.terminal.id, index + 1]));

  return (
    <div className={["ssh-terminal-grid", panes.length > 1 ? "multi-pane" : "single-pane"].join(" ")}>
      <SplitNode
        activeTerminalId={activeTerminalId}
        layout={layout}
        node={layout}
        paneById={paneById}
        paneIndexById={paneIndexById}
        panes={panes}
        path={[]}
        pendingTerminalId={pendingTerminalId}
        renderPane={renderPane}
        onActivate={onActivate}
        onClose={onClose}
        onResize={onResize}
        onSplit={onSplit}
      />
    </div>
  );
});

function SplitNode({
  activeTerminalId,
  node,
  paneById,
  paneIndexById,
  panes,
  path,
  pendingTerminalId,
  renderPane,
  onActivate,
  onClose,
  onResize,
  onSplit,
  ...sharedProps
}: SplitNodeProps) {
  if (node.type === "terminal") {
    const pane = paneById.get(node.terminalId);
    if (!pane) {
      return null;
    }

    const isActive = node.terminalId === activeTerminalId;
    const paneNumber = paneIndexById.get(node.terminalId) ?? 1;
    const splitDisabled = panes.length >= maximumSshTerminalPanes || Boolean(pendingTerminalId);
    const closeDisabled = panes.length <= 1 || Boolean(pendingTerminalId);

    return (
      <section
        aria-label={`SSH 终端 ${paneNumber}`}
        className={["ssh-terminal-grid-pane", isActive ? "active" : ""].filter(Boolean).join(" ")}
        onMouseDownCapture={() => onActivate(node.terminalId)}
      >
        <header className="ssh-terminal-grid-toolbar">
          <button
            className="ssh-terminal-grid-title"
            onClick={() => onActivate(node.terminalId)}
            title={`聚焦 SSH 终端 ${paneNumber}`}
            type="button"
          >
            <Icon name="terminal" />
            <span>SSH {paneNumber}</span>
            <small>{shortTerminalId(node.terminalId)}</small>
          </button>
          <div className="ssh-terminal-grid-actions" role="toolbar" aria-label={`SSH 终端 ${paneNumber} 分屏控制`}>
            <button
              aria-label="向右拆分终端"
              disabled={splitDisabled}
              onClick={() => onSplit(node.terminalId, "columns")}
              title={splitDisabled ? "最多同时显示 4 个 SSH 终端" : "向右拆分"}
              type="button"
            >
              <Icon name="columns-2" />
            </button>
            <button
              aria-label="向下拆分终端"
              disabled={splitDisabled}
              onClick={() => onSplit(node.terminalId, "rows")}
              title={splitDisabled ? "最多同时显示 4 个 SSH 终端" : "向下拆分"}
              type="button"
            >
              <Icon name="rows-2" />
            </button>
            <button
              aria-label="关闭当前分屏终端"
              disabled={closeDisabled}
              onClick={() => onClose(node.terminalId)}
              title={closeDisabled ? "至少保留一个 SSH 终端" : "关闭当前终端"}
              type="button"
            >
              <Icon name="x" />
            </button>
          </div>
        </header>
        <div className="ssh-terminal-grid-content">
          {renderPane(pane, isActive, panes.length)}
        </div>
        {pendingTerminalId === node.terminalId ? (
          <div className="ssh-terminal-grid-pending" role="status">正在创建终端…</div>
        ) : null}
      </section>
    );
  }

  const style = {
    "--terminal-split-ratio": `${Math.round(node.ratio * 10000) / 100}%`,
  } as CSSProperties;
  const childProps = {
    activeTerminalId,
    layout: sharedProps.layout,
    paneById,
    paneIndexById,
    panes,
    pendingTerminalId,
    renderPane,
    onActivate,
    onClose,
    onResize,
    onSplit,
  };

  return (
    <div className={["ssh-terminal-split-branch", node.orientation].join(" ")} style={style}>
      <div className="ssh-terminal-split-child first">
        <SplitNode {...childProps} node={node.first} path={[...path, 0]} />
      </div>
      <div
        aria-label={node.orientation === "columns" ? "调整左右分屏宽度" : "调整上下分屏高度"}
        aria-orientation={node.orientation === "columns" ? "vertical" : "horizontal"}
        aria-valuemax={78}
        aria-valuemin={22}
        aria-valuenow={Math.round(node.ratio * 100)}
        className="ssh-terminal-grid-resizer"
        onPointerDown={(event) => startResize(event, node.orientation, path, onResize)}
        role="separator"
        title={node.orientation === "columns" ? "调整左右分屏宽度" : "调整上下分屏高度"}
      />
      <div className="ssh-terminal-split-child second">
        <SplitNode {...childProps} node={node.second} path={[...path, 1]} />
      </div>
    </div>
  );
}

function startResize(
  event: ReactPointerEvent<HTMLDivElement>,
  orientation: TerminalSplitOrientation,
  path: number[],
  onResize: (path: number[], ratio: number) => void,
) {
  event.preventDefault();
  event.stopPropagation();
  const branch = event.currentTarget.parentElement;
  if (!branch) {
    return;
  }

  let latestRatio = 0.5;
  const updateRatio = (clientX: number, clientY: number) => {
    const bounds = branch.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return;
    }

    const rawRatio = orientation === "columns"
      ? (clientX - bounds.left) / bounds.width
      : (clientY - bounds.top) / bounds.height;
    latestRatio = Math.min(0.78, Math.max(0.22, rawRatio));
    branch.style.setProperty("--terminal-split-ratio", `${latestRatio * 100}%`);
  };
  const resizeClass = `terminal-grid-resizing-${orientation}`;
  const onPointerMove = (moveEvent: PointerEvent) => updateRatio(moveEvent.clientX, moveEvent.clientY);
  const onPointerUp = () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    document.body.classList.remove(resizeClass);
    onResize(path, latestRatio);
  };

  document.body.classList.add(resizeClass);
  updateRatio(event.clientX, event.clientY);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
}

function shortTerminalId(terminalId: string) {
  const compact = terminalId.replace(/[^a-zA-Z0-9]/g, "");
  return compact.slice(-6) || terminalId.slice(-6);
}
