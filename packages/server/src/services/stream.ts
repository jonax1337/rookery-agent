import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AgentEvent } from '@rookery/core';
import type { WebSocket } from '@fastify/websocket';

/**
 * One turn produces one AgentEvent stream. Two transports carry it:
 * websockets (the default, bidirectional, abortable) and SSE (the fallback for
 * plain fetch clients). Both funnel through here so the event vocabulary and
 * the abort semantics can never drift apart.
 */

export interface SseStream {
  send(event: AgentEvent): void;
  /** Comment frame - keeps proxies from closing an idle stream. */
  comment(text: string): void;
  end(): void;
  readonly closed: boolean;
}

/**
 * Take over the raw response and start an SSE stream.
 *
 * `reply.hijack()` tells Fastify to stop managing the response, which is what
 * lets us write frames for as long as the turn runs.
 */
export function openSse(request: FastifyRequest, reply: FastifyReply): SseStream {
  reply.hijack();
  const res = reply.raw;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  // Stops nginx and friends from buffering the stream into uselessness.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Deltas are tiny; waiting on Nagle would add latency to every token.
  request.raw.socket?.setNoDelay(true);

  let closed = false;
  const markClosed = (): void => {
    closed = true;
  };
  res.on('close', markClosed);
  res.on('error', markClosed);

  return {
    get closed() {
      return closed || res.writableEnded;
    },
    send(event: AgentEvent) {
      if (closed || res.writableEnded) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    comment(text: string) {
      if (closed || res.writableEnded) return;
      res.write(`: ${text}\n\n`);
    },
    end() {
      if (res.writableEnded) return;
      res.end();
    },
  };
}

/**
 * Pump a turn into an SSE response.
 *
 * The generator is always drained to completion, even after the client has
 * gone away (Workstream E.1: a closed tab must not cut a run short). `send`
 * already no-ops once `sse.closed`, so there is nothing left to deliver, but
 * the underlying `assistant.chat`/`assign`/`runTask` call still needs to run
 * to the end so its result is written to the DB and broadcast normally.
 */
export async function pipeToSse(
  events: AsyncGenerator<AgentEvent, void, unknown>,
  sse: SseStream,
): Promise<void> {
  try {
    for await (const event of events) {
      sse.send(event);
    }
  } catch (error) {
    sse.send({ type: 'error', message: (error as Error).message, fatal: true });
  } finally {
    sse.end();
  }
}

/** Server -> client websocket frames. */
export type ServerFrame =
  /**
   * One event of a turn, `id` being the turn's. `seq` is the journal
   * position of that event: a client that rebuilt the turn from the journal
   * over REST applies only frames numbered above where its replay ended, so
   * the handover from replay to live can neither duplicate nor drop.
   */
  | { type: 'event'; id: string; seq?: number; event: AgentEvent }
  /**
   * Reply to `attach`: the turn running in that session - whose live events
   * this socket now receives - or `null` when none is, with the journal
   * position the turn has already reached.
   */
  | { type: 'attached'; id: string | null; seq: number }
  | { type: 'memory'; event: unknown }
  /** Broadcast: an assignment changed state somewhere in the company. */
  | { type: 'assignment'; event: AgentEvent }
  /**
   * To watchers only: one live-log entry of a running assignment, in arrival
   * order. `seq` is monotone over the whole run, so a client can merge these
   * frames onto a REST snapshot without assuming continuity.
   */
  | { type: 'assignment-log'; assignmentId: string; seq: number; event: AgentEvent }
  /** Broadcast: a message between agents or to the assistant was posted. */
  | { type: 'message'; event: AgentEvent }
  /** Broadcast: mail was sent - a new mail in someone's inbox or outbox. */
  | { type: 'mail'; event: AgentEvent }
  /** Broadcast: a task on the board was created or changed state. */
  | { type: 'task'; event: AgentEvent }
  /** Broadcast: a schedule was created, edited, deleted, or a run of it changed state. */
  | { type: 'cron'; event: AgentEvent }
  /** Broadcast: the memory started, advanced through or finished a night. */
  | { type: 'sleep'; event: AgentEvent }
  /**
   * Broadcast: the assistant asked something and a turn is waiting. It goes
   * to every open connection, not only the one that started the turn - the
   * person may well be at a different screen by now.
   */
  | { type: 'question'; event: AgentEvent }
  /** Broadcast: that question is over, so every surface drops the card. */
  | { type: 'question-closed'; event: AgentEvent }
  /** Broadcast: an agent, team or project was created or edited. */
  | { type: 'changed'; change: { kind: string; id: string } }
  | { type: 'pong' }
  | { type: 'error'; id?: string; message: string };

const OPEN = 1;

export function sendFrame(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState !== OPEN) return;
  socket.send(JSON.stringify(frame));
}
