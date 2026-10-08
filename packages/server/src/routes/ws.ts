import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { tuiSessions, type AgentEvent } from '@rookery/core';
import type { ServerContext } from '../context.js';
import { isAuthorized, requireSameOrigin } from '../auth.js';
import { errorMessage } from '../errors.js';
import { clientFrameSchema, formatIssues, type ClientFrame } from '../schemas.js';
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
    { websocket: true, preValidation: (request, reply) => authorizeUpgrade(context, request, reply) },
    (socket: WebSocket, request: FastifyRequest) => {
      context.sockets.add(socket);
      context.log.debug('Websocket connected', { ip: request.ip, open: context.sockets.size });

      const handleFrame = createFrameHandler(context, socket);
      socket.on('message', (raw: unknown) => handleRawMessage(context, socket, raw, handleFrame));
      socket.on('close', () => forgetSocket(context, socket));
      socket.on('error', (error: Error) => {
        context.log.warn('Websocket error', { error: error.message });
      });
    },
  );
}

async function authorizeUpgrade(
  context: ServerContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
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
}

function handleRawMessage(
  context: ServerContext,
  socket: WebSocket,
  raw: unknown,
  handleFrame: (frame: ClientFrame) => void,
): void {
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

  // An exception escaping an event listener would take the whole process down;
  // a terminal that has just exited refuses a write, for one.
  try {
    handleFrame(frame.data);
  } catch (error) {
    const message = errorMessage(error);
    context.log.warn('Websocket frame failed', { type: frame.data.type, error: message });
    sendFrame(socket, { type: 'error', message });
  }
}

function forgetSocket(context: ServerContext, socket: WebSocket): void {
  // Tab-close/connection-drop must not cancel in-flight work (Workstream
  // E.1): the subscriptions go, the turns stay. Their generators keep
  // running to completion in the hub, results land in the DB as usual,
  // and the journal keeps answering anyone who looks. A deliberate
  // `abort` frame sent *while still connected* is the only thing that
  // stops a turn early - see the `abort` frame handler.
  context.turns.detach(socket);
  context.sockets.delete(socket);
  // A terminal window closing stops the watching, never the run.
  context.assignmentWatchers.delete(socket);
  context.tuiWatchers.delete(socket);
  context.log.debug('Websocket closed', { open: context.sockets.size });
}

/** One dispatch per socket; each frame type is a single call into a handler below. */
function createFrameHandler(context: ServerContext, socket: WebSocket): (frame: ClientFrame) => void {
  const hub = context.turns;

  return function handleFrame(frame: ClientFrame): void {
    switch (frame.type) {
      case 'ping':
        sendFrame(socket, { type: 'pong' });
        return;

      case 'abort':
        if (!hub.abort(frame.id)) {
          sendFrame(socket, { type: 'error', id: frame.id, message: 'No running turn with that id.' });
        }
        return;

      // Terminal windows, not turns: `watch` opts this socket into the
      // live log of one running assignment, `unwatch` opts it back out.
      // Neither touches the run itself - a watcher going away ends
      // nothing but the watching (Workstream E.1).
      case 'watch':
        addWatch(context.assignmentWatchers, socket, frame.assignmentId);
        return;

      case 'unwatch':
        removeWatch(context.assignmentWatchers, socket, frame.assignmentId);
        return;

      case 'tui-watch':
        watchTerminal(context, socket, frame.assignmentId);
        return;

      case 'tui-unwatch':
        removeWatch(context.tuiWatchers, socket, frame.assignmentId);
        return;

      // Keystrokes into the agent's terminal - the person taking over.
      // The socket is authorised and same-origin, which is the same bar
      // every other write frame on it clears.
      case 'tui-input':
        tuiSessions.write(frame.assignmentId, frame.data);
        return;

      case 'tui-resize':
        tuiSessions.resize(frame.assignmentId, frame.cols, frame.rows);
        return;

      // Closing the terminal ends the process; a run that was still
      // working fails the same way it would if Claude Code crashed.
      case 'tui-kill':
        tuiSessions.kill(frame.assignmentId);
        return;

      case 'tui-open':
        openConversationTerminal(context, socket, frame);
        return;

      // Back to chat: the terminal goes, every exchange in it is already
      // in the conversation's history.
      case 'tui-close':
        context.assistant.closeConversationTerminal(frame.sessionId);
        return;

      case 'answer':
        answerQuestion(context, socket, frame);
        return;

      // Rejoin: whatever runs in this conversation, this socket wants
      // its live tail. The journal replay came over REST before this;
      // the `attached` reply lines the two up by sequence number.
      case 'attach':
        hub.attach(frame.sessionId, socket);
        return;

      case 'detach':
        hub.leave(frame.sessionId, socket);
        return;

      case 'chat':
      case 'assign':
      case 'run_task':
        startTurn(context, socket, frame);
        return;
    }
  };
}

