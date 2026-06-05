import type { DragEvent, KeyboardEventHandler, MouseEventHandler, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { IconButton } from "../../shared/ui";

export type HttpTreeDragType = "project" | "request";
export type HttpTreeDropType = "workspace" | "project" | "request";
export type HttpTreeDropPosition = "before" | "after" | "inside";

export interface HttpTreeDragPayload {
  nodeId: string;
  projectId: string | null;
  type: HttpTreeDragType;
  workspaceId: string;
}

export interface HttpTreeDropTarget {
  position: HttpTreeDropPosition;
  projectId: string | null;
  requestId?: string;
  type: HttpTreeDropType;
  workspaceId: string;
}

export type HttpTreeDropTargetBase = Omit<HttpTreeDropTarget, "position">;

export interface HttpTreePointerDragState {
  active: boolean;
  drag: HttpTreeDragPayload;
  pointerId: number;
  startX: number;
  startY: number;
}

export interface HttpTreeDndHandlers {
  clearTreeDrag: () => void;
  dropTreeNode: (event: DragEvent<HTMLElement>, target: HttpTreeDropTargetBase) => void;
  startTreeDrag: (event: DragEvent<HTMLElement>, drag: HttpTreeDragPayload) => void;
  startTreePointerDrag: (event: ReactPointerEvent<HTMLElement>, drag: HttpTreeDragPayload) => void;
  treeDragClassName: (drag: HttpTreeDragPayload) => string;
  treeDropClassName: (target: HttpTreeDropTargetBase) => string;
  updateTreeDropTarget: (event: DragEvent<HTMLElement>, target: HttpTreeDropTargetBase) => void;
}

interface HttpTreeItemProps {
  active?: boolean;
  children: ReactNode;
  className?: string;
  dnd: HttpTreeDndHandlers;
  drag?: HttpTreeDragPayload;
  drop: HttpTreeDropTargetBase;
  onClick?: MouseEventHandler<HTMLDivElement>;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  onDoubleClick?: MouseEventHandler<HTMLDivElement>;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  root?: boolean;
  title?: string;
}

interface HttpTreeCreateActionProps {
  className?: string;
  label: string;
  onCreate: () => void;
  title?: string;
}

export function HttpTreeCreateAction({
  className = "http-tree-action",
  label,
  onCreate,
  title = label,
}: HttpTreeCreateActionProps) {
  return (
    <IconButton
      aria-label={label}
      className={className}
      icon="plus"
      onClick={(event) => {
        event.stopPropagation();
        onCreate();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      title={title}
    />
  );
}

export function HttpTreeItem({
  active = false,
  children,
  className = "",
  dnd,
  drag,
  drop,
  onClick,
  onContextMenu,
  onDoubleClick,
  onKeyDown,
  root = false,
  title,
}: HttpTreeItemProps) {
  const classes = [
    root ? "http-tree-root" : "http-tree-row",
    className,
    drag ? "drag-enabled" : "",
    active ? "active" : "",
    drag ? dnd.treeDragClassName(drag) : "",
    dnd.treeDropClassName(drop),
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classes}
      data-http-drop-type={drop.type}
      data-project-id={drop.projectId ?? ""}
      data-request-id={drop.requestId}
      data-workspace-id={drop.workspaceId}
      draggable={drag ? false : undefined}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      onDragEnd={drag ? dnd.clearTreeDrag : undefined}
      onDragOver={(event) => dnd.updateTreeDropTarget(event, drop)}
      onDragStart={drag ? (event) => dnd.startTreeDrag(event, drag) : undefined}
      onDrop={(event) => dnd.dropTreeNode(event, drop)}
      onKeyDown={onKeyDown}
      onPointerDown={drag ? (event) => dnd.startTreePointerDrag(event, drag) : undefined}
      role="button"
      tabIndex={0}
      title={title}
    >
      {children}
    </div>
  );
}
