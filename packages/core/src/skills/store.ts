import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolServerAudience } from '../types.js';
import { builtinSkill, builtinSkills, isBuiltinSkill } from './builtin.js';

/**
 * Skills: written instructions the assistant and its agents can pull in on
 * demand. One folder per skill under `<home>/skills`, a `SKILL.md` with a
 * small frontmatter, any other files alongside it.
 *
 * Rookery renders skills itself rather than leaning on a provider's own
 * skill loading: the assistant runs with its system prompt replaced and
 * without user settings, so none of it would reach the process. The prompt
 * carries an index (name and description); `use_skill` returns the body.
 *
 * Below every directory sits the shelf Rookery ships with (`builtin.ts`):
 * present from the first start, read-only, and shadowed by a folder of the
 * same name.
 *
 * A `SkillStore` can hold more than one directory - the home skills plus, for
 * an agent working in a project, that project's own `<project>/.claude/skills`
 * (see `projectSkillsDir`). Directories are read in order and a later one
 * wins on a name clash, so the project always overrides the home skill of
 * the same name. This is read-only: `save`/`remove` always write to the
 * first directory, so an agent's job never writes a skill into a project.
 * The same read - never a native provider mechanism - is why this is
 * identical whatever backend a turn runs on: the process only ever sees the
 * rendered prompt text, never the directories themselves.
 */

/**
 * Who wrote a skill.
 *
 * `user` covers everything a person put there - the skill editor, an import
 * from GitHub, a folder dropped in by hand. `agent` is a skill the assistant
 * or one of its agents wrote with `write_skill` while working, `sleep` one the
 * night distilled out of what the memory kept repeating. `builtin` is the
 * handful Rookery ships with (see `builtin.ts`): no folder on disk, and
 * nothing may write to them.
 *
 * The distinction earns its keep in one place above all: nothing written
 * unattended may overwrite what a person wrote, or what Rookery shipped.
 * See `save`.
 */
export type SkillOrigin = 'user' | 'agent' | 'sleep' | 'builtin';

export interface Skill {
  name: string;
  description: string;
  audience: ToolServerAudience;
  body: string;
  /** Who wrote it. Anything that does not say counts as the user's. */
  origin: SkillOrigin;
  /** Other files in the folder, relative names. */
  files: string[];
  path: string;
  updatedAt: number;
  /**
   * Set only for a skill read out of the Claude Code installation:
   * the label of the source it came from. Rookery's own skills leave it
   * unset, and nothing carrying it may be written to.
   */
  source?: string;
}

export interface SkillInput {
  name: string;
  description: string;
  audience?: ToolServerAudience;
  body: string;
  origin?: SkillOrigin;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function skillSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** The frontmatter block and the body; a file without frontmatter is all body. */
function parse(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: (match[2] ?? '').trim() };
}

function asAudience(value: string | undefined): ToolServerAudience {
  return value === 'agents' || value === 'assistant' ? value : 'both';
}

/**
 * `builtin` is deliberately not accepted here: it says "this text came out of
 * Rookery's own dist", which a file on disk cannot be however its frontmatter
 * is worded. Anything else unrecognised stays the user's.
 */
function asOrigin(value: string | undefined): SkillOrigin {
  return value === 'agent' || value === 'sleep' ? value : 'user';
}

/**
 * One skill folder, read from disk.
 *
 * Standalone rather than a method because the folder format is the open
 * Agent Skills standard: the same read serves Rookery's own shelf and a
 * folder sitting in somebody's Claude Code installation, which is
 * what `skills/shelf.ts` opens. Null when there is no `SKILL.md` there.
 */
export function readSkillFolder(dir: string, name: string): Skill | null {
  if (!NAME.test(name)) return null;
  const folder = join(dir, name);
  const file = join(folder, 'SKILL.md');
  if (!existsSync(file)) return null;
  const { meta, body } = parse(readFileSync(file, 'utf8'));
  const files = readdirSync(folder).filter((entry) => entry !== 'SKILL.md');
  return {
    name,
    description: meta.description ?? '',
    audience: asAudience(meta.audience),
    origin: asOrigin(meta.origin),
    body,
    files,
    path: folder,
    updatedAt: statSync(file).mtimeMs,
  };
}

export class SkillStore {
  readonly dirs: readonly string[];

  constructor(dirs: string | string[]) {
    this.dirs = Array.isArray(dirs) ? dirs : [dirs];
  }

