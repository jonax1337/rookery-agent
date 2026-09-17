import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { ServerContext } from '../context.js';
import { isAuthorized, requireSameOrigin } from '../auth.js';
import { clientFrameSchema, formatIssues } from '../schemas.js';
import { buildAnswer, isOpenQuestion } from './questions.js';
import { sendFrame } from '../services/stream.js';

/**
 * The primary transport.
 *
 * Turns live in the hub, not in this connection: every generator is drained
 * server-side and its events fan out to whichever sockets are watching that
 * conversation, so a reload - or a second tab, or a phone - reads the journal
 * over REST, attaches, and the stream simply continues. A connection that
 * drops takes nothing with it but its subscriptions (Workstream E.1); a
 * deliberate `abort` frame, from any connection including one that re-joined,
 * is the one way a turn ends early.
 *
 * The one frame that is not scoped to a turn is `answer`: a question belongs
 * to the person, not to the connection that provoked it, so its id is looked
 * up in the assistant's question registry rather than in the hub.
 */
export async function registerWebsocketRoutes(
  app: FastifyInstance,
  context: ServerContext,
): Promise<void> {
  app.get(
    '/ws',
    {
      websocket: true,
      preValidation: async (request: FastifyRequest, reply: FastifyReply) => {
        if (!isAuthorized(context, request)) {
          reply.code(401).send({ error: 'Unauthorized', message: 'A valid token is required.' });
          return;
        }
        // A WebSocket upgrade is a GET, so the global same-origin hook skips
        // it — yet a browser page can open a socket cross-site and send
        // write frames (chat/assign/run_task), which is exactly what
        // requireSameOrigin exists to stop. Non-browser clients send no
        // Origin and pass untouched.
        await requireSameOrigin(request);
      },
    },
    (socket: WebSocket, request: FastifyRequest) => {
      const hub = context.turns;
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
            if (!hub.abort(frame.data.id)) {
              sendFrame(socket, {
                type: 'error',
                id: frame.data.id,
                message: 'No running turn with that id.',
              });
            }
            return;
          }

          // Terminal windows, not turns: `watch` opts this socket into the
          // live log of one running assignment, `unwatch` opts it back out.
          // Neither touches the run itself - a watcher going away ends
          // nothing but the watching (Workstream E.1).
          case 'watch': {
            let watched = context.assignmentWatchers.get(socket);
            if (!watched) {
              watched = new Set();
              context.assignmentWatchers.set(socket, watched);
            }
            watched.add(frame.data.assignmentId);
            return;
          }

          case 'unwatch': {
            const watched = context.assignmentWatchers.get(socket);
            if (!watched) return;
            watched.delete(frame.data.assignmentId);
            if (watched.size === 0) context.assignmentWatchers.delete(socket);
            return;
          }

          // An answer to a question the assistant asked. Deliberately not
          // looked up in the hub: the id is the question's, and the turn
          // blocked on it may have been started on another connection, in
          // another window or on the phone. Any connection may answer any
          // open question - the person is one person.
          case 'answer': {
            const answer = buildAnswer(frame.data, 'web');
            if (!answer) {
              sendFrame(socket, {
                type: 'error',
                message: 'An answer needs a selected option or some text.',
              });
              return;
            }
            // Stale card: the question timed out, the turn was aborted, or
            // another surface got there first. The `question-closed`
            // broadcast already told this socket so; say it plainly rather
            // than dropping the frame silently. No `id` on the error frame -
            // that field is a turn id to every client reading it, and this
            // one is not.
            if (!isOpenQuestion(context, frame.data.id)) {
              sendFrame(socket, { type: 'error', message: 'No open question with that id.' });
              return;
            }
            context.assistant.questions.answer(frame.data.id, answer);
            return;
          }

          // Rejoin: whatever runs in this conversation, this socket wants
          // its live tail. The journal replay came over REST before this;
          // the `attached` reply lines the two up by sequence number.
          case 'attach':
            hub.attach(frame.data.sessionId, socket);
            return;

          // A chat turn and a direct assignment differ only in which
          // generator they open: both carry the same event vocabulary and
          // the same abort contract, and both go through the hub now, so
          // either can be re-joined from anywhere it can be seen.
          case 'chat':
          case 'assign':
          case 'run_task': {
            const { id } = frame.data;
            if (hub.has(id)) {
              sendFrame(socket, { type: 'error', id, message: 'That id is already running.' });
              return;
            }
            const controller = new AbortController();
            const sessionId =
              frame.data.type === 'run_task' ? undefined : frame.data.payload.sessionId;

            const events =
              frame.data.type === 'chat'
                ? // The frame id doubles as the journal id: a client that
                  // re-joined the turn can stop the very turn it re-joined.
                  context.assistant.chat({
                    ...frame.data.payload,
                    signal: controller.signal,
                    turnId: id,
                  })
                : frame.data.type === 'assign'
                  ? context.assistant.assign({ ...frame.data.payload, signal: controller.signal })
                  : context.assistant.runTask({ taskId: frame.data.payload.taskId, signal: controller.signal });

            hub.start({ id, ...(sessionId ? { sessionId } : {}), controller, events, socket });
            return;
          }
        }
      });

      socket.on('close', () => {
        // Tab-close/connection-drop must not cancel in-flight work (Workstream
        // E.1): the subscriptions go, the turns stay. Their generators keep
        // running to completion in the hub, results land in the DB as usual,
        // and the journal keeps answering anyone who looks. A deliberate
        // `abort` frame sent *while still connected* is the only thing that
        // stops a turn early - see the `case 'abort'` handler above.
        hub.detach(socket);
        context.sockets.delete(socket);
        // A terminal window closing stops the watching, never the run.
        context.assignmentWatchers.delete(socket);
        context.log.debug('Websocket closed', { open: context.sockets.size });
      });

      socket.on('error', (error: Error) => {
        context.log.warn('Websocket error', { error: error.message });
      });
    },
  );
}
