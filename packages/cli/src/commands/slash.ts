/**
 * What the two slash-command front-ends share: `src/repl.ts` prints line by
 * line, `src/tui/commands.ts` builds scrollback entries, but both parse the
 * same input and do the same work on the assistant. Only the presentation
 * differs, so only the presentation lives in those files.
 */

import type { Agent, Assistant, MemoryRecord, ScoredMemory, Session, Task } from '@rookery/core';
import { renderBoard } from '@rookery/core';
import { shortId } from '../ui/render.js';
import {
  ACTIVE_TASK_STATUSES,
  CliError,
  agentIndex,
  inspectMemories,
  parseTaskStatuses,
  resolveMemoryId,
} from './shared.js';

/** `/talk` words that mean "back to the assistant". */
export const ASSISTANT_ALIASES: readonly string[] = ['assistant', 'rookery', 'off', 'none'];
/** `/effort` words that mean "the provider's own default". */
export const EFFORT_RESET_WORDS: readonly string[] = ['off', 'default', 'none'];
/** `/project` words that mean "no project". */
export const PROJECT_DETACH_WORDS: readonly string[] = ['off', 'none'];

/** Importance given to a memory the user stores by hand. */
const HAND_MEMORY_IMPORTANCE = 0.7;

/** How many conversations `/sessions` lists. */
const RECENT_SESSIONS_SHOWN = 10;
/** How many hits `/memory` lists. */
const MEMORY_HITS_SHOWN = 10;

const COMMAND_ALIASES: Record<string, string> = { '?': 'help', quit: 'exit', q: 'exit' };

export interface SlashInput {
  /** Lower-cased, with aliases folded into the name the handler tables use. */
  command: string;
  argument: string;
}

/** `/Model  gpt-5` -> `{ command: 'model', argument: 'gpt-5' }`. */
export function parseSlashInput(input: string): SlashInput {
  const body = input.trim().slice(1);
  const [rawCommand = ''] = body.split(/\s+/u);
  const command = rawCommand.toLowerCase();
  return {
    command: COMMAND_ALIASES[command] ?? command,
    argument: body.slice(rawCommand.length).trim(),
  };
}

/** The handler for `command`; unknown names are the user's typo, never a prototype key. */
export function lookupSlashHandler<Handler>(
  handlers: Readonly<Record<string, Handler>>,
  command: string,
): Handler {
  const handler = Object.hasOwn(handlers, command) ? handlers[command] : undefined;
  if (!handler) throw new CliError('Unknown command /' + command + '. Try /help.');
  return handler;
}

/** `/assign <agent> <task>` -> who and what, or a usage error. */
export function parseAssignment(
  assistant: Assistant,
  argument: string,
): { agent: Agent; task: string } {
  const [agentRef = ''] = argument.split(/\s+/u);
  const task = argument.slice(agentRef.length).trim();
  if (!agentRef || !task) throw new CliError('Usage: /assign <agent> <task>');

  const organization = assistant.org.activeOrganization();
  const agent = assistant.store.org.findAgent(organization.id, agentRef);
  if (!agent) throw new CliError('No agent "' + agentRef + '". Try /agents.');
  return { agent, task };
}

/** The company board as text, for the statuses named in `statusArgument` (default: active work). */
export function renderTaskBoard(assistant: Assistant, statusArgument: string): string {
  const organization = assistant.org.activeOrganization();
  const status = parseTaskStatuses(statusArgument || undefined) ?? [...ACTIVE_TASK_STATUSES];
  const board = assistant.store.org.listTasks(organization.id, { status });
  return renderBoard(board, assistant.org.snapshot(organization.id), assistant.store.org);
}

/** `/task <title>`: a one-line task is its own brief, and planning reads the description. */
export function addUserTask(assistant: Assistant, title: string, projectId: string | undefined): Task {
  const organization = assistant.org.activeOrganization();
  return assistant.store.org.createTask({
    orgId: organization.id,
    title,
    description: title,
    projectId,
    createdBy: 'user',
  });
}

export function rememberByHand(assistant: Assistant, content: string): MemoryRecord {
  return assistant.rememberFact({ content, kind: 'fact', importance: HAND_MEMORY_IMPORTANCE });
}

/** Soft-forget the memory behind an id or prefix; returns what was forgotten, for the echo. */
export function forgetMemory(assistant: Assistant, idOrPrefix: string): string {
  const id = resolveMemoryId(assistant, idOrPrefix);
  const memory = assistant.store.getMemory(id);
  assistant.store.forgetMemory(id);
  return memory?.content ?? id;
}

export interface InboxRow {
  /** Slug of the sender, or `the assistant`. */
  from: string;
  content: string;
  createdAt: number;
}

/**
 * Unread messages from the staff. Read-only on purpose: the turn that
 * actually uses the inbox is the one allowed to mark it read.
 */
export function unreadInbox(assistant: Assistant): InboxRow[] {
  const organization = assistant.org.activeOrganization();
  const messages = assistant.store.org.inbox(organization.id, null, { unreadOnly: true });
  if (!messages.length) return [];

  const agents = agentIndex(assistant, organization);
  return messages.map((message) => ({
    from: message.fromAgentId
      ? (agents.get(message.fromAgentId)?.slug ?? shortId(message.fromAgentId))
      : 'the assistant',
    content: message.content,
    createdAt: message.createdAt,
  }));
}

/** `/memory <query>`: what a turn would recall for the query. */
export function searchMemory(assistant: Assistant, query: string): ScoredMemory[] {
  return inspectMemories(assistant, { text: query, limit: MEMORY_HITS_SHOWN, threshold: 0 });
}

export function recentSessions(assistant: Assistant): Session[] {
  return assistant.store.listSessions({ limit: RECENT_SESSIONS_SHOWN });
}

/** Commands that need an argument say how to use them instead of guessing. */
export function requireArgument(argument: string, usage: string): void {
  if (!argument) throw new CliError('Usage: ' + usage);
}
