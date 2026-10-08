/**
 * Turning `AgentEvent`s into terminal output.
 *
 * One renderer serves the one-shot `chat` command, the REPL and `rookery
 * assign`, so the three can never drift apart. It owns the "is the cursor
 * mid-line?" bookkeeping that keeps side-channel notices (tools, memory,
 * assignments) from cutting the streamed answer in half.
 *
 * Assignments and agent messages are side channels too: the answer belongs to
 * the assistant, and the company working in the background is reported next to
 * it rather than inside it.
 */

import type {
  Agent,
  AgentEvent,
  AgentMessage,
  AssignmentStatus,
  AssignmentView,
  MemoryRecord,
  Message,
  ProviderStatus,
  QuotaWindow,
  ScoredMemory,
  Session,
  Task,
  TaskStatus,
} from '@rookery/core';
import { glyph, theme } from './theme.js';
import type { Spinner } from './spinner.js';

type EventOf<Type extends AgentEvent['type']> = Extract<AgentEvent, { type: Type }>;

export interface RendererOptions {
  /** Emit raw AgentEvent JSON lines instead of prose. */
  json?: boolean;
  /** Print only the final answer. */
  quiet?: boolean;
  /** Include thinking traces, tool completions and assignment progress. */
  verbose?: boolean;
  spinner?: Spinner | null;
  /** Resolve an agent id to its slug, for message lines. */
  agentSlug?: (agentId: string) => string;
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
}

/** What streaming a whole run through a renderer left behind. */
export interface StreamOutcome {
  sessionId: string | undefined;
  /** A fatal error ended the run (never set once the caller aborted it). */
  failed: boolean;
}

export class EventRenderer {
  readonly #json: boolean;
  readonly #quiet: boolean;
  readonly #verbose: boolean;
  readonly #spinner: Spinner | null;
  readonly #agentSlug: (agentId: string) => string;
  readonly #out: NodeJS.WritableStream;
  readonly #err: NodeJS.WritableStream;

  #answer = '';
  #atLineStart = true;
  #thinkingBuffer = '';
  /** Last status seen per assignment, so progress is not re-announced. */
  #assignments = new Map<string, AssignmentStatus>();
  /** Same for board entries: core re-sends the whole task on every change. */
  #tasks = new Map<string, TaskStatus>();

  constructor(options: RendererOptions = {}) {
    this.#json = options.json ?? false;
    this.#quiet = options.quiet ?? false;
    this.#verbose = options.verbose ?? false;
    this.#spinner = options.spinner ?? null;
    this.#agentSlug = options.agentSlug ?? shortId;
    this.#out = options.out ?? process.stdout;
    this.#err = options.err ?? process.stderr;
  }

  /**
   * Stream a whole run through this renderer, spinner included. Never throws:
   * a stream that dies is shown as a fatal error - unless `signal` was
   * aborted, because a killed provider reports its own death and the user
   * who pressed Ctrl+C does not need to be told about it.
   */
  async consume(events: AsyncIterable<AgentEvent>, signal?: AbortSignal): Promise<StreamOutcome> {
    let sessionId: string | undefined;
    let failed = false;

    this.#spinner?.start();
    try {
      for await (const event of events) {
        if (event.type === 'session') sessionId = event.sessionId;
        if (event.type === 'error') {
          if (signal?.aborted) continue;
          if (event.fatal) failed = true;
        }
        this.handle(event);
      }
    } catch (error) {
      if (!signal?.aborted) {
        failed = true;
        this.handle({ type: 'error', message: (error as Error).message, fatal: true });
      }
    } finally {
      this.#spinner?.stop();
    }
    return { sessionId, failed };
  }

