/**
 * `rookery serve` - run the HTTP/WS server as a child process.
 *
 * The child inherits stdio, so its logs are the terminal's logs, and it is
 * killed on every exit path here: no orphaned servers holding port 4317.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@rookery/core';
import { glyph, theme } from '../ui/theme.js';
import { CliError } from './shared.js';

export interface ServeOptions {
  port?: string;
  host?: string;
  open?: boolean;
}

/** Where the built server entry can plausibly live. */
function serverEntryCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url)); // packages/cli/dist/commands
  return [
    resolve(here, '../../../server/dist/main.js'),
    resolve(here, '../../../../packages/server/dist/main.js'),
    resolve(process.cwd(), 'packages/server/dist/main.js'),
  ];
}

export async function serveCommand(options: ServeOptions = {}): Promise<number> {
  const entry = serverEntryCandidates().find((candidate) => existsSync(candidate));
  if (!entry) {
    throw new CliError(
      'The Rookery server is not built yet (packages/server/dist/main.js is missing).\n' +
        '  Run `npm run build` in the repository root first, then try again.',
    );
  }

  const config = loadConfig();
  const port = options.port ?? String(config.port);
  const host = options.host ?? config.host;
  if (!/^\d+$/.test(port)) throw new CliError('--port must be a number, got "' + port + '".');

  const url = 'http://' + (host === '0.0.0.0' ? 'localhost' : host) + ':' + port;

  process.stdout.write(theme.dim(glyph.dot + ' starting server ' + entry) + '\n');
  process.stdout.write(theme.accent(glyph.bullet + ' ' + url) + '\n');

  const child = spawn(process.execPath, [entry], {
    stdio: 'inherit',
    env: { ...process.env, ROOKERY_PORT: port, ROOKERY_HOST: host },
  });

  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  };
  const onSigint = (): void => stop('SIGINT');
  const onSigterm = (): void => stop('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('exit', () => stop('SIGTERM'));

  if (options.open) {
    // Give the server a moment to bind before handing the URL to a browser.
    const timer = setTimeout(() => openBrowser(url), 1200);
    timer.unref?.();
  }

  try {
    return await new Promise<number>((resolveExit) => {
      child.on('error', (error: Error) => {
        process.stderr.write(theme.red(glyph.fail + ' ' + error.message) + '\n');
        resolveExit(1);
      });
      child.on('close', (code, signal) => {
        if (signal) resolveExit(0);
        else resolveExit(code ?? 0);
      });
    });
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    stop('SIGTERM');
  }
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command as string, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => {
      process.stderr.write(theme.dim('Could not open a browser. Visit ' + url) + '\n');
    });
    child.unref();
  } catch {
    process.stderr.write(theme.dim('Could not open a browser. Visit ' + url) + '\n');
  }
}
