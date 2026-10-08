import { EventEmitter } from 'node:events';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyWebsocket, { type WebSocket } from '@fastify/websocket';
import {
  createLogger,
  silentLogger,
  toView,
  tuiSessions,
  type AgentEvent,
  type Assistant,
  type AssignmentLogFrame,
  type Logger,
  type MemoryLearnedEvent,
  type TuiSessionInfo,
} from '@rookery/core';
import { VERSION, type ServerContext } from './context.js';
import { createAuthHook, createHostGuard, createSameOriginHook } from './auth.js';
import { errorMessage } from './errors.js';
import { sendFrame, type ServerFrame } from './services/stream.js';
import { TurnHub } from './services/turns.js';
import { UpdateService } from './services/updates.js';
import { registerStatic } from './static.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerUpdateRoutes } from './routes/updates.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerProfileRoutes } from './routes/profile.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerMemoryRoutes } from './routes/memories.js';
import { registerSleepRoutes } from './routes/sleep.js';
import { registerDreamRoutes } from './routes/dream.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerOrgRoutes } from './routes/org.js';
import { registerTerminalRoutes } from './routes/terminals.js';
import { registerCronRoutes } from './routes/cron.js';
import { registerTtsRoutes } from './routes/tts.js';
import { registerToolRoutes } from './routes/tools.js';
import { registerGatewayRoutes } from './routes/gateways.js';
import { registerHookRoutes } from './routes/hooks.js';
import { registerListenerRoutes } from './routes/listeners.js';
import { registerQuestionRoutes } from './routes/questions.js';
import { registerWebsocketRoutes } from './routes/ws.js';
import { createListenerRegistry } from './listeners/registry.js';
import { createTelegramGateway } from './gateways/telegram.js';
import { attachGatewayPush } from './gateways/push.js';

/** How often to prove each socket is still there. */
const HEARTBEAT_MS = 30_000;

/** Provider transcripts and pasted files get large; Fastify's default 1 MB is the wrong ceiling for a personal assistant. */
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

const RESTART_REASON = 'The server restarted while this was running.';

/** Undoes whatever a `start…`/`attach…` step set up. */
type Stop = () => void;

/**
 * A webhook carries its secret in the path, and a 500 is precisely the moment
 * that path would otherwise be copied into a log file that outlives the
 * request. Nothing else in the URL space is secret, so one pattern is enough.
 */
