import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AgentEvent, QuestionAnswer, QuestionOption } from '../types.js';

/**
 * The open questions.
 *
 * `ask_user` is the one tool call that does not compute an answer but waits
 * for one: the provider process sits in an MCP call while a person, on
 * whichever surface happens to be in front of them, picks an option. The
 * registry is the meeting point between the two halves - the tool handler
 * holds a promise, every channel holds the id, and the first answer wins.
 *
 * It is deliberately in core and knows nothing about HTTP, sockets or
 * terminals: it emits `question` and `question-closed` and lets whoever owns
 * a transport carry them. Nothing is persisted either. A question only makes
 * sense while the turn that asked it is alive, and that turn dies with the
 * process; a question read back off disk after a restart would block on a
 * tool call that nobody is waiting on any more.
 */

/** What the `ask_user` tool hands in; the id and the deadline come from here. */
export interface QuestionRequest {
  /** Two or three words over the card, e.g. "Deploy target". */
  header: string;
  question: string;
  options: QuestionOption[];
  /** More than one option may be picked. */
  multiSelect?: boolean;
  /** The session the asking turn belongs to, for surfaces that filter. */
  sessionId?: string;
}

/** An open question: what was asked, and when it gives up on its own. */
export interface PendingQuestion {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
  sessionId?: string;
  askedAt: number;
  expiresAt: number;
}

/** Why a question stopped being open. */
export type QuestionCloseReason = 'answered' | 'cancelled' | 'expired';

export interface AskOptions {
  /**
   * The asking turn's abort signal. Wired explicitly because no other tool
   * handler watches one: killing the provider process ends the call, but the
   * question would otherwise stay open for its full timeout with nobody left
   * to receive the answer.
   */
  signal?: AbortSignal;
  /** How long the question stays open. Defaults to ten minutes. */
  timeoutMs?: number;
  /**
   * The asking turn's own event stream. Gets the same two events as the
   * registry's listeners, so the conversation that asked sees the card in
   * line with everything else it is streaming, without waiting for a
   * broadcast to come back round.
   */
  emit?: (event: AgentEvent) => void;
  /**
   * Who is asking: the bridge token of the turn that called `ask_user`. A
   * turn can end without its abort signal ever firing - the provider process
   * crashes, a fallback provider takes over - and everything that turn asked
   * is closed when its token is retired, rather than standing on every
   * surface for the full timeout, answerable, reaching nothing.
   */
  owner?: string;
}

/** Ten minutes, matching the `questions.timeoutMs` default in config.ts. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

interface OpenQuestion {
  pending: PendingQuestion;
  owner?: string;
  settle: (answer: QuestionAnswer | null, reason: QuestionCloseReason) => void;
}

export class QuestionRegistry extends EventEmitter {
  readonly #open = new Map<string, OpenQuestion>();

  /**
   * Ask, and wait. Resolves with the answer, or with `null` when the question
   * timed out or the turn was aborted - never rejects, because the caller is a
   * tool handler whose job is to say what happened and let the turn continue.
   */
  ask(request: QuestionRequest, options: AskOptions = {}): Promise<QuestionAnswer | null> {
    const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    const now = Date.now();
    const pending: PendingQuestion = {
      id: randomUUID(),
      header: request.header,
      question: request.question,
      options: request.options,
      multiSelect: request.multiSelect === true,
      sessionId: request.sessionId,
      askedAt: now,
      expiresAt: now + timeoutMs,
    };

    // Already gone before it started: an abort that landed between the tool
    // call and here would otherwise open a question nobody can close.
    if (options.signal?.aborted) return Promise.resolve(null);

    return new Promise<QuestionAnswer | null>((resolve) => {
      let done = false;
      const timer = setTimeout(() => settle(null, 'expired'), timeoutMs);
      // Unref so an open question cannot hold the process up on its own; the
      // turn waiting on it is what keeps things alive.
      timer.unref?.();

      const onAbort = (): void => settle(null, 'cancelled');

      const settle = (answer: QuestionAnswer | null, reason: QuestionCloseReason): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        this.#open.delete(pending.id);
        const closed: AgentEvent = { type: 'question-closed', id: pending.id, reason };
        if (answer) closed.answer = answer;
        options.emit?.(closed);
        this.emit('question-closed', closed);
        resolve(answer);
      };

      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.#open.set(pending.id, { pending, settle, ...(options.owner ? { owner: options.owner } : {}) });

      const asked = questionEvent(pending);
      options.emit?.(asked);
      this.emit('question', asked);
    });
  }

  /**
   * Deliver an answer. `false` when the id is unknown - the question was
   * already answered somewhere else, gave up, or never existed. Every surface
   * may call this, so a late second click is normal, not an error.
   */
  answer(id: string, answer: QuestionAnswer): boolean {
    const open = this.#open.get(id);
    if (!open) return false;
    // Indices are cleaned here rather than in each surface: they arrive from
    // a browser, a bot callback and a terminal, and the tool result is built
    // by looking them up in the options - one stale index would otherwise
    // read as a choice nobody made.
    const count = open.pending.options.length;
    const selected = (Array.isArray(answer.selected) ? answer.selected : [])
      .filter((index) => Number.isInteger(index) && index >= 0 && index < count)
      .filter((index, position, all) => all.indexOf(index) === position)
      .slice(0, open.pending.multiSelect ? count : 1);
    const text = answer.text?.trim();
    // Neither a pick nor a word: nothing came back, so the question stays
    // open for whoever answers it properly.
    if (!selected.length && !text) return false;
    open.settle(
      { ...answer, selected, ...(text ? { text } : { text: undefined }), at: answer.at ?? Date.now() },
      'answered',
    );
    return true;
  }

  /** Close a question without an answer; the waiting turn carries on. */
  cancel(id: string, reason: 'cancelled' | 'expired' = 'cancelled'): boolean {
    const open = this.#open.get(id);
    if (!open) return false;
    open.settle(null, reason);
    return true;
  }

  /** Everything still open, oldest first - for a reload or a late listener. */
  pending(): PendingQuestion[] {
    return [...this.#open.values()].map((open) => open.pending).sort((a, b) => a.askedAt - b.askedAt);
  }

  /** One open question by id, or `null`. */
  get(id: string): PendingQuestion | null {
    return this.#open.get(id)?.pending ?? null;
  }

  /** Close everything still open; used when the runtime shuts down. */
  cancelAll(): void {
    for (const id of [...this.#open.keys()]) this.cancel(id, 'cancelled');
  }

  /**
   * Close everything one turn asked. Called when that turn's bridge token is
   * retired, which happens on every exit - a clean answer, an abort, and a
   * provider crash alike - so a question can never outlive the tool call
   * that was waiting on it.
   */
  cancelForOwner(owner: string): number {
    let closed = 0;
    for (const [id, open] of [...this.#open]) {
      if (open.owner !== owner) continue;
      this.cancel(id, 'cancelled');
      closed += 1;
    }
    return closed;
  }
}

/**
 * The `question` event of one open question, for a surface that joined late
 * and got the pending list rather than the live event.
 */
export function questionEvent(pending: PendingQuestion): AgentEvent {
  return {
    type: 'question',
    id: pending.id,
    header: pending.header,
    question: pending.question,
    options: pending.options,
    multiSelect: pending.multiSelect,
    expiresAt: pending.expiresAt,
  };
}
