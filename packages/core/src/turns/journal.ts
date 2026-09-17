import type { Db } from '../memory/db.js';

/**
 * The running-turn journal.
 *
 * A conversation turn used to exist only in the memory of the client that
 * started it: the message landed in the store when the turn finished, and
 * anything in between - the streaming text, the tool calls it made, the
 * question it asked - was gone the moment that client reloaded. The journal
 * makes the turn durable while it runs: every event the runtime yields
 * becomes a row the moment it is yielded, in exactly the order it was
 * yielded, with a sequence number that the live transports reuse. Reading it
 * back and feeding it through the same reduction a live client applies
 * reproduces the turn as it stood - same text, same tool calls, same
 * question - on any client, whenever it looks.
 *
 * Sequence numbers start at 1 and count every event of the turn, once each.
 * They are the join between the two halves of a rejoin: the replay a client
 * reads over REST carries them, the live frames carry them, and a client that
 * has applied up to seq N simply ignores anything numbered N or lower, so the
 * handover can neither duplicate nor drop an event.
 */

/** One journal row: where in the turn an event sits, and the event itself. */
export interface JournalEntry {
  seq: number;
  event: Record<string, unknown>;
}

/** What a running (or interrupted) turn looks like from the outside. */
export interface JournalTurn {
  id: string;
  sessionId: string;
  kind: string;
  status: 'running' | 'done' | 'interrupted';
  startedAt: number;
  endedAt?: number;
}

export class TurnJournal {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Open the turn. Called once, when the turn's session is known. */
  begin(id: string, sessionId: string, kind: string, startedAt: number): void {
    this.#db
      .prepare('INSERT INTO turns (id, session_id, kind, status, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, sessionId, kind, 'running', startedAt);
  }

  /**
   * Write one event, in yield order, and hand back its sequence number. The
   * caller is the turn wrapper in the runtime - the one place every yielded
   * event passes through - so journal order and live order are the same
   * order, numbered by the same counter.
   */
  append(turnId: string, event: Record<string, unknown>): number {
    const row = this.#db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM turn_events WHERE turn_id = ?')
      .get(turnId) as { next: number };
    const seq = row.next;
    this.#db
      .prepare('INSERT INTO turn_events (turn_id, seq, json) VALUES (?, ?, ?)')
      .run(turnId, seq, JSON.stringify(event));
    return seq;
  }

  /**
   * Close the turn. `done` is every orderly end - a finished answer, an
   * aborted one whose partial text was stored - while `interrupted` is what
   * the database itself marks a turn that died with its process.
   */
  settle(turnId: string, status: 'done' | 'interrupted', endedAt: number): void {
    this.#db
      .prepare('UPDATE turns SET status = ?, ended_at = ? WHERE id = ?')
      .run(status, endedAt, turnId);
  }

  /** Everything journalled so far, in order. */
  events(turnId: string): JournalEntry[] {
    const rows = this.#db
      .prepare('SELECT seq, json FROM turn_events WHERE turn_id = ? ORDER BY seq')
      .all(turnId) as { seq: number; json: string }[];
    return rows.map((row) => ({ seq: row.seq, event: JSON.parse(row.json) as Record<string, unknown> }));
  }

  /**
   * The turn of this conversation a client should rejoin, if there is one.
   *
   * A `running` turn always qualifies. An `interrupted` one only while it is
   * news: once the conversation has a newer answer than the turn began - not
   * merely the turn's own prompt, which always postdates its start - history
   * tells the story better than a partial transcript that never finished.
   */
  rejoinable(sessionId: string): { turn: JournalTurn; events: JournalEntry[] } | null {
    const row = this.#db
      .prepare(
        `SELECT t.* FROM turns t
         WHERE t.session_id = ? AND (
           t.status = 'running'
           OR (t.status = 'interrupted' AND t.started_at >
               COALESCE((SELECT MAX(m.created_at) FROM messages m
                         WHERE m.session_id = ? AND m.role = 'assistant'), 0))
         )
         ORDER BY t.started_at DESC LIMIT 1`,
      )
      .get(sessionId, sessionId) as
      | { id: string; session_id: string; kind: string; status: string; started_at: number; ended_at: number | null }
      | undefined;
    if (!row) return null;
    const turn: JournalTurn = {
      id: row.id,
      sessionId: row.session_id,
      kind: row.kind,
      status: row.status as JournalTurn['status'],
      startedAt: row.started_at,
      ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
    };
    return { turn, events: this.events(turn.id) };
  }
}
