import type { DataTableTab } from '@/components/blocks/data-table/data-table';
import { NO_PROJECT, TASK_STATUS_ORDER } from '@/lib/format';
import type { Task, TaskStatus } from '@/lib/types';

/** The sentinel for "nobody assigned yet" in the Assignee filter. */
export const UNASSIGNED = '__unassigned__';

export const ALL_TAB = 'all';

/** Failed and cancelled share one tab: both are "not done". */
const UNDONE_TAB = 'undone';

export interface TaskFilters {
  assignee: string | null;
  project: string | null;
}

export type StatusTally = Record<TaskStatus, number>;

/** Local midnight of this week's Monday - the base of "N this week". */
export function startOfWeek(now = Date.now()): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return date.getTime();
}

/** Shows a status change before the server has confirmed it. */
export function withPendingStatus(
  tasks: readonly Task[],
  pending: Readonly<Record<string, TaskStatus>>,
): Task[] {
  return tasks.map((task) => {
    const optimistic = pending[task.id];
    return optimistic ? { ...task, status: optimistic } : task;
  });
}

export function filterTasks(tasks: readonly Task[], { assignee, project }: TaskFilters): Task[] {
  return tasks.filter(
    (task) => matchesAssignee(task, assignee) && matchesProject(task, project),
  );
}

function matchesAssignee(task: Task, assignee: string | null): boolean {
  if (assignee === null) return true;
  if (assignee === UNASSIGNED) return !task.assigneeId;
  return task.assigneeId === assignee;
}

function matchesProject(task: Task, project: string | null): boolean {
  if (project === null) return true;
  if (project === NO_PROJECT) return !task.projectId;
  return task.projectId === project;
}

export function tallyByStatus(tasks: readonly Task[]): StatusTally {
  const tally = Object.fromEntries(TASK_STATUS_ORDER.map((status) => [status, 0])) as StatusTally;
  for (const task of tasks) tally[task.status] += 1;
  return tally;
}

export function buildStatusTabs(total: number, counts: StatusTally): DataTableTab[] {
  return [
    { value: ALL_TAB, label: 'All', count: total },
    { value: 'open', label: 'Open', count: counts.open },
    { value: 'planned', label: 'Planned', count: counts.planned },
    { value: 'running', label: 'Running', count: counts.running },
    { value: 'blocked', label: 'Blocked', count: counts.blocked },
    { value: 'done', label: 'Done', count: counts.done },
    { value: UNDONE_TAB, label: 'Not done', count: counts.failed + counts.cancelled },
  ];
}

export function filterByTab(tasks: Task[], tab: string): Task[] {
  if (tab === ALL_TAB) return tasks;
  if (tab === UNDONE_TAB) {
    return tasks.filter((task) => task.status === 'failed' || task.status === 'cancelled');
  }
  return tasks.filter((task) => task.status === tab);
}
