import type { RookeryConfig } from '../types.js';
import { tokenize } from '../memory/recall.js';
import { shorten } from '../util/queue.js';
import { externalScan } from '../external/discovery.js';
import { externalSkillsFor } from './shelf.js';
import type { Skill } from './store.js';

/**
 * Which skills look like they fit the task in hand.
 *
 * The index in the prompt asks the model to open a skill "when a task
 * matches", and `find_skill` searches the shelf it cannot list. Both leave the
 * remembering to the model, and that is the part that fails: whoever is deep
 * in an assignment does not stop to wonder whether somebody wrote the
 * procedure down already.
 *
 * So Rookery looks instead. This is the same move the memory made - nobody
 * calls a `recall` tool, `renderMemoryBlock(recall(...))` simply puts the
 * relevant rows in the prompt - applied to the shelf: score the task against
 * every skill available to this audience and name the best few, so the
 * question is no longer whether the model thinks to search but whether the
 * match is already in front of it.
 *
 * The matching is lexical, over `tokenize` from the recall side (same stop
 * words, same 24-token cap). It therefore fires on names and technical terms -
 * "react", "vercel", "playwright", "pdf" - and not on paraphrase, which also
 * means a German assignment meets an English description only on the words
 * the two share. That is a floor, not a ceiling: it never invents a match, and
 * `find_skill` is still there for everything this misses.
 */

/**
 * What it takes to be named: a name hit is worth 3 and a description hit 1,
 * so 5 is two words in the name, or one word in the name and two more in the
 * description. Below that the evidence is a single coincidence.
 */
const MIN_SCORE = 5;

export interface SkillMatch {
  name: string;
  description: string;
  /** The source label for a skill off the installed shelf; empty for our own. */
  label: string;
  score: number;
}

/** A skill's own words: the name carries more signal than the description. */
function terms(name: string, description: string): { name: Set<string>; description: Set<string> } {
  return {
    // Names are slugs - `react-performance` has to become two words.
    name: new Set(tokenize(name.replace(/-/g, ' '))),
    description: new Set(tokenize(description)),
  };
}

/**
 * How many of a set's tokens the task also used. A word of four letters or
 * more counts when one is the start of the other, so that "scroll" reaches
 * `scrollytelling` and German inflection ("schreib" against "schreiben")
 * does not miss by an ending.
 */
function overlap(task: Set<string>, other: Set<string>): number {
  let shared = 0;
  for (const token of other) {
    if (task.has(token)) {
      shared += 1;
      continue;
    }
    if (token.length < 4) continue;
    for (const word of task) {
      if (word.length >= 4 && (token.startsWith(word) || word.startsWith(token))) {
        shared += 1;
        break;
      }
    }
  }
  return shared;
}

/**
 * A hit in the name is worth three in the description, and the description
 * cannot win on volume alone: four is as much as it may contribute, so a
 * skill with a page-long description does not out-rank a precise name.
 *
 * Nothing qualifies on a single stray description word. A name hit is enough
 * on its own; without one it takes three words from the description before
 * this is a match rather than a coincidence.
 */
function rate(task: Set<string>, name: string, description: string): number {
  const own = terms(name, description);
  const nameHits = overlap(task, own.name);
  const descHits = Math.min(4, overlap(task, own.description));
  if (nameHits === 0 && descHits < 3) return 0;
  return nameHits * 3 + descHits;
}

/**
 * The best matches for one task across both shelves: Rookery's own skills and
 * whatever of the installed shelf this audience may open.
 */
export function matchSkills(
  config: RookeryConfig,
  who: 'assistant' | 'agent',
  own: Skill[],
  task: string,
  limit = 3,
): SkillMatch[] {
  const words = new Set(tokenize(task));
  if (!words.size) return [];

  const matches: SkillMatch[] = [];
  for (const skill of own) {
    const score = rate(words, skill.name, skill.description);
    if (score > 0) matches.push({ name: skill.name, description: skill.description, label: '', score });
  }

  const external = externalSkillsFor(config, who);
  if (external.length) {
    const labels = new Map(externalScan({ enabled: config.external.enabled }).sources.map((s) => [s.id, s.label]));
    for (const skill of external) {
      const score = rate(words, skill.name, skill.description);
      if (score > 0) {
        matches.push({
          name: skill.name,
          description: skill.description,
          label: labels.get(skill.sourceId) ?? '',
          score,
        });
      }
    }
  }

  // The bar applies to every line, not just the first: a strong match does
  // not earn the right to bring two weak ones along.
  const strong = matches
    .filter((match) => match.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const best = strong[0];
  if (!best) return [];

  // One shared word is not a match. "Mach die React-Seite schneller" against
  // 357 skills shares only "react" with three dozen of them, all scoring the
  // same, and the order between them is then the alphabet - which is how a
  // list of three confidently wrong skills gets into a prompt. So it takes
  // two signals: two words in the name, or one plus a description that keeps
  // agreeing.
  // And if many are tied at the top, the word they share was a common one,
  // not a match. Better to say nothing and leave find_skill to the model
  // than to name an arbitrary few of thirty.
  const tied = strong.filter((match) => match.score === best.score).length;
  if (tied > limit) return [];

  return strong.slice(0, limit);
}

/**
 * The paragraph that goes into the prompt beside the index. Empty when
 * nothing matched, so a task that needs no skill costs no tokens - and so
 * that a block appearing at all means something.
 */
export function renderSkillMatches(matches: SkillMatch[]): string {
  if (!matches.length) return '';
  return (
    'These skills look like they fit what you have been asked to do. Open the one that does with ' +
    'use_skill and follow it before you start; if none of them actually fits, say so to yourself and ' +
    'carry on without one:\n' +
    matches
      .map((match) => '- ' + match.name + (match.label ? ' (' + match.label + ')' : '') +
        ': ' + shorten(match.description || 'no description', 160))
      .join('\n')
  );
}
