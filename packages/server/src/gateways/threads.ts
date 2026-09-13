import type { Session } from '@rookery/core';
import type { ServerContext } from '../context.js';

/**
 * What a message from the bot was about, and where an answer to it belongs.
 *
 * Telegram has one chat per bot. Everything the assistant sends - last
 * night's sleep report, this morning's schedule, a mail from a team lead,
 * yesterday's answer about something else entirely - arrives in that same
 * column. The reply gesture is the only handle Telegram gives for saying
 * "this one", and until now it was ignored: every message went into the one
 * running conversation, which is how a reply to a mail ended up in the
 * middle of a debugging session.
 *
 * So two things are kept. First, a small registry: for every message the
 * bot sends, what it was about. It lives in the `meta` table as a ring
 * buffer per chat, so it survives a restart and cannot grow without bound.
 * Second, a thread per subject: the mail, the schedule, the sleep run each
 * get their own conversation, resolved through `meta` the same way the
 * plain Telegram chat already is.
 *
 * The original is never quoted from the registry. The registry holds ids;
 * the text is read back out of the store when the reply arrives, so a reply
 * to a two-day-old mail carries the mail as it is, not as it was shortened
 * for a push notification.
 */

export type OriginKind = 'mail' | 'cron' | 'sleep' | 'assignment' | 'task' | 'notify' | 'digest' | 'answer';

export interface MessageOrigin {
  kind: OriginKind;
  /** The record this message was about: mail id, cron run id, and so on. */
  ref?: string;
  /** The record's parent, where one is needed to find it: a run's job. */
  parent?: string;
  /** The conversation this message came out of, when it had one. */
  sessionId?: string;
  /** A short label for the thread's title in the sidebar. */
  title?: string;
  /** What was sent, cut short - the fallback when the record is gone. */
  snippet?: string;
  at: number;
}

/** One chat's registry, as it sits in `meta`. */
interface OriginBook {
  v: 1;
  items: Array<{ id: number } & MessageOrigin>;
}

/**
 * How many outgoing messages one chat remembers.
 *
 * Generous on purpose: a reply to something from last week is exactly the
 * case this exists for, and one entry is a handful of ids. At a hundred
 * notifications a day this still reaches back three days; beyond that the
 * plain chat takes over, which is the old behaviour and not a failure.
 */
const BOOK_SIZE = 400;

/** How much of a sent message is kept as the fallback quote. */
const SNIPPET = 400;

const bookKey = (chatId: number): string => `telegram:origins:${chatId}`;
const threadKey = (kind: OriginKind, ref: string): string => `telegram:thread:${kind}:${ref}`;

function readBook(context: ServerContext, chatId: number): OriginBook {
  const raw = context.assistant.store.getMeta(bookKey(chatId));
  if (!raw) return { v: 1, items: [] };
  try {
    const parsed = JSON.parse(raw) as OriginBook;
    return Array.isArray(parsed?.items) ? { v: 1, items: parsed.items } : { v: 1, items: [] };
  } catch {
    // A registry that cannot be read is a registry that gets rebuilt. It
    // holds convenience, not truth.
    return { v: 1, items: [] };
  }
}

/**
 * Note what one or more just-sent messages were about.
 *
 * A long answer is several Telegram messages; all of them point at the same
 * subject, so replying to any piece of it lands in the same place.
 */
