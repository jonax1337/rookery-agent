import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeHome } from './homes.js';
import { scanClaudeCode } from './claude-code.js';
import {
  EMPTY_SCAN,
  type ExternalMcpServer,
  type ExternalScan,
  type ExternalSkillRef,
  type ExternalSource,
} from './shared.js';

/**
 * One look at the Claude Code installation, cached.
 *
 * The scan is cheap but not free - three hundred and sixty skill folders on
 * this machine - and it happens in front of a turn, so it is kept until
 * something that could have changed it did. The signature is the modification
 * time of the handful of files that decide the answer; a plugin updated in
 * place moves its cache folder's time, so that shows too. Beyond that a
 * short expiry, and `refreshExternal` for the button on the page.
 */

/** How long a scan is trusted even when nothing looks touched. */
const MAX_AGE_MS = 5 * 60 * 1000;

function stamp(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** The mtimes that decide whether a rescan is due. */
function signature(home: string): string {
  const claude = claudeHome(home);
  return [
    join(claude, 'skills'),
    join(claude, 'settings.json'),
    join(claude, 'plugins', 'installed_plugins.json'),
    join(claude, 'plugins', 'cache'),
    join(home, '.claude.json'),
    join(claude, '.claude.json'),
  ]
    .map(stamp)
    .join('.');
}

let cached: { home: string; signature: string; at: number; scan: ExternalScan } | null = null;

/** Settle the duplicates a single scan can still produce, then sort. Never touches the scan it is given: that may be the shared EMPTY_SCAN. */
function normalise(raw: ExternalScan): ExternalScan {
  const scan = { ...raw, servers: foldServers(raw.servers) };
  disambiguate(scan);
  scan.sources.sort((a, b) => a.label.localeCompare(b.label));
  scan.skills.sort((a, b) => a.name.localeCompare(b.name));
  scan.servers.sort((a, b) => a.name.localeCompare(b.name));
  return scan;
}

/**
 * The same MCP server declared twice is one server.
 *
 * `context7` and `vercel` are hosted endpoints that a plugin and the person's
 * own `.claude.json` can both name, so both hand over the identical URL;
 * starting it twice would only give the model two names for one thing.
 * Identity is the fingerprint: where the start definition differs - two
 * `projectatlas` executables from different runtimes, say - they stay two
 * rows, because they really are two.
 */
function foldServers(servers: ExternalMcpServer[]): ExternalMcpServer[] {
  const kept = new Set<string>();
  return servers.filter((server) => {
    const key = server.name + ' ' + server.fingerprint + ' ' + (server.projectPath ?? '');
    if (kept.has(key)) return false;
    kept.add(key);
    return true;
  });
}

/**
 * The same plugin name in two marketplaces gives two shelves reading
 * "Claude Code - frontend-design", and a switch you cannot tell apart is a
 * switch you cannot use. Where that happens, the marketplace comes along.
 */
function disambiguate(scan: ExternalScan): void {
  const seen = new Map<string, number>();
  for (const source of scan.sources) seen.set(source.label, (seen.get(source.label) ?? 0) + 1);
  for (const source of scan.sources) {
    const marketplace = source.plugin?.split('@')[1];
    if (!marketplace || (seen.get(source.label) ?? 0) < 2) continue;
    const full = source.label + ' (' + marketplace + ')';
    for (const server of scan.servers) if (server.sourceId === source.id) server.label = full;
    source.label = full;
  }
}

/** What Claude Code has installed, from the cache when it still holds. */
export function externalScan(options: { home?: string; enabled?: boolean } = {}): ExternalScan {
  if (options.enabled === false) return EMPTY_SCAN;
  const home = options.home ?? homedir();
  const now = Date.now();
  const current = signature(home);
  if (cached && cached.home === home && cached.signature === current && now - cached.at < MAX_AGE_MS) return cached.scan;

  const scan = normalise(scanClaudeCode(home));
  cached = { home, signature: current, at: now, scan };
  return scan;
}

/** Throw the cache away, so the next look reads the disk again. */
export function refreshExternal(): void {
  cached = null;
}

/**
 * Whether a source is on, and the default for one nobody has decided about.
 *
 * A plugin can hold three hundred skills; nothing that big joins the shelf
 * unasked. Claude Code's own skills folder is the person's own hand-picked
 * set, so that one counts from the start.
 */
export function sourceEnabled(source: ExternalSource, switches: Record<string, boolean>): boolean {
  return switches[source.id] ?? source.origin === 'home';
}

/**
 * The skills of the sources a person has switched on, each name once.
 *
 * The last duplicate is the one two different shelves happen to share: a
 * `gsap-core` sits in `~/.claude/skills` and again in the `gsap-skills`
 * plugin, because half of that folder is the loose copy of a plugin
 * installed later. Same name, same procedure - listing it twice only makes
 * the model choose between two identical answers.
 *
 * Deliberately done here and not in the scan: which copy survives depends on
 * which shelves are switched on, so a name dropped while its neighbour was
 * enabled must come back when that neighbour is switched off. The person's
 * own folder wins over a plugin - they put that one there by hand.
 */
export function enabledExternalSkills(scan: ExternalScan, switches: Record<string, boolean>): ExternalSkillRef[] {
  const on = new Map(
    scan.sources.filter((source) => sourceEnabled(source, switches)).map((source) => [source.id, source]),
  );
  const rank = (id: string): number => (on.get(id)?.origin === 'home' ? 0 : 1);
  const seen = new Set<string>();
  return scan.skills
    .filter((skill) => on.has(skill.sourceId))
    .sort((a, b) => rank(a.sourceId) - rank(b.sourceId) || a.sourceId.localeCompare(b.sourceId))
    .filter((skill) => {
      if (seen.has(skill.name)) return false;
      seen.add(skill.name);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type { ExternalMcpServer, ExternalScan, ExternalSkillRef, ExternalSource } from './shared.js';
