import { createHash } from 'node:crypto';
import { existsSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolServerAudience } from '../types.js';
import { EXTERNAL_KIND, readJsonFile, readTextFile } from './homes.js';

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
  /**
   * The plugin root, the parent of `skills/`, `agents/` and `hooks/`. Set for
   * a plugin only, and only because `--plugin-dir` needs exactly this path
   * when somebody trusts the plugin outright.
   */
  installPath?: string;
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

/**
 * A subagent type declared beside Claude Code's skills: one markdown file in
 * a plugin's `agents/` folder, frontmatter only. The prompt body is read when
 * the turn is assembled, the same way `openExternalSkill` leaves SKILL.md
 * closed until somebody opens it.
 */
export interface ExternalAgentRef {
  /** `<sourceId>/<name>`: unique even when two plugins pick the same name. */
  id: string;
  name: string;
  description: string;
  sourceId: string;
  /** The `.md` file, so the prompt body can be read at spawn time. */
  path: string;
  /** Frontmatter `model`, when the file names one. */
  model?: string;
  /** Frontmatter `tools`, split; empty means the provider's own default. */
  tools?: string[];
  /** Over name, description, model and tools, so a later edit is noticed. */
  fingerprint: string;
}

/**
 * The hook handlers one source declares in `hooks/hooks.json`. Kept as a set
 * rather than per handler: they are approved and shown together, because a
 * handler in isolation says nothing about what the file does around a turn.
 */
export interface ExternalHookSet {
  /** The source it belongs to; one set per source at most, so this is the id. */
  sourceId: string;
  /** The `hooks.json` file, read again when an approved set is used. */
  path: string;
  /** Event names it hooks, e.g. `PreToolUse`, `SessionStart`. */
  events: string[];
  /** How many handlers over all those events. */
  handlerCount: number;
  /**
   * One line per handler, `<event> <matcher>: <command>`. This is the whole
   * reason the approval exists: nobody can judge a hook set without reading
   * what it actually runs, so the lines travel to the page - and never back.
   */
  commands: string[];
  /** Over the whole declaration: an edited file deactivates its own approval. */
  fingerprint: string;
}

export interface ExternalScan {
  sources: ExternalSource[];
  skills: ExternalSkillRef[];
  servers: ExternalMcpServer[];
  /**
   * Subagent types found in the same plugin folders as the skills. Optional
   * only so a scanner that does not fill them yet still type-checks; read it
   * as `scan.agents ?? []` and treat absent as empty.
   */
  agents?: ExternalAgentRef[];
  /** Hook sets found there, at most one per source. Same rule as `agents`. */
  hooks?: ExternalHookSet[];
}

export const EMPTY_SCAN: ExternalScan = { sources: [], skills: [], servers: [], agents: [], hooks: [] };

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

/** A short hash over whatever decides identity; the one shape used everywhere. */
export function fingerprintOf(material: unknown): string {
  return createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 16);
}

/**
 * What an approval of a subagent is taken over: the fields the page shows and
 * the body whole. The body is the instructions the spawned subagent actually
 * runs under, so it is the one part that must not be able to change behind an
 * approval's back; a fingerprint over the frontmatter alone would leave the
 * one thing nobody re-reads as the one thing that is free to drift.
 */
const agentFingerprint = (name: string, description: string, model: string, tools: string[], text: string): string =>
  fingerprintOf([name, description, model, tools, text]);

/**
 * The subagent types in one `agents/` folder.
 *
 * The whole file is read here - not just the frontmatter window the skills
 * shelf gets away with - because the fingerprint above covers the body. One
 * plugin ships seventy of these at a few kilobytes each and the scan is
 * cached for minutes; the read is cheap next to approving instructions
 * nobody has seen since they changed.
 */
export function scanAgents(dir: string, sourceId: string): ExternalAgentRef[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const agents: ExternalAgentRef[] = [];
  for (const file of names) {
    if (!file.endsWith('.md')) continue;
    const stem = file.slice(0, -3);
    const text = readTextFile(join(dir, file));
    if (text === null) continue;
    const meta = frontmatter(text);
    // The frontmatter name wins, the file name stands in for a file that
    // forgot one; anything that is not a usable tool name is skipped rather
    // than handed to the CLI, which would only reject it later.
    const name = NAME.test(meta.name ?? '') ? (meta.name as string) : stem;
    if (!NAME.test(name)) continue;
    const tools = (meta.tools ?? '')
      .split(',')
      .map((tool) => tool.trim())
      .filter(Boolean);
    const description = meta.description ?? '';
    const model = meta.model ?? '';
    agents.push({
      id: sourceId + '/' + name,
      name,
      description,
      sourceId,
      path: join(dir, file),
      ...(model ? { model } : {}),
      ...(tools.length ? { tools } : {}),
      fingerprint: agentFingerprint(name, description, model, tools, text),
    });
  }
  return agents;
}