export function rememberOrigin(
  context: ServerContext,
  chatId: number,
  messageIds: Array<number | undefined>,
  origin: Omit<MessageOrigin, 'at'>,
): void {
  const ids = messageIds.filter((id): id is number => typeof id === 'number');
  if (ids.length === 0) return;
  const entry: MessageOrigin = { ...origin, at: Date.now() };
  if (entry.snippet) entry.snippet = entry.snippet.slice(0, SNIPPET);

  const book = readBook(context, chatId);
  for (const id of ids) book.items.push({ id, ...entry });
  if (book.items.length > BOOK_SIZE) book.items.splice(0, book.items.length - BOOK_SIZE);
  try {
    context.assistant.store.setMeta(bookKey(chatId), JSON.stringify(book));
  } catch (error) {
    context.log.warn('Telegram origin could not be stored', {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** What a message the user replied to was about, if it is still remembered. */
export function findOrigin(context: ServerContext, chatId: number, messageId: number): MessageOrigin | undefined {
  const book = readBook(context, chatId);
  // From the back: a rebuilt registry can hold an older duplicate, and the
  // newest entry is the one that was actually sent.
  for (let index = book.items.length - 1; index >= 0; index -= 1) {
    const item = book.items[index];
    if (item?.id === messageId) {
      const { id: _id, ...origin } = item;
      return origin;
    }
  }
  return undefined;
}

/* ------------------------------- the ledger ------------------------------- */

/**
 * Which messages are standing in one Telegram chat.
 *
 * `/clear` empties the chat so it reads like the first time, and to do that
 * the bot has to name the messages: Telegram deletes by id, never "all". So
 * every message this gateway sees - the sender's and its own - is noted
 * here, in a ring alongside the origin registry.
 *
 * Two limits are worth knowing and are not this file's to fix. Telegram
 * refuses to let a bot delete anything older than 48 hours, and a ring is a
 * ring: an id that has fallen out is not deleted either. Both end the same
 * way - a message stays - so the caller reports what it actually removed
 * rather than claiming the chat is empty.
 */
const LEDGER_SIZE = 1000;

const ledgerKey = (chatId: number): string => `telegram:messages:${chatId}`;

/** Note messages that are now standing in the chat, in either direction. */
export function noteMessages(context: ServerContext, chatId: number, ids: Array<number | undefined>): void {
  const fresh = ids.filter((id): id is number => typeof id === 'number');
  if (fresh.length === 0) return;
  const known = readLedger(context, chatId);
  for (const id of fresh) if (!known.includes(id)) known.push(id);
  if (known.length > LEDGER_SIZE) known.splice(0, known.length - LEDGER_SIZE);
  writeLedger(context, chatId, known);
}

/** Hand over every remembered id and forget them - what `/clear` deletes. */
export function takeMessages(context: ServerContext, chatId: number): number[] {
  const known = readLedger(context, chatId);
  writeLedger(context, chatId, []);
  return known;
}

function readLedger(context: ServerContext, chatId: number): number[] {
  const raw = context.assistant.store.getMeta(ledgerKey(chatId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === 'number') : [];
  } catch {
    return [];
  }
}

function writeLedger(context: ServerContext, chatId: number, ids: number[]): void {
  try {
    context.assistant.store.setMeta(ledgerKey(chatId), JSON.stringify(ids));
  } catch (error) {
    context.log.warn('Telegram message ledger could not be stored', {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/* ------------------------------ the original ------------------------------ */

function agentName(context: ServerContext, agentId?: string): string | undefined {
  if (!agentId) return undefined;
  return context.assistant.store.org.getAgent(agentId)?.name;
}

function stamp(at?: number): string {
  return at ? new Date(at).toLocaleString('en-GB') : '';
}

/**
 * The notification, written out in full for the turn that answers it.
 *
 * Read from the store rather than from the registry, so what the assistant
 * sees is the record itself: the whole mail, the schedule's actual output,
 * the night's report. `undefined` means there is nothing left to quote -
 * the record was deleted - and the turn then runs on the snippet alone.
 */
export function originContext(context: ServerContext, origin: MessageOrigin): string | undefined {
  const store = context.assistant.store;

  switch (origin.kind) {
    case 'mail': {
      const mail = origin.ref ? store.org.getMail(origin.ref) : null;
      if (!mail) break;
      const sender =
        mail.fromKind === 'assistant'
          ? context.config.assistantName
          : (agentName(context, mail.fromAgentId) ?? mail.fromKind);
      return [
        `Mail from ${sender}, ${stamp(mail.createdAt)}`,
        `Subject: ${mail.subject}`,
        '',
        mail.body.trim(),
      ].join('\n');
    }

    case 'cron': {
      const job = origin.parent ? context.assistant.cron.get(origin.parent) : null;
      const run =
        origin.parent && origin.ref
          ? context.assistant.cron.runs(origin.parent, 50).find((entry) => entry.id === origin.ref)
          : undefined;
      if (!job && !run) break;
      const lines = [`Schedule “${job?.name ?? 'unknown'}” (${job?.schedule ?? 'schedule removed'})`];
      if (job?.prompt) lines.push('', 'Its standing instruction:', job.prompt.trim());
      if (run) {
        lines.push('', `Run ${run.status} at ${stamp(run.startedAt)}.`);
        if (run.result?.trim()) lines.push('', 'What it reported:', run.result.trim());
        if (run.error?.trim()) lines.push('', 'How it failed:', run.error.trim());
      }
      return lines.join('\n');
    }

    case 'sleep': {
      const run = origin.ref ? store.getSleepRun(origin.ref) : null;
      if (!run) break;
      const lines = [`Sleep run ${run.status}, started ${stamp(run.startedAt)}.`];
      lines.push(
        `Read ${run.readCount}, replayed ${run.replayedCount}, learned ${run.learnedCount}, ` +
          `merged ${run.mergedCount}, put to sleep ${run.dormantCount}.`,
      );
      if (run.report?.trim()) lines.push('', 'Its report:', run.report.trim());
      if (run.error?.trim()) lines.push('', 'How it failed:', run.error.trim());
      return lines.join('\n');
    }

    case 'assignment': {
      const assignment = origin.ref ? store.org.getAssignment(origin.ref) : null;
      if (!assignment) break;
      const who = agentName(context, assignment.agentId) ?? 'an agent';
      const lines = [
        `Assignment to ${who}, ${assignment.status}, ${stamp(assignment.finishedAt ?? assignment.createdAt)}.`,
      ];
      lines.push('', 'The task as it was given:', assignment.task.trim());
      if (assignment.result?.trim()) lines.push('', 'What came back:', assignment.result.trim());
      if (assignment.error?.trim()) lines.push('', 'How it failed:', assignment.error.trim());
      return lines.join('\n');
    }

    case 'task': {
      const task = origin.ref ? store.org.getTask(origin.ref) : null;
      if (!task) break;
      const lines = [`Task “${task.title}”, ${task.status}, ${task.priority} priority.`];
      if (task.description.trim()) lines.push('', task.description.trim());
      if (task.error?.trim()) lines.push('', 'How it failed:', task.error.trim());
      if (task.result?.trim()) lines.push('', 'Result so far:', task.result.trim());
      return lines.join('\n');
    }

    default:
      break;
  }

  // Nothing in the store, or a kind that never had a record: the message as
  // it was sent is all there is, and it is better than nothing.
  return origin.snippet?.trim() || undefined;
}

/* -------------------------------- threads -------------------------------- */

export interface Thread {
  session: Session;
  /** True when this reply opened the conversation rather than continued it. */
  fresh: boolean;
}

/** A title a person can find in the sidebar three days later. */
function threadTitle(origin: MessageOrigin): string {
  const prefix: Record<OriginKind, string> = {
    mail: 'Mail',
    cron: 'Schedule',
    sleep: 'Sleep',
    assignment: 'Assignment',
    task: 'Task',
    notify: 'Notice',
    digest: 'Summary',
    answer: 'Telegram',
  };
  const head = prefix[origin.kind] ?? 'Telegram';
  const label = origin.title?.replace(/\s+/g, ' ').trim();
  return label ? `${head}: ${label}`.slice(0, 80) : head;
}

/**
 * The conversation a reply to this message belongs in.
 *
 * Three cases, in order. A message that came out of a conversation goes
 * back into it - that is a schedule whose job owns a session, and it is the
 * whole point: answering "what did you find?" continues the run's own
 * thread, with everything it already knows. A message about a record opens
 * one thread per record, reused by every further reply. Anything else falls
 * back to the plain Telegram chat, which is what `fallback` provides.
 */
export function openThread(context: ServerContext, origin: MessageOrigin, fallback: () => Session): Thread {
  const store = context.assistant.store;

  if (origin.sessionId) {
    const existing = context.assistant.getSession(origin.sessionId);
    if (existing) return { session: existing, fresh: existing.messageCount === 0 };
  }

  if (!origin.ref) return { session: fallback(), fresh: false };

  const key = threadKey(origin.kind, origin.ref);
  const known = store.getMeta(key);
  if (known) {
    const session = context.assistant.getSession(known);
    if (session) return { session, fresh: session.messageCount === 0 };
  }

  // A thread is an ordinary chat session, for the same reason the Telegram
  // chat itself is: what was started on the phone has to be continuable at
  // the desk, in the same sidebar as everything else.
  const session = context.assistant.createSession({ title: threadTitle(origin), kind: 'chat' });
  store.setMeta(key, session.id);
  return { session, fresh: true };
}
