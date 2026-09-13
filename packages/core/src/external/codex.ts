import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { codexHome, kindLabel, readJsonFile, readTextFile } from './homes.js';
import { readToml, tomlTable, type TomlTable } from './toml.js';
import {
  EMPTY_SCAN,
  newestVersion,
  scanSkills,
  skillSource,
  toExternalServer,
  type ExternalMcpServer,
  type ExternalScan,
  type ExternalSkillRef,
  type ExternalSource,
  type McpServerJson,
} from './shared.js';

/**
 * What a Codex installation has to offer.
 *
 * Codex keeps everything in one `config.toml`: `[mcp_servers.<name>]` for the
 * servers, `[plugins."<name>@<marketplace>"]` for the switches. The plugins
 * themselves are unpacked under `plugins/cache/<marketplace>/<name>/<version>`,
 * one version folder per install with a `latest` link beside it, and they
 * carry their skills in the same `skills/` shape Claude Code uses - the
 * folder format is the open standard, which is why one reader serves both.
 */

/** `mcp_servers.<name>` in TOML into the JSON shape `toExternalServer` takes. */
function fromToml(table: TomlTable): McpServerJson {
  const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
  return {
    type: text(table.type) ?? (text(table.url) ? 'http' : undefined),
    command: text(table.command),
    args: table.args,
    env: (tomlTable(table, 'env') as Record<string, unknown> | null) ?? {},
    url: text(table.url),
    headers: (tomlTable(table, 'headers') as Record<string, unknown> | null) ?? {},
  };
}

/** The plugin keys switched on in `config.toml`, as `<name>@<marketplace>`. */
function enabledPlugins(doc: TomlTable): string[] {
  const plugins = tomlTable(doc, 'plugins');
  if (!plugins) return [];
  return Object.entries(plugins)
    .filter(([, value]) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      return (value as TomlTable).enabled !== false;
    })
    .map(([key]) => key);
}

/** Everything Codex has installed on this machine. */
export function scanCodex(home = homedir()): ExternalScan {
  const dir = codexHome(home);
  if (!existsSync(dir)) return EMPTY_SCAN;

  const kind = 'codex' as const;
  const label = kindLabel(kind);
  const sources: ExternalSource[] = [];
  const skills: ExternalSkillRef[] = [];
  const servers: ExternalMcpServer[] = [];

  const collect = (source: Omit<ExternalSource, 'skillCount'>): void => {
    const found = scanSkills(source.dir, source.id);
    const entry = skillSource(source, found);
    if (!entry) return;
    sources.push(entry);
    skills.push(...found);
  };

  collect({ id: kind + ':home', kind, label, origin: 'home', dir: join(dir, 'skills') });

  const doc = readToml(readTextFile(join(dir, 'config.toml')) ?? '');

  for (const [name, value] of Object.entries(tomlTable(doc, 'mcp_servers') ?? {})) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const server = toExternalServer(name, fromToml(value as TomlTable), { kind, sourceId: kind + ':home', label });
    if (server) servers.push(server);
  }

  for (const key of enabledPlugins(doc)) {
    const [name, marketplace] = key.split('@');
    if (!name || !marketplace) continue;
    const installed = newestVersion(join(dir, 'plugins', 'cache', marketplace, name));
    if (!installed) continue;

    const sourceId = kind + ':plugin/' + key;
    const pluginLabel = label + ' - ' + name;
    collect({ id: sourceId, kind, label: pluginLabel, origin: 'plugin', plugin: key, dir: join(installed, 'skills') });

    const mcp = readJsonFile<{ mcpServers?: Record<string, McpServerJson> }>(join(installed, '.mcp.json'));
    for (const [server, json] of Object.entries(mcp?.mcpServers ?? {})) {
      const spec = toExternalServer(server, json, { kind, sourceId, label: pluginLabel, scope: key });
      if (spec) servers.push(spec);
    }
  }

  return { sources, skills, servers };
}
