import { createHash } from 'node:crypto';
import { existsSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolServerAudience } from '../types.js';
import { EXTERNAL_KIND } from './homes.js';

/**
 * The shapes the reader produces, and the two jobs it does: pick the skills
 * out of a folder, and turn Claude Code's MCP declaration into something
 * Rookery can start.
 */

/** One shelf of skills: Claude Code's own skills folder, or one plugin's. */
export interface ExternalSource {
  /** `claude-code:home`, `claude-code:plugin/ecc@ecc`, and so on. */
  id: string;
  /** What a person reads on the page: "Claude Code", "Claude Code - ecc". */
  label: string;
  origin: 'home' | 'plugin';
  /** The plugin key as Claude Code names it, when this is a plugin. */
  plugin?: string;
  /** The folder holding one directory per skill. */
  dir: string;
  skillCount: number;
}

/** A skill sitting in the Claude Code installation. Read, never written. */
export interface ExternalSkillRef {
  /** `<sourceId>/<name>`: unique even when two plugins pick the same name. */
  id: string;
  name: string;
  description: string;
  sourceId: string;
  /** The skill folder, so `use_skill` can read the body and list the files. */
  path: string;
  audience: ToolServerAudience;
}

/** An MCP server declared by Claude Code or by one of its plugins. */
export interface ExternalMcpServer {
  /** `ext-claude-code-projectatlas`: stable across scans, safe as a tool id. */
  id: string;
  /** The name Claude Code uses; tools arrive as `mcp__<name>__<tool>`. */
  name: string;
  sourceId: string;
  /** Where it came from, for the badge on the page. */
  label: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /**
   * Set for a server Claude Code keeps under one project path in
   * `~/.claude.json`; it only belongs to turns in that directory.
   */
  projectPath?: string;
  /** Over the start definition, so a later edit is noticed. See `hub.ts`. */
  fingerprint: string;
}

export interface ExternalScan {
  sources: ExternalSource[];
  skills: ExternalSkillRef[];
  servers: ExternalMcpServer[];
}

export const EMPTY_SCAN: ExternalScan = { sources: [], skills: [], servers: [] };

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Enough of a SKILL.md to hold the frontmatter; the body is read on demand. */
const FRONTMATTER_BYTES = 8 * 1024;

function readHead(path: string): string {
  let handle: number;
  try {
    handle = openSync(path, 'r');
  } catch {
    return '';
  }
  try {
    const buffer = Buffer.alloc(FRONTMATTER_BYTES);
    const read = readSync(handle, buffer, 0, FRONTMATTER_BYTES, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    closeSync(handle);
  }
}

function frontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    // A wrapped description continues on the next line; only real keys count.
    if (colon === -1 || /^\s/.test(line)) continue;
    meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
  }
  return meta;
}

function asAudience(value: string | undefined): ToolServerAudience {
  return value === 'agents' || value === 'assistant' ? value : 'both';
}

/**
 * The skills in one folder, frontmatter only.
 *
 * A single enabled plugin can hold three hundred of them, so this never
 * touches a body: the name and the one-line description are all the shelf
 * and the search need, and `use_skill` reads the rest when it is asked for.
 */
export function scanSkills(dir: string, sourceId: string): ExternalSkillRef[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const skills: ExternalSkillRef[] = [];
  for (const name of names) {
    if (!NAME.test(name)) continue;
    const folder = join(dir, name);
    const file = join(folder, 'SKILL.md');
    if (!existsSync(file)) continue;
    const meta = frontmatter(readHead(file));
    skills.push({
      id: sourceId + '/' + name,
      name,
      description: meta.description ?? '',
      sourceId,
      path: folder,
      audience: asAudience(meta.audience),
    });
  }
  return skills;
}

/** A source for a skills folder, or null when there is nothing in it. */
export function skillSource(
  source: Omit<ExternalSource, 'skillCount'>,
  skills: ExternalSkillRef[],
): ExternalSource | null {
  return skills.length ? { ...source, skillCount: skills.length } : null;
}

/** A short hash over what would be started, so a later edit is noticed. */
export function fingerprintServer(
  server: Pick<ExternalMcpServer, 'transport' | 'args' | 'env'> &
    Partial<Pick<ExternalMcpServer, 'command' | 'url' | 'headers'>>,
): string {
  const material = JSON.stringify([
    server.transport,
    server.command ?? '',
    server.args,
    Object.entries(server.env).sort(),
    server.url ?? '',
    Object.keys(server.headers ?? {}).sort(),
  ]);
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

const slug = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** A tool-server id that survives a rescan and cannot collide with the catalogue. */
export function externalServerId(name: string, scope?: string): string {
  return ['ext', EXTERNAL_KIND, scope ? slug(scope) : '', slug(name)].filter(Boolean).join('-');
}

/** The `mcpServers` shape Claude Code writes in JSON, plus its HTTP variant. */
export interface McpServerJson {
  type?: string;
  command?: string;
  args?: unknown;
  env?: Record<string, unknown>;
  url?: string;
  headers?: Record<string, unknown>;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const stringMap = (value: Record<string, unknown> | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value ?? {})) if (typeof item === 'string') out[key] = item;
  return out;
};

/**
 * One declaration into an `ExternalMcpServer`, or null when it says nothing
 * startable. Both transports appear in the wild: a plugin like `context7`
 * ships a hosted HTTP endpoint, `projectatlas` a local executable.
 */
export function toExternalServer(
  name: string,
  json: McpServerJson,
  context: { sourceId: string; label: string; scope?: string; projectPath?: string },
): ExternalMcpServer | null {
  const declared = typeof json.type === 'string' ? json.type.toLowerCase() : '';
  const http = declared === 'http' || declared === 'streamable-http' || (!json.command && Boolean(json.url));
  const transport: ExternalMcpServer['transport'] = declared === 'sse' ? 'sse' : http ? 'http' : 'stdio';

  const base: Pick<ExternalMcpServer, 'name' | 'transport' | 'args' | 'env'> &
    Partial<Pick<ExternalMcpServer, 'command' | 'url' | 'headers' | 'projectPath'>> = {
    name,
    transport,
    args: strings(json.args),
    env: stringMap(json.env),
  };
  if (transport === 'stdio') base.command = json.command;
  else {
    base.url = json.url;
    base.headers = stringMap(json.headers);
  }
  if (context.projectPath) base.projectPath = context.projectPath;
  if (transport === 'stdio' ? !base.command : !base.url) return null;

  return {
    ...base,
    id: externalServerId(name, context.scope),
    sourceId: context.sourceId,
    label: context.label,
    fingerprint: fingerprintServer(base),
  };
}
