import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the Claude Code on this machine keeps its own installation.
 *
 * Rookery already runs on the OAuth session of the locally logged-in
 * `claude`, so whatever a person has installed for it is sitting on the same
 * disk: skills, plugins, MCP servers. This module only says where to look and
 * reads a file if it is there. Nothing here ever writes - what belongs to
 * Claude Code stays Claude Code's.
 */

/** What a person reads on the page for anything found in that installation. */
export const EXTERNAL_LABEL = 'Claude Code';

/**
 * The prefix every discovered source and server id carries.
 *
 * Fixed rather than derived: these ids are written into `config.external`
 * when somebody switches a shelf or a server on, so they have to survive a
 * rescan - and a rename here would silently reset those decisions.
 */
export const EXTERNAL_KIND = 'claude-code';

/** `~/.claude`, honouring the same override the CLI itself takes. */
export function claudeHome(home = homedir()): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
}

/** Read and parse a JSON file; null when it is missing or does not parse. */
export function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Read a text file; null when it is missing or unreadable. */
export function readTextFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
