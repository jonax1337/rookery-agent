import type { AgentEvent, Logger } from '@rookery/core';
import type { WebSocket } from '@fastify/websocket';
import { sendFrame, type ServerFrame } from './stream.js';

/**
 * The turn hub: transport without ownership.
 *
 * A turn used to belong to the websocket that started it - the route drained
 * the generator into that one socket, and a reload orphaned the stream: the
 * work went on, but nobody could see or stop it any more. The hub moves the
 * draining to the server and keeps only routing state: which sockets are
 * watching which turn. It buffers nothing and replays nothing - the journal in
 * core is the record, and a client that arrives late reads it over REST, then
 * attaches here for the tail. Sequence numbers on the frames are the journal's
 * own, so the handover lines up exactly.
 *
 * Closing a tab detaches a subscription and nothing else (Workstream E.1): the
 * generator always runs to the end, its result lands in the database as before.
 */

interface RunningTurn {
  id: string;
  /** The conversation the turn belongs to; what an `attach` looks up. */
  sessionId?: string;
  controller: AbortController;
  subscribers: Set<WebSocket>;
  /** Events fanned out so far - the journal's numbering, arrived at in step. */
  seq: number;
}

/** The slice of the core journal the hub reads: the events a turn has recorded, in sequence order. */
export interface TurnJournal {
  events(turnId: string): { seq: number; event: unknown }[];
}

export class TurnHub {
  readonly #turns = new Map<string, RunningTurn>();
  /**
   * Who has a conversation open, by session id. A turn can start there that
   * none of them asked for - a report-back from work handed off earlier, a
   * message from the phone - and each of them is told the moment it does.
   */
  readonly #conversations = new Map<string, Set<WebSocket>>();
  /** Reverse index, so a closing socket leaves every turn in one sweep. */
  readonly #subscriptions = new Map<WebSocket, Set<RunningTurn>>();
  readonly #log: Logger;
  /** The journal, read on attach so the handover to live is gapless. */
  readonly #journal: TurnJournal | null;

  constructor(log: Logger, journal?: TurnJournal) {
    this.#log = log;
    this.#journal = journal ?? null;
  }

  has(id: string): boolean {
    return this.#turns.has(id);
  }

  /** Turns still being drained. */
  get size(): number {
    return this.#turns.size;
  }

  /**
   * Take over a generator: drain it to the end, whatever happens to the
   * sockets along the way. The caller keeps the AbortController and hands it
   * in - `abort` is the one deliberate way a turn ends early.
   *
   * `socket` is the connection that asked for the turn, and it is a
   * subscriber like any other from the very first event: without this, the
   * tab that sent the message would hear nothing of the answer it started -
   * not the stream, not the session event that routes it to `/c/<id>` - and
   * would have to reload just to watch its own turn.
   */
  start(input: {
    id: string;
    sessionId?: string;
    controller: AbortController;
    events: AsyncGenerator<AgentEvent, void, unknown>;
    socket?: WebSocket;
  }): void {
    const turn: RunningTurn = {
      id: input.id,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      controller: input.controller,
      subscribers: new Set(),
      seq: 0,
    };
    this.#turns.set(turn.id, turn);
    if (input.socket) this.#remember(input.socket, turn);
    this.#announce(turn);

    void this.#drain(turn, input.events);
  }

