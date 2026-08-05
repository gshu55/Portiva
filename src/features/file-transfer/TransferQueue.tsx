import type { TransferTask } from "../../shared/types";
import {
  conflictPolicyLabel,
  transferDirectionLabel,
  transferProgressPercent,
  transferTaskDisplayName,
  transferTaskSummary,
  transferTaskTooltip,
} from "../../shared/labels";
import { Icon } from "../../shared/Icon";

interface TransferQueueProps {
  tasks: TransferTask[];
  onCancel: (transferId: string) => void;
  onDelete: (transferId: string) => void;
  onPause: (transferId: string) => void;
  onResume: (transferId: string) => void;
  onRetry: (transferId: string) => void;
}

export function TransferQueue({ onCancel, onDelete, onPause, onResume, onRetry, tasks }: TransferQueueProps) {
  return (
    <section className="transfer-queue">
      <div className="dock-heading">
        <strong>传输队列</strong>
        <span>{tasks.length}</span>
      </div>
      {tasks.map((task) => {
        const progress = transferProgressPercent(task);
        const active =
          task.status === "running"
          || task.status === "paused"
          || task.status === "waiting-conflict";
        const cancellable = task.status === "pending" || active;

        return (
          <div
            className="transfer-item"
            key={task.id}
            title={transferTaskTooltip(task)}
          >
            <span>{transferDirectionLabel(task.direction)}</span>
            <span>{transferTaskDisplayName(task)}</span>
            <progress max="100" value={progress} />
            <span>{conflictPolicyLabel(task.conflictPolicy)}</span>
            <span>{task.retryCount}</span>
            <span>{transferTaskSummary(task)}</span>
            <span className="transfer-actions">
              {task.status === "paused" ? (
                <button aria-label="继续传输" onClick={() => onResume(task.id)} title="继续传输" type="button">
                  <Icon name="play" />
                </button>
              ) : task.status === "running" ? (
                <button aria-label="暂停传输" onClick={() => onPause(task.id)} title="暂停传输" type="button">
                  <Icon name="pause" />
                </button>
              ) : null}
              {task.status === "failed" ? (
                <button aria-label="重试传输" onClick={() => onRetry(task.id)} title="重试传输" type="button">
                  <Icon name="rotate-ccw" />
                </button>
              ) : null}
              {cancellable ? (
                <button aria-label="取消传输" onClick={() => onCancel(task.id)} title="取消传输" type="button">
                  <Icon name="ban" />
                </button>
              ) : null}
              <button
                aria-label="删除传输记录"
                className="danger-action"
                disabled={active}
                onClick={() => onDelete(task.id)}
                title={active ? "请先取消正在传输的任务" : "从队列中删除"}
                type="button"
              >
                <Icon name="trash" />
              </button>
            </span>
          </div>
        );
      })}
    </section>
  );
}
