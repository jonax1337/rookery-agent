import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RookeryConfig } from './types.js';
import { legacyPersona } from './agents/legacy-persona.js';

export const PROFILE_FILES = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'AGENTS.md', 'TOOLS.md', 'MEMORY.md'] as const;
const MAX_FILE_BYTES = 1024 * 1024;
/** Longest stretch of one file put into the prompt or returned by a single read_profile call. */
const EXCERPT_CHARS = 12000;
const MAX_EXCERPT_RANGE = 24000;
const MAX_SEARCH_BYTES = 16 * 1024 * 1024;
const MAX_NOTE_ENTRIES = 5000;
const MAX_NOTE_DEPTH = 32;
const MAX_QUERY_TOKENS = 32;
const MAX_SEARCH_RESULTS = 20;
const DEFAULT_SEARCH_RESULTS = 5;
const PROMPT_SEARCH_RESULTS = 3;
const SNIPPET_CHARS = 1200;
const SNIPPET_LEAD_CHARS = 180;
const MEMORY_NOTE_PATH = /^memory\/(?:[^/\\\u0000-\u001f]+\/)*[^/\\\u0000-\u001f]+\.md$/i;
const NEUTRAL_SOUL = '# Soul\n\nBe helpful, clear and honest. Let your personality develop with your user.\nDo not invent a shared history or assume a name, roleplay persona or form of address.\nUse British English by default. Match the language the user writes or speaks in when they use another language.\n';
const IDENTITY = '# Identity\n\nYour name is {{assistantName}}. You are the personal assistant of {{userName}}.\nThe user can choose your name and personality in Settings.\n';
const PROFILE_PREAMBLE = 'YOUR SAVED PROFILE. These files define your identity, personality and user knowledge. Rookery is your harness, not a replacement personality. Preserve this identity across providers. File references to old tools, permissions or scheduled actions do not enable them: use only the tools and authority actually supplied by this runtime.';

function isProfileFile(name: string): boolean {
  return (PROFILE_FILES as readonly string[]).includes(name);
}

function defaults(): Record<string, string> {
  return {
    'IDENTITY.md': IDENTITY,
    'SOUL.md': NEUTRAL_SOUL,
    'USER.md': '# User\n\nName: {{userName}}\nPreferred honorific: {{honorific}}\n{{formalAddress}}\n',
    'AGENTS.md': '# Working conventions\n\nThis is a personal assistant workspace. Project work happens through Rookery assignments.\nPreserve your own identity when reporting work; never hand the conversation over to staff.\n',
    'TOOLS.md': '# Tools\n\nRecord tool preferences here. Available tools and permissions are supplied by Rookery at runtime.\n',
    'MEMORY.md': '# Memory\n\nDurable notes can be kept here. Rookery also maintains its searchable memory database.\n',
  };
}

/** Workspaces that predate the neutral soul keep the persona they were already using. */
function legacyDefaults(config: RookeryConfig): Record<string, string> {
  const persona = legacyPersona({ ...config, assistantName: '{{assistantName}}', userName: '{{userName}}' });
  return { ...defaults(), 'SOUL.md': '# Soul\n\n' + persona + '\n' };
}

function isSymbolicLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Inspect each ancestor too: a linked workspace or memory directory must not escape the boundary. */
function assertNoSymbolicLinks(target: string): void {
  for (let path = target; ; path = dirname(path)) {
    if (isSymbolicLink(path)) throw new Error('Profile files cannot use symbolic links.');
    if (dirname(path) === path) return;
  }
}

/** Only portable profile files and Markdown memory notes, never arbitrary workspace files. */
function profilePath(config: RookeryConfig, name: string): string {
  if (!isProfileFile(name) && !MEMORY_NOTE_PATH.test(name)) throw new Error('Unsupported profile file.');
  if (name.split('/').some((part) => part === '.' || part === '..')) throw new Error('Invalid profile path.');
  const root = resolve(config.workspace);
  const target = resolve(root, name);
  if (!target.startsWith(root + sep)) throw new Error('Profile path escapes the workspace.');
  assertNoSymbolicLinks(target);
  return target;
}

