/**
 * `rookery config get|set` over dotted keys, e.g. `voice.lang`,
 * `memory.recallLimit`.
 *
 * A `set` is type-checked against the shape of the live config, so a typo
 * cannot quietly turn `memory.recallLimit` into the string "8".
 */

import { loadConfig, saveConfig } from '@rookery/core';
import type { RookeryConfig } from '@rookery/core';
import { glyph, theme } from '../ui/theme.js';
import { heading } from '../ui/render.js';
import { CliError, withAssistant } from './shared.js';

type Plain = Record<string, unknown>;

export interface ConfigOptions {
  json?: boolean;
}

export async function configCommand(
  action: string,
  key: string | undefined,
  value: string | undefined,
  options: ConfigOptions = {},
): Promise<number> {
  const verb = action.trim().toLowerCase();
  if (verb === 'get') return configGet(key, options);
  if (verb === 'set') return configSet(key, value, options);
  if (verb === 'path') return configPathCommand();
  throw new CliError('Unknown config action "' + action + '". Use `get`, `set` or `path`.');
}

function configGet(key: string | undefined, options: ConfigOptions): number {
  const config = loadConfig();

  if (!key) {
    if (options.json) {
      process.stdout.write(JSON.stringify(config, null, 2) + '\n');
      return 0;
    }
    process.stdout.write('\n' + heading('Config') + '\n');
    for (const [path, entry] of flatten(config as unknown as Plain)) {
      process.stdout.write(theme.dim(path.padEnd(24)) + format(entry) + '\n');
    }
    process.stdout.write('\n');
    return 0;
  }

  const current = readPath(config as unknown as Plain, key.split('.'));
  if (current === undefined) throw unknownKey(key, config);

  if (options.json) {
    process.stdout.write(JSON.stringify(current, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(format(current) + '\n');
  return 0;
}

function configSet(key: string | undefined, raw: string | undefined, options: ConfigOptions): number {
  if (!key) throw new CliError('Which key? e.g. `rookery config set voice.lang en-GB`');
  if (raw === undefined) throw new CliError('Which value? e.g. `rookery config set voice.lang en-GB`');

  const config = loadConfig();
  const parts = key.split('.');
  const current = readPath(config as unknown as Plain, parts);
  if (current === undefined) throw unknownKey(key, config);
  if (isPlainObject(current)) {
    throw new CliError(
      '"' + key + '" is a group, not a value. Try one of: ' +
        Object.keys(current).map((child) => key + '.' + child).join(', '),
    );
  }

  const coerced = coerce(raw, current, key);
  const patch: Plain = {};
  writePath(patch, parts, coerced);

  const next = saveConfig(patch as Partial<RookeryConfig>);
  const stored = readPath(next as unknown as Plain, parts);

  if (options.json) {
    process.stdout.write(JSON.stringify({ key, value: stored }, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(
    theme.green(glyph.ok + ' ') + theme.dim(key + ' = ') + format(stored) + '\n',
  );
  return 0;
}

async function configPathCommand(): Promise<number> {
  return withAssistant((assistant) => {
    process.stdout.write(assistant.config.home + '\n');
    return 0;
  });
}

/* ------------------------------ helpers ------------------------------ */

function coerce(raw: string, current: unknown, key: string): unknown {
  if (typeof current === 'number') {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new CliError(key + ' expects a number, got "' + raw + '".');
    return parsed;
  }
  if (typeof current === 'boolean') {
    const lower = raw.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(lower)) return true;
    if (['false', '0', 'no', 'off'].includes(lower)) return false;
    throw new CliError(key + ' expects true or false, got "' + raw + '".');
  }
  if (Array.isArray(current)) {
    return raw.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return raw;
}

function readPath(source: Plain, parts: string[]): unknown {
  let node: unknown = source;
  for (const part of parts) {
    if (!isPlainObject(node)) return undefined;
    node = node[part];
  }
  return node;
}

function writePath(target: Plain, parts: string[], value: unknown): void {
  let node = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index] as string;
    const child = node[part];
    if (!isPlainObject(child)) {
      const created: Plain = {};
      node[part] = created;
      node = created;
    } else {
      node = child;
    }
  }
  node[parts[parts.length - 1] as string] = value;
}

function flatten(source: Plain, prefix = ''): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? prefix + '.' + key : key;
    if (isPlainObject(value)) out.push(...flatten(value, path));
    else out.push([path, value]);
  }
  return out;
}

function isPlainObject(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function format(value: unknown): string {
  if (value === undefined || value === null) return theme.dim('(unset)');
  if (typeof value === 'string') return value === '' ? theme.dim('(empty)') : theme.ivory(value);
  if (typeof value === 'boolean') return value ? theme.green('true') : theme.yellow('false');
  if (typeof value === 'number') return theme.cyan(String(value));
  return theme.ivory(JSON.stringify(value));
}

function unknownKey(key: string, config: RookeryConfig): CliError {
  const known = flatten(config as unknown as Plain)
    .map(([path]) => path)
    .filter((path) => path.startsWith(key.split('.')[0] ?? ''));
  const hint = known.length ? ' Did you mean: ' + known.slice(0, 6).join(', ') + '?' : '';
  return new CliError(
    'Unknown config key "' + key + '".' + hint + ' Run `rookery config get` to list them all.',
  );
}
