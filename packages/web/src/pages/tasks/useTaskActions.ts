import { useCallback, useState } from 'react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import { isSettableTaskStatus, type SettableTaskStatus } from '@/lib/format';
import type { RookerySocket } from '@/lib/socket';
import type { Task, TaskStatus } from '@/lib/types';
import { useOrgState, useTasksState } from '@/providers/rookery-provider';
import { useConfirm, type ConfirmHandle } from '@/components/common/confirm-dialog';
import {
  CANCEL_TASK_CONFIRMATION,
  isTaskConflict,
  notifyTaskRunning,
} from '@/pages/tasks/task-feedback';

const STATUS_CHANGED_TOAST: Record<SettableTaskStatus, string> = {
  done: 'Task completed',
  cancelled: 'Task cancelled',
  open: 'Task reopened',
  blocked: 'Task reopened',
};

const FAILED_ASSIGNMENT_MARKER = 'assignment failed';

export interface TaskActions {
  /** Status changes shown before the server has confirmed them, by task id. */
  pending: Readonly<Record<string, TaskStatus>>;
  /** Render this once inside the owning component. */
  dialog: ConfirmHandle['dialog'];
  setStatus(task: Task, status: SettableTaskStatus): Promise<void>;
  /** Applies a choice from the row's status submenu. */
  selectStatus(task: Task, status: TaskStatus): void;
  cancelTask(task: Task): Promise<void>;
  reorderTask(task: Task, sortOrder: number): Promise<void>;
  planTask(task: Task): Promise<void>;
  runTask(task: Task): void;
}

/** The row-level actions of the task list: status, cancel, reorder, plan, run. */
export function useTaskActions(socket: RookerySocket): TaskActions {
  const tasks = useTasksState();
  const org = useOrgState();
  const { confirm, dialog } = useConfirm();
  /**
   * The row reads through this map, and an entry is dropped again either when
   * the refetch lands or when the request failed - which is the rollback.
   */
  const [pending, setPending] = useState<Record<string, TaskStatus>>({});

  const applyStatus = useCallback(
    async (task: Task, status: SettableTaskStatus, force: boolean): Promise<void> => {
      setPending((current) => ({ ...current, [task.id]: status }));
      try {
        await api.updateTask(task.id, { status, ...(force ? { force: true } : {}) });
        await tasks.refresh();
        toast(STATUS_CHANGED_TOAST[status]);
      } catch (caught) {
        if (await shouldForceStatus(caught, status, force, confirm)) {
          await applyStatus(task, status, true);
        }
      } finally {
        setPending((current) => {
          const next = { ...current };
          delete next[task.id];
          return next;
        });
      }
    },
    [confirm, tasks],
  );

  const setStatus = useCallback(
    (task: Task, status: SettableTaskStatus) => applyStatus(task, status, false),
    [applyStatus],
  );

  const cancelTask = useCallback(
    async (task: Task): Promise<void> => {
      if (await confirm(CANCEL_TASK_CONFIRMATION)) await setStatus(task, 'cancelled');
    },
    [confirm, setStatus],
  );

  const selectStatus = useCallback(
    (task: Task, status: TaskStatus): void => {
      if (status === task.status) return;
      if (status === 'cancelled') void cancelTask(task);
      else if (isSettableTaskStatus(status)) void setStatus(task, status);
    },
    [cancelTask, setStatus],
  );

  const reorderTask = useCallback(
    async (task: Task, sortOrder: number): Promise<void> => {
      try {
        await api.updateTask(task.id, { sortOrder });
      } catch (caught) {
        reportFailure('Reorder task', caught);
        await tasks.refresh();
      }
    },
    [tasks],
  );

  const planTask = useCallback(
    async (task: Task): Promise<void> => {
      toast('Planning…', { description: task.title });
      try {
        await api.planTask(task.id);
        await tasks.refresh();
        toast('Plan ready', { description: task.title });
      } catch (caught) {
        reportFailure('Plan', caught);
      }
    },
    [tasks],
  );

  const runTask = useCallback(
    (task: Task): void => {
      // The row does not follow the stream: the task broadcast moves the row
      // through planned → running → done on its own. The detail page is where
      // the text is worth watching.
      socket.sendRunTask(
        { taskId: task.id },
        {
          onEvent: () => {},
          onDone: () => {
            void tasks.refresh();
            void org.refresh();
            toast('Task completed', { description: task.title });
          },
          onError: (message) => toast.error('Run failed', { description: message }),
        },
      );
      toast('Task started', { description: task.title });
    },
    [org, socket, tasks],
  );

  return { pending, dialog, setStatus, selectStatus, cancelTask, reorderTask, planTask, runTask };
}

/**
 * Reports a failed status change; resolves `true` when the reader chose to
 * force it through.
 *
 * 409 comes in two shapes: the runner has the task (only "cancel" gets
 * through), or a manual "done" disagrees with a failed assignment - the
 * latter is a confirm-and-retry, not a hard stop.
 */
async function shouldForceStatus(
  caught: unknown,
  status: SettableTaskStatus,
  alreadyForced: boolean,
  confirm: ConfirmHandle['confirm'],
): Promise<boolean> {
  if (!isTaskConflict(caught)) {
    reportFailure('Change status', caught);
    return false;
  }
  const failedAssignment = caught.message.toLowerCase().includes(FAILED_ASSIGNMENT_MARKER);
  if (alreadyForced || status !== 'done' || !failedAssignment) {
    notifyTaskRunning();
    return false;
  }
  return confirm({
    title: 'Assignment failed',
    description: 'The linked assignment failed. Mark the task done anyway?',
    confirmLabel: 'Mark done',
    cancelLabel: 'Keep open',
  });
}
