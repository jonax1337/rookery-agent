import type { AgentEvent, Logger } from '@rookery/core';
import type { WebSocket } from '@fastify/websocket';
import { sendFrame } from './stream.js';

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

export class TurnHub {
  readonly #turns = new Map<string, RunningTurn>();
  /** Reverse index, so a closing socket leaves every turn in one sweep. */
  readonly #subscriptions = new Map<WebSocket, Set<RunningTurn>>();
  readonly #log: Logger;

  constructor(log: Logger) {
    this.#log = log;
  }

  has(id: string): boolean {
    return this.#turns.has(id);
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

    void (async () => {
      try {
        for await (const event of input.events) {
          turn.seq += 1;
          for (const socket of turn.subscribers) {
            sendFrame(socket, { type: 'event', id: turn.id, seq: turn.seq, event });
          }
        }
      } catch (error) {
        for (const socket of turn.subscribers) {
          sendFrame(socket, { type: 'error', id: turn.id, message: (error as Error).message });
        }
      } finally {
        this.#turns.delete(turn.id);
        for (const socket of turn.subscribers) this.#forget(socket, turn);
      }
    })();
  }

  /**
   * Point a socket at whatever runs in this conversation. The reply says
   * which turn that is and where its journal stands, so the client can line
   * its REST replay up with the frames that follow. No turn, no frames - and
   * an explicit `null`, so the client never has to guess silence.
   */
  attach(sessionId: string, socket: WebSocket): void {
    const turn = [...this.#turns.values()].find((entry) => entry.sessionId === sessionId);
    if (!turn) {
      sendFrame(socket, { type: 'attached', id: null, seq: 0 });
      return;
    }
    this.#remember(socket, turn);
    sendFrame(socket, { type: 'attached', id: turn.id, seq: turn.seq });
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
    const mine = this.#subscriptions.get(socket);
    if (!mine) return;
    for (const turn of mine) turn.subscribers.delete(socket);
    this.#subscriptions.delete(socket);
    this.#log.debug('Turn subscriptions dropped', { remaining: this.#turns.size });
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
