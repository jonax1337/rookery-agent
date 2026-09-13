import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the two CLIs keep their own installation.
 *
 * Rookery already runs on the OAuth session of the locally logged-in `claude`
 * and `codex`, so whatever a person has installed for those two is sitting on
 * the same disk: skills, plugins, MCP servers. This module only says where to
 * look and reads a file if it is there. Nothing here ever writes - what
 * belongs to Claude Code and Codex stays theirs.
 */

export type ExternalKind = 'claude-code' | 'codex';

export interface ExternalHome {
  kind: ExternalKind;
  /** The configuration directory, `~/.claude` or `~/.codex`. */
  dir: string;
}

/** `~/.claude`, honouring the same override the CLI itself takes. */
export function claudeHome(home = homedir()): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
}

/** `~/.codex`, honouring `CODEX_HOME`. */
export function codexHome(home = homedir()): string {
  return process.env.CODEX_HOME?.trim() || join(home, '.codex');
}

/** The homes that actually exist on this machine. */
export function externalHomes(home = homedir()): ExternalHome[] {
  const homes: ExternalHome[] = [
    { kind: 'claude-code', dir: claudeHome(home) },
    { kind: 'codex', dir: codexHome(home) },
  ];
  return homes.filter((entry) => existsSync(entry.dir));
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

/** The label a person recognises for a kind. */
export function kindLabel(kind: ExternalKind): string {
  return kind === 'claude-code' ? 'Claude Code' : 'Codex';
}
