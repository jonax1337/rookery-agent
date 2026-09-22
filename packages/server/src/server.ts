import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket, { type WebSocket } from '@fastify/websocket';
import {
  createLogger,
  silentLogger,
  toView,
  type AgentEvent,
  type Assistant,
  type AssignmentLogFrame,
  type MemoryLearnedEvent,
} from '@rookery/core';
import type { ServerContext } from './context.js';
import { createAuthHook, createSameOriginHook } from './auth.js';
import { BadRequestError } from './schemas.js';
import { sendFrame } from './services/stream.js';
import { TurnHub } from './services/turns.js';
import { registerStatic } from './static.js';
import { registerHealthRoutes } from './routes/health.js';
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
import { registerCronRoutes } from './routes/cron.js';
import { registerTtsRoutes } from './routes/tts.js';
import { registerToolRoutes } from './routes/tools.js';
import { registerGatewayRoutes } from './routes/gateways.js';
import { registerHookRoutes } from './routes/hooks.js';
import { registerListenerRoutes } from './routes/listeners.js';
import { registerQuestionRoutes } from './routes/questions.js';
import { registerWebsocketRoutes } from './routes/ws.js';
import { createListenerRegistry } from './listeners/registry.js';
import { createTelegramGateway, type GatewayHandle } from './gateways/telegram.js';
import { attachGatewayPush } from './gateways/push.js';

