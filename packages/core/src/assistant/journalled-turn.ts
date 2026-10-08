import { randomUUID } from 'node:crypto';
import type { Store } from '../memory/store.js';
import type { AgentEvent, RookeryConfig } from '../types.js';
import type { DreamRecorder } from './dream-recorder.js';
import type { ChatInput } from './types.js';

/**
 * What the journal wrapper learns while the turn it wraps is running.
 *
 * `chat()` opens and closes the journal but does not resolve the session -
 * the turn body does, once the prompt has survived its first checks - so the
 * two facts the wrapper needs afterwards are handed back through this one
 * object rather than re-derived from the store.
 */
export interface TurnJournalState {
  begun: boolean;
  sessionId?: string;
}

/** The turn itself, run with the wrapper's guarded input and the id it is journalled under. */
export type TurnBody = (
  input: ChatInput,
  turnId: string,
  journal: TurnJournalState,
) => AsyncGenerator<AgentEvent, void, unknown>;

/** What the wrapper needs from the runtime. */
export interface JournalContext {
  store: Store;
  config: RookeryConfig;
  recorder: DreamRecorder;
}

/**
 * The backstop a turn never had. A run and a schedule both stop
 * themselves; a turn ran until its provider process did, and over
 * `POST /api/chat` - which passes no signal - nobody could interrupt
 * it. The caller's own signal still works and still wins; this only
 * adds an end to turns that would otherwise not have one.
 */
function guardTurn(caller: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; release(): void } {
  const guard = new AbortController();
  const onCallerAbort = (): void => guard.abort();
  // A signal that was already aborted never fires the event again, so
  // forwarding only through the listener would start a turn the caller
  // had already given up on.
  if (caller?.aborted) guard.abort();
  else caller?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => guard.abort(), timeoutMs);
  // Node keeps the process alive for a pending timer; this one must never
  // be the reason a CLI command refuses to exit.
  timer.unref?.();
  return {
    signal: guard.signal,
    release: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    },
  };
}

/**
 * One conversational turn, journalled while it runs.
 *
 * The wrapper is the single place every yielded event passes through, which
 * is what makes the journal faithful: whatever a live client saw, in the
 * order it saw it, numbered once each. A client that arrives late - a
 * reloaded tab, another browser - reads the same events back and continues
 * from the same numbers, so rejoining can neither duplicate nor drop.
 *
 * `body` does the work and opens the journal once its session is resolved;
 * events yielded before that (a rejected empty prompt, say) are ephemeral by
 * nature and stay unjournalled.
 */
export async function* journalledTurn(
  context: JournalContext,
  input: ChatInput,
  body: TurnBody,
): AsyncGenerator<AgentEvent, void, unknown> {
  const { store, recorder } = context;
  const turnId = input.turnId ?? randomUUID();
  const startedAt = Date.now();
  const journal: TurnJournalState = { begun: false };
  const guard = guardTurn(input.signal, context.config.turns.timeoutMs);
  let settled = false;
  try {
    for await (const event of body({ ...input, signal: guard.signal }, turnId, journal)) {
      if (journal.begun) store.turns.append(turnId, event as unknown as Record<string, unknown>);
      yield event;
    }
    if (journal.begun) {
      store.turns.settle(turnId, 'done', Date.now());
      settled = true;
      // Only an orderly end is an episode: a turn that died mid-flight has
      // no outcome to judge a trajectory against (concept 7.2).
      recorder.recordTrialEpisode(turnId, journal.sessionId, startedAt);
    }
  } finally {
    guard.release();
    // The turn did not end orderly: it threw, or the consumer walked away
    // from the stream. Whatever reached the journal is the only record of it
    // - it stays, marked, rather than vanishing whole or reading as running
    // until the next restart.
    if (journal.begun && !settled) store.turns.settle(turnId, 'interrupted', Date.now());
  }
}
