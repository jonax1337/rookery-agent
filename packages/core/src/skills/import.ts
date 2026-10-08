import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { SkillStore, skillSlug, type Skill } from './store.js';

/**
 * Importing skills from GitHub.
 *
 * The SKILL.md folder format is the open Agent Skills standard, so any skill
 * published on GitHub - Anthropic's own collection, the skills.sh registry,
 * a colleague's repo - drops straight into `<home>/skills`. A source is
 * `owner/repo`, `owner/repo/path/to/skill`, or a github.com URL; when the
 * path holds several skills instead of one, the candidates come back so the
 * user can pick.
 */

export interface SkillSource {
  owner: string;
  repo: string;
  ref?: string;
  path: string;
}

export interface SkillSourceEntry {
  /** What to type into the import box. */
  source: string;
  name: string;
  description: string;
  /** Scripts inside need a shell; only agents with permission `full` can run them. */
  needsShell: boolean;
}

/** A hand-picked shelf: Anthropic's public skills, one line each in English. */
export const SKILL_SOURCES: SkillSourceEntry[] = [
  { source: 'anthropics/skills/skills/pdf', name: 'PDF', description: 'Read, merge and split PDFs, fill forms and run OCR.', needsShell: true },
  { source: 'anthropics/skills/skills/docx', name: 'Word (docx)', description: 'Create, read and edit Word documents with formatting.', needsShell: true },
  { source: 'anthropics/skills/skills/xlsx', name: 'Excel (xlsx)', description: 'Create and analyse spreadsheets with formulas, formatting and charts.', needsShell: true },
  { source: 'anthropics/skills/skills/pptx', name: 'PowerPoint (pptx)', description: 'Create and edit presentations.', needsShell: true },
  { source: 'anthropics/skills/skills/frontend-design', name: 'Frontend design', description: 'Build interfaces with distinctive designs.', needsShell: false },
  { source: 'anthropics/skills/skills/webapp-testing', name: 'Web app testing', description: 'Navigate and test web applications with Playwright.', needsShell: true },
  { source: 'anthropics/skills/skills/mcp-builder', name: 'Build MCP servers', description: 'Design custom MCP servers following the protocol.', needsShell: false },
  { source: 'anthropics/skills/skills/skill-creator', name: 'Write skills', description: 'Guidance on structuring and testing effective skills.', needsShell: false },
  { source: 'DietrichGebert/ponytail/skills/ponytail', name: 'Ponytail', description: 'Write less code: check what already exists, then use the smallest solution. A summary is already in the agent prompt.', needsShell: false },
  { source: 'anthropics/skills/skills/doc-coauthoring', name: 'Co-author documents', description: 'Develop longer documents together with the user.', needsShell: false },
  { source: 'anthropics/skills/skills/canvas-design', name: 'Canvas design', description: 'Posters, graphics and visual designs.', needsShell: false },
];

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 80;
const LISTING_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** `owner/repo[/path]` or a github.com URL to its parts. */
export function parseSkillSource(source: string): SkillSource {
  const text = source.trim().replace(/\/+$/, '');
  const url = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.*))?)?$/.exec(text);
  if (url) {
    return { owner: url[1] as string, repo: (url[2] as string).replace(/\.git$/, ''), ref: url[3], path: url[4] ?? '' };
  }
  const parts = text.split('/').filter(Boolean);
  if (parts.length < 2 || text.includes(':')) throw new Error('Enter a source as owner/repo, owner/repo/path or a GitHub URL.');
  return { owner: parts[0] as string, repo: parts[1] as string, path: parts.slice(2).join('/') };
}

interface Entry {
  name: string;
  path: string;
  type: 'file' | 'dir' | string;
  size?: number;
  download_url?: string | null;
}

async function listContents(source: SkillSource, path: string): Promise<Entry[]> {
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  const url =
    'https://api.github.com/repos/' + source.owner + '/' + source.repo + '/contents/' + path.split('/').map(encodeURIComponent).join('/') +
    (source.ref ? '?ref=' + encodeURIComponent(source.ref) : '');
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'rookery-agent',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
  });
  if (response.status === 404) throw new Error('Not found on GitHub: ' + source.owner + '/' + source.repo + (path ? '/' + path : '') + '.');
  if (response.status === 403) throw new Error('GitHub denied access (possibly rate limited). Set GITHUB_TOKEN in the environment for a higher limit.');
  if (!response.ok) throw new Error('GitHub returned ' + response.status + '.');
  const body = (await response.json()) as Entry[] | Entry;
  return Array.isArray(body) ? body : [body];
}

