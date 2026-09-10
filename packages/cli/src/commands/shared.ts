/**
 * Small helpers shared by the commands: option validation, an assistant
 * factory with guaranteed cleanup, and id-prefix resolution so nobody has to
 * paste a full UUID at a prompt.
 */

import { Assistant, EFFORT_LEVELS, MEMORY_KINDS } from '@rookery/core';
import type {
  EffortLevel,
  Agent,
  MemoryKind,
  PermissionLevel,
  Project,
  ProviderId,
  Session,
  Task,
  TaskPriority,
  TaskStatus,
} from '@rookery/core';
import { glyph, theme } from '../ui/theme.js';

export const PERMISSION_LEVELS: readonly PermissionLevel[] = ['chat', 'read', 'write', 'full'];
export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'codex'];
export const TASK_STATUSES: readonly TaskStatus[] = [
  'open',
  'planned',
  'running',
  'done',
  'failed',
  'cancelled',
];
export const TASK_PRIORITIES: readonly TaskPriority[] = ['low', 'normal', 'high'];
/**
 * What a board shows when nobody asked for a set of statuses. Finished and
 * cancelled work is history, and history is what `--all` is for.
 */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ['open', 'planned', 'running', 'failed'];

export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export function parsePermission(value: string | undefined): PermissionLevel | undefined {
  if (value === undefined) return undefined;
  const level = value.trim().toLowerCase() as PermissionLevel;
  if (!PERMISSION_LEVELS.includes(level)) {
    throw new CliError('Unknown permission "' + value + '". Use one of: ' + PERMISSION_LEVELS.join(', '));
  }
  return level;
}

export function parseEffort(value: string | undefined): EffortLevel | undefined {
  if (value === undefined) return undefined;
  const level = value.trim().toLowerCase() as EffortLevel;
  if (!EFFORT_LEVELS.includes(level)) {
    throw new CliError('Unknown effort "' + value + '". Use one of: ' + EFFORT_LEVELS.join(', '));
  }
  return level;
}

export function parseProvider(value: string | undefined): ProviderId | undefined {
  if (value === undefined) return undefined;
  const id = value.trim().toLowerCase() as ProviderId;
  if (!PROVIDER_IDS.includes(id)) {
    throw new CliError('Unknown provider "' + value + '". Use one of: ' + PROVIDER_IDS.join(', '));
  }
  return id;
}

export function parseKind(value: string | undefined): MemoryKind | undefined {
  if (value === undefined) return undefined;
  const kind = value.trim().toLowerCase() as MemoryKind;
  if (!MEMORY_KINDS.includes(kind)) {
    throw new CliError('Unknown memory kind "' + value + '". Use one of: ' + MEMORY_KINDS.join(', '));
  }
  return kind;
}

export function parseTags(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const tags = value
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  return tags.length ? tags : undefined;
}

export function parseImportance(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const importance = Number(value);
  if (!Number.isFinite(importance) || importance < 0 || importance > 1) {
    throw new CliError('Importance must be a number between 0 and 1, got "' + value + '".');
  }
  return importance;
}

/** `--status open,running` -> the statuses, or undefined when nothing was asked for. */
export function parseTaskStatuses(value: string | undefined): TaskStatus[] | undefined {
  if (value === undefined) return undefined;
  const wanted = value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean) as TaskStatus[];
  if (!wanted.length) return undefined;
  for (const status of wanted) {
    if (!TASK_STATUSES.includes(status)) {
      throw new CliError('Unknown task status "' + status + '". Use one of: ' + TASK_STATUSES.join(', '));
    }
  }
  return [...new Set(wanted)];
}

export function parseTaskPriority(value: string | undefined): TaskPriority | undefined {
  if (value === undefined) return undefined;
  const priority = value.trim().toLowerCase() as TaskPriority;
  if (!TASK_PRIORITIES.includes(priority)) {
    throw new CliError('Unknown priority "' + value + '". Use one of: ' + TASK_PRIORITIES.join(', '));
  }
  return priority;
}

export function parseLimit(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new CliError('--limit must be a positive integer, got "' + value + '".');
  }
  return limit;
}

/** Run `fn` with an assistant that is always closed, even on failure. */
export async function withAssistant<T>(fn: (assistant: Assistant) => Promise<T> | T): Promise<T> {
  const assistant = new Assistant();
  try {
    return await fn(assistant);
  } finally {
    try {
      assistant.close();
    } catch {
      /* the database was already closed */
    }
  }
}