  list(): Skill[] {
    const byName = new Map<string, Skill>();
    // The lowest shelf, below every directory: what Rookery ships is there
    // from the first start, and a folder of the same name takes over from it.
    for (const skill of builtinSkills()) byName.set(skill.name, skill);
    for (const dir of this.dirs) {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        const skill = this.#read(dir, name);
        if (skill) byName.set(name, skill);
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Skill | null {
    if (!NAME.test(name)) return null;
    let found: Skill | null = builtinSkill(name);
    for (const dir of this.dirs) {
      const skill = this.#read(dir, name);
      if (skill) found = skill;
    }
    return found;
  }

  #read(dir: string, name: string): Skill | null {
    return readSkillFolder(dir, name);
  }

  /** Always the first directory: an agent's job never writes a skill into a project. */
  save(input: SkillInput): Skill {
    const name = skillSlug(input.name);
    if (!NAME.test(name)) throw new Error('A skill needs a name of letters, digits and dashes.');
    if (!input.description.trim()) throw new Error('A skill needs a one-line description.');
    if (!input.body.trim()) throw new Error('A skill needs instructions to follow.');

    const origin = asOrigin(input.origin);
    // A skill the user wrote is theirs. An agent working at three in the
    // afternoon, or the night distilling one at half past three in the
    // morning, may add to the shelf and may revise its own work - it may not
    // quietly rewrite a procedure a person put there.
    if (origin !== 'user') {
      // Shipped skills are the same case as the user's, one step further: a
      // person can put their own version over one of them in the editor, but
      // an unattended write must not quietly shadow what Rookery delivers.
      if (isBuiltinSkill(name)) {
        throw new Error('The skill "' + name + '" ships with Rookery and is not yours to change.');
      }
      // The home directory only - the one being written to. A project skill
      // of the same name shadows this one when read, but it is not what is
      // about to be overwritten.
      const existing = this.#read(this.dirs[0] as string, name);
      if (existing && existing.origin === 'user') {
        throw new Error('The skill "' + name + '" was written by the user and is not yours to change.');
      }
    }

    const folder = join(this.dirs[0] as string, name);
    mkdirSync(folder, { recursive: true });
    const text =
      '---\n' +
      'name: ' + name + '\n' +
      'description: ' + input.description.trim().replace(/\s+/g, ' ') + '\n' +
      'audience: ' + asAudience(input.audience) + '\n' +
      'origin: ' + origin + '\n' +
      '---\n\n' +
      input.body.trim() + '\n';
    writeFileSync(join(folder, 'SKILL.md'), text, 'utf8');
    return this.get(name) as Skill;
  }

  /**
   * The file exactly as it reads, unparsed.
   *
   * `get` returns a skill with the frontmatter already interpreted, which is
   * lossy: an unknown key, a comment, the exact spacing - all gone. A
   * snapshot taken so a rewrite can be undone has to be able to put back what
   * was there, not a re-rendering of the parts this file happens to know
   * about. Null when there is no such skill in the home directory.
   */
  raw(name: string): string | null {
    if (!NAME.test(name)) return null;
    const file = join(this.dirs[0] as string, name, 'SKILL.md');
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }

  /**
   * Put a snapshot back, byte for byte. `null` content means the skill did
   * not exist when the snapshot was taken, so restoring it removes the
   * folder again.
   *
   * This is the only write that ignores the "never overwrite the user's
   * work" rule, and it has to: it is the undo of a write that rule already
   * allowed, so what it puts back is by definition what was there before.
   */
  restore(name: string, content: string | null): boolean {
    if (!NAME.test(name)) return false;
    if (content === null) return this.remove(name);
    const folder = join(this.dirs[0] as string, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'SKILL.md'), content, 'utf8');
    return true;
  }

  /**
   * The home folder, and only it. A built-in has no folder, so removing one
   * is a no-op that answers false - what a person deletes is their own copy
   * of it, and doing so brings the shipped text back into `list`.
   */
  remove(name: string): boolean {
    if (!NAME.test(name)) return false;
    const folder = join(this.dirs[0] as string, name);
    if (!existsSync(folder)) return false;
    rmSync(folder, { recursive: true, force: true });
    return true;
  }

  /** The skills one audience may open. */
  for(who: 'assistant' | 'agent'): Skill[] {
    return this.list().filter(
      (skill) => skill.audience === 'both' || (who === 'assistant' ? skill.audience === 'assistant' : skill.audience === 'agents'),
    );
  }
}

/** Where a project's own skills live, read but never written by Rookery. */
export function projectSkillsDir(projectPath: string): string {
  return join(projectPath, '.claude', 'skills');
}

/** The index paragraph for a prompt; empty when there is nothing to open. */
export function renderSkillsIndex(skills: Skill[]): string {
  if (!skills.length) return '';
  return (
    'Skills - written instructions you can open with the use_skill tool when a task matches; ' +
    'open one before starting such a task and follow it:\n' +
    skills.map((skill) => '- ' + skill.name + ': ' + skill.description).join('\n')
  );
}

/** What use_skill returns: the instructions and the files that come with them. */
export function renderSkill(skill: Skill): string {
  const files = skill.files.length ? '\n\nFiles in ' + skill.path + ': ' + skill.files.join(', ') : '';
  return '# ' + skill.name + '\n' + skill.description + '\n\n' + skill.body + files;
}
