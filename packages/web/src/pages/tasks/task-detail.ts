import { formatDuration, timeAgo } from '@/lib/format';
import type {
  Agent,
  Assignment,
  AssignmentStatus,
  AssignmentView,
  Task,
  TaskEvent,
} from '@/lib/types';

/** Whether a run is still open - the live list and the tab badge count these. */
export function isOpenRun(status: AssignmentStatus): boolean {
  return status === 'pending' || status === 'running';
}

/**
 * How long the task took, or how long it has been going.
 *
 * `finishedAt - startedAt` is the only duration a task carries; while it runs
 * there is no end yet, so the card says when it started and uses the same
 * coarse buckets the rest of the app uses for elapsed time.
 */
export function runtimeOf(task: Task): string {
  if (task.startedAt && task.finishedAt && task.finishedAt >= task.startedAt) {
    return formatDuration(task.finishedAt - task.startedAt) || '–';
  }
  if (task.startedAt && task.status === 'running') {
    return 'Started ' + timeAgo(task.startedAt);
  }
  return '–';
}

/** An `Assignment` record as the live list wants it, for rehydrating a run. */
export function viewOf(assignment: Assignment, agent?: Agent): AssignmentView {
  return {
    id: assignment.id,
    agentId: assignment.agentId,
    agentSlug: agent?.slug ?? assignment.agentId,
    agentName: agent?.name ?? 'Agent',
    title: assignment.title,
    task: assignment.task,
    status: assignment.status,
    depth: assignment.depth,
    chars: assignment.chars,
    ...(assignment.projectId ? { projectId: assignment.projectId } : {}),
    ...(assignment.parentId ? { parentId: assignment.parentId } : {}),
    ...(assignment.provider ? { provider: assignment.provider } : {}),
    ...(assignment.durationMs !== undefined ? { durationMs: assignment.durationMs } : {}),
    ...(assignment.error ? { error: assignment.error } : {}),
  };
}

/** Who asked the open question, as a name the answer box can address. */
export function questionAskerName(
  question: TaskEvent,
  agentById: (id: string) => Agent | undefined,
): string {
  switch (question.actorKind) {
    case 'agent':
      return agentById(question.actorAgentId ?? '')?.name ?? 'Former agent';
    case 'user':
      return 'You';
    case 'system':
      return 'Rookery';
    default:
      return 'The assistant';
  }
}
