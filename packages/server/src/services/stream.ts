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
  | { type: 'event'; id: string; event: AgentEvent }
  | { type: 'memory'; event: unknown }
  /** Broadcast: an assignment changed state somewhere in the company. */
  | { type: 'assignment'; event: AgentEvent }
  /** Broadcast: a message between agents or to the assistant was posted. */
  | { type: 'message'; event: AgentEvent }
  /** Broadcast: a task on the board was created or changed state. */
  | { type: 'task'; event: AgentEvent }
  /** Broadcast: a schedule was created, edited, deleted, or a run of it changed state. */
  | { type: 'cron'; event: AgentEvent }
  /** Broadcast: the memory started, advanced through or finished a night. */
  | { type: 'sleep'; event: AgentEvent }
  /** Broadcast: an agent, team or project was created or edited. */
  | { type: 'changed'; change: { kind: string; id: string } }
  | { type: 'pong' }
  | { type: 'error'; id?: string; message: string };

const OPEN = 1;

export function sendFrame(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState !== OPEN) return;
  socket.send(JSON.stringify(frame));
}

/**
 * Pump a turn down one websocket, tagging every frame with the request id.
 *
 * The generator is always drained to completion, even after the socket has
 * closed (Workstream E.1: a closed tab must not cut a run short).
 * `sendFrame` already no-ops once the socket is no longer OPEN, but the
 * underlying `assistant.chat`/`assign`/`runTask` call still needs to run to
 * the end so its result is written to the DB and broadcast normally.
 */
export async function pipeToSocket(
  events: AsyncGenerator<AgentEvent, void, unknown>,
  socket: WebSocket,
  id: string,
): Promise<void> {
  try {
    for await (const event of events) {
      sendFrame(socket, { type: 'event', id, event });
    }
  } catch (error) {
    sendFrame(socket, { type: 'error', id, message: (error as Error).message });
  }
}
