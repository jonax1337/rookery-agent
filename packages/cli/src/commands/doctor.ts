/**
 * `rookery doctor` - is this machine actually able to run the assistant?
 *
 * Exits 1 when no provider is logged in, and prints the exact command that
 * fixes it, because "no provider is ready" is the one failure a new user will
 * definitely hit.
 */

import { existsSync, statSync } from 'node:fs';
import { databasePath } from '@rookery/core';
import type { ProviderStatus } from '@rookery/core';
import { glyph, theme } from '../ui/theme.js';
import { heading, keyValue } from '../ui/render.js';
import { describeSpeech } from '../ui/speech.js';
import { withAssistant } from './shared.js';

/** The command that gets a logged-out provider logged in. */
const LOGIN_HINT: Record<string, string> = {
  claude: 'run `claude`, then type `/login`',
  codex: 'run `codex login`',
};

/**
 * The command that gets a missing binary installed.
 *
 * One entry, because every provider runs on the same binary - the id only
 * says what that process is pointed at. A provider that reports its binary
 * missing is missing this one.
 */
const INSTALL_HINT = 'npm i -g @anthropic-ai/claude-code';

export interface DoctorOptions {
  json?: boolean;
}

export async function doctorCommand(options: DoctorOptions = {}): Promise<number> {
  return withAssistant(async (assistant) => {
    const statuses = await assistant.providers.statuses(true);
    const dbPath = databasePath(assistant.config);
    const stats = assistant.store.memoryStats();
    const sessions = assistant.store.listSessions({ limit: 1000, includeArchived: true });
    const speech = await describeSpeech();
    const ready = statuses.filter((s) => s.available && s.authenticated);

    if (options.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: ready.length > 0,
            providers: statuses,
            home: assistant.config.home,
            workspace: assistant.config.workspace,
            database: { path: dbPath, exists: existsSync(dbPath), bytes: fileSize(dbPath) },
            memory: stats,
            sessions: sessions.length,
            speech,
            defaults: {
              provider: assistant.config.defaultProvider,
              model: assistant.config.defaultModel ?? null,
              permission: assistant.config.defaultPermission,
            },
          },
          null,
          2,
        ) + '\n',
      );
      return ready.length ? 0 : 1;
    }

    const out = process.stdout;
    out.write('\n' + heading('Rookery doctor') + '\n\n');

    out.write(heading('Providers') + '\n');
    for (const status of statuses) {
      out.write(providerBlock(status));
    }
    out.write('\n');

    out.write(heading('Storage') + '\n');
    out.write(keyValue('home', assistant.config.home) + '\n');
    // The assistant's own provider process always runs here, never in the
    // directory Rookery happened to be started from.
    out.write(
      keyValue(
        'workspace',
        assistant.config.workspace +
          (existsSync(assistant.config.workspace) ? '' : theme.yellow('  (not created yet)')),
      ) + '\n',
    );
    out.write(
      keyValue(
        'database',
        dbPath + (existsSync(dbPath) ? theme.dim('  (' + formatBytes(fileSize(dbPath)) + ')') : theme.yellow('  (not created yet)')),
      ) + '\n',
    );
    out.write(keyValue('sessions', String(sessions.length)) + '\n');
    out.write(
      keyValue(
        'memories',
        String(stats.total) +
          (stats.forgotten ? theme.dim('  +' + stats.forgotten + ' forgotten') : '') +
          (Object.keys(stats.byKind).length
            ? theme.dim(
                '  [' +
                  Object.entries(stats.byKind)
                    .map(([kind, count]) => kind + ' ' + count)
                    .join(', ') +
                  ']',
              )
            : ''),
      ) + '\n',
    );
    out.write('\n');

    out.write(heading('Defaults') + '\n');
    out.write(keyValue('provider', assistant.config.defaultProvider) + '\n');
    out.write(keyValue('model', assistant.config.defaultModel ?? theme.dim('provider default')) + '\n');
    out.write(keyValue('permission', assistant.config.defaultPermission) + '\n');
    out.write(keyValue('memory recall', String(assistant.config.memory.recallLimit) + ' per turn') + '\n');
    out.write(keyValue('voice lang', assistant.config.voice.lang) + '\n');
    out.write(keyValue('speech', speech) + '\n');
    out.write('\n');

    if (!ready.length) {
      out.write(theme.red(glyph.fail + ' No AI provider is logged in. Rookery cannot answer anything yet.') + '\n\n');
      for (const status of statuses) {
        const fix = status.available
          ? LOGIN_HINT[status.id] ?? 'log in to ' + status.id
          : 'install it: ' + INSTALL_HINT;
        out.write('  ' + theme.amber(status.id) + '  ' + fix + '\n');
      }
      out.write('\n');
      return 1;
    }

    out.write(
      theme.green(glyph.ok + ' Ready via ' + ready.map((status) => status.id).join(' + ')) + '\n\n',
    );
    return 0;
  });
}

function providerBlock(status: ProviderStatus): string {
  const mark = status.available && status.authenticated
    ? theme.green(glyph.ok)
    : status.available
      ? theme.yellow(glyph.warn)
      : theme.red(glyph.fail);

  const state = status.available
    ? status.authenticated
      ? theme.green('authenticated')
      : theme.yellow('logged out')
    : theme.red('not installed');

  const lines: string[] = [];
  lines.push('  ' + mark + ' ' + theme.amberBold(status.id.padEnd(8)) + state);
  lines.push('    ' + keyValue('binary', status.binary || theme.dim('not found'), 14));
  lines.push('    ' + keyValue('version', status.version ?? theme.dim('unknown'), 14));
  if (status.detail) lines.push('    ' + keyValue('detail', theme.dim(status.detail), 14));
  if (status.available && !status.authenticated) {
    lines.push('    ' + keyValue('fix', theme.amber(LOGIN_HINT[status.id] ?? 'log in'), 14));
  }
  if (!status.available) {
    lines.push('    ' + keyValue('fix', theme.amber(INSTALL_HINT), 14));
  }
  return lines.join('\n') + '\n';
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