async function download(entry: Entry): Promise<Buffer> {
  if (!entry.download_url) throw new Error('No download for ' + entry.path + '.');
  const response = await fetch(entry.download_url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error('Download of ' + entry.path + ' failed (' + response.status + ').');
  return Buffer.from(await response.arrayBuffer());
}

export type ImportResult = { skill: Skill } | { candidates: string[] };

/**
 * Fetch one skill folder into the store. When the path holds several skill
 * folders (a collection like `anthropics/skills/skills`), nothing is written
 * and the candidates are returned instead.
 */
export async function importSkillFromGitHub(store: SkillStore, sourceText: string): Promise<ImportResult> {
  const source = parseSkillSource(sourceText);
  const entries = await listContents(source, source.path);
  if (!entries.some((entry) => entry.type === 'file' && entry.name === 'SKILL.md')) {
    return { candidates: await skillCandidates(source, entries) };
  }

  const files = await collectFiles(source, entries);
  const prefix = source.path ? source.path + '/' : '';
  const skillFile = files.find((entry) => entry.path === prefix + 'SKILL.md');
  if (!skillFile) throw new Error('SKILL.md is missing.');
  const skillText = (await download(skillFile)).toString('utf8');
  const declared = /^---[\s\S]*?^name:\s*(.+?)\s*$/m.exec(skillText)?.[1];
  const name = skillSlug(declared ?? source.path.split('/').pop() ?? source.repo);
  if (!name) throw new Error('The skill has no usable name.');

  const folder = resolve(store.dirs[0] as string, name);
  const staged = await stageFiles(folder, prefix, files, skillFile, skillText);
  writeFolder(folder, staged);
  const skill = store.get(name);
  if (!skill) throw new Error('The skill could not be read after downloading.');
  return { skill };
}

/** A collection rather than a skill: offer what is inside, one level deep. */
async function skillCandidates(source: SkillSource, entries: Entry[]): Promise<string[]> {
  const dirs = entries.filter((entry) => entry.type === 'dir');
  const nested = dirs.find((dir) => dir.name === 'skills');
  if (nested) {
    const inside = await listContents(source, nested.path);
    return inside.filter((entry) => entry.type === 'dir').map((entry) => qualified(source, entry));
  }
  if (!dirs.length) throw new Error('There is no SKILL.md under ' + (source.path || 'the repository root') + '.');
  return dirs.map((dir) => qualified(source, dir));
}

function qualified(source: SkillSource, dir: Entry): string {
  return source.owner + '/' + source.repo + '/' + dir.path;
}

/** Walk the folder breadth first and keep the files small enough to take. */
async function collectFiles(source: SkillSource, entries: Entry[]): Promise<Entry[]> {
  const files: Entry[] = [];
  const queue = [...entries];
  while (queue.length) {
    const entry = queue.shift() as Entry;
    if (entry.type === 'dir') queue.push(...(await listContents(source, entry.path)));
    else if (entry.type === 'file' && (entry.size ?? 0) <= MAX_FILE_BYTES) files.push(entry);
    if (files.length > MAX_FILES) throw new Error('The skill contains more than ' + MAX_FILES + ' files; this is not a skill folder.');
  }
  return files;
}

interface StagedFile {
  target: string;
  data: Buffer;
}

/** Download everything before anything on disk is touched; entries escaping the folder are dropped. */
async function stageFiles(folder: string, prefix: string, files: Entry[], skillFile: Entry, skillText: string): Promise<StagedFile[]> {
  const staged: StagedFile[] = [{ target: join(folder, 'SKILL.md'), data: Buffer.from(skillText, 'utf8') }];
  for (const entry of files) {
    if (entry === skillFile) continue;
    const relative = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.name;
    const target = resolve(folder, relative);
    if (!target.startsWith(folder + sep)) continue;
    staged.push({ target, data: await download(entry) });
  }
  return staged;
}

/** Replace the folder in one go. */
function writeFolder(folder: string, staged: StagedFile[]): void {
  if (existsSync(folder)) rmSync(folder, { recursive: true, force: true });
  for (const item of staged) {
    mkdirSync(dirname(item.target), { recursive: true });
    writeFileSync(item.target, item.data);
  }
}