  handle(event: AgentEvent): void {
    this.#collect(event);

    if (this.#json) {
      this.#spinner?.stop();
      this.#out.write(JSON.stringify(event) + '\n');
      return;
    }

    switch (event.type) {
      case 'text':
        this.#onText(event.delta);
        return;
      case 'thinking':
        this.#onThinking(event.delta);
        return;
      case 'tool':
        this.#onTool(event);
        return;
      case 'memory':
        this.#onMemory(event);
        return;
      case 'status':
        this.note(glyph.status + ' ' + event.label + (event.detail ? ' ' + glyph.dot + ' ' + event.detail : ''));
        return;
      case 'assignment':
        // A changed status is always worth a line: it is how the terminal
        // shows that work started somewhere else. Progress on an assignment
        // that is still running is noise unless the user asked for it.
        if (this.#isNews(this.#assignments, event.assignment.id, event.assignment.status)) {
          this.note(assignmentNote(event.assignment));
        }
        return;
      case 'task':
        // The board is a side channel like the assignments are: a changed
        // status is news, the same status again is not.
        if (this.#isNews(this.#tasks, event.task.id, event.task.status)) {
          this.note(taskNote(event.task, this.#agentSlug));
        }
        return;
      case 'message':
        this.note(messageNote(event.message, this.#agentSlug));
        return;
      case 'error':
        this.#onError(event.message);
        return;
      case 'question':
        // The numbered block the REPL prints below is the surface now, and a
        // person is about to type into that line; a spinner redrawing it
        // would eat the answer as it is being written. One-way like every
        // other stop: whatever follows the question is announced as itself.
        this.#spinner?.stop();
        return;
      case 'question-closed':
      case 'session':
      case 'done':
        return;
    }
  }

  /**
   * Close out the turn: flush buffers, print the answer in quiet mode and
   * leave the cursor on a fresh line. Returns the final answer text.
   */
  finish(): string {
    this.#spinner?.stop();
    if (this.#json) return this.#answer;

    if (this.#thinkingBuffer.trim() && this.#verbose && !this.#quiet) {
      this.note(glyph.thinking + ' ' + this.#thinkingBuffer.trim());
    }
    this.#thinkingBuffer = '';

    if (this.#quiet) {
      const text = this.#answer.trim();
      if (text) this.#out.write(text + '\n');
      return this.#answer;
    }

    this.#endLine();
    return this.#answer;
  }

  /** A dim side-channel line that never interrupts a half-written sentence. */
  note(text: string): void {
    if (this.#json || this.#quiet) return;
    this.#spinner?.stop();
    this.#endLine();
    this.#out.write(theme.dim(text) + '\n');
  }

  #collect(event: AgentEvent): void {
    if (event.type === 'text') this.#answer += event.delta;
    else if (event.type === 'done') this.#answer = event.text || this.#answer;
  }

  #onText(delta: string): void {
    if (this.#quiet || !delta) return;
    // Answer text has begun: whatever thinking was half-written is stale.
    this.#thinkingBuffer = '';
    this.#spinner?.stop();
    this.#write(delta);
  }

  #onThinking(delta: string): void {
    if (!this.#verbose || this.#quiet) return;
    this.#spinner?.stop();
    this.#thinkingBuffer += delta;
    const completeLines = this.#thinkingBuffer.split('\n');
    this.#thinkingBuffer = completeLines.pop() ?? '';
    for (const line of completeLines) {
      if (line.trim()) this.note(glyph.thinking + ' ' + line.trim());
    }
  }

  #onTool(event: EventOf<'tool'>): void {
    if (event.status === 'start') {
      this.note(glyph.tool + ' ' + event.name + (event.detail ? ' ' + shorten(event.detail, 72) : ''));
    } else if (this.#verbose) {
      this.note(glyph.tool + ' ' + event.name + ' done');
    }
  }

  #onMemory(event: EventOf<'memory'>): void {
    const word = event.count === 1 ? 'memory' : 'memories';
    const verb = event.action === 'recalled' ? 'recalled' : 'stored';
    this.note(glyph.memory + ' ' + event.count + ' ' + word + ' ' + verb);
    if (this.#verbose && event.items) {
      for (const item of event.items) this.note('  ' + glyph.dot + ' ' + shorten(item.content, 90));
    }
  }

  #onError(message: string): void {
    this.#spinner?.stop();
    this.#endLine();
    this.#err.write(theme.red(glyph.fail + ' ' + message) + '\n');
  }

  /** Records `status` for `id`; true when it differs from the last one seen, or when verbose. */
  #isNews<Status>(seen: Map<string, Status>, id: string, status: Status): boolean {
    const previous = seen.get(id);
    seen.set(id, status);
    return previous !== status || this.#verbose;
  }

  #write(text: string): void {
    this.#out.write(text);
    this.#atLineStart = text.endsWith('\n');
  }

  #endLine(): void {
    if (!this.#atLineStart) {
      this.#out.write('\n');
      this.#atLineStart = true;
    }
  }
}

