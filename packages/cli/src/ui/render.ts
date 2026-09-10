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
  AgentEvent,
  AgentMessage,
  AssignmentStatus,
  AssignmentView,
  MemoryRecord,
  Message,
  ScoredMemory,
  Session,
  Task,
  TaskStatus,
} from '@rookery/core';
import { glyph, theme } from './theme.js';
import type { Spinner } from './spinner.js';

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
  #errors: string[] = [];
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

  /** The assistant text collected so far. */
  get answer(): string {
    return this.#answer;
  }

  get errors(): readonly string[] {
    return this.#errors;
  }

  handle(event: AgentEvent): void {
    if (this.#json) {
      this.#collect(event);
      this.#spinner?.stop();
      this.#out.write(JSON.stringify(event) + '\n');
      return;
    }

    this.#collect(event);

    switch (event.type) {
      case 'text': {
        if (this.#quiet || !event.delta) return;
        this.#flushThinking();
        this.#spinner?.stop();
        this.#write(event.delta);
        return;
      }

      case 'thinking': {
        if (!this.#verbose || this.#quiet) return;
        this.#spinner?.stop();
        this.#thinkingBuffer += event.delta;
        const parts = this.#thinkingBuffer.split('\n');
        this.#thinkingBuffer = parts.pop() ?? '';
        for (const line of parts) {
          if (line.trim()) this.note(glyph.thinking + ' ' + line.trim());
        }
        return;
      }

      case 'tool': {
        if (this.#quiet) return;
        if (event.status === 'start') {
          this.note(glyph.tool + ' ' + event.name + (event.detail ? ' ' + shorten(event.detail, 72) : ''));
        } else if (this.#verbose) {
          this.note(glyph.tool + ' ' + event.name + ' done');
        }
        return;
      }

      case 'memory': {
        if (this.#quiet) return;
        const word = event.count === 1 ? 'memory' : 'memories';
        const verb = event.action === 'recalled' ? 'recalled' : 'stored';
        this.note(glyph.memory + ' ' + event.count + ' ' + word + ' ' + verb);
        if (this.#verbose && event.items) {
          for (const item of event.items) this.note('  ' + glyph.dot + ' ' + shorten(item.content, 90));
        }
        return;
      }

      case 'status': {
        if (this.#quiet) return;
        this.note(glyph.status + ' ' + event.label + (event.detail ? ' ' + glyph.dot + ' ' + event.detail : ''));
        return;
      }

      case 'assignment': {
        if (this.#quiet) return;
        const view = event.assignment;
        const previous = this.#assignments.get(view.id);
        this.#assignments.set(view.id, view.status);
        // A changed status is always worth a line: it is how the terminal
        // shows that work started somewhere else. Progress on an assignment
        // that is still running is noise unless the user asked for it.
        if (previous === view.status && !this.#verbose) return;
        this.note(assignmentNote(view));
        return;
      }

      case 'task': {
        if (this.#quiet) return;
        const task = event.task;
        const previous = this.#tasks.get(task.id);
        this.#tasks.set(task.id, task.status);
        // The board is a side channel like the assignments are: a changed
        // status is news, the same status again is not.
        if (previous === task.status && !this.#verbose) return;
        this.note(taskNote(task, this.#agentSlug));
        return;
      }

      case 'message': {
        if (this.#quiet) return;
        this.note(messageNote(event.message, this.#agentSlug));
        return;
      }

      case 'error': {
        this.#spinner?.stop();
        this.#endLine();
        this.#err.write(theme.red(glyph.fail + ' ' + event.message) + '\n');
        return;
      }

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
    else if (event.type === 'error') this.#errors.push(event.message);
  }

  #flushThinking(): void {
    this.#thinkingBuffer = '';
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
export function assignmentNote(view: AssignmentView): string {
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
export function taskNote(task: Task, agentSlug: (agentId: string) => string = shortId): string {
  const bits: string[] = [shorten(task.title, 64), task.status];
  if (task.assigneeId) bits.push(agentSlug(task.assigneeId));
  const head = glyph.task + ' ' + bits.join(' ' + glyph.dot + ' ');
  if (task.status === 'failed' && task.error) return head + '  ' + shorten(task.error, 64);
  return head;
}

/** One row of a task list: id, status, title, who it is on. */
export function taskLine(task: Task, assignee = 'unassigned'): string {
  const paint =
    task.status === 'done'
      ? theme.green
      : task.status === 'failed'
        ? theme.red
        : task.status === 'running'
          ? theme.yellow
          : theme.dim;
  return (
    theme.amber(shortId(task.id).padEnd(9)) +
    paint(task.status.padEnd(10)) +
    theme.ivory(shorten(task.title, 48).padEnd(50)) +
    theme.dim(shorten(assignee, 16))
  );
}

/** One side-channel line for a message between agents. */
export function messageNote(
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
    theme.amber(shortId(session.id).padEnd(9)) +
    theme.ivory(shorten(session.title, 38).padEnd(40)) +
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
    theme.amber(shortId(memory.id).padEnd(9)) +
    score +
    theme.dim(memory.kind.padEnd(11)) +
    theme.ivory(shorten(memory.content, 76)) +
    tags +
    reason
  );
}

export function transcriptBlock(message: Message): string {
  const stamp = new Date(message.createdAt).toLocaleString();
  const who =
    message.role === 'user'
      ? theme.amberBold('you')
      : message.role === 'assistant'
        ? theme.cyan(message.agent ?? 'rookery')
        : theme.dim('system');
  const meta = [message.provider, message.model].filter(Boolean).join(' ');
  const header = who + theme.dim('  ' + stamp + (meta ? '  ' + meta : ''));
  return header + '\n' + message.content.trimEnd() + '\n';
}

export function heading(text: string): string {
  return theme.amberBold(text);
}

export function keyValue(key: string, value: string, width = 18): string {
  return theme.dim(key.padEnd(width)) + value;
}
