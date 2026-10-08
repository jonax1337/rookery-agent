/**
 * `rookery doctor` - is this machine actually able to run the assistant?
 *
 * Exits 1 when no provider is logged in, and prints the exact command that
 * fixes it, because "no provider is ready" is the one failure a new user will
 * definitely hit.
 */

import { existsSync, statSync } from 'node:fs';
import { databasePath } from '@rookery/core';
import type { Assistant, ProviderStatus } from '@rookery/core';
import { glyph, theme } from '../ui/theme.js';
import { heading, keyValue, providerHealth, providerMark } from '../ui/render.js';
import type { ProviderHealth } from '../ui/render.js';
import { describeSpeech } from '../ui/speech.js';
import { printJson, withAssistant } from './shared.js';

const out = process.stdout;
const PROVIDER_FIELD_WIDTH = 14;

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

/** The slice of the memory statistics the report prints. */
interface MemoryStats {
  total: number;
  forgotten: number;
  byKind: Record<string, number>;
}

interface DoctorFacts {
  assistant: Assistant;
  statuses: ProviderStatus[];
  ready: ProviderStatus[];
  databaseFile: string;
  memoryStats: MemoryStats;
  sessionCount: number;
  speech: string;
}

export async function doctorCommand(options: DoctorOptions = {}): Promise<number> {
  return withAssistant(async (assistant) => {
    const facts = await gatherFacts(assistant);
    if (options.json) printJson(jsonReport(facts));
    else printReport(facts);
    return facts.ready.length ? 0 : 1;
  });
}

async function gatherFacts(assistant: Assistant): Promise<DoctorFacts> {
  const statuses = await assistant.providers.statuses(true);
  const databaseFile = databasePath(assistant.config);
  const memoryStats = assistant.store.memoryStats();
  const sessionCount = assistant.store.listSessions({ limit: 1000, includeArchived: true }).length;
  const speech = await describeSpeech();
  const ready = statuses.filter((status) => status.available && status.authenticated);
  return { assistant, statuses, ready, databaseFile, memoryStats, sessionCount, speech };
}

function jsonReport(facts: DoctorFacts): object {
  const { assistant, databaseFile } = facts;
  return {
    ok: facts.ready.length > 0,
    providers: facts.statuses,
    home: assistant.config.home,
    workspace: assistant.config.workspace,
    database: { path: databaseFile, exists: existsSync(databaseFile), bytes: fileSize(databaseFile) },
    memory: facts.memoryStats,
    sessions: facts.sessionCount,
    speech: facts.speech,
    defaults: {
      provider: assistant.config.defaultProvider,
      model: assistant.config.defaultModel ?? null,
      permission: assistant.config.defaultPermission,
    },
  };
}

function printReport(facts: DoctorFacts): void {
  out.write('\n' + heading('Rookery doctor') + '\n\n');
  printProviders(facts.statuses);
  printStorage(facts);
  printDefaults(facts);
  printVerdict(facts);
}

function printProviders(statuses: ProviderStatus[]): void {
  out.write(heading('Providers') + '\n');
  for (const status of statuses) {
    out.write(providerBlock(status));
  }
  out.write('\n');
}

function printStorage({ assistant, databaseFile, memoryStats, sessionCount }: DoctorFacts): void {
  const { config } = assistant;
  const notCreatedYet = theme.yellow('  (not created yet)');

  out.write(heading('Storage') + '\n');
  out.write(keyValue('home', config.home) + '\n');
  // The assistant's own provider process always runs here, never in the
  // directory Rookery happened to be started from.
  out.write(keyValue('workspace', config.workspace + (existsSync(config.workspace) ? '' : notCreatedYet)) + '\n');
  out.write(
    keyValue(
      'database',
      databaseFile +
        (existsSync(databaseFile) ? theme.dim('  (' + formatBytes(fileSize(databaseFile)) + ')') : notCreatedYet),
    ) + '\n',
  );
  out.write(keyValue('sessions', String(sessionCount)) + '\n');
  out.write(keyValue('memories', memoriesSummary(memoryStats)) + '\n');
  out.write('\n');
}

function memoriesSummary(stats: MemoryStats): string {
  const kinds = Object.entries(stats.byKind)
    .map(([kind, count]) => kind + ' ' + count)
    .join(', ');
  return (
    String(stats.total) +
    (stats.forgotten ? theme.dim('  +' + stats.forgotten + ' forgotten') : '') +
    (kinds ? theme.dim('  [' + kinds + ']') : '')
  );
}

function printDefaults({ assistant, speech }: DoctorFacts): void {
  const { config } = assistant;
  out.write(heading('Defaults') + '\n');
  out.write(keyValue('provider', config.defaultProvider) + '\n');
  out.write(keyValue('model', config.defaultModel ?? theme.dim('provider default')) + '\n');
  out.write(keyValue('permission', config.defaultPermission) + '\n');
  out.write(keyValue('memory recall', String(config.memory.recallLimit) + ' per turn') + '\n');
  out.write(keyValue('voice lang', config.voice.lang) + '\n');
  out.write(keyValue('speech', speech) + '\n');
  out.write('\n');
}

function printVerdict({ statuses, ready }: DoctorFacts): void {
  if (ready.length) {
    out.write(theme.green(glyph.ok + ' Ready via ' + ready.map((status) => status.id).join(' + ')) + '\n\n');
    return;
  }

  out.write(theme.red(glyph.fail + ' No AI provider is logged in. Rookery cannot answer anything yet.') + '\n\n');
  for (const status of statuses) {
    const fix = status.available
      ? LOGIN_HINT[status.id] ?? 'log in to ' + status.id
      : 'install it: ' + INSTALL_HINT;
    out.write('  ' + theme.accent(status.id) + '  ' + fix + '\n');
  }
  out.write('\n');
}

const PROVIDER_STATE: Record<ProviderHealth, string> = {
  ok: theme.green('authenticated'),
  warn: theme.yellow('logged out'),
  fail: theme.red('not installed'),
};

function providerBlock(status: ProviderStatus): string {
  const field = (key: string, value: string): string =>
    '    ' + keyValue(key, value, PROVIDER_FIELD_WIDTH);

  const lines: string[] = [
    '  ' + providerMark(status) + ' ' + theme.accentBold(status.id.padEnd(8)) + PROVIDER_STATE[providerHealth(status)],
    field('binary', status.binary || theme.dim('not found')),
    field('version', status.version ?? theme.dim('unknown')),
  ];
  if (status.detail) lines.push(field('detail', theme.dim(status.detail)));
  if (status.available && !status.authenticated) {
    lines.push(field('fix', theme.accent(LOGIN_HINT[status.id] ?? 'log in')));
  }
  if (!status.available) lines.push(field('fix', theme.accent(INSTALL_HINT)));
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