/* ----------------------------- formatters ----------------------------- */

export function shorten(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : clean.slice(0, Math.max(0, max - 1)) + '…';
}

/** "in 2h 15m" for a moment ahead; the counterpart of relativeTime. */
export function untilTime(timestamp: number): string {
  const delta = timestamp - Date.now();
  if (delta <= 0) return 'now';
  const minutes = Math.ceil(delta / 60_000);
  if (minutes < 60) return 'in ' + minutes + 'm';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return 'in ' + hours + 'h ' + (minutes % 60) + 'm';
  const days = Math.floor(hours / 24);
  return 'in ' + days + 'd ' + (hours % 24) + 'h';
}

export function relativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 0) return 'just now';
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  if (days < 30) return days + 'd ago';
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60_000) return (ms / 1000).toFixed(1) + 's';
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return minutes + 'm ' + seconds + 's';
}

/** Output volume as a cheap progress signal: `840`, `1.2k`. */
export function formatChars(chars: number | undefined): string {
  if (chars === undefined) return '';
  if (chars < 1000) return String(chars);
  return (chars / 1000).toFixed(1) + 'k';
}

/** Short id form used everywhere a full UUID would be noise. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** One side-channel line for an assignment: who, what state, how far along. */
function assignmentNote(view: AssignmentView): string {
  const bits: string[] = [view.agentSlug, view.status];
  if (view.chars) bits.push(formatChars(view.chars) + ' chars');
  if (view.durationMs !== undefined) bits.push(formatDuration(view.durationMs));
  const indent = '  '.repeat(Math.max(0, view.depth));
  const head = indent + glyph.agent + ' ' + bits.join(' ' + glyph.dot + ' ');
  if (view.status === 'failed' && view.error) return head + '  ' + shorten(view.error, 72);
  if (view.status === 'pending' || view.status === 'running') {
    const tail = view.preview ? view.preview : view.task;
    return head + '  ' + shorten(tail, 64);
  }
  return head;
}

/**
 * One side-channel line for a board entry: what it is and where it stands.
 * The agent is named as soon as the task has one, because "who is this on"
 * is the first thing anyone asks about a running task.
 */
function taskNote(task: Task, agentSlug: (agentId: string) => string = shortId): string {
  const bits: string[] = [shorten(task.title, 64), task.status];
  if (task.assigneeId) bits.push(agentSlug(task.assigneeId));
  const head = glyph.task + ' ' + bits.join(' ' + glyph.dot + ' ');
  if (task.status === 'failed' && task.error) return head + '  ' + shorten(task.error, 64);
  return head;
}

const LIST_STATUS_PAINT: Record<string, (text: string) => string> = {
  done: theme.green,
  failed: theme.red,
  running: theme.yellow,
};

/** Colour of a status word in a list row; anything unremarkable stays dim. */
export function statusPaint(status: string): (text: string) => string {
  return LIST_STATUS_PAINT[status] ?? theme.dim;
}

/** One row of a task list: id, status, title, who it is on. */
export function taskLine(task: Task, assignee = 'unassigned'): string {
  return (
    theme.accent(shortId(task.id).padEnd(9)) +
    statusPaint(task.status)(task.status.padEnd(10)) +
    theme.frost(shorten(task.title, 48).padEnd(50)) +
    theme.dim(shorten(assignee, 16))
  );
}

/** One side-channel line for a message between agents. */
function messageNote(
  message: AgentMessage,
  agentSlug: (agentId: string) => string = shortId,
): string {
  const from = message.fromAgentId ? agentSlug(message.fromAgentId) : 'the assistant';
  return glyph.message + ' from ' + from + ': ' + shorten(message.content, 88);
}

/**
 * One row of the session list. `counterpart` is who the conversation is with -
 * an agent slug for a direct chat, the assistant otherwise - because with
 * agent chats in the picture the title alone no longer says who answered.
 */
