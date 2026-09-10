import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  child(scope: string): Logger;
}

/**
 * Small structured logger. Writes human lines to stderr (so stdout stays a
 * clean channel for piped CLI output) and JSON lines to ~/.rookery/logs.
 */
export function createLogger(options: {
  level?: LogLevel;
  home?: string;
  scope?: string;
  stderr?: boolean;
} = {}): Logger {
  const level = options.level ?? 'info';
  const scope = options.scope ?? 'rookery';
  const toStderr = options.stderr ?? true;
  const logFile = options.home ? prepareLogFile(options.home) : undefined;

  function emit(lvl: Exclude<LogLevel, 'silent'>, msg: string, meta?: unknown): void {
    if (ORDER[lvl] < ORDER[level]) return;
    const time = new Date().toISOString();
    if (toStderr) {
      const suffix = meta === undefined ? '' : ` ${safeJson(meta)}`;
      process.stderr.write(`${time} ${lvl.toUpperCase().padEnd(5)} [${scope}] ${msg}${suffix}\n`);
    }
    if (logFile) {
      try {
        appendFileSync(logFile, `${JSON.stringify({ time, level: lvl, scope, msg, meta })}\n`);
      } catch {
        // Logging must never take the process down.
      }
    }
  }

  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    child: (childScope) =>
      createLogger({ ...options, scope: `${scope}:${childScope}` }),
  };
}

function prepareLogFile(home: string): string {
  const dir = join(home, 'logs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  return join(dir, `rookery-${day}.log`);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** A logger that swallows everything - handy in tests and in piped CLI modes. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silentLogger,
};