/** Accept a full id or any unambiguous prefix of one. */
export function resolveSession(assistant: Assistant, idOrPrefix: string): Session {
  const exact = assistant.getSession(idOrPrefix);
  if (exact) return exact;

  const needle = idOrPrefix.trim().toLowerCase();
  const matches = assistant.store
    .listSessions({ limit: 500, includeArchived: true })
    .filter((session) => session.id.toLowerCase().startsWith(needle));

  if (matches.length === 1) return matches[0] as Session;
  if (matches.length === 0) throw new CliError('No session matches "' + idOrPrefix + '".');
  throw new CliError(
    'Ambiguous session id "' + idOrPrefix + '": ' + matches.map((s) => s.id.slice(0, 8)).join(', '),
  );
}

/**
 * Resolve a project name or id in the active company. Returns undefined when
 * no reference was given, and throws when one was given and does not exist -
 * silently running in the wrong project is worse than a hard stop.
 */
export function resolveProject(assistant: Assistant, ref: string | undefined): Project | undefined {
  const wanted = ref?.trim();
  if (!wanted) return undefined;
  const organization = assistant.org.activeOrganization();
  const project = assistant.store.org.findProject(organization.id, wanted);
  if (!project) {
    throw new CliError('No project "' + wanted + '". Run `rookery org projects` to see them.');
  }
  return project;
}

/**
 * Resolve an agent by slug, name or id in the active company. Throws when the
 * reference does not match anyone: talking to the wrong colleague, or silently
 * falling back to the assistant, is worse than a hard stop.
 */
export function resolveAgent(assistant: Assistant, ref: string): Agent {
  const wanted = ref.trim();
  if (!wanted) throw new CliError('Name an agent, e.g. `--agent backend-dev`.');
  const organization = assistant.org.activeOrganization();
  const agent = assistant.store.org.findAgent(organization.id, wanted);
  if (!agent) {
    throw new CliError('No agent "' + wanted + '". Run `rookery org agents` to see who works here.');
  }
  return agent;
}

/**
 * Who a conversation is with, as one short handle: an agent's slug for a
 * direct chat, `assistant` otherwise. An agent that has since been let go
 * still leaves its id behind, so that case degrades to the id rather than
 * pretending the conversation was with the assistant all along.
 */
export function counterpartLabel(assistant: Assistant, agentId: string | undefined): string {
  if (!agentId) return 'assistant';
  return assistant.store.org.getAgent(agentId)?.slug ?? agentId.slice(0, 8);
}

/** Accept a full task id or any unambiguous prefix of one. */
export function resolveTask(assistant: Assistant, idOrPrefix: string): Task {
  const wanted = idOrPrefix.trim();
  if (!wanted) throw new CliError('Name a task, e.g. `rookery tasks show 4f3a`.');
  const organization = assistant.org.activeOrganization();
  const task = assistant.org.findTask(organization.id, wanted);
  if (task) return task;

  // `findTask` returns null both for "nothing" and for "several"; say which.
  const matches = assistant.store.org
    .listAllTasks(organization.id, 500)
    .filter((candidate) => candidate.id.toLowerCase().startsWith(wanted.toLowerCase()));
  if (matches.length > 1) {
    throw new CliError(
      'Ambiguous task id "' + wanted + '": ' + matches.map((item) => item.id.slice(0, 8)).join(', '),
    );
  }
  throw new CliError('No task matches "' + wanted + '". Run `rookery tasks` to see the board.');
}

/** Same prefix trick for memories. */
export function resolveMemoryId(assistant: Assistant, idOrPrefix: string): string {
  if (assistant.store.getMemory(idOrPrefix)) return idOrPrefix;

  const needle = idOrPrefix.trim().toLowerCase();
  const matches = assistant.store
    .listMemories({ limit: 1000, includeForgotten: true })
    .filter((memory) => memory.id.toLowerCase().startsWith(needle));

  if (matches.length === 1) return (matches[0] as { id: string }).id;
  if (matches.length === 0) throw new CliError('No memory matches "' + idOrPrefix + '".');
  throw new CliError(
    'Ambiguous memory id "' + idOrPrefix + '": ' + matches.map((m) => m.id.slice(0, 8)).join(', '),
  );
}

export function printError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(theme.red(glyph.fail + ' ' + message) + '\n');
}
