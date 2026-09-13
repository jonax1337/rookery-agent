import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { ServerContext } from '../context.js';
import { isAuthorized } from '../auth.js';
import { clientFrameSchema, formatIssues } from '../schemas.js';
import { pipeToSocket, sendFrame } from '../services/stream.js';

/**
 * The primary transport.
 *
 * A connection may run several turns at once, each identified by the client's
 * own `id`; that id is what an `abort` frame refers to and what every event
 * frame carries back, so a UI with two panes never mixes streams. The
 * AbortController map is per connection and is emptied when a turn settles, so
 * a long-lived socket does not accumulate dead controllers.
 */
export async function registerWebsocketRoutes(
  app: FastifyInstance,
  context: ServerContext,
): Promise<void> {
  app.get(
    '/ws',
    {
      websocket: true,
      preValidation: (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
        if (isAuthorized(context, request)) {
          done();
          return;
        }
        reply.code(401).send({ error: 'Unauthorized', message: 'A valid token is required.' });
      },
    },
    (socket: WebSocket, request: FastifyRequest) => {
      const turns = new Map<string, AbortController>();
      context.sockets.add(socket);
      context.log.debug('Websocket connected', { ip: request.ip, open: context.sockets.size });

      socket.on('message', (raw: unknown) => {
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(String(raw));
        } catch {
          sendFrame(socket, { type: 'error', message: 'Frame is not valid JSON.' });
          return;
        }

        const frame = clientFrameSchema.safeParse(parsedJson);
        if (!frame.success) {
          sendFrame(socket, { type: 'error', message: formatIssues(frame.error) });
          return;
        }

        switch (frame.data.type) {
          case 'ping':
            sendFrame(socket, { type: 'pong' });
            return;

          case 'abort': {
            const controller = turns.get(frame.data.id);
            if (!controller) {
              sendFrame(socket, {
                type: 'error',
                id: frame.data.id,
                message: 'No running turn with that id.',
              });
              return;
            }
            controller.abort();
            turns.delete(frame.data.id);
            return;
          }

          // A chat turn and a direct assignment differ only in which generator
          // they open: both carry the same event vocabulary and the same abort
          // contract, so an `abort` frame stops either one.
          case 'chat':
          case 'assign':
          case 'run_task': {
            const { id } = frame.data;
            if (turns.has(id)) {
              sendFrame(socket, { type: 'error', id, message: 'That id is already running.' });
              return;
            }
            const controller = new AbortController();
            turns.set(id, controller);

            const events =
              frame.data.type === 'chat'
                ? context.assistant.chat({ ...frame.data.payload, signal: controller.signal })
                : frame.data.type === 'assign'
                  ? context.assistant.assign({ ...frame.data.payload, signal: controller.signal })
                  : context.assistant.runTask({ taskId: frame.data.payload.taskId, signal: controller.signal });

            void pipeToSocket(events, socket, id).finally(() => {
              turns.delete(id);
            });
            return;
          }
        }
      });

      socket.on('close', () => {
        // Tab-close/connection-drop must not cancel in-flight work (Workstream
        // E.1): forget the local bookkeeping so it can be garbage collected,
        // but leave every turn's own AbortController alone. Its generator
        // keeps running to completion server-side, its result lands in the
        // DB as usual, and completion still reaches every other open
        // connection through the org-wide broadcast. A deliberate `abort`
        // frame sent *while still connected* is the only thing that stops a
        // turn early - see the `case 'abort'` handler above.
        turns.clear();
        context.sockets.delete(socket);
        context.log.debug('Websocket closed', { open: context.sockets.size });
      });

      socket.on('error', (error: Error) => {
        context.log.warn('Websocket error', { error: error.message });
      });
    },
  );
}
