/**
 * Small helpers shared by the commands: option validation, an assistant
 * factory with guaranteed cleanup, and id-prefix resolution so nobody has to
 * paste a full UUID at a prompt.
 */

import { Assistant, EFFORT_LEVELS, MEMORY_KINDS, recall } from '@rookery/core';
import type { RecallOptions } from '@rookery/core';
import type {
  Agent,
  EffortLevel,
  MemoryKind,
  Organization,
  PermissionLevel,
  Project,
  ProviderId,
  ScoredMemory,
  Session,
  Task,
  TaskPriority,
  TaskStatus,
} from '@rookery/core';
import { shortId } from '../ui/render.js';
import { glyph, theme } from '../ui/theme.js';

export const PERMISSION_LEVELS: readonly PermissionLevel[] = ['chat', 'read', 'write', 'full'];
export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'codex'];
const TASK_STATUSES: readonly TaskStatus[] = [
  'open',
  'planned',
  'running',
  'blocked',
  'done',
  'failed',
  'cancelled',
];
const TASK_PRIORITIES: readonly TaskPriority[] = ['low', 'normal', 'high'];
/**
 * What a board shows when nobody asked for a set of statuses. Finished and
 * cancelled work is history, and history is what `--all` is for.
 */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ['open', 'planned', 'running', 'blocked', 'failed'];

/** Exit code of a run the user interrupted (128 + SIGINT). */
export const EXIT_INTERRUPTED = 130;

export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/* ---------------------------- option parsing --------------------------- */

function parseChoice<Choice extends string>(
  value: string | undefined,
  choices: readonly Choice[],
  noun: string,
): Choice | undefined {
  if (value === undefined) return undefined;
  const choice = value.trim().toLowerCase() as Choice;
  if (!choices.includes(choice)) {
    throw new CliError('Unknown ' + noun + ' "' + value + '". Use one of: ' + choices.join(', '));
  }
  return choice;
}

export function parsePermission(value: string): PermissionLevel;
export function parsePermission(value: string | undefined): PermissionLevel | undefined;
export function parsePermission(value: string | undefined): PermissionLevel | undefined {
  return parseChoice(value, PERMISSION_LEVELS, 'permission');
}

export function parseEffort(value: string): EffortLevel;
export function parseEffort(value: string | undefined): EffortLevel | undefined;
export function parseEffort(value: string | undefined): EffortLevel | undefined {
  return parseChoice<EffortLevel>(value, EFFORT_LEVELS, 'effort');
}

export function parseProvider(value: string): ProviderId;
export function parseProvider(value: string | undefined): ProviderId | undefined;
export function parseProvider(value: string | undefined): ProviderId | undefined {
  return parseChoice(value, PROVIDER_IDS, 'provider');
}

export function parseKind(value: string | undefined): MemoryKind | undefined {
  return parseChoice<MemoryKind>(value, MEMORY_KINDS, 'memory kind');
}

export function parseTaskPriority(value: string | undefined): TaskPriority | undefined {
  return parseChoice(value, TASK_PRIORITIES, 'priority');
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

export function parseLimit(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new CliError('--limit must be a positive integer, got "' + value + '".');
  }
  return limit;
}

/* ------------------------------- lifecycle ------------------------------ */

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

/** Run `fn` with a signal that Ctrl+C trips instead of killing the process. */
export async function withInterruptSignal<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onInterrupt = (): void => {
    controller.abort();
  };
  process.on('SIGINT', onInterrupt);
  try {
    return await fn(controller.signal);
  } finally {
    process.off('SIGINT', onInterrupt);
  }
}

export function printInterrupted(): void {
  process.stderr.write(theme.dim(glyph.warn + ' interrupted') + '\n');
}

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export function printError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(theme.red(glyph.fail + ' ' + message) + '\n');
}

/* ------------------------------ resolution ------------------------------ */

/** Resolve an agent id to its slug, falling back to the short id for staff who left. */
export function agentSlugOf(assistant: Assistant): (agentId: string) => string {
  return (agentId) => assistant.store.org.getAgent(agentId)?.slug ?? shortId(agentId);
}

/** Every agent of the company, archived ones included, by id. */
export function agentIndex(assistant: Assistant, organization: Organization): Map<string, Agent> {
  return new Map(
    assistant.store.org
      .listAgents(organization.id, { includeArchived: true })
      .map((agent) => [agent.id, agent]),
  );
}

/**
 * The one candidate whose id starts with `idOrPrefix`. Throws when none does
 * or when several do, so a short prefix can never act on the wrong record.
 */
export function pickByIdPrefix<Candidate extends { id: string }>(
  candidates: readonly Candidate[],
  idOrPrefix: string,
  noun: string,
  noMatchMessage = 'No ' + noun + ' matches "' + idOrPrefix + '".',
): Candidate {
  const needle = idOrPrefix.trim().toLowerCase();
  const matches = candidates.filter((candidate) => candidate.id.toLowerCase().startsWith(needle));

  const [only] = matches;
  if (matches.length === 1 && only) return only;
  if (!matches.length) throw new CliError(noMatchMessage);
  throw ambiguousIdError(noun, idOrPrefix, matches);
}

function ambiguousIdError(noun: string, idOrPrefix: string, matches: readonly { id: string }[]): CliError {
  return new CliError(
    'Ambiguous ' + noun + ' id "' + idOrPrefix + '": ' + matches.map((match) => shortId(match.id)).join(', '),
  );
}

/** Accept a full id or any unambiguous prefix of one. */
export function resolveSession(assistant: Assistant, idOrPrefix: string): Session {
  const exact = assistant.getSession(idOrPrefix);
  if (exact) return exact;

  const sessions = assistant.store.listSessions({ limit: 500, includeArchived: true });
  return pickByIdPrefix(sessions, idOrPrefix, 'session');
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
  return assistant.store.org.getAgent(agentId)?.slug ?? shortId(agentId);
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
  if (matches.length > 1) throw ambiguousIdError('task', wanted, matches);
  throw new CliError('No task matches "' + wanted + '". Run `rookery tasks` to see the board.');
}

/** Same prefix trick for memories. */
export function resolveMemoryId(assistant: Assistant, idOrPrefix: string): string {
  if (assistant.store.getMemory(idOrPrefix)) return idOrPrefix;

  const memories = assistant.store.listMemories({ limit: 1000, includeForgotten: true });
  return pickByIdPrefix(memories, idOrPrefix, 'memory').id;
}

/** Scored recall exactly as a turn would see it, without counting as a use of what it finds. */
export function inspectMemories(assistant: Assistant, query: Omit<RecallOptions, 'touch'>): ScoredMemory[] {
  // Inspection should not inflate the usage signal it is inspecting.
  return recall(assistant.store, { ...query, touch: false });
}
