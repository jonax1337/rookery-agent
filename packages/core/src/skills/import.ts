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

/** A hand-picked shelf: Anthropic's public skills, one line each in German. */
export const SKILL_SOURCES: SkillSourceEntry[] = [
  { source: 'anthropics/skills/skills/pdf', name: 'PDF', description: 'PDFs lesen, zusammenführen, teilen, Formulare ausfüllen, OCR.', needsShell: true },
  { source: 'anthropics/skills/skills/docx', name: 'Word (docx)', description: 'Word-Dokumente anlegen, lesen und bearbeiten, mit Formatierung.', needsShell: true },
  { source: 'anthropics/skills/skills/xlsx', name: 'Excel (xlsx)', description: 'Tabellen mit Formeln, Formatierung und Diagrammen erzeugen und auswerten.', needsShell: true },
  { source: 'anthropics/skills/skills/pptx', name: 'PowerPoint (pptx)', description: 'Präsentationen anlegen und bearbeiten.', needsShell: true },
  { source: 'anthropics/skills/skills/frontend-design', name: 'Frontend-Design', description: 'Oberflächen mit eigenständigem, nicht generischem Design bauen.', needsShell: false },
  { source: 'anthropics/skills/skills/webapp-testing', name: 'Web-App testen', description: 'Web-Anwendungen mit Playwright durchklicken und prüfen.', needsShell: true },
  { source: 'anthropics/skills/skills/mcp-builder', name: 'MCP-Server bauen', description: 'Eigene MCP-Server nach den Regeln des Protokolls entwerfen.', needsShell: false },
  { source: 'anthropics/skills/skills/skill-creator', name: 'Skills schreiben', description: 'Anleitung, wie gute Skills aufgebaut und getestet werden.', needsShell: false },
  { source: 'anthropics/skills/skills/doc-coauthoring', name: 'Dokumente mitschreiben', description: 'Längere Texte gemeinsam mit dem Nutzer entwickeln.', needsShell: false },
  { source: 'anthropics/skills/skills/canvas-design', name: 'Canvas-Design', description: 'Poster, Grafiken und visuelle Entwürfe.', needsShell: false },
];

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 80;

/** `owner/repo[/path]` or a github.com URL to its parts. */
export function parseSkillSource(source: string): SkillSource {
  const text = source.trim().replace(/\/+$/, '');
  const url = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.*))?)?$/.exec(text);
  if (url) {
    return { owner: url[1] as string, repo: (url[2] as string).replace(/\.git$/, ''), ref: url[3], path: url[4] ?? '' };
  }
  const parts = text.split('/').filter(Boolean);
  if (parts.length < 2 || text.includes(':')) throw new Error('Quelle bitte als owner/repo, owner/repo/pfad oder GitHub-URL.');
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
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) throw new Error('Nicht gefunden auf GitHub: ' + source.owner + '/' + source.repo + (path ? '/' + path : '') + '.');
  if (response.status === 403) throw new Error('GitHub verweigert (Rate-Limit?). Mit GITHUB_TOKEN in der Umgebung geht mehr.');
  if (!response.ok) throw new Error('GitHub antwortet ' + response.status + '.');
  const body = (await response.json()) as Entry[] | Entry;
  return Array.isArray(body) ? body : [body];
}

async function download(entry: Entry): Promise<Buffer> {
  if (!entry.download_url) throw new Error('Kein Download für ' + entry.path + '.');
  const response = await fetch(entry.download_url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error('Download von ' + entry.path + ' schlug fehl (' + response.status + ').');
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
  let entries = await listContents(source, source.path);

  // A collection rather than a skill: offer what is inside, one level deep.
  if (!entries.some((entry) => entry.type === 'file' && entry.name === 'SKILL.md')) {
    const dirs = entries.filter((entry) => entry.type === 'dir');
    const nested = dirs.find((dir) => dir.name === 'skills');
    if (nested) {
      entries = await listContents(source, nested.path);
      return { candidates: entries.filter((e) => e.type === 'dir').map((e) => source.owner + '/' + source.repo + '/' + e.path) };
    }
    if (!dirs.length) throw new Error('Unter ' + (source.path || 'dem Repo-Stamm') + ' liegt keine SKILL.md.');
    return { candidates: dirs.map((dir) => source.owner + '/' + source.repo + '/' + dir.path) };
  }

  // Walk the folder, files first, small directories after.
  const files: Entry[] = [];
  const queue: Entry[] = entries;
  while (queue.length) {
    const entry = queue.shift() as Entry;
    if (entry.type === 'dir') {
      if (files.length > MAX_FILES) break;
      queue.push(...(await listContents(source, entry.path)));
    } else if (entry.type === 'file' && (entry.size ?? 0) <= MAX_FILE_BYTES) {
      files.push(entry);
    }
    if (files.length > MAX_FILES) throw new Error('Der Skill hat mehr als ' + MAX_FILES + ' Dateien; das ist kein Skill-Ordner.');
  }

  const skillFile = files.find((entry) => entry.path === (source.path ? source.path + '/' : '') + 'SKILL.md');
  if (!skillFile) throw new Error('SKILL.md fehlt.');
  const skillText = (await download(skillFile)).toString('utf8');
  const declared = /^---[\s\S]*?^name:\s*(.+?)\s*$/m.exec(skillText)?.[1];
  const name = skillSlug(declared ?? source.path.split('/').pop() ?? source.repo);
  if (!name) throw new Error('Der Skill hat keinen brauchbaren Namen.');

  const folder = resolve(store.dir, name);
  const prefix = source.path ? source.path + '/' : '';
  const staged: { target: string; data: Buffer }[] = [{ target: join(folder, 'SKILL.md'), data: Buffer.from(skillText, 'utf8') }];
  for (const entry of files) {
    if (entry === skillFile) continue;
    const relative = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.name;
    const target = resolve(folder, relative);
    if (!target.startsWith(folder + sep)) continue;
    staged.push({ target, data: await download(entry) });
  }

  // Everything is downloaded; replace the folder in one go.
  if (existsSync(folder)) rmSync(folder, { recursive: true, force: true });
  for (const item of staged) {
    mkdirSync(dirname(item.target), { recursive: true });
    writeFileSync(item.target, item.data);
  }
  const skill = store.get(name);
  if (!skill) throw new Error('Der Skill konnte nach dem Download nicht gelesen werden.');
  return { skill };
}