function redactUrl(url: string | undefined): string | undefined {
  return url?.replace(/^\/hooks\/[^/?#]+/, '/hooks/***');
}

export interface BuildServerOptions {
  /** Silence Fastify's own request logging - handy in tests. */
  quiet?: boolean;
  /**
   * End the process cleanly. Given by the entrypoint, which owns shutdown;
   * without it an update cannot be installed from the app, because nothing
   * would stop this server for the updater.
   */
  requestShutdown?: () => void;
}

/**
 * Build the HTTP + websocket surface around a running Assistant.
 *
 * Exported separately from `main` so tests can drive a server without binding
 * a port, and so the CLI can embed one in-process.
 */
export async function buildServer(
  assistant: Assistant,
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const log = openLog(assistant);
  const context = createContext(assistant, log, options);
  const app = Fastify({ logger: false, bodyLimit: MAX_PAYLOAD_BYTES, trustProxy: false });
  app.setErrorHandler(createErrorHandler(log));

  await registerMiddleware(app, context);
  await registerRoutes(app, context);

  const stopBroadcasts = attachBroadcasts(context);
  const staleTasks = failStaleRuns(assistant, log);
  startClock(assistant);
  startListeners(context);
  const stopTelegram = startTelegramChannel(context);
  routeBackgroundTurnsThroughHub(context);
  // Work a restart killed was handed off by somebody who is still waiting
  // for it; they hear that it died, now that the turn can be shown.
  for (const task of staleTasks) assistant.org.reportEnded(task);
  const stopHeartbeat = startHeartbeat(app, context);
  context.updates.start();

  app.addHook('onClose', async () => {
    stopHeartbeat();
    context.updates.stop();
    assistant.cron.stop();
    stopBroadcasts();
    // No terminal outlives the server that streams it.
    tuiSessions.killAll();
    assistant.turnRunner = undefined;
    await stopQuietly(log, 'Telegram gateway', stopTelegram);
    // An open IMAP connection is a live socket, not an unref'd timer: without
    // this the process would stay up long after the server was told to close.
    await stopQuietly(log, 'Listeners', () => context.listeners.stop());
    closeSockets(context);
  });

  app.decorate('rookery', context);

  if (!options.quiet) {
    log.debug('Server built', { routes: app.printRoutes({ commonPrefix: false }) });
  }

  return app;
}

function openLog(assistant: Assistant): Logger {
  const { config } = assistant;
  return config.logLevel === 'silent'
    ? silentLogger
    : createLogger({ level: config.logLevel, home: config.home, scope: 'server' });
}

function createContext(assistant: Assistant, log: Logger, options: BuildServerOptions): ServerContext {
  // Created before the context so the context can hold it: a gateway needs
  // the context to reach the assistant and the config, so it cannot exist
  // before the context does, and the context's own field cannot be filled
  // in until the gateway does.
  const turns = new TurnHub(log, { events: (id) => assistant.store.turns.events(id) });
  const context: ServerContext = {
    assistant,
    config: assistant.config,
    log,
    sockets: new Set<WebSocket>(),
    assignmentWatchers: new Map(),
    tuiWatchers: new Map(),
    turns,
    gateways: [],
    updates: new UpdateService({ assistant, turns, log, version: VERSION, requestShutdown: options.requestShutdown }),
    // Replaced on the next line. A listener fires a schedule through the
    // context, so it cannot be built before the context it fires through.
    listeners: undefined as never,
  };
  context.listeners = createListenerRegistry(context);
  return context;
}

function createErrorHandler(log: Logger) {
  return (error: FastifyError, request: FastifyRequest, reply: FastifyReply): void => {
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status >= 500) {
      log.error('Request failed', { url: redactUrl(request.raw.url), error: error.message });
    }
    reply.code(status).send({
      error: status === 400 ? 'Bad Request' : (error.name || 'Error'),
      message: error.message,
    });
  };
}

async function registerMiddleware(app: FastifyInstance, context: ServerContext): Promise<void> {
  // Not even CORS. The web app is served by this server (or proxied to it by
  // Vite) and so is always same-origin; sending no `Access-Control-*` headers
  // means no other page's script can read a response, which the Origin check
  // on writes alone does not stop. The host guard in front of everything
  // covers the one way a page can become "same-origin" regardless: DNS rebinding.
  app.addHook('onRequest', createHostGuard(context));

  await app.register(fastifyWebsocket, { options: { maxPayload: MAX_PAYLOAD_BYTES } });

  // Auth guards the API surface only; the websocket route checks the token
  // itself on the upgrade, where headers are not available to a browser.
  const auth = createAuthHook(context);
  app.addHook('preHandler', (request, reply, done) => {
    if (!request.raw.url?.startsWith('/api')) {
      done();
      return;
    }
    auth.call(app, request, reply, done);
  });

  // Same-origin enforcement closes the CSRF hole the reflected CORS policy
  // above would otherwise leave open: with credentials allowed and every
  // origin echoed back, any webpage in any browser tab could write
  // cross-origin against the API. Registered before every route so it covers
  // all of them; only mutating requests from a browser are affected.
  app.addHook('preHandler', createSameOriginHook());
}

async function registerRoutes(app: FastifyInstance, context: ServerContext): Promise<void> {
  await registerHealthRoutes(app, context);
  await registerUpdateRoutes(app, context);
  await registerStatsRoutes(app, context);
  await registerConfigRoutes(app, context);
  await registerProfileRoutes(app, context);
  await registerProviderRoutes(app, context);
  await registerSessionRoutes(app, context);
  await registerMemoryRoutes(app, context);
  await registerSleepRoutes(app, context);
  await registerDreamRoutes(app, context);
  await registerChatRoutes(app, context);
  await registerOrgRoutes(app, context);
  await registerTerminalRoutes(app, context);
  await registerCronRoutes(app, context);
  await registerTtsRoutes(app, context);
  await registerToolRoutes(app, context);
  await registerGatewayRoutes(app, context);
  await registerListenerRoutes(app, context);
  await registerQuestionRoutes(app, context);
  // Deliberately outside /api, where the shared bearer token is not demanded
  // on top of the job's own secret. See routes/hooks.ts for the whole argument.
  await registerHookRoutes(app, context);
  await registerWebsocketRoutes(app, context);

  // Registered last so the static SPA fallback never shadows an API route.
  await registerStatic(app, context);
}

/* --------------------------- background fan-out --------------------------- */

function broadcast(context: ServerContext, frame: ServerFrame): void {
  for (const socket of context.sockets) sendFrame(socket, frame);
}

/** Frame for the sockets that asked to watch `key`, and for nobody else. */
function sendToWatchers(watchers: Map<WebSocket, Set<string>>, key: string, frame: ServerFrame): void {
  for (const [socket, keys] of watchers) {
    if (keys.has(key)) sendFrame(socket, frame);
  }
}

function subscribe<Args extends unknown[]>(
  emitter: EventEmitter,
  event: string,
  listener: (...args: Args) => void,
): Stop {
  emitter.on(event, listener);
  return () => {
    emitter.off(event, listener);
  };
}

/**
 * Forward what happens in the background to the open sockets. One listener
 * per server, not per socket: attaching per connection would leak listeners
 * on the Assistant for the process lifetime.
 */
function attachBroadcasts(context: ServerContext): Stop {
  const { assistant } = context;
  const toAll = (frame: ServerFrame): void => broadcast(context, frame);
  const stops: Stop[] = [];

  // Memory extraction finishes after the turn that caused it, so it cannot ride
  // that turn's stream.
  stops.push(subscribe(assistant, 'memory', (event: MemoryLearnedEvent) => toAll({ type: 'memory', event })));

  // Company activity is broadcast the same way: an assignment an agent runs
  // in the background, a message between agents, or a structural change
  // matters to the org page whichever socket started it. The brain falling
  // asleep and waking up again is no different: the memory page follows a
  // run phase by phase, so it has to arrive on every socket, not one. A task
  // on the board was created or changed state.
  //
  // A question is the one event where the broadcast is not a convenience but
  // the point: the turn that asked is blocked, and the person may well be at
  // another screen by now. Every open connection gets the card, and the
  // matching close so that whichever surface did not answer takes it away
  // again. `GET /api/questions` covers the third case - a reload, which was
  // not connected for either frame.
  for (const type of ['assignment', 'message', 'task', 'sleep', 'question', 'question-closed'] as const) {
    stops.push(subscribe(assistant, type, (event: AgentEvent) => toAll({ type, event })));
  }

  // Something for the user - the inbox and its badge follow it on every
  // screen; the phone hears about it through gateways/push.ts.
  stops.push(
    subscribe(assistant, 'notification', (event: AgentEvent) => {
      if (event.type === 'notification') toAll({ type: 'notification', notification: event.notification });
    }),
  );

  // A line on a card's activity: an open task page appends it live.
  stops.push(
    subscribe(assistant, 'task-event', (event: AgentEvent) => {
      if (event.type === 'task-event') toAll({ type: 'task-event', event: event.event });
    }),
  );

  stops.push(
    subscribe(assistant, 'changed', (change: { kind: string; id: string }) => {
      toAll({ type: 'changed', change });
      // The assistant can add a mailbox through its own tools, and what it
      // writes is settings until something opens the connection. PATCH
      // /api/config does this for the page; this does it for the conversation.
      if (change.kind === 'listeners') {
        void context.listeners.refresh().catch((error: unknown) => {
          context.log.warn('Listeners did not follow a change made through a tool', { error: errorMessage(error) });
        });
      }
    }),
  );

  // The nightly memory run is machinery the schedules page does not serve:
  // `CronScheduler.list` filters it out of the REST fetch and `routes/cron.ts`
  // 404s it by id, but the scheduler announces every job including that one.
  // Sent here unfiltered it was merged straight into an open page's table - a
  // row the API insists does not exist, appearing live and staying until a
  // reload. `gateways/push.ts` already drops it at exactly this point; this
  // is the other broadcast finally agreeing with it.
  stops.push(
    subscribe(assistant, 'cron', (event: AgentEvent) => {
      if (event.type === 'cron' && event.job?.kind === 'sleep') return;
      toAll({ type: 'cron', event });
    }),
  );

  // The live log is different: a terminal feed, delivered only to the sockets
  // that sent `watch` for this particular run. Everything else would spray a
  // full transcript at every open tab in the company.
  stops.push(
    subscribe(assistant, 'assignment-log', (frame: AssignmentLogFrame) => {
      sendToWatchers(context.assignmentWatchers, frame.assignmentId, {
        type: 'assignment-log',
        assignmentId: frame.assignmentId,
        seq: frame.entry.seq,
        event: frame.entry.event,
      });
    }),
  );

  // A run's terminal is the same kind of feed, and heavier still: raw screen
  // bytes go only to the sockets that opened that terminal.
  stops.push(
    subscribe(tuiSessions, 'data', (assignmentId: string, data: string) => {
      sendToWatchers(context.tuiWatchers, assignmentId, { type: 'tui-data', assignmentId, data });
    }),
  );
  stops.push(
    subscribe(tuiSessions, 'state', (info: TuiSessionInfo) => {
      sendToWatchers(context.tuiWatchers, info.key, { type: 'tui-state', assignmentId: info.key, info });
      // A terminal opening, finishing or going away changes the workspace's
      // list of tabs, wherever that page is open.
      toAll({ type: 'changed', change: { kind: 'terminals', id: info.key } });
    }),
  );

  return () => {
    for (const stop of stops) stop();
  };
}

/* ------------------------------ restart recovery ------------------------------ */

/**
 * A crash or a plain restart leaves any assignment/task/sleep run still
 * marked pending/running stuck that way forever - nothing ever revisits
 * it. Fail them now, the same way `CronScheduler.start()` already does for
 * `cron_runs` (cron/store.ts `failStaleRuns`), and announce each one on
 * the usual event so an already-open tab reflects reality once it
 * reconnects instead of showing a run stuck at "running".
 *
 * Returns the tasks that were running: their owners are told once the hub
 * can show the report.
 */
function failStaleRuns(assistant: Assistant, log: Logger) {
  const { org } = assistant.store;
  const staleAssignments = org.failStaleAssignments(RESTART_REASON);
  for (const assignment of staleAssignments) {
    const agent = org.getAgent(assignment.agentId);
    if (!agent) continue;
    assistant.emit('assignment', {
      type: 'assignment',
      assignment: toView(assignment, agent, { error: assignment.error }),
    } satisfies AgentEvent);
  }
  const staleTasks = org.failStaleTasks(RESTART_REASON);
  for (const task of staleTasks) {
    assistant.emit('task', { type: 'task', task } satisfies AgentEvent);
  }
  const staleSleepRuns = assistant.store.failStaleSleepRuns(RESTART_REASON);
  for (const run of staleSleepRuns) {
    assistant.emit('sleep', { type: 'sleep', run } satisfies AgentEvent);
  }
  // Dream traces left open by the same crash get the same closing pass: a
  // trace without `finished_at` is the 'unfinished' abstention at scoring
  // time, so the restart closes what the dead process owed. No event rides
  // along - no client shows a trace - which is why this one is just counted.
  const staleDreamTraces = assistant.store.failStaleTraces(RESTART_REASON);
  if (staleAssignments.length || staleTasks.length || staleSleepRuns.length || staleDreamTraces) {
    log.warn('Failed stale rows left running by a previous process', {
      assignments: staleAssignments.length,
      tasks: staleTasks.length,
      sleepRuns: staleSleepRuns.length,
      dreamTraces: staleDreamTraces,
    });
  }
  return staleTasks;
}

/* ------------------------------ background work ------------------------------ */

/**
 * The clock runs for as long as the server does: a schedule is a promise
 * that something happens at a time, and the server is the process that is
 * up at that time.
 */
function startClock(assistant: Assistant): void {
  assistant.cron.start();
  // The nightly memory run is an ordinary schedule row, created on first start.
  assistant.ensureSleepSchedule();
  // Jarvis gets the board as a standing order too - a visible, editable
  // schedule row like any other, seeded once and left alone after that.
  assistant.ensureBoardWatchSchedule();
}

/**
 * Listeners are the other half of the clock: connections held open so a
 * schedule hears about something instead of asking every few minutes. Not
 * awaited - a mailbox that is unreachable right now is a reason to run
 * without it, never a reason the server refuses to start.
 */
function startListeners(context: ServerContext): void {
  void context.listeners.start().catch((error: unknown) => {
    context.log.warn('Listeners could not start', { error: errorMessage(error) });
  });
}

/**
 * The Telegram channel is best-effort: a missing token or a network hiccup
 * is a reason to run without it, never a reason the server itself refuses
 * to start. `start()` is therefore not awaited here - its own status()
 * reports what happened, for the gateways page to show.
 *
 * Returns what shuts the channel down again.
 */
function startTelegramChannel(context: ServerContext): () => Promise<void> {
  const gateway = createTelegramGateway(context);
  context.gateways.push(gateway);
  void gateway.start().catch((error: unknown) => {
    context.log.warn('Telegram gateway could not start', { error: errorMessage(error) });
  });
  const push = attachGatewayPush(context, gateway);
  // The `notify` tool refuses rather than reporting a delivery that never
  // happened; this is the honest answer it asks for, and it changes with a
  // setting or a blocked recipient, so the probe is a call, not a flag.
  context.assistant.notifyProbe = () => push.canDeliver();
  return async () => {
    push.detach();
    context.assistant.notifyProbe = undefined;
    await gateway.stop();
  };
}

/**
 * A turn nobody typed - a report-back from work handed off earlier - runs
 * through the hub like any other, so every tab that has the conversation
 * open watches it arrive, and it can be stopped from any of them.
 */
function routeBackgroundTurnsThroughHub(context: ServerContext): void {
  context.assistant.turnRunner = (turn) => {
    context.turns.start({
      id: turn.turnId,
      sessionId: turn.sessionId,
      controller: turn.controller,
      events: turn.events,
    });
  };
}

/**
 * A socket that misses a full heartbeat round trip is dead weight: without
 * this a dropped Wi-Fi connection would sit in `sockets` forever.
 */
function startHeartbeat(app: FastifyInstance, context: ServerContext): Stop {
  const liveness = new WeakMap<WebSocket, boolean>();
  app.websocketServer.on('connection', (socket: WebSocket) => {
    liveness.set(socket, true);
    socket.on('pong', () => liveness.set(socket, true));
  });

  const dropSocket = (socket: WebSocket): void => {
    context.sockets.delete(socket);
    liveness.delete(socket);
    socket.terminate();
  };

  const timer = setInterval(() => {
    for (const socket of context.sockets) {
      // Missed the previous round trip - the peer is gone.
      if (liveness.get(socket) === false) {
        dropSocket(socket);
        continue;
      }
      liveness.set(socket, false);
      try {
        socket.ping();
      } catch {
        // `ping` throws on a socket that is no longer open.
        dropSocket(socket);
      }
    }
  }, HEARTBEAT_MS);
  timer.unref?.();

  return () => clearInterval(timer);
}

/* -------------------------------- shutdown -------------------------------- */

async function stopQuietly(log: Logger, what: string, stop: () => Promise<void>): Promise<void> {
  try {
    await stop();
  } catch (error) {
    log.warn(`${what} did not stop cleanly`, { error: errorMessage(error) });
  }
}

function closeSockets(context: ServerContext): void {
  for (const socket of context.sockets) {
    try {
      socket.close(1001, 'server shutting down');
    } catch {
      // Already gone.
    }
  }
  context.sockets.clear();
}

declare module 'fastify' {
  interface FastifyInstance {
    rookery: ServerContext;
  }
}