export function sessionLine(session: Session, counterpart = 'assistant'): string {
  return (
    theme.accent(shortId(session.id).padEnd(9)) +
    theme.frost(shorten(session.title, 38).padEnd(40)) +
    theme.cyan(shorten(counterpart, 15).padEnd(16)) +
    theme.dim(
      String(session.messageCount).padStart(3) +
        ' msg  ' +
        session.provider.padEnd(8) +
        relativeTime(session.updatedAt),
    )
  );
}

export function memoryLine(memory: MemoryRecord | ScoredMemory): string {
  const score = 'score' in memory ? theme.green(memory.score.toFixed(2).padStart(5)) + ' ' : '';
  const tags = memory.tags.length ? theme.dim(' #' + memory.tags.join(' #')) : '';
  const reason = 'reason' in memory && memory.reason ? theme.dim('  (' + memory.reason + ')') : '';
  return (
    theme.accent(shortId(memory.id).padEnd(9)) +
    score +
    theme.dim(memory.kind.padEnd(11)) +
    theme.frost(shorten(memory.content, 76)) +
    tags +
    reason
  );
}

export function transcriptBlock(message: Message): string {
  const stamp = new Date(message.createdAt).toLocaleString('en-GB');
  const who =
    message.role === 'user'
      ? theme.accentBold('you')
      : message.role === 'assistant'
        ? theme.cyan(message.agent ?? 'rookery')
        : theme.dim('system');
  const meta = [message.provider, message.model].filter(Boolean).join(' ');
  const header = who + theme.dim('  ' + stamp + (meta ? '  ' + meta : ''));
  return header + '\n' + message.content.trimEnd() + '\n';
}

export function heading(text: string): string {
  return theme.accentBold(text);
}

/** The heading of a listing, with how many rows follow. */
export function listHeader(title: string, count: number): string {
  return '\n' + heading(title) + theme.dim('  (' + count + ')') + '\n\n';
}

export function keyValue(key: string, value: string, width = 18): string {
  return theme.dim(key.padEnd(width)) + value;
}

const QUOTA_BAR_CELLS = 20;

/** One subscription window as a label, a usage bar, the percentage and when it resets. */
export function quotaWindowLine(window: QuotaWindow): string {
  const filled = Math.min(QUOTA_BAR_CELLS, Math.max(0, Math.round(window.percent / (100 / QUOTA_BAR_CELLS))));
  const bar = '█'.repeat(filled) + '░'.repeat(QUOTA_BAR_CELLS - filled);
  const reset = window.resetsAt ? '  resets ' + untilTime(new Date(window.resetsAt).getTime()) : '';
  return '  ' + window.label.padEnd(14) + bar + '  ' + String(window.percent).padStart(3) + '%' + reset;
}

/** How ready a provider is: usable, installed but logged out, or not installed. */
export type ProviderHealth = 'ok' | 'warn' | 'fail';

export function providerHealth(status: ProviderStatus): ProviderHealth {
  if (!status.available) return 'fail';
  return status.authenticated ? 'ok' : 'warn';
}

export const HEALTH_GLYPH: Record<ProviderHealth, string> = {
  ok: glyph.ok,
  warn: glyph.warn,
  fail: glyph.fail,
};

const HEALTH_PAINT: Record<ProviderHealth, (text: string) => string> = {
  ok: theme.green,
  warn: theme.yellow,
  fail: theme.red,
};

/** The provider's health glyph, painted for a line terminal. */
export function providerMark(status: ProviderStatus): string {
  const health = providerHealth(status);
  return HEALTH_PAINT[health](HEALTH_GLYPH[health]);
}

/** The columns of one staff-list row; callers paint them or leave them plain. */
export function agentRosterRow(
  agent: Agent,
  agentsById: ReadonlyMap<string, Agent>,
): { handle: string; title: string; reportsTo: string } {
  const manager = agent.managerId ? agentsById.get(agent.managerId) : undefined;
  return {
    handle: shorten(agent.slug, 17).padEnd(18),
    title: shorten(agent.title, 27).padEnd(28),
    reportsTo: 'reports to ' + (manager ? manager.slug : 'the assistant'),
  };
}
