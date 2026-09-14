import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServerSpec } from '../types.js';

/**
 * A project's own `.mcp.json`: the same file a person's own Claude Code
 * session in that folder would already read. Rookery reads it centrally,
 * once, and turns it into the generic `McpServerSpec[]` every provider
 * adapter already accepts (`ProviderTurnOptions.mcpExtra`) - so Claude Code
 * and any future provider get the same servers through their own existing
 * serializer, with nothing provider-specific added here.
 *
 * `.mcp.json` starts real processes, unlike a skill, which is just prose -
 * so a project only gets its servers once a person has approved it (see
 * `projectMcpStatus`), and a later edit to the file is noticed because the
 * fingerprint no longer matches.
 */

export interface ProjectMcpFile {
  /** The raw file content, for fingerprinting and for showing the user. */
  raw: string;
  servers: McpServerSpec[];
}

export function projectMcpPath(projectPath: string): string {
  return join(projectPath, '.mcp.json');
}

/** Reads and parses a project's `.mcp.json`; null when there is none or it does not parse. */
export function readProjectMcpFile(projectPath: string): ProjectMcpFile | null {
  const file = projectMcpPath(projectPath);
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const doc = JSON.parse(raw) as {
      mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
    };
    const servers: McpServerSpec[] = Object.entries(doc.mcpServers ?? {})
      .filter((entry): entry is [string, { command: string; args?: string[]; env?: Record<string, string> }] =>
        typeof entry[1]?.command === 'string',
      )
      .map(([name, server]) => ({
        name,
        command: server.command,
        args: server.args ?? [],
        env: server.env ?? {},
      }));
    return { raw, servers };
  } catch {
    return null;
  }
}

/** A short fingerprint of the file's content, so a later edit is noticed. */
export function fingerprintMcpFile(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

export type ProjectMcpStatus = 'none' | 'pending' | 'trusted' | 'changed';

/** Where a project stands: no file (or an empty one), never decided, approved and unchanged, or approved but the file moved on since. */
export function projectMcpStatus(
  file: ProjectMcpFile | null,
  trust: { fingerprint: string } | undefined,
): ProjectMcpStatus {
  if (!file || !file.servers.length) return 'none';
  if (!trust) return 'pending';
  return trust.fingerprint === fingerprintMcpFile(file.raw) ? 'trusted' : 'changed';
}

/** One line per server, for a tool result. */
export function renderProjectMcpServers(servers: McpServerSpec[]): string {
  if (!servers.length) return "No MCP servers in this project's .mcp.json.";
  return servers.map((server) => '- ' + server.name + ': ' + server.command + ' ' + server.args.join(' ')).join('\n');
}