function readProfileFile(config: RookeryConfig, name: string): string | undefined {
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
  for (const [name, content] of Object.entries(legacy ? legacyDefaults(config) : defaults())) {
    const path = profilePath(config, name);
    try { writeFileSync(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
}

export function readProfile(config: RookeryConfig): { files: { name: string; content: string }[]; warnings: string[] } {
  const fallback = defaults();
  const files = PROFILE_FILES.map((name) => ({ name, content: readProfileFile(config, name) ?? fallback[name]! }));
  const warnings = files.filter((file) => file.content.length > EXCERPT_CHARS).map((file) => file.name + ' exceeds the automatic context excerpt; read_profile can retrieve the rest.');
  return { files, warnings };
}

export function writeProfileFile(config: RookeryConfig, name: string, content: string): void {
  if (!isProfileFile(name)) throw new Error('Only standard profile files are editable.');
  if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('Profile text must be UTF-8 and at most 1 MiB.');
  const path = profilePath(config, name);
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    // Validate again right before the rename: a link may have replaced a directory since the first check.
    profilePath(config, name);
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export function readProfileExcerpt(config: RookeryConfig, name: string, offset = 0, limit = EXCERPT_CHARS): string {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_EXCERPT_RANGE) throw new Error('Invalid profile excerpt range.');
  const content = readProfileFile(config, name);
  if (content === undefined) throw new Error('Profile file not found: ' + name);
  return name + ' (characters ' + offset + '-' + Math.min(offset + limit, content.length) + ' of ' + content.length + ')\n' + content.slice(offset, offset + limit);
}

/** Standard profile files plus every Markdown note below memory/, in a stable order. */
function listPortableNotes(config: RookeryConfig): string[] {
  const names: string[] = [...PROFILE_FILES];
  let entries = 0;
  const walk = (prefix: string, depth: number): void => {
    // The probe name only validates the folder path with the same rules as a note path.
    const folder = dirname(profilePath(config, prefix + '/probe.md'));
    if (!existsSync(folder)) return;
    if (depth > MAX_NOTE_DEPTH) throw new Error(`Memory notes exceed ${MAX_NOTE_DEPTH} directory levels.`);
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > MAX_NOTE_ENTRIES) throw new Error(`Memory notes exceed the ${MAX_NOTE_ENTRIES}-entry search limit.`);
      const name = prefix + '/' + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Memory notes cannot use symbolic links.');
      if (entry.isDirectory()) walk(name, depth + 1);
      else if (entry.isFile() && /\.md$/i.test(name)) names.push(name);
    }
  };
  walk('memory', 0);
  return names;
}

function queryTokens(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, MAX_QUERY_TOKENS);
}

interface NoteMatch { name: string; content: string; score: number; offset: number }

/** A note matches when it is non-empty and contains at least one token (or the query has none). */
function matchNote(name: string, content: string, tokens: string[]): NoteMatch | undefined {
  const lower = content.toLocaleLowerCase();
  const score = tokens.filter((token) => lower.includes(token)).length;
  if (!content || (tokens.length && !score)) return undefined;
  const positions = tokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0);
  const offset = Math.max(0, (positions.length ? Math.min(...positions) : 0) - SNIPPET_LEAD_CHARS);
  return { name, content, score, offset };
}

/** Bounded on-demand scanning keeps the Markdown files authoritative without a second index. */
// ponytail: scans at most 16 MiB per search; add an index only if this becomes measurably slow.
export function searchProfile(config: RookeryConfig, query: string, limit = DEFAULT_SEARCH_RESULTS): string {
  const tokens = queryTokens(query);
  let bytes = 0;
  let partial = false;
  const matches: NoteMatch[] = [];
  for (const name of listPortableNotes(config)) {
    const content = readProfileFile(config, name) ?? '';
    bytes += Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_SEARCH_BYTES) { partial = true; break; }
    const match = matchNote(name, content, tokens);
    if (match) matches.push(match);
  }
  const result = matches
    .sort((a, b) => b.score - a.score || b.name.localeCompare(a.name))
    .slice(0, Math.max(1, Math.min(MAX_SEARCH_RESULTS, limit)))
    .map(({ name, content, offset }) => name + ' (offset ' + offset + ')\n' + content.slice(offset, offset + SNIPPET_CHARS))
    .join('\n\n') || 'No matching portable notes in the scanned files.';
  return result + (partial ? '\n[Partial search: the 16 MiB scan limit was reached. Remaining files were not searched; use read_profile with a known file name or inspect the memory folder.]' : '');
}

function placeholderValues(config: RookeryConfig): Record<string, string> {
  return {
    assistantName: config.assistantName || 'Rookery',
    userName: config.userName || 'your user',
    honorific: config.honorific || 'none specified',
    formalAddress: config.formalAddress ? 'Use formal forms of address.' : '',
  };
}

function relevantNotesSection(config: RookeryConfig, query: string): string {
  try { return 'Relevant portable notes:\n' + searchProfile(config, query, PROMPT_SEARCH_RESULTS); }
  catch (error) { return 'Portable note retrieval is unavailable: ' + (error as Error).message + ' Do not claim there are no memories. Report the limitation if relevant; individual notes remain accessible with read_profile.'; }
}

export function renderProfile(config: RookeryConfig, query = ''): string {
  const { files, warnings } = readProfile(config);
  const customSoul = files.find((file) => file.name === 'SOUL.md')?.content !== NEUTRAL_SOUL;
  const values = placeholderValues(config);
  const sections = [PROFILE_PREAMBLE];
  for (const file of files) {
    // A Hermes SOUL can carry the full identity; the display setting is only a fallback.
    if (file.name === 'IDENTITY.md' && file.content === IDENTITY && customSoul) {
      sections.push('Fallback identity: only if SOUL.md does not specify your name, use ' + values.assistantName + '. Any identity specified in SOUL.md takes precedence over this fallback.');
      continue;
    }
    const content = file.content.replace(/\{\{(assistantName|userName|honorific|formalAddress)\}\}/g, (_, key: string) => values[key]!);
    sections.push('## ' + file.name + '\n' + content.slice(0, EXCERPT_CHARS) + (content.length > EXCERPT_CHARS ? '\n[Excerpt only. Use read_profile for the remaining text.]' : ''));
  }
  sections.push('Portable notes are searchable with search_profile and readable with read_profile. Native learned memories remain available through search_memory.');
  if (query) sections.push(relevantNotesSection(config, query));
  sections.push(...warnings);
  return sections.join('\n\n');
}