  /** Pump a generator into the turn's subscribers until it ends or fails; the turn is gone from the hub afterwards. */
  async #drain(turn: RunningTurn, events: AsyncGenerator<AgentEvent, void, unknown>): Promise<void> {
    try {
      for await (const event of events) {
        this.#adoptSession(turn, event);
        turn.seq += 1;
        this.#fanOut(turn, { type: 'event', id: turn.id, seq: turn.seq, event });
      }
    } catch (error) {
      this.#fanOut(turn, { type: 'error', id: turn.id, message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.#turns.delete(turn.id);
      for (const socket of turn.subscribers) this.#forget(socket, turn);
    }
  }

  /**
   * The first turn of a new conversation starts before its session
   * exists - the client cannot name what it is about to create. The
   * session event closes that gap one event in, and an `attach` that
   * arrives a moment later (a reload, a second tab) finds the turn.
   */
  #adoptSession(turn: RunningTurn, event: AgentEvent): void {
    if (event.type !== 'session' || turn.sessionId || !event.sessionId) return;
    turn.sessionId = event.sessionId;
    this.#announce(turn);
  }

  #fanOut(turn: RunningTurn, frame: ServerFrame): void {
    for (const socket of turn.subscribers) sendFrame(socket, frame);
  }

  /**
   * Point a socket at whatever runs in this conversation. The reply says
   * which turn that is and where its journal stands, and everything the
   * journal holds up to that position is sent right after - read from the
   * database, not from any buffer, in the same synchronous step as the
   * subscription, so no event can slip between "replayed" and "live". A
   * client that already rebuilt over REST drops the overlap by sequence
   * number; a client that comes in dry gets the whole turn. No turn, no
   * frames - and an explicit `null`, so the client never has to guess
   * silence.
   */
  attach(sessionId: string, socket: WebSocket): void {
    // Remembered whether or not anything runs now: the next turn that starts
    // here finds this socket without it having to ask again.
    let watching = this.#conversations.get(sessionId);
    if (!watching) {
      watching = new Set();
      this.#conversations.set(sessionId, watching);
    }
    watching.add(socket);
    const turn = [...this.#turns.values()].find((entry) => entry.sessionId === sessionId);
    if (!turn) {
      sendFrame(socket, { type: 'attached', id: null, seq: 0 });
      return;
    }
    this.#remember(socket, turn);
    sendFrame(socket, { type: 'attached', id: turn.id, seq: turn.seq });
    if (!this.#journal) return;
    for (const row of this.#journal.events(turn.id)) {
      // Only what has already been fanned out. Events journalled but not yet
      // sent are still in the pump and arrive live - replaying them here too
      // would say everything twice.
      if (row.seq > turn.seq) break;
      sendFrame(socket, { type: 'event', id: turn.id, seq: row.seq, event: row.event as AgentEvent });
    }
  }

  /**
   * The socket left a conversation's page. Turns that start there later are
   * no longer announced to it; one it already follows runs out as before.
   */
  leave(sessionId: string, socket: WebSocket): void {
    const watching = this.#conversations.get(sessionId);
    if (!watching) return;
    watching.delete(socket);
    if (watching.size === 0) this.#conversations.delete(sessionId);
  }

  /** Stop a turn, from any connection - including one that only re-joined it. */
  abort(id: string): boolean {
    const turn = this.#turns.get(id);
    if (!turn) return false;
    turn.controller.abort();
    return true;
  }

  /** A socket went away: its subscriptions go with it, the turns stay. */
  detach(socket: WebSocket): void {
    for (const sessionId of this.#conversations.keys()) this.leave(sessionId, socket);
    const mine = this.#subscriptions.get(socket);
    if (!mine) return;
    for (const turn of mine) turn.subscribers.delete(socket);
    this.#subscriptions.delete(socket);
    this.#log.debug('Turn subscriptions dropped', { remaining: this.#turns.size });
  }

  /**
   * A turn started in a conversation somebody has open: subscribe them and
   * say so with the same `attached` reply an explicit attach gets. The
   * client then reads the journal and joins, exactly as after a reload.
   */
  #announce(turn: RunningTurn): void {
    if (!turn.sessionId) return;
    for (const socket of this.#conversations.get(turn.sessionId) ?? []) {
      if (turn.subscribers.has(socket)) continue;
      this.#remember(socket, turn);
      sendFrame(socket, { type: 'attached', id: turn.id, seq: turn.seq });
    }
  }

  #forget(socket: WebSocket, turn: RunningTurn): void {
    turn.subscribers.delete(socket);
    const mine = this.#subscriptions.get(socket);
    if (!mine) return;
    mine.delete(turn);
    if (mine.size === 0) this.#subscriptions.delete(socket);
  }

  /** One socket, one turn, both indexes - there is no subscribing halfway. */
  #remember(socket: WebSocket, turn: RunningTurn): void {
    turn.subscribers.add(socket);
    let mine = this.#subscriptions.get(socket);
    if (!mine) {
      mine = new Set();
      this.#subscriptions.set(socket, mine);
    }
    mine.add(turn);
  }
}