/** How often to prove each socket is still there. */
const HEARTBEAT_MS = 30_000;

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
  const config = assistant.config;
  const log =
    config.logLevel === 'silent'
      ? silentLogger
      : createLogger({ level: config.logLevel, home: config.home, scope: 'server' });

  // Created before the context so the context can hold it: a gateway needs
  // the context to reach the assistant and the config, so it cannot exist
  // before the context does, and the context's own field cannot be filled
  // in until the gateway does.
  const gateways: GatewayHandle[] = [];
  const context: ServerContext = {
    assistant,
    config,
    log,
    sockets: new Set<WebSocket>(),
    assignmentWatchers: new Map(),
    turns: new TurnHub(log, { events: (id) => assistant.store.turns.events(id) }),
    gateways,
    // Replaced on the next line. A listener fires a schedule through the
    // context, so it cannot be built before the context it fires through.
    listeners: undefined as never,
  };
  context.listeners = createListenerRegistry(context);

  const app = Fastify({
    logger: false,
    // Provider transcripts and pasted files get large; the default 1 MB is
    // the wrong ceiling for a personal assistant.
    bodyLimit: 16 * 1024 * 1024,
    trustProxy: false,
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status =
      error instanceof BadRequestError
        ? 400
        : typeof error.statusCode === 'number'
          ? error.statusCode
          : 500;
    if (status >= 500) {
      log.error('Request failed', { url: redactUrl(request.raw.url), error: error.message });
    }
    reply.code(status).send({
      error: status === 400 ? 'Bad Request' : (error.name || 'Error'),
      message: error.message,
    });
  });

  await app.register(fastifyCors, {
    // Loopback by default; a token is what gates access when it is not.
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(fastifyWebsocket, {
    options: { maxPayload: 16 * 1024 * 1024 },
  });

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

  await registerHealthRoutes(app, context);
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

  /* --------------------------- background fan-out --------------------------- */

  // Memory extraction finishes after the turn that caused it, so it cannot ride
  // that turn's stream. One listener per server, not per socket: attaching per
  // connection would leak listeners on the Assistant for the process lifetime.
  const onMemory = (event: MemoryLearnedEvent): void => {
    for (const socket of context.sockets) sendFrame(socket, { type: 'memory', event });
  };
  assistant.on('memory', onMemory);

  // Company activity is broadcast the same way: an assignment an agent runs
  // in the background, a message between agents, or a structural change
  // matters to the org page whichever socket started it.
  const onAssignment = (event: AgentEvent): void => {
    for (const socket of context.sockets) sendFrame(socket, { type: 'assignment', event });
  };
  // The live log is different: a terminal feed, delivered only to the sockets
  // that sent `watch` for this particular run. Everything else would spray a
  // full transcript at every open tab in the company.
  const onAssignmentLog = (frame: AssignmentLogFrame): void => {
    for (const [socket, ids] of context.assignmentWatchers) {
      if (ids.has(frame.assignmentId)) {
        sendFrame(socket, {
          type: 'assignment-log',
          assignmentId: frame.assignmentId,
          seq: frame.entry.seq,
          event: frame.entry.event,
        });
      }
    }
  };
  const onMessage = (event: AgentEvent): void => {
    for (const socket of context.sockets) sendFrame(socket, { type: 'message', event });
  };
  const onMail = (event: AgentEvent): void => {
    for (const socket of context.sockets) sendFrame(socket, { type: 'mail', event });
  };
  const onChanged = (change: { kind: string; id: string }): void => {
    for (const socket of context.sockets) sendFrame(socket, { type: 'changed', change });
    // The assistant can add a mailbox through its own tools, and what it
    // writes is settings until something opens the connection. PATCH
    // /api/config does this for the page; this does it for the conversation.
    if (change.kind === 'listeners') {
      void context.listeners.refresh().catch((error: Error) => {
        log.warn('Listeners did not follow a change made through a tool', { error: error.message });
      });
    }
  };
  const onTask = (event: AgentEvent): void => {
    for (const socket of context.sockets) sendFrame(socket, { type: 'task', event });
  };
  // The nightly memory run is machinery the schedules page does not serve:
  // `CronScheduler.list` filters it out of the REST fetch and `routes/cron.ts`
  // 404s it by id, but the scheduler announces every job including that one.
  // Sent here unfiltered it was merged straight into an open page's table - a
  // row the API insists does not exist, appearing live and staying until a
  // reload. `gateways/push.ts` already drops it at exactly this point; this
  // is the other broadcast finally agreeing with it.
  const onCron = (event: AgentEvent): void => {
    if (event.type === 'cron' && event.job?.kind === 'sleep') return;
    for (const socket of context.sockets) sendFrame(socket, { type: 'cron', event });
  };
  // The brain falling asleep and waking up again: the memory page follows a
  // run phase by phase, so it has to arrive on every socket, not one.
  const onSleep = (event: AgentEvent): void => {
    for (const socket of context.sockets) sendFrame(socket, { type: 'sleep', event });
  };
  // A question is the one event where the broadcast is not a convenience but
  // the point: the turn that asked is blocked, and the person may well be at
  // another screen by now. Every open connection gets the card, and the
  // matching close so that whichever surface did not answer takes it away
  // again. `GET /api/questions` covers the third case - a reload, which was
  // not connected for either frame.
  const onQuestion = (event: AgentEvent): void => {
    for (const socket of context.sockets) sendFrame(socket, { type: 'question', event });
  };
  const onQuestionClosed = (event: AgentEvent): void => {
    for (const socket of context.sockets) sendFrame(socket, { type: 'question-closed', event });
  };
  assistant.on('assignment', onAssignment);
  assistant.on('assignment-log', onAssignmentLog);
  assistant.on('message', onMessage);
  assistant.on('mail', onMail);
  assistant.on('changed', onChanged);
  assistant.on('task', onTask);
  assistant.on('cron', onCron);
  assistant.on('sleep', onSleep);
  assistant.on('question', onQuestion);
  assistant.on('question-closed', onQuestionClosed);

  // A crash or a plain restart leaves any assignment/task/sleep run still
  // marked pending/running stuck that way forever - nothing ever revisits
  // it. Fail them now, the same way `CronScheduler.start()` already does for
  // `cron_runs` (cron/store.ts `failStaleRuns`), and announce each one on
  // the usual event so an already-open tab reflects reality once it
  // reconnects instead of showing a run stuck at "running".
  const RESTART_REASON = 'The server restarted while this was running.';
  const staleAssignments = assistant.store.org.failStaleAssignments(RESTART_REASON);
  for (const assignment of staleAssignments) {
    const agent = assistant.store.org.getAgent(assignment.agentId);
    if (!agent) continue;
    assistant.emit('assignment', {
      type: 'assignment',
      assignment: toView(assignment, agent, { error: assignment.error }),
    } satisfies AgentEvent);
  }
  const staleTasks = assistant.store.org.failStaleTasks(RESTART_REASON);
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

  // The clock runs for as long as the server does: a schedule is a promise
  // that something happens at a time, and the server is the process that is
  // up at that time.
  assistant.cron.start();
  // The nightly memory run is an ordinary schedule row, created on first start.
  assistant.ensureSleepSchedule();
  // Jarvis gets the board as a standing order too - a visible, editable
  // schedule row like any other, seeded once and left alone after that.
  assistant.ensureBoardWatchSchedule();

  // The Telegram channel is best-effort: a missing token or a network hiccup
  // is a reason to run without it, never a reason the server itself refuses
  // to start. `start()` is therefore not awaited here - its own status()
  // reports what happened, for the gateways page to show.
  // Listeners are the other half of the clock: connections held open so a
  // schedule hears about something instead of asking every few minutes. Not
  // awaited, for the same reason the gateway below is not - a mailbox that is
  // unreachable right now is a reason to run without it, never a reason the
  // server refuses to start.
  void context.listeners.start().catch((error: Error) => {
    log.warn('Listeners could not start', { error: error.message });
  });

  const telegramGateway = createTelegramGateway(context);
  gateways.push(telegramGateway);
  void telegramGateway.start().catch((error: Error) => {
    log.warn('Telegram gateway could not start', { error: error.message });
  });
  const telegramPush = attachGatewayPush(context, telegramGateway);
  // The `notify` tool refuses rather than reporting a delivery that never
  // happened; this is the honest answer it asks for, and it changes with a
  // setting or a blocked recipient, so the probe is a call, not a flag.
  assistant.notifyProbe = () => telegramPush.canDeliver();

  // A socket that misses a full heartbeat round trip is dead weight: without
  // this a dropped Wi-Fi connection would sit in `sockets` forever.
  const liveness = new WeakMap<WebSocket, boolean>();
  app.websocketServer.on('connection', (socket: WebSocket) => {
    liveness.set(socket, true);
    socket.on('pong', () => liveness.set(socket, true));
  });

  const heartbeat = setInterval(() => {
    for (const socket of context.sockets) {
      const alive = liveness.get(socket);
      if (alive === false) {
        // Missed the previous round trip - the peer is gone.
        context.sockets.delete(socket);
        liveness.delete(socket);
        socket.terminate();
        continue;
      }
      liveness.set(socket, false);
      try {
        socket.ping();
      } catch {
        context.sockets.delete(socket);
        liveness.delete(socket);
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    assistant.cron.stop();
    assistant.off('memory', onMemory);
    assistant.off('assignment', onAssignment);
    assistant.off('assignment-log', onAssignmentLog);
    assistant.off('message', onMessage);
    assistant.off('mail', onMail);
    assistant.off('changed', onChanged);
    assistant.off('task', onTask);
    assistant.off('cron', onCron);
    assistant.off('sleep', onSleep);
    assistant.off('question', onQuestion);
    assistant.off('question-closed', onQuestionClosed);
    telegramPush.detach();
    assistant.notifyProbe = undefined;
    try {
      await telegramGateway.stop();
    } catch (error) {
      log.warn('Telegram gateway did not stop cleanly', { error: (error as Error).message });
    }
    // An open IMAP connection is a live socket, not an unref'd timer: without
    // this the process would stay up long after the server was told to close.
    try {
      await context.listeners.stop();
    } catch (error) {
      log.warn('Listeners did not stop cleanly', { error: (error as Error).message });
    }
    for (const socket of context.sockets) {
      try {
        socket.close(1001, 'server shutting down');
      } catch {
        // Already gone.
      }
    }
    context.sockets.clear();
  });

  app.decorate('rookery', context);

  if (!options.quiet) {
    log.debug('Server built', { routes: app.printRoutes({ commonPrefix: false }) });
  }

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    rookery: ServerContext;
  }
}
