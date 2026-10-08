/**
 * The memory bank as a set of commands: inspect it, add to it, search it the
 * same way a turn does, and forget things.
 */

import { glyph, theme } from '../ui/theme.js';
import { heading, keyValue, listHeader, memoryLine, relativeTime, shorten } from '../ui/render.js';
import {
  CliError,
  inspectMemories,
  parseImportance,
  parseKind,
  parseLimit,
  parseTags,
  printJson,
  resolveMemoryId,
  withAssistant,
} from './shared.js';

const out = process.stdout;

export interface MemoryListOptions {
  kind?: string;
  limit?: string;
  json?: boolean;
  all?: boolean;
}

export async function memoryListCommand(options: MemoryListOptions = {}): Promise<number> {
  return withAssistant((assistant) => {
    const kind = parseKind(options.kind);
    const limit = parseLimit(options.limit, 30);
    const memories = assistant.store.listMemories({
      kinds: kind ? [kind] : [],
      limit,
      includeForgotten: options.all ?? false,
    });

    if (options.json) {
      printJson(memories);
      return 0;
    }

    if (!memories.length) {
      out.write(theme.dim('No memories yet. Add one with `rookery memory add "..."`.') + '\n');
      return 0;
    }

    out.write(listHeader('Memories', memories.length));
    for (const memory of memories) {
      const flag = memory.forgotten ? theme.dim(' [forgotten]') : '';
      out.write(memoryLine(memory) + flag + '\n');
    }
    out.write('\n');
    return 0;
  });
}

export interface MemoryAddOptions {
  kind?: string;
  tags?: string;
  importance?: string;
  json?: boolean;
}

export async function memoryAddCommand(
  textParts: string[],
  options: MemoryAddOptions = {},
): Promise<number> {
  const content = textParts.join(' ').trim();
  if (!content) throw new CliError('A memory needs some text.');

  return withAssistant((assistant) => {
    const record = assistant.rememberFact({
      content,
      kind: parseKind(options.kind) ?? 'fact',
      tags: parseTags(options.tags),
      importance: parseImportance(options.importance),
    });

    if (options.json) {
      printJson(record);
      return 0;
    }

    out.write(theme.green(glyph.ok + ' Remembered') + '\n');
    out.write(memoryLine(record) + '\n');
    return 0;
  });
}

export interface MemorySearchOptions {
  kind?: string;
  limit?: string;
  json?: boolean;
  threshold?: string;
}

export async function memorySearchCommand(
  queryParts: string[],
  options: MemorySearchOptions = {},
): Promise<number> {
  const query = queryParts.join(' ').trim();
  if (!query) throw new CliError('Give me something to search for.');

  return withAssistant((assistant) => {
    const kind = parseKind(options.kind);
    const limit = parseLimit(options.limit, 10);
    const threshold = options.threshold === undefined ? 0 : Number(options.threshold);
    if (!Number.isFinite(threshold)) throw new CliError('--threshold must be a number.');

    const hits = inspectMemories(assistant, {
      text: query,
      limit,
      kinds: kind ? [kind] : undefined,
      threshold,
    });

    if (options.json) {
      printJson(hits);
      return 0;
    }

    if (!hits.length) {
      out.write(theme.dim('Nothing recalled for "' + shorten(query, 60) + '".') + '\n');
      return 0;
    }

    out.write('\n' + heading('Recall') + theme.dim('  "' + shorten(query, 60) + '"') + '\n\n');
    for (const hit of hits) out.write(memoryLine(hit) + '\n');
    out.write('\n');
    return 0;
  });
}

export interface MemoryForgetOptions {
  hard?: boolean;
}

export async function memoryForgetCommand(
  id: string,
  options: MemoryForgetOptions = {},
): Promise<number> {
  return withAssistant((assistant) => {
    const resolved = resolveMemoryId(assistant, id);
    const memory = assistant.store.getMemory(resolved);
    if (!memory) throw new CliError('No memory with id ' + id + '.');

    if (options.hard) {
      assistant.store.deleteMemory(resolved);
      out.write(theme.green(glyph.ok + ' Deleted permanently: ') + theme.dim(shorten(memory.content, 70)) + '\n');
    } else {
      assistant.store.forgetMemory(resolved);
      out.write(theme.green(glyph.ok + ' Forgotten (recoverable): ') + theme.dim(shorten(memory.content, 70)) + '\n');
    }
    return 0;
  });
}

export interface MemoryStatsOptions {
  json?: boolean;
}

export async function memoryStatsCommand(options: MemoryStatsOptions = {}): Promise<number> {
  return withAssistant((assistant) => {
    const stats = assistant.store.memoryStats();
    const recent = assistant.store.listMemories({ limit: 5 });

    if (options.json) {
      printJson(stats);
      return 0;
    }

    out.write('\n' + heading('Memory') + '\n');
    out.write(keyValue('active', String(stats.total)) + '\n');
    out.write(keyValue('forgotten', String(stats.forgotten)) + '\n');
    for (const [kind, count] of Object.entries(stats.byKind).sort((a, b) => b[1] - a[1])) {
      out.write(keyValue('  ' + kind, String(count)) + '\n');
    }

    if (recent.length) {
      out.write('\n' + heading('Top by importance') + '\n');
      for (const memory of recent) {
        out.write(
          theme.dim(memory.importance.toFixed(2) + '  ') +
            theme.frost(shorten(memory.content, 74)) +
            theme.dim('  ' + relativeTime(memory.updatedAt)) +
            '\n',
        );
      }
    }
    out.write('\n');
    return 0;
  });
}
