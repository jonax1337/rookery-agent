import { useMemo } from 'react';

import { useOrgState, useTasksState } from '@/providers/rookery-provider';
import type { Assignment } from '@/lib/types';

import { toAssignmentRow, type AssignmentRow } from './assignment-row';

/**
 * Table rows for the given assignments: agent names resolved, the socket's
 * live status overlaid, and the board task that points at each run (for
 * "View task").
 */
export function useAssignmentRows(assignments: Assignment[]): AssignmentRow[] {
  const org = useOrgState();
  const { tasks } = useTasksState();

  const taskIdByAssignment = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of tasks) if (task.assignmentId) map.set(task.assignmentId, task.id);
    return map;
  }, [tasks]);

  return useMemo(
    () =>
      assignments.map((assignment) =>
        toAssignmentRow(
          assignment,
          org.agentById(assignment.agentId),
          org.live[assignment.id],
          taskIdByAssignment.get(assignment.id),
        ),
      ),
    [assignments, org, taskIdByAssignment],
  );
}
