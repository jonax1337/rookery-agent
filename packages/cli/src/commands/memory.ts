/**
 * The memory bank as a set of commands: inspect it, add to it, search it the
 * same way a turn does, and forget things.
 */

import { recall } from '@rookery/core';
import type { MemoryKind } from '@rookery/core';
import { glyph, theme } from '../ui/theme.js';
import { heading, keyValue, memoryLine, relativeTime, shorten } from '../ui/render.js';
import {
  CliError,
  parseImportance,
  parseKind,
  parseLimit,
  parseTags,
  resolveMemoryId,
  withAssistant,
} from './shared.js';

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
    const kinds: MemoryKind[] = kind ? [kind] : [];
    const memories = assistant.store.listMemories({
      kinds,
      limit,
      includeForgotten: options.all ?? false,
    });

    if (options.json) {
      process.stdout.write(JSON.stringify(memories, null, 2) + '\n');
      return 0;
    }

    if (!memories.length) {
      process.stdout.write(theme.dim('No memories yet. Add one with `rookery memory add "..."`.') + '\n');
      return 0;
    }

    process.stdout.write('\n' + heading('Memories') + theme.dim('  (' + memories.length + ')') + '\n\n');
    for (const memory of memories) {
      const flag = memory.forgotten ? theme.dim(' [forgotten]') : '';
      process.stdout.write(memoryLine(memory) + flag + '\n');
    }
    process.stdout.write('\n');
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
      process.stdout.write(JSON.stringify(record, null, 2) + '\n');
      return 0;
    }

    process.stdout.write(theme.green(glyph.ok + ' Remembered') + '\n');
    process.stdout.write(memoryLine(record) + '\n');
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

    const hits = recall(assistant.store, {
      text: query,
      limit,
      kinds: kind ? [kind] : undefined,
      threshold,
      // Inspection should not inflate the usage signal it is inspecting.
      touch: false,
    });

    if (options.json) {
      process.stdout.write(JSON.stringify(hits, null, 2) + '\n');
      return 0;
    }

    if (!hits.length) {
      process.stdout.write(theme.dim('Nothing recalled for "' + shorten(query, 60) + '".') + '\n');
      return 0;
    }

    process.stdout.write('\n' + heading('Recall') + theme.dim('  "' + shorten(query, 60) + '"') + '\n\n');
    for (const hit of hits) process.stdout.write(memoryLine(hit) + '\n');
    process.stdout.write('\n');
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
      process.stdout.write(
        theme.green(glyph.ok + ' Deleted permanently: ') + theme.dim(shorten(memory.content, 70)) + '\n',
      );
    } else {
      assistant.store.forgetMemory(resolved);
      process.stdout.write(
        theme.green(glyph.ok + ' Forgotten (recoverable): ') + theme.dim(shorten(memory.content, 70)) + '\n',
      );
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
      process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
      return 0;
    }

    process.stdout.write('\n' + heading('Memory') + '\n');
    process.stdout.write(keyValue('active', String(stats.total)) + '\n');
    process.stdout.write(keyValue('forgotten', String(stats.forgotten)) + '\n');
    for (const [kind, count] of Object.entries(stats.byKind).sort((a, b) => b[1] - a[1])) {
      process.stdout.write(keyValue('  ' + kind, String(count)) + '\n');
    }

    if (recent.length) {
      process.stdout.write('\n' + heading('Top by importance') + '\n');
      for (const memory of recent) {
        process.stdout.write(
          theme.dim(memory.importance.toFixed(2) + '  ') +
            theme.ivory(shorten(memory.content, 74)) +
            theme.dim('  ' + relativeTime(memory.updatedAt)) +
            '\n',
        );
      }
    }
    process.stdout.write('\n');
    return 0;
  });
}
