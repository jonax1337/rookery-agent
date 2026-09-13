import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket, { type WebSocket } from '@fastify/websocket';
import { createLogger, silentLogger, type AgentEvent, type Assistant, type MemoryLearnedEvent } from '@rookery/core';
import type { ServerContext } from './context.js';
import { createAuthHook } from './auth.js';
import { BadRequestError } from './schemas.js';
import { sendFrame } from './services/stream.js';
import { registerStatic } from './static.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerProfileRoutes } from './routes/profile.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerMemoryRoutes } from './routes/memories.js';
import { registerSleepRoutes } from './routes/sleep.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerOrgRoutes } from './routes/org.js';
import { registerCronRoutes } from './routes/cron.js';
import { registerTtsRoutes } from './routes/tts.js';
import { registerToolRoutes } from './routes/tools.js';
import { registerGatewayRoutes } from './routes/gateways.js';
import { registerWebsocketRoutes } from './routes/ws.js';
import { createTelegramGateway, type GatewayHandle } from './gateways/telegram.js';
import { attachGatewayPush } from './gateways/push.js';

/** How often to prove each socket is still there. */
const HEARTBEAT_MS = 30_000;

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
    gateways,
  };

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
      log.error('Request failed', { url: request.raw.url, error: error.message });
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

  await registerHealthRoutes(app, context);
  await registerStatsRoutes(app, context);
  await registerConfigRoutes(app, context);
  await registerProfileRoutes(app, context);
  await registerProviderRoutes(app, context);
  await registerSessionRoutes(app, context);
  await registerMemoryRoutes(app, context);
  await registerSleepRoutes(app, context);
  await registerChatRoutes(app, context);
  await registerOrgRoutes(app, context);
  await registerCronRoutes(app, context);
  await registerTtsRoutes(app, context);
  await registerToolRoutes(app, context);
  await registerGatewayRoutes(app, context);
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
  const onMessage = (event: AgentEvent): void => {
    for (const socket of context.sockets) sendFrame(socket, { type: 'message', event });
  };
  const onChanged = (change: { kind: string; id: string }): void => {
    for (const socket of context.sockets) sendFrame(socket, { type: 'changed', change });
  };
  const onTask = (event: AgentEvent): void => {
    for (const socket of context.sockets) sendFrame(socket, { type: 'task', event });
  };
  const onCron = (event: AgentEvent): void => {
    for (const socket of context.sockets) sendFrame(socket, { type: 'cron', event });
  };
  // The brain falling asleep and waking up again: the memory page follows a
  // run phase by phase, so it has to arrive on every socket, not one.
  const onSleep = (event: AgentEvent): void => {
    for (const socket of context.sockets) sendFrame(socket, { type: 'sleep', event });
  };
  assistant.on('assignment', onAssignment);
  assistant.on('message', onMessage);
  assistant.on('changed', onChanged);
  assistant.on('task', onTask);
  assistant.on('cron', onCron);
  assistant.on('sleep', onSleep);

  // The clock runs for as long as the server does: a schedule is a promise
  // that something happens at a time, and the server is the process that is
  // up at that time.
  assistant.cron.start();
  // The nightly memory run is an ordinary schedule row, created on first start.
  assistant.ensureSleepSchedule();

  // The Telegram channel is best-effort: a missing token or a network hiccup
  // is a reason to run without it, never a reason the server itself refuses
  // to start. `start()` is therefore not awaited here - its own status()
  // reports what happened, for the gateways page to show.
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
    assistant.off('message', onMessage);
    assistant.off('changed', onChanged);
    assistant.off('task', onTask);
    assistant.off('cron', onCron);
    assistant.off('sleep', onSleep);
    telegramPush.detach();
    assistant.notifyProbe = undefined;
    try {
      await telegramGateway.stop();
    } catch (error) {
      log.warn('Telegram gateway did not stop cleanly', { error: (error as Error).message });
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
