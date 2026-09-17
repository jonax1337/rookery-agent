import { dirname } from 'node:path';
import type { RookeryConfig, ToolServerAudience } from '../types.js';
import { enabledExternalSkills, externalScan, sourceEnabled } from '../external/discovery.js';
import { loadWholeSourceIds } from '../tools/hub.js';
import type { ExternalSkillRef, ExternalSource } from '../external/shared.js';
import { readSkillFolder, type Skill } from './store.js';

/**
 * The second shelf: skills that belong to the Claude Code installed on
 * this machine.
 *
 * Rookery's own skills go into the prompt in full - there are a handful of
 * them and the model should simply know they exist. The other shelf cannot
 * work that way: on this machine Claude Code and its enabled plugins hold
 * over seven hundred skills, which is more prompt than the conversation. So
 * the prompt says only what is there and how much of it, `find_skill`
 * searches it, and `use_skill` opens the one that matched. The model sees
 * what is available and loads it when a task calls for it.
 *
 * Read-only throughout: `write_skill` and the skill editor never come here.
 */

const serves = (audience: ToolServerAudience, who: 'assistant' | 'agent'): boolean =>
  audience === 'both' || (who === 'assistant' ? audience === 'assistant' : audience === 'agents');

/** Every source found, with whether its skills currently count. */
export function externalSources(config: RookeryConfig): { source: ExternalSource; enabled: boolean }[] {
  const scan = externalScan({ enabled: config.external.enabled });
  return scan.sources.map((source) => ({ source, enabled: sourceEnabled(source, config.external.skillSources) }));
}

/** The skills of the switched-on sources that this audience may open. */
export function externalSkillsFor(config: RookeryConfig, who: 'assistant' | 'agent'): ExternalSkillRef[] {
  const scan = externalScan({ enabled: config.external.enabled });
  // A source loaded whole brings its own skills with it through the plugin
  // folder the turn is handed; the curated shelf keeps out so the same shelf
  // does not stand in the turn twice, under two names.
  const loadedWhole = loadWholeSourceIds(config);
  return enabledExternalSkills(scan, config.external.skillSources).filter(
    (skill) => serves(skill.audience, who) && !loadedWhole.has(skill.sourceId),
  );
}

/** Words worth matching on: short noise carries no signal in a search. */
function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);
}

/**
 * Rank by name first, description second. Somebody asking for "pdf" means
 * the skill called pdf, not the twenty that mention one in passing.
 */
function score(skill: ExternalSkillRef, query: string, words: string[]): number {
  const name = skill.name.toLowerCase();
  const description = skill.description.toLowerCase();
  let points = 0;
  if (name === query) points += 200;
  else if (name.startsWith(query)) points += 120;
  else if (name.includes(query)) points += 80;
  if (description.includes(query)) points += 30;
  for (const word of words) {
    if (name.includes(word)) points += 25;
    if (description.includes(word)) points += 6;
  }
  return points;
}

export interface SkillHit extends ExternalSkillRef {
  /** The source label, so the model and the page can say where it comes from. */
  label: string;
}

/** The best matches among the switched-on external skills. */
export function findExternalSkills(
  config: RookeryConfig,
  who: 'assistant' | 'agent',
  query: string,
  limit = 12,
): SkillHit[] {
  const text = query.trim().toLowerCase();
  if (!text) return [];
  const scan = externalScan({ enabled: config.external.enabled });
  const labels = new Map(scan.sources.map((source) => [source.id, source.label]));
  const words = terms(text);
  return externalSkillsFor(config, who)
    .map((skill) => ({ skill, points: score(skill, text, words) }))
    .filter((entry) => entry.points > 0)
    .sort((a, b) => b.points - a.points || a.skill.name.localeCompare(b.skill.name))
    .slice(0, limit)
    .map((entry) => ({ ...entry.skill, label: labels.get(entry.skill.sourceId) ?? '' }));
}

/**
 * `<plugin>:<name>`, the way Claude Code itself names a plugin's skill:
 * `ecc:react-performance`. Not a spelling Rookery hands out - `find_skill`
 * prints the bare name - but a model that knows the CLI writes it without
 * being told to, and a null in return costs it a turn for nothing.
 */
function pluginQualified(
  skills: ExternalSkillRef[],
  sources: ExternalSource[],
  wanted: string,
): ExternalSkillRef | undefined {
  const colon = wanted.lastIndexOf(':');
  // A qualified id carries a slash and is already handled; this form has none.
  if (colon <= 0 || wanted.includes('/')) return undefined;
  const prefix = wanted.slice(0, colon);
  const bare = wanted.slice(colon + 1);
  const plugins = new Map(sources.map((source) => [source.id, (source.plugin ?? '').toLowerCase()]));
  return skills.find((skill) => {
    if (skill.name !== bare) return false;
    const plugin = plugins.get(skill.sourceId) ?? '';
    // Both halves of the key: Claude Code writes `ecc` where Rookery's source
    // id carries the marketplace too (`ecc@ecc`).
    return plugin === prefix || plugin.split('@')[0] === prefix;
  });
}

/**
 * Open one by name, by its qualified `<source>/<name>` id, or by the
 * `<plugin>:<name>` form above. Only now is the body read from disk - the
 * scan never touches it.
 */
export function openExternalSkill(config: RookeryConfig, who: 'assistant' | 'agent', name: string): Skill | null {
  const wanted = name.trim().toLowerCase();
  const skills = externalSkillsFor(config, who);
  const scan = externalScan({ enabled: config.external.enabled });
  const ref =
    skills.find((skill) => skill.id.toLowerCase() === wanted) ??
    skills.find((skill) => skill.name === wanted) ??
    pluginQualified(skills, scan.sources, wanted);
  if (!ref) return null;
  const skill = readSkillFolder(dirname(ref.path), ref.name);
  if (!skill) return null;
  const label = scan.sources.find((source) => source.id === ref.sourceId)?.label;
  return { ...skill, source: label ?? ref.sourceId };
}

/** What the search results become in a tool result. */
export function renderSkillHits(hits: SkillHit[]): string {
  if (!hits.length) return 'Nothing matched. Try another word, or work without a skill.';
  return hits
    .map((hit) => '- ' + hit.name + (hit.label ? ' (' + hit.label + ')' : '') + ': ' + (hit.description || 'no description'))
    .join('\n');
}

/**
 * What the prompt says about the second shelf: how much is there and where
 * it came from, never the skills themselves.
 */
export function renderExternalSkillsHint(config: RookeryConfig, who: 'assistant' | 'agent'): string {
  const skills = externalSkillsFor(config, who);
  if (!skills.length) return '';

  const scan = externalScan({ enabled: config.external.enabled });
  const counts = new Map<string, number>();
  for (const skill of skills) counts.set(skill.sourceId, (counts.get(skill.sourceId) ?? 0) + 1);
  const lines = scan.sources
    .filter((source) => counts.has(source.id))
    .map((source) => {
      const examples = skills
        .filter((skill) => skill.sourceId === source.id)
        .slice(0, 5)
        .map((skill) => skill.name)
        .join(', ');
      return '- ' + source.label + ': ' + counts.get(source.id) + ' (e.g. ' + examples + ')';
    });

  return (
    'Further skills are installed on this machine, ' + skills.length + ' of them, in the Claude Code ' +
    'this Rookery runs on. They are not listed above because there are too many to read every turn. ' +
    'Search them with find_skill when a task looks like somebody has written the procedure down already, ' +
    'then open the match with use_skill:\n' +
    lines.join('\n')
  );
}
