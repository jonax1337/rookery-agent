import { loadDotEnv } from './env.js';
import { Assistant, createLogger, type RookeryConfig } from '@rookery/core';
import { buildServer } from './server.js';
import { VERSION } from './context.js';

/**
 * Process entrypoint.
 *
 * Everything configurable already lives in ~/.rookery/config.json and the
 * ROOKERY_* environment variables; the two flags here exist so a second
 * instance can be started on another port without touching either.
 */
function parseArgs(argv: string[]): Partial<RookeryConfig> {
  const patch: Partial<RookeryConfig> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value)) patch.port = value;
      i += 1;
    } else if (arg === '--host') {
      const value = argv[i + 1];
      if (value) patch.host = value;
      i += 1;
    }
  }
  return patch;
}

async function main(): Promise<void> {
  loadDotEnv();
  const overrides = parseArgs(process.argv.slice(2));
  const assistant = new Assistant({ config: overrides });
  const config = assistant.config;
  const log = createLogger({ level: config.logLevel, home: config.home, scope: 'main' });

  const app = await buildServer(assistant);

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    log.info('Shutting down', { signal });
    app
      .close()
      .catch((error: unknown) => log.error('Close failed', { error: String(error) }))
      .finally(() => {
        assistant.close();
        process.exit(0);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', { reason: String(reason) });
  });

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    log.error('Failed to listen', { error: (error as Error).message });
    assistant.close();
    process.exit(1);
  }

  const providers = await assistant.providers.statuses();
  const ready = providers.filter((p) => p.available && p.authenticated).map((p) => p.id);

  log.info(`Rookery server ${VERSION} listening`, {
    url: `http://${config.host}:${config.port}`,
    providers: ready.length ? ready.join(', ') : 'none ready',
    auth: config.token ? 'token required' : 'open (loopback)',
  });
}

void main();
