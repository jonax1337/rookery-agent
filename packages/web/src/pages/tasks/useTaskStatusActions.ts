import { useCallback } from 'react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { failureMessage } from '@/lib/errors';
import { useTasksState } from '@/providers/rookery-provider';
import { useConfirm } from '@/components/common/confirm-dialog';
import {
  CANCEL_TASK_CONFIRMATION,
  isTaskConflict,
  notifyTaskRunning,
} from '@/pages/tasks/task-feedback';

type ManualStatus = 'done' | 'cancelled';

const STATUS_CHANGED_TOAST: Record<ManualStatus, string> = {
  done: 'Task completed',
  cancelled: 'Task cancelled',
};

interface UseTaskStatusActionsOptions {
  taskId: string | undefined;
  reload(): Promise<void>;
}

/** Complete and cancel, the two status changes the detail page offers. */
export function useTaskStatusActions({ taskId, reload }: UseTaskStatusActionsOptions) {
  const tasks = useTasksState();
  const { confirm, dialog } = useConfirm();

  const setStatus = useCallback(
    async (status: ManualStatus): Promise<void> => {
      if (!taskId) return;
      try {
        await api.updateTask(taskId, { status });
        await tasks.refresh();
        await reload();
        toast(STATUS_CHANGED_TOAST[status]);
      } catch (caught) {
        if (isTaskConflict(caught)) {
          notifyTaskRunning();
        } else {
          toast.error('Status unchanged', { description: failureMessage(caught) });
        }
      }
    },
    [taskId, reload, tasks],
  );

  const completeTask = useCallback(() => setStatus('done'), [setStatus]);

  const cancelTask = useCallback(async (): Promise<void> => {
    if (await confirm(CANCEL_TASK_CONFIRMATION)) await setStatus('cancelled');
  }, [confirm, setStatus]);

  return { completeTask, cancelTask, dialog };
}
