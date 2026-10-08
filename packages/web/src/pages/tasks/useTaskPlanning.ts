import { useCallback, useState } from 'react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import { useTasksState } from '@/providers/rookery-provider';

interface UseTaskPlanningOptions {
  taskId: string | undefined;
  /** Re-reads the task's own record after a plan landed. */
  reload(): Promise<void>;
  /** Called with whether the plan split the task into subtasks. */
  onPlanned(createdSubtasks: boolean): void;
}

export function useTaskPlanning({ taskId, reload, onPlanned }: UseTaskPlanningOptions) {
  const tasks = useTasksState();
  const [planning, setPlanning] = useState(false);

  /** Resolves `true` when a plan was made. */
  const plan = useCallback(
    async (hint?: string): Promise<boolean> => {
      if (!taskId || planning) return false;
      setPlanning(true);
      try {
        const answer = await api.planTask(taskId, hint);
        await tasks.refresh();
        await reload();
        onPlanned(answer.children.length > 0);
        // The planner's reasoning is persisted as `planNote` and shown under
        // "Why this plan"; the toast only says where to look.
        toast('Plan ready', { description: answer.plan.reason });
        return true;
      } catch (caught) {
        reportFailure('Plan', caught);
        return false;
      } finally {
        setPlanning(false);
      }
    },
    [taskId, planning, reload, tasks, onPlanned],
  );

  return { planning, plan };
}
