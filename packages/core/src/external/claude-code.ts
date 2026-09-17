import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeHome, EXTERNAL_KIND, EXTERNAL_LABEL, readJsonFile } from './homes.js';
import {
  EMPTY_SCAN,
  readHookSet,
  scanAgents,
  scanSkills,
  toExternalServer,
  type ExternalAgentRef,
  type ExternalHookSet,
  type ExternalMcpServer,
  type ExternalScan,
  type ExternalSkillRef,
  type ExternalSource,
  type McpServerJson,
} from './shared.js';

/**
 * What a Claude Code installation has to offer.
 *
 * Four files carry it. `skills/` is the person's own shelf. `settings.json`
 * says which plugins are switched on, `plugins/installed_plugins.json` says
 * where each one was unpacked - a plugin brings its own `skills/` folder and
 * may bring an `.mcp.json`, an `agents/` folder of subagent types and a
 * `hooks/hooks.json`. And `.claude.json` holds the MCP servers the
 * person added with `claude mcp add`, both the ones that count everywhere
 * and the ones kept under a single project path.
 */

interface InstalledPlugins {
  plugins?: Record<string, { scope?: string; installPath?: string; version?: string }[]>;
}

interface ClaudeSettings {
  enabledPlugins?: Record<string, boolean>;
  mcpServers?: Record<string, McpServerJson>;
}

interface ClaudeConfig {
  mcpServers?: Record<string, McpServerJson>;
  projects?: Record<string, { mcpServers?: Record<string, McpServerJson> }>;
}

/**
 * `.claude.json` sits in the config directory when it was moved, next to it
 * otherwise. With `CLAUDE_CONFIG_DIR` set the directory is the whole answer -
 * falling back to the real home would reach past an installation somebody
 * deliberately pointed elsewhere.
 */
function configFile(dir: string, home: string): string {
  const inside = join(dir, '.claude.json');
  if (existsSync(inside) || process.env.CLAUDE_CONFIG_DIR?.trim()) return inside;
  return join(home, '.claude.json');
}

/** The plugins that are installed and not switched off. */
function enabledPlugins(dir: string): { key: string; path: string }[] {
  const installed = readJsonFile<InstalledPlugins>(join(dir, 'plugins', 'installed_plugins.json'));
  const settings = readJsonFile<ClaudeSettings>(join(dir, 'settings.json'));
  const switches = settings?.enabledPlugins ?? {};
  const found: { key: string; path: string }[] = [];
  for (const [key, entries] of Object.entries(installed?.plugins ?? {})) {
    // Absent means on: a plugin lands in the file the moment it is installed.
    if (switches[key] === false) continue;
    const path = entries.map((entry) => entry.installPath).find((candidate) => candidate && existsSync(candidate));
    if (path) found.push({ key, path });
  }
  return found;
}

/** Everything Claude Code has installed on this machine. */
export function scanClaudeCode(home = homedir()): ExternalScan {
  const dir = claudeHome(home);
  if (!existsSync(dir)) return EMPTY_SCAN;

  const kind = EXTERNAL_KIND;
  const label = EXTERNAL_LABEL;
  const sources: ExternalSource[] = [];
  const skills: ExternalSkillRef[] = [];
  const servers: ExternalMcpServer[] = [];
  const agents: ExternalAgentRef[] = [];
  const hooks: ExternalHookSet[] = [];

  /**
   * One shelf: its skills, its subagent types, its hook set. The source is
   * listed when it holds any of the three - a plugin can ship seventy agents
   * and no skill at all, and a shelf that is not listed has no switch.
   */
  const collect = (source: Omit<ExternalSource, 'skillCount'>, root: string): void => {
    const foundSkills = scanSkills(source.dir, source.id);
    const foundAgents = scanAgents(join(root, 'agents'), source.id);
    const foundHooks = readHookSet(join(root, 'hooks'), source.id);
    if (!foundSkills.length && !foundAgents.length && !foundHooks) return;
    sources.push({ ...source, skillCount: foundSkills.length });
    skills.push(...foundSkills);
    agents.push(...foundAgents);
    if (foundHooks) hooks.push(foundHooks);
  };

  collect({ id: kind + ':home', label, origin: 'home', dir: join(dir, 'skills') }, dir);

  for (const plugin of enabledPlugins(dir)) {
    const sourceId = kind + ':plugin/' + plugin.key;
    const pluginLabel = label + ' - ' + (plugin.key.split('@')[0] ?? plugin.key);
    collect(
      {
        id: sourceId,
        label: pluginLabel,
        origin: 'plugin',
        plugin: plugin.key,
        dir: join(plugin.path, 'skills'),
        // `--plugin-dir` wants the plugin root, not its skills folder.
        installPath: plugin.path,
      },
      plugin.path,
    );

    const mcp = readJsonFile<{ mcpServers?: Record<string, McpServerJson> }>(join(plugin.path, '.mcp.json'));
    for (const [name, json] of Object.entries(mcp?.mcpServers ?? {})) {
      const server = toExternalServer(name, json, { sourceId, label: pluginLabel, scope: plugin.key });
      if (server) servers.push(server);
    }
  }

  // The person's own servers. `settings.json` may carry them too; the ones in
  // `.claude.json` win because that is what `claude mcp add` writes.
  const settings = readJsonFile<ClaudeSettings>(join(dir, 'settings.json'));
  const config = readJsonFile<ClaudeConfig>(configFile(dir, home));
  const own = { ...(settings?.mcpServers ?? {}), ...(config?.mcpServers ?? {}) };
  for (const [name, json] of Object.entries(own)) {
    const server = toExternalServer(name, json, { sourceId: kind + ':home', label });
    if (server) servers.push(server);
  }

  // Servers Claude Code keeps under one project path. They only make sense in
  // that directory, so the path travels with them and `hub.ts` scopes them.
  for (const [path, project] of Object.entries(config?.projects ?? {})) {
    for (const [name, json] of Object.entries(project?.mcpServers ?? {})) {
      const server = toExternalServer(name, json, {
        sourceId: kind + ':home',
        label: label + ' - ' + path,
        scope: path,
        projectPath: resolve(path),
      });
      if (server) servers.push(server);
    }
  }

  agents.sort((a, b) => a.name.localeCompare(b.name));
  hooks.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  return { sources, skills, servers, agents, hooks };
}
