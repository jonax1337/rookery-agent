import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RookeryConfig } from './types.js';
import { legacyPersona } from './agents/legacy-persona.js';

export const PROFILE_FILES = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'AGENTS.md', 'TOOLS.md', 'MEMORY.md'] as const;
const MAX_FILE_BYTES = 1024 * 1024;
const NEUTRAL_SOUL = '# Soul\n\nBe helpful, clear and honest. Let your personality develop with your user.\nDo not invent a shared history or assume a name, roleplay persona or form of address.\nUse British English by default. Match the language the user writes or speaks in when they use another language.\n';
const IDENTITY = '# Identity\n\nYour name is {{assistantName}}. You are the personal assistant of {{userName}}.\nThe user can choose your name and personality in Settings.\n';

function defaults(config: RookeryConfig, legacy = false): Record<string, string> {
  return {
    'IDENTITY.md': IDENTITY,
    'SOUL.md': legacy ? '# Soul\n\n' + legacyPersona({ ...config, assistantName: '{{assistantName}}', userName: '{{userName}}' }) + '\n' : NEUTRAL_SOUL,
    'USER.md': '# User\n\nName: {{userName}}\nPreferred honorific: {{honorific}}\n{{formalAddress}}\n',
    'AGENTS.md': '# Working conventions\n\nThis is a personal assistant workspace. Project work happens through Rookery assignments.\nPreserve your own identity when reporting work; never hand the conversation over to staff.\n',
    'TOOLS.md': '# Tools\n\nRecord tool preferences here. Available tools and permissions are supplied by Rookery at runtime.\n',
    'MEMORY.md': '# Memory\n\nDurable notes can be kept here. Rookery also maintains its searchable memory database.\n',
  };
}