/** `hooks.json` as Claude Code writes it: events, each with matcher groups. */
interface HooksJson {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * The hook set one source declares, or null when it declares none.
 *
 * Both spellings appear: the documented `{ "hooks": { "PreToolUse": [...] } }`
 * and a bare `{ "PreToolUse": [...] }`. The handlers are flattened into the
 * command lines a person has to read before switching this on, and the
 * fingerprint covers exactly those lines - an edited `hooks.json` therefore
 * takes its own approval with it.
 */
export function readHookSet(dir: string, sourceId: string): ExternalHookSet | null {
  const path = join(dir, 'hooks.json');
  const doc = readHookDocument(path);
  if (!doc) return null;
  const { events, commands, handlerCount, fingerprint } = doc;
  return { sourceId, path, events, handlerCount, commands, fingerprint };
}

/**
 * One `hooks.json` read from disk: the event table exactly as the provider
 * wants it, and the fingerprint over the command lines inside it.
 *
 * Kept separate from `readHookSet` because the turn assembler reads the file
 * again at spawn time and compares this fingerprint with the approved one.
 * The scan is cached for minutes; without the second look, a file edited
 * inside that window would still be handed over under an old approval.
 */
export function readHookDocument(path: string): {
  table: Record<string, unknown>;
  events: string[];
  commands: string[];
  handlerCount: number;
  fingerprint: string;
} | null {
  const json = readJsonFile<HooksJson>(path);
  if (!json) return null;
  const source = (json.hooks && typeof json.hooks === 'object' ? json.hooks : json) as Record<string, unknown>;

  const table: Record<string, unknown> = {};
  const events: string[] = [];
  const commands: string[] = [];
  let handlerCount = 0;
  for (const [event, value] of Object.entries(source)) {
    // `$schema` and friends sit beside the events in the bare spelling.
    if (!Array.isArray(value) || event.startsWith('$')) continue;
    let seen = false;
    for (const group of value as Record<string, unknown>[]) {
      const matcher = typeof group?.matcher === 'string' && group.matcher ? group.matcher : '*';
      for (const handler of Array.isArray(group?.hooks) ? (group.hooks as Record<string, unknown>[]) : []) {
        const command = typeof handler?.command === 'string' ? handler.command : '';
        if (!command) continue;
        seen = true;
        handlerCount += 1;
        commands.push(event + ' ' + matcher + ': ' + command);
      }
    }
    if (!seen) continue;
    events.push(event);
    table[event] = value;
  }
  if (!handlerCount) return null;
  return { table, events, commands, handlerCount, fingerprint: fingerprintOf(commands) };
}

/**
 * One agent file read whole: the same reference the scan produces, plus the
 * prompt body under the frontmatter.
 *
 * This is the only place a body is read, and it happens while a turn is
 * being assembled - the same deal `openExternalSkill` strikes with SKILL.md.
 * The fingerprint comes back with it so the caller can check that what it is
 * about to hand over is still what somebody approved.
 */
export function readAgentFile(path: string, sourceId: string): { ref: ExternalAgentRef; prompt: string } | null {
  const text = readTextFile(path);
  if (text === null) return null;
  const stem = path.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/, '') ?? '';
  const meta = frontmatter(text);
  const name = NAME.test(meta.name ?? '') ? (meta.name as string) : stem;
  if (!NAME.test(name)) return null;
  const tools = (meta.tools ?? '')
    .split(',')
    .map((tool) => tool.trim())
    .filter(Boolean);
  const description = meta.description ?? '';
  const model = meta.model ?? '';
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return {
    ref: {
      id: sourceId + '/' + name,
      name,
      description,
      sourceId,
      path,
      ...(model ? { model } : {}),
      ...(tools.length ? { tools } : {}),
      // The same material the scan hashed, body included, so the caller's
      // comparison really is "still the approved file" and not "still the
      // approved name".
      fingerprint: agentFingerprint(name, description, model, tools, text),
    },
    prompt: (match ? text.slice(match[0].length) : text).trim(),
  };
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
