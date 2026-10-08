import { shorten } from '@/lib/format';
import type {
  Agent,
  Assignment,
  AssignmentStatus,
  AssignmentView,
  ProviderId,
} from '@/lib/types';

/** Longest title that still reads well inside an accessible label or a page title. */
const LABEL_TITLE_LENGTH = 60;

/**
 * One table row: an `Assignment` flattened, with the agent's name resolved and
 * the live status overlaid.
 *
 * Flat rather than a nested `{ assignment, agent }` because sorting, the
 * column visibility menu and the toolbar search all address fields by name.
 */
export interface AssignmentRow {
  id: string;
  status: AssignmentStatus;
  agentId: string;
  agentName: string;
  agentSlug: string;
  /** The run's name - a task's name when it carries one out. */
  title: string;
  /** The full brief, kept for search and for the drawer. */
  task: string;
  provider?: ProviderId;
  model?: string;
  chars: number;
  durationMs?: number;
  depth: number;
  createdAt: number;
  error?: string;
  /** The board task this run belongs to, when one points at it. */
  taskId?: string;
}

/**
 * Builds a row, letting the socket's newest word win over the loaded record.
 *
 * That overlay is what replaced the old full reload on every broadcast: a
 * running assignment changes its status, its character count and its duration
 * several times a second, and refetching 500 rows for each of them made the
 * table flicker for the whole length of a run.
 */
export function toAssignmentRow(
  assignment: Assignment,
  agent?: Agent,
  live?: AssignmentView,
  taskId?: string,
): AssignmentRow {
  const durationMs = live?.durationMs ?? assignment.durationMs;
  const provider = assignment.provider ?? live?.provider;
  const error = assignment.error ?? live?.error;

  return {
    id: assignment.id,
    status: live?.status ?? assignment.status,
    agentId: assignment.agentId,
    agentName: agent?.name ?? live?.agentName ?? 'Unknown',
    agentSlug: agent?.slug ?? live?.agentSlug ?? '',
    title: live?.title ?? assignment.title,
    task: assignment.task,
    chars: live?.chars ?? assignment.chars,
    depth: assignment.depth,
    createdAt: assignment.createdAt,
    ...(provider ? { provider } : {}),
    ...(assignment.model ? { model: assignment.model } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(error ? { error } : {}),
    ...(taskId ? { taskId } : {}),
  };
}

/** Pending and running assignments are the ones that can still be cancelled. */
export function isOpenStatus(status: AssignmentStatus): boolean {
  return status === 'pending' || status === 'running';
}

/** A title cut short enough for an accessible label or a page title. */
export function shortTitle(title: string): string {
  return shorten(title, LABEL_TITLE_LENGTH);
}