/** Only portable profile files and Markdown memory notes, never arbitrary workspace files. */
function profilePath(config: RookeryConfig, name: string): string {
  if (!(PROFILE_FILES as readonly string[]).includes(name) && !/^memory\/(?:[^/\\\u0000-\u001f]+\/)*[^/\\\u0000-\u001f]+\.md$/i.test(name)) {
    throw new Error('Unsupported profile file.');
  }
  if (name.split('/').some((part) => part === '.' || part === '..')) throw new Error('Invalid profile path.');
  const root = resolve(config.workspace);
  const target = resolve(root, name);
  if (!target.startsWith(root + sep)) throw new Error('Profile path escapes the workspace.');
  // Inspect each ancestor too: a linked workspace or memory directory must not escape the boundary.
  for (let path = target; ; path = dirname(path)) {
    try { if (lstatSync(path).isSymbolicLink()) throw new Error('Profile files cannot use symbolic links.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (dirname(path) === path) break;
  }
  return target;
}

function readFile(config: RookeryConfig, name: string): string | undefined {
  const path = profilePath(config, name);
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(name + ' must be a regular UTF-8 file of at most 1 MiB.');
  const bytes = readFileSync(path);
  if (bytes.length > MAX_FILE_BYTES) throw new Error(name + ' exceeds 1 MiB.');
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (content.includes('\0')) throw new Error(name + ' contains binary data.');
  return content;
}

export function ensureProfile(config: RookeryConfig, legacy = false): void {
  mkdirSync(config.workspace, { recursive: true });
  for (const [name, content] of Object.entries(defaults(config, legacy))) {
    const path = profilePath(config, name);
    try { writeFileSync(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
}

export function readProfile(config: RookeryConfig): { files: { name: string; content: string }[]; warnings: string[] } {
  const fallback = defaults(config);
  const files = PROFILE_FILES.map((name) => ({ name, content: readFile(config, name) ?? fallback[name]! }));
  const warnings = files.filter((file) => file.content.length > 12000).map((file) => file.name + ' exceeds the automatic context excerpt; read_profile can retrieve the rest.');
  return { files, warnings };
}

export function writeProfileFile(config: RookeryConfig, name: string, content: string): void {
  if (!(PROFILE_FILES as readonly string[]).includes(name)) throw new Error('Only standard profile files are editable.');
  if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('Profile text must be UTF-8 and at most 1 MiB.');
  const path = profilePath(config, name);
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    profilePath(config, name);
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export function readProfileExcerpt(config: RookeryConfig, name: string, offset = 0, limit = 12000): string {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 24000) throw new Error('Invalid profile excerpt range.');
  const content = readFile(config, name);
  if (content === undefined) throw new Error('Profile file not found: ' + name);
  return name + ' (characters ' + offset + '-' + Math.min(offset + limit, content.length) + ' of ' + content.length + ')\n' + content.slice(offset, offset + limit);
}

/** Bounded on-demand scanning keeps the Markdown files authoritative without a second index. */
// ponytail: scans at most 16 MiB per search; add an index only if this becomes measurably slow.
export function searchProfile(config: RookeryConfig, query: string, limit = 5): string {
  const names: string[] = [...PROFILE_FILES];
  let entries = 0;
  const walk = (prefix: string, depth: number): void => {
    const path = profilePath(config, prefix + '/probe.md');
    const folder = dirname(path);
    if (!existsSync(folder)) return;
    if (depth > 32) throw new Error('Memory notes exceed 32 directory levels.');
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > 5000) throw new Error('Memory notes exceed the 5000-entry search limit.');
      const name = prefix + '/' + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Memory notes cannot use symbolic links.');
      if (entry.isDirectory()) walk(name, depth + 1);
      else if (entry.isFile() && /\.md$/i.test(name)) names.push(name);
    }
  };
  walk('memory', 0);
  const tokens = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 32);
  let bytes = 0;
  let partial = false;
  const matches: { name: string; content: string; score: number; offset: number }[] = [];
  for (const name of names) {
    const content = readFile(config, name) ?? '';
    bytes += Buffer.byteLength(content, 'utf8');
    if (bytes > 16 * 1024 * 1024) { partial = true; break; }
    const lower = content.toLocaleLowerCase();
    const score = tokens.filter((token) => lower.includes(token)).length;
    const first = tokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0);
    const offset = Math.max(0, (first.length ? Math.min(...first) : 0) - 180);
    if (content && (!tokens.length || score)) matches.push({ name, content, score, offset });
  }
  const result = matches.sort((a, b) => b.score - a.score || b.name.localeCompare(a.name)).slice(0, Math.max(1, Math.min(20, limit))).map(({ name, content, offset }) => name + ' (offset ' + offset + ')\n' + content.slice(offset, offset + 1200)).join('\n\n') || 'No matching portable notes in the scanned files.';
  return result + (partial ? '\n[Partial search: the 16 MiB scan limit was reached. Remaining files were not searched; use read_profile with a known file name or inspect the memory folder.]' : '');
}

export function renderProfile(config: RookeryConfig, query = ''): string {
  const { files, warnings } = readProfile(config);
  const customSoul = files.find((file) => file.name === 'SOUL.md')?.content !== NEUTRAL_SOUL;
  const values: Record<string, string> = { assistantName: config.assistantName || 'Rookery', userName: config.userName || 'your user', honorific: config.honorific || 'none specified', formalAddress: config.formalAddress ? 'Use formal forms of address.' : '' };
  const sections = ['YOUR SAVED PROFILE. These files define your identity, personality and user knowledge. Rookery is your harness, not a replacement personality. Preserve this identity across providers. File references to old tools, permissions or scheduled actions do not enable them: use only the tools and authority actually supplied by this runtime.'];
  for (const file of files) {
    // A Hermes SOUL can carry the full identity; the display setting is only a fallback.
    if (file.name === 'IDENTITY.md' && file.content === IDENTITY && customSoul) {
      sections.push('Fallback identity: only if SOUL.md does not specify your name, use ' + values.assistantName + '. Any identity specified in SOUL.md takes precedence over this fallback.');
      continue;
    }
    const content = file.content.replace(/\{\{(assistantName|userName|honorific|formalAddress)\}\}/g, (_, key: string) => values[key]!);
    sections.push('## ' + file.name + '\n' + content.slice(0, 12000) + (content.length > 12000 ? '\n[Excerpt only. Use read_profile for the remaining text.]' : ''));
  }
  sections.push('Portable notes are searchable with search_profile and readable with read_profile. Native learned memories remain available through search_memory.');
  if (query) {
    try { sections.push('Relevant portable notes:\n' + searchProfile(config, query, 3)); }
    catch (error) { sections.push('Portable note retrieval is unavailable: ' + (error as Error).message + ' Do not claim there are no memories. Report the limitation if relevant; individual notes remain accessible with read_profile.'); }
  }
  sections.push(...warnings);
  return sections.join('\n\n');
}