function addWatch(registry: Map<WebSocket, Set<string>>, socket: WebSocket, key: string): void {
  const watched = registry.get(socket);
  if (watched) watched.add(key);
  else registry.set(socket, new Set([key]));
}

function removeWatch(registry: Map<WebSocket, Set<string>>, socket: WebSocket, key: string): void {
  const watched = registry.get(socket);
  if (!watched) return;
  watched.delete(key);
  if (watched.size === 0) registry.delete(socket);
}

/**
 * A run's Claude Code terminal. Subscribing first, snapshot
 * second: output that arrives in between is sent twice at worst,
 * never lost. The snapshot is the screen as it is (the emulator
 * mirroring the process), not the raw bytes that painted it - those
 * only make sense at the size they were painted for.
 */
function watchTerminal(context: ServerContext, socket: WebSocket, assignmentId: string): void {
  addWatch(context.tuiWatchers, socket, assignmentId);
  tuiSessions
    .screen(assignmentId)
    .then((screen) => {
      sendFrame(socket, {
        type: 'tui-snapshot',
        assignmentId,
        info: screen?.info ?? null,
        data: screen?.data ?? '',
      });
    })
    .catch((error: Error) => sendFrame(socket, { type: 'error', message: error.message }));
}

/**
 * A conversation into Claude Code's own terminal. The terminal
 * itself is then watched like any other, under the returned key.
 */
function openConversationTerminal(
  context: ServerContext,
  socket: WebSocket,
  frame: Extract<ClientFrame, { type: 'tui-open' }>,
): void {
  const { id, type: _type, ...input } = frame;
  context.assistant
    .openConversationTerminal(input)
    .then((opened) => sendFrame(socket, { type: 'tui-opened', id, ...opened }))
    .catch((error: Error) => sendFrame(socket, { type: 'error', id, message: error.message }));
}

/**
 * An answer to a question the assistant asked. Deliberately not
 * looked up in the hub: the id is the question's, and the turn
 * blocked on it may have been started on another connection, in
 * another window or on the phone. Any connection may answer any
 * open question - the person is one person.
 *
 * Errors carry no `id`: that field is a turn id to every client reading it,
 * and this one is a question's.
 */
function answerQuestion(
  context: ServerContext,
  socket: WebSocket,
  frame: Extract<ClientFrame, { type: 'answer' }>,
): void {
  const answer = buildAnswer(frame, 'web');
  if (!answer) {
    sendFrame(socket, { type: 'error', message: 'An answer needs a selected option or some text.' });
    return;
  }
  // Stale card: the question timed out, the turn was aborted, or
  // another surface got there first. The `question-closed`
  // broadcast already told this socket so; say it plainly rather
  // than dropping the frame silently.
  if (!isOpenQuestion(context, frame.id)) {
    sendFrame(socket, { type: 'error', message: 'No open question with that id.' });
    return;
  }
  context.assistant.questions.answer(frame.id, answer);
}

/**
 * A chat turn and a direct assignment differ only in which generator they
 * open: both carry the same event vocabulary and the same abort contract, and
 * both go through the hub, so either can be re-joined from anywhere it can be
 * seen.
 */
function startTurn(
  context: ServerContext,
  socket: WebSocket,
  frame: Extract<ClientFrame, { type: 'chat' | 'assign' | 'run_task' }>,
): void {
  const { id } = frame;
  if (context.turns.has(id)) {
    sendFrame(socket, { type: 'error', id, message: 'That id is already running.' });
    return;
  }
  const controller = new AbortController();
  const sessionId = frame.type === 'run_task' ? undefined : frame.payload.sessionId;
  context.turns.start({
    id,
    ...(sessionId ? { sessionId } : {}),
    controller,
    events: openTurnEvents(context, frame, controller),
    socket,
  });
}

function openTurnEvents(
  context: ServerContext,
  frame: Extract<ClientFrame, { type: 'chat' | 'assign' | 'run_task' }>,
  controller: AbortController,
): AsyncGenerator<AgentEvent, void, unknown> {
  const { signal } = controller;
  switch (frame.type) {
    // The frame id doubles as the journal id: a client that
    // re-joined the turn can stop the very turn it re-joined.
    case 'chat':
      return context.assistant.chat({ ...frame.payload, signal, turnId: frame.id });
    case 'assign':
      return context.assistant.assign({ ...frame.payload, signal });
    case 'run_task':
      return context.assistant.runTask({ taskId: frame.payload.taskId, signal });
  }
}
