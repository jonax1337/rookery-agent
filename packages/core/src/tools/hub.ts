import type {
  McpServerSpec,
  ProviderAgentFile,
  ProviderHookTable,
  ProviderId,
  ProviderSettings,
  RookeryConfig,
  ToolServerAudience,
  ToolServerConfig,
} from '../types.js';
import { TOOL_CATALOG, catalogEntry, type ToolCatalogEntry } from './catalog.js';
import { externalScan } from '../external/discovery.js';
import {
  fingerprintOf,
  readAgentFile,
  readHookDocument,
  type ExternalAgentRef,
  type ExternalHookSet,
  type ExternalMcpServer,
  type ExternalSource,
} from '../external/shared.js';

/**
 * The hub: which MCP servers a turn gets, and what the model is told about
 * them. Catalogue entries and custom servers share one shape here so the
 * web page, the CLI and the assistant's own tools all see the same list.
 */

export interface ToolServerState {
  id: string;
  name: string;
  description: string;
  homepage: string;
  install: 'bundled' | 'on-demand' | 'custom' | 'external';
  enabled: boolean;
  audience: ToolServerAudience;
  options: Record<string, string>;
  /** Which environment names are set, never their values. */
  envSet: Record<string, boolean>;
  /** Required keys that are still missing; the server stays off until they are there. */
  missingEnv: string[];
  installed: boolean;
  /** True when the server would actually start for its audience right now. */
  active: boolean;
  /** Project ids this server is limited to; empty means every project. */
  projectIds: string[];
  entry?: ToolCatalogEntry;
  custom?: ToolServerConfig['custom'];
  /** Read out of the Claude Code installed here; never started unasked. */
  external?: ExternalMcpServer;
  /** Where an external server came from, for the badge on the page. */
  source?: string;
  /**
   * An approved external server whose start definition has moved on since.
   * It stays out of every turn until a person looks at it again.
   */
  changed?: boolean;
  /** Only a person may switch this on - `set_tool_server` refuses. */
  approvalRequired?: boolean;
}

const RESERVED = new Set(['rookery']);

/** The stored entry for an id, or the catalogue defaults when the user never touched it. */
export function toolServerConfig(config: RookeryConfig, id: string): ToolServerConfig {
  const stored = config.tools.servers.find((server) => server.id === id);
  if (stored) return stored;
  const entry = catalogEntry(id);
  return {
    id,
    enabled: false,
    audience: entry?.defaultAudience ?? 'assistant',
    options: Object.fromEntries((entry?.options ?? []).map((option) => [option.key, option.default])),
    env: {},
  };
}

function optionsWithDefaults(entry: ToolCatalogEntry | undefined, options: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const option of entry?.options ?? []) merged[option.key] = options[option.key] ?? option.default;
  for (const [key, value] of Object.entries(options)) if (!(key in merged)) merged[key] = value;
  return merged;
}

function missingEnv(entry: ToolCatalogEntry | undefined, env: Record<string, string>): string[] {
  return (entry?.env ?? [])
    .filter((item) => item.required && !env[item.name] && !process.env[item.name])
    .map((item) => item.name);
}

/** Every server the user can see: the catalogue plus custom entries, with their state. */
export function toolServerStates(config: RookeryConfig): ToolServerState[] {
  const ids = [...TOOL_CATALOG.map((entry) => entry.id), ...config.tools.servers.map((server) => server.id)];
  const seen = new Set<string>();
  const states: ToolServerState[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const stored = toolServerConfig(config, id);
    const entry = catalogEntry(id);
    if (!entry && !stored.custom) continue;
    const options = optionsWithDefaults(entry, stored.options);
    const missing = missingEnv(entry, stored.env);
    const installed = entry ? entry.installed() : true;
    states.push({
      id,
      name: entry?.name ?? stored.custom?.name ?? id,
      description: entry?.description ?? (stored.custom ? stored.custom.command + ' ' + stored.custom.args.join(' ') : ''),
      homepage: entry?.homepage ?? '',
      install: entry ? entry.install : 'custom',
      enabled: stored.enabled,
      audience: stored.audience,
      options,
      envSet: Object.fromEntries((entry?.env ?? []).map((item) => [item.name, Boolean(stored.env[item.name] || process.env[item.name])])),
      missingEnv: missing,
      installed,
      active: stored.enabled && installed && missing.length === 0,
      projectIds: stored.projectIds ?? [],
      entry,
      custom: stored.custom,
    });
  }
  // A discovered server sharing an id with a catalogue or custom entry loses
  // it: two rows with one id would leave it open which of the two a switch on
  // the page or `set_tool_server` actually starts. The entry out of this
  // config wins; the other is dropped rather than listed beside it.
  for (const state of externalServerStates(config)) {
    if (seen.has(state.id)) continue;
    seen.add(state.id);
    states.push(state);
  }
  return states;
}

/**
 * The MCP servers found in the Claude Code on this machine.
 *
 * They are listed whether or not anybody wants them - seeing what is there
 * is the point - but they only ever run once a person has said so. That is
 * why `approvalRequired` is set: unlike a catalogue entry, the assistant
 * cannot flip this switch itself. A server is a process out of somebody
 * else's plugin, which is a decision, not a convenience.
 */
export function externalServerStates(config: RookeryConfig): ToolServerState[] {
  const scan = externalScan({ enabled: config.external.enabled });
  return scan.servers.map((server) => {
    const stored = config.external.servers[server.id];
    const changed = Boolean(stored?.enabled && stored.fingerprint !== server.fingerprint);
    const enabled = Boolean(stored?.enabled);
    return {
      id: server.id,
      name: server.name,
      description:
        server.transport === 'stdio'
          ? [server.command, ...server.args].filter(Boolean).join(' ')
          : server.transport.toUpperCase() + ' ' + (server.url ?? ''),
      homepage: '',
      install: 'external',
      enabled,
      audience: stored?.audience ?? 'assistant',
      options: {},
      envSet: {},
      missingEnv: [],
      installed: true,
      active: enabled && !changed,
      projectIds: stored?.projectIds ?? [],
      external: server,
      source: server.label,
      changed,
      approvalRequired: true,
    };
  });
}

/* ------------------------- subagents, hooks, plugins ------------------------ */

/**
 * The same deal `externalServerStates` strikes, for the three things beside
 * the MCP servers that a Claude Code installation offers.
 *
 * All of them are listed whether or not anybody wants them, none of them is
 * ever handed to a turn until a person said so, and every approval is tied to
 * a fingerprint of what was approved: a subagent whose frontmatter moved on,
 * or a `hooks.json` edited afterwards, goes back to inactive and waits for
 * somebody to look again. `approvalRequired` is implicit here - there is no
 * tool that could flip these at all, only the page.
 */

export interface ExternalAgentState extends ExternalAgentRef {
  enabled: boolean;
  audience: ToolServerAudience;
  /** Approved, and still what was approved. */
  active: boolean;
  /** Approved once, but the file has moved on since. */
  changed: boolean;
}

export interface ExternalHookState extends ExternalHookSet {
  enabled: boolean;
  audience: ToolServerAudience;
  active: boolean;
  changed: boolean;
}

/** The "load the whole plugin" switch for one source. */
export interface ExternalPluginState {
  sourceId: string;
  label: string;
  /** The folder `--plugin-dir` would be given. */
  installPath: string;
  loadWhole: boolean;
  audience: ToolServerAudience;
  active: boolean;
  changed: boolean;
}

/** Sources that can be loaded whole: a plugin has a folder, a home shelf has not. */
function pluginSources(config: RookeryConfig): ExternalSource[] {
  const scan = externalScan({ enabled: config.external.enabled });
  return scan.sources.filter((source) => source.origin === 'plugin' && Boolean(source.installPath));
}

/**
 * What a whole-plugin approval is taken over. The folder alone is not enough:
 * a plugin can be updated in place, same path, different hooks. The
 * fingerprint therefore folds in what the scan saw inside - every subagent
 * and hook set of that source - so an edit in any of them re-locks the
 * whole-plugin switch until somebody approves the new state.
 */
const pluginFingerprint = (source: ExternalSource): string => {
  const scan = externalScan({ enabled: true });
  const agents = (scan.agents ?? []).filter((agent) => agent.sourceId === source.id).map((agent) => agent.fingerprint);
  const hooks = (scan.hooks ?? []).filter((set) => set.sourceId === source.id).map((set) => set.fingerprint);
  return fingerprintOf(['plugin', source.id, source.installPath ?? '', ...agents, ...hooks]);
};

export function externalAgentStates(config: RookeryConfig): ExternalAgentState[] {
  const scan = externalScan({ enabled: config.external.enabled });
  const stored = config.external.agents ?? {};
  return (scan.agents ?? []).map((agent) => {
    const decision = stored[agent.id];
    const changed = Boolean(decision?.enabled && decision.fingerprint !== agent.fingerprint);
    const enabled = Boolean(decision?.enabled);
    return {
      ...agent,
      enabled,
      audience: decision?.audience ?? 'assistant',
      active: enabled && !changed,
      changed,
    };
  });
}

export function externalHookStates(config: RookeryConfig): ExternalHookState[] {
  const scan = externalScan({ enabled: config.external.enabled });
  const stored = config.external.hooks ?? {};
  return (scan.hooks ?? []).map((set) => {
    const decision = stored[set.sourceId];
    const changed = Boolean(decision?.enabled && decision.fingerprint !== set.fingerprint);
    const enabled = Boolean(decision?.enabled);
    return {
      ...set,
      enabled,
      audience: decision?.audience ?? 'assistant',
      active: enabled && !changed,
      changed,
    };
  });
}

export function externalPluginStates(config: RookeryConfig): ExternalPluginState[] {
  const stored = config.external.plugins ?? {};
  return pluginSources(config).map((source) => {
    const decision = stored[source.id];
    const print = pluginFingerprint(source);
    const changed = Boolean(decision?.loadWhole && decision.fingerprint !== print);
    const loadWhole = Boolean(decision?.loadWhole);
    return {
      sourceId: source.id,
      label: source.label,
      installPath: source.installPath ?? '',
      loadWhole,
      audience: decision?.audience ?? 'assistant',
      active: loadWhole && !changed,
      changed,
    };
  });
}

/**
 * A config patch with one approval changed; pure, like `withToolServer`, so
 * the caller decides how to persist it. Null means there is no such thing on
 * this machine - the route answers 404 rather than storing a decision about
 * something nobody can point at.
 *
 * The fingerprint is always taken from the scan, never from the caller:
 * approving is approving what is there now, and the browser has no say in
 * what "now" looks like.
 */
export function withExternalApproval(
  config: RookeryConfig,
  kind: 'agent' | 'hook' | 'plugin',
  id: string,
  patch: { enabled?: boolean; audience?: ToolServerAudience; loadWhole?: boolean },
): Partial<RookeryConfig> | null {
  const scan = externalScan({ enabled: config.external.enabled });

  if (kind === 'plugin') {
    const source = pluginSources(config).find((entry) => entry.id === id);
    if (!source) return null;
    const stored = config.external.plugins?.[id];
    const loadWhole = patch.loadWhole ?? stored?.loadWhole ?? false;
    return {
      external: {
        ...config.external,
        plugins: {
          ...(config.external.plugins ?? {}),
          [id]: {
            // One switch on the page, two fields in the config: `loadWhole`
            // says what it means, `enabled` keeps the shape of every other
            // approval so nothing has to special-case it.
            enabled: loadWhole,
            loadWhole,
            audience: patch.audience ?? stored?.audience ?? 'assistant',
            fingerprint: pluginFingerprint(source),
          },
        },
      },
    };
  }

  const found =
    kind === 'agent'
      ? (scan.agents ?? []).find((agent) => agent.id === id)
      : (scan.hooks ?? []).find((set) => set.sourceId === id);
  if (!found) return null;
  const table = kind === 'agent' ? (config.external.agents ?? {}) : (config.external.hooks ?? {});
  const stored = table[id];
  const entry = {
    enabled: patch.enabled ?? stored?.enabled ?? false,
    audience: patch.audience ?? stored?.audience ?? 'assistant',
    // Only a switch that faces the content re-approves it. An audience change
    // or an empty patch keeps the fingerprint the approval was taken over, so
    // a file edited in the meantime stays `changed` and locked out until
    // somebody looks at it again - a dropdown is not a second look.
    fingerprint: patch.enabled === true ? found.fingerprint : (stored?.fingerprint ?? found.fingerprint),
  };
  return {
    external: {
      ...config.external,
      ...(kind === 'agent'
        ? { agents: { ...(config.external.agents ?? {}), [id]: entry } }
        : { hooks: { ...(config.external.hooks ?? {}), [id]: entry } }),
    },
  };
}

/**
 * Rookery's own floor under every turn, hooks or no hooks.
 *
 * Until now `full` meant `--dangerously-skip-permissions` and there was
 * nothing between that and `write`. This list is the something: the handful
 * of commands that are never a legitimate step of an assignment, and the
 * places outside a project that an agent has no business writing to - the
 * CLI's own configuration among them, since an agent that may edit
 * `~/.claude/settings.json` can rewrite the rules it runs under.
 *
 * It is a floor, not a fence. The Bash rules match on a command prefix, so a
 * spelling nobody listed still gets through; what this removes is the
 * accident, not the determined shell. Every entry is a form the provider
 * documents - `Tool(prefix:*)` for a command, a gitignore-style path for a
 * file - because a rule it cannot parse would take the whole settings
 * document, hooks included, down with it.
 */
export const PERMISSION_DENY_BASELINE: readonly string[] = [
  'Bash(rm -rf:*)',
  'Bash(rm -fr:*)',
  'Bash(sudo:*)',
  'Bash(doas:*)',
  'Bash(mkfs:*)',
  'Bash(dd:*)',
  'Bash(shutdown:*)',
  'Bash(reboot:*)',
  'Bash(git push --force:*)',
  'Bash(git push -f:*)',
  // Outside any project: keys, the CLI's own rules, the shell's own startup.
  'Read(~/.ssh/**)',
  'Edit(~/.ssh/**)',
  'Write(~/.ssh/**)',
  'Edit(~/.aws/**)',
  'Write(~/.aws/**)',
  'Edit(~/.claude/**)',
  'Write(~/.claude/**)',
  'Edit(~/.bashrc)',
  'Write(~/.bashrc)',
  'Edit(~/.profile)',
  'Write(~/.profile)',
  'Edit(//etc/**)',
  'Write(//etc/**)',
  // Rookery's own bookkeeping, for the same reason as the CLI's: config.json
  // holds the external approval table, so a turn that may write it can enable
  // a plugin - hooks included - without anybody clicking a switch. The
  // workspace under ~/.rookery stays open on purpose: files land there by
  // design, and the memory bank is not writable through these tools anyway.
  'Read(~/.rookery/config.json)',
  'Edit(~/.rookery/config.json)',
  'Write(~/.rookery/config.json)',
  'Read(~/.rookery/voice-keys.json)',
  'Edit(~/.rookery/voice-keys.json)',
  'Write(~/.rookery/voice-keys.json)',
  'Edit(~/.rookery/rookery.db)',
  'Write(~/.rookery/rookery.db)',
];

/**
 * What a turn gets from the Claude Code installation beyond MCP servers:
 * approved subagent types, approved hook sets, and the plugin folders
 * somebody trusts outright - plus the permission floor above, which rides
 * the same settings document whether or not a hook was ever approved.
 *
 * Called once per turn next to `toolServersFor`, and it reads from disk:
 * the prompt body of an agent, and `hooks.json` again. The second read is
 * the point - the scan is cached for minutes, and only bytes that still
 * match the approved fingerprint are handed to a spawn.
 */
export function externalTurnExtras(
  config: RookeryConfig,
  who: 'assistant' | 'agent',
): {
  handoffAgents?: ProviderAgentFile[];
  settings: ProviderSettings;
  hooks?: ProviderHookTable;
  pluginDirs?: string[];
} {
  const settings: ProviderSettings = { permissions: { deny: [...PERMISSION_DENY_BASELINE] } };
  if (!config.external.enabled) return { settings };

  // A source loaded whole brings its own skills, agents and hooks with it;
  // handing the curated copies over as well would put the same shelf in the
  // turn twice, under two names. Loading a folder whole cannot load half of
  // it: `--plugin-dir` brings the hooks along whatever the per-capability
  // switches say, so a source whose hook set exists but is not approved for
  // this audience is left out entirely for that audience - the hook approval
  // is the gate the plan set, and a convenience switch must not route around
  // it. Subagents and skills come back the moment the hooks are approved too.
  const hookStates = externalHookStates(config);
  const hookSetFor = (sourceId: string): ExternalHookState | undefined =>
    hookStates.find((set) => set.sourceId === sourceId);
  const whole = externalPluginStates(config).filter((state) => {
    if (!state.active || !serves(state.audience, who)) return false;
    const hooks = hookSetFor(state.sourceId);
    return !hooks || (hooks.active && serves(hooks.audience, who));
  });
  const loadedWhole = new Set(whole.map((state) => state.sourceId));
  const pluginDirs = whole.map((state) => state.installPath).filter(Boolean);

  const handoffAgents: ProviderAgentFile[] = [];
  const taken = new Set<string>();
  for (const state of externalAgentStates(config)) {
    if (!state.active || !serves(state.audience, who) || loadedWhole.has(state.sourceId)) continue;
    // Two plugins may name a subagent the same thing; the model has one name
    // per agent, so the first one keeps it.
    if (taken.has(state.name)) continue;
    const file = readAgentFile(state.path, state.sourceId);
    // Gone, unreadable, or edited since it was approved: left out silently,
    // exactly as an approval that no longer matches should behave.
    if (!file || file.ref.fingerprint !== state.fingerprint || !file.prompt) continue;
    taken.add(state.name);
    handoffAgents.push({ name: state.name, path: state.path });
  }

  const hooks: ProviderHookTable = {};
  for (const state of hookStates) {
    if (!state.active || !serves(state.audience, who) || loadedWhole.has(state.sourceId)) continue;
    const doc = readHookDocument(state.path);
    if (!doc || doc.fingerprint !== state.fingerprint) continue;
    for (const [event, value] of Object.entries(doc.table)) {
      if (!Array.isArray(value)) continue;
      hooks[event] = [...(hooks[event] ?? []), ...value];
    }
  }

  return {
    ...(handoffAgents.length ? { handoffAgents } : {}),
    settings,
    ...(Object.keys(hooks).length ? { hooks } : {}),
    ...(pluginDirs.length ? { pluginDirs } : {}),
  };
}

/**
 * Sources whose whole-plugin switch is on for somebody. The skills shelf uses
 * this to keep the curated copies out of the prompt: a source loaded whole
 * brings its own skills with it, and the same shelf twice is noise twice.
 */
export function loadWholeSourceIds(config: RookeryConfig): Set<string> {
  if (!config.external.enabled) return new Set();
  return new Set(externalPluginStates(config).filter((state) => state.loadWhole).map((state) => state.sourceId));
}

const serves = (audience: ToolServerAudience, who: 'assistant' | 'agent'): boolean =>
  audience === 'both' || (who === 'assistant' ? audience === 'assistant' : audience === 'agents');

/** Whether a server's project scope covers this turn: unscoped serves everyone. */
const scoped = (projectIds: string[], projectId: string | undefined): boolean =>
  projectIds.length === 0 || (projectId !== undefined && projectIds.includes(projectId));

/** The servers one audience gets this turn, and the prompt paragraphs that go with them. */
export function toolServersFor(
  config: RookeryConfig,
  who: 'assistant' | 'agent',
  provider?: ProviderId,
  projectId?: string,
): { specs: McpServerSpec[]; hints: string[] } {
  const specs: McpServerSpec[] = [];
  const hints: string[] = [];
  for (const state of toolServerStates(config)) {
    if (!state.active || !serves(state.audience, who) || !scoped(state.projectIds, projectId)) continue;
    const stored = toolServerConfig(config, state.id);
    let spec: McpServerSpec | null = null;
    let hint = '';
    if (state.external) {
      const server = state.external;
      spec = {
        name: server.name,
        transport: server.transport,
        args: server.args,
        env: server.env,
        ...(server.transport === 'stdio' ? { command: server.command } : { url: server.url, headers: server.headers }),
      };
      hint =
        'The MCP server ' + server.name + ' is attached, the one installed in ' + server.label +
        '; its tools arrive as mcp__' + server.name + '__*.';
    } else if (state.entry) {
      spec = state.entry.spec({ config, options: state.options, env: stored.env, provider });
      hint = state.entry.hint(state.options);
    } else if (stored.custom) {
      spec = { name: state.id, command: stored.custom.command, args: stored.custom.args, env: stored.env };
      hint = stored.custom.hint;
    }
    if (!spec || RESERVED.has(spec.name)) continue;
    specs.push(spec);
    if (hint) hints.push(hint);
  }
  return { specs, hints };
}

/**
 * What the assistant could reach this turn but does not have attached.
 *
 * Without this paragraph the model is blind to its own reach: a server that
 * is switched off simply does not exist in the prompt, so the obvious detour
 * around a wall - attach the browser and carry on - never occurs to it. The
 * distinction that matters is between a server it can attach itself and one
 * that needs the user on the Tools page; only the second is a real wall,
 * and then the model can say exactly what is missing.
 *
 * Agents get nothing here: only the assistant may flip a switch. A server
 * scoped to other projects is left out entirely rather than listed as
 * blocked - it is not a wall in this conversation, it simply belongs
 * elsewhere.
 */
export function dormantToolsHint(config: RookeryConfig, who: 'assistant' | 'agent', projectId?: string): string {
  if (who !== 'assistant') return '';
  const ready: string[] = [];
  const blocked: string[] = [];
  // Servers out of the two CLIs are counted, not listed: there are a dozen of
  // them, none is one sentence away, and naming them all would be a paragraph
  // about doors the assistant cannot open.
  let installedElsewhere = 0;
  for (const state of toolServerStates(config)) {
    if (state.active && serves(state.audience, 'assistant')) continue;
    if (!scoped(state.projectIds, projectId)) continue;
    if (state.approvalRequired) {
      installedElsewhere += 1;
      continue;
    }
    const what = state.id + ' (' + state.name + ')';
    if (!state.installed) blocked.push(what + ': not installed on this machine');
    else if (state.missingEnv.length) blocked.push(what + ': needs ' + state.missingEnv.join(', '));
    else ready.push(what);
  }
  if (!ready.length && !blocked.length && !installedElsewhere) return '';

  const lines = ['Tools you do not have in this turn but can reach:'];
  if (ready.length) {
    lines.push(
      'ready to attach with set_tool_server: ' + ready.join(', ') + '.',
      'Attaching one is yours to decide and needs no approval from anyone. The turn does not end there:',
      'after you attach a server the work continues with it available, so switch it on and go on',
      'with the job instead of announcing it and stopping.',
    );
  }
  if (blocked.length) {
    lines.push(
      'out of reach until the user acts on the Tools page: ' + blocked.join('; ') + '.',
      'When one of these is the only route left, name exactly what is missing.',
    );
  }
  if (installedElsewhere) {
    lines.push(
      installedElsewhere + ' further MCP servers are installed in the Claude Code on this machine.',
      'Those are not yours to switch on - starting somebody else\'s server is the user\'s decision,',
      'and they make it on the Tools page. Say so if one of them is what a task needs.',
    );
  }
  return lines.join(' ');
}

/**
 * A config patch with one server changed; pure, so callers decide how to
 * persist it. Which block it lands in depends on the server: a catalogue or
 * custom entry lives under `tools`, a server discovered in Claude Code
 * under `external` - what was decided about somebody else's server is
 * a decision, not a copy of their configuration.
 */
export function withToolServer(
  config: RookeryConfig,
  id: string,
  patch: Partial<Pick<ToolServerConfig, 'enabled' | 'audience' | 'options' | 'env' | 'custom' | 'projectIds'>>,
): Partial<RookeryConfig> {
  const discovered = externalScan({ enabled: config.external.enabled }).servers.find((server) => server.id === id);
  if (discovered) {
    const stored = config.external.servers[id];
    return {
      external: {
        ...config.external,
        servers: {
          ...config.external.servers,
          [id]: {
            enabled: patch.enabled ?? stored?.enabled ?? false,
            audience: patch.audience ?? stored?.audience ?? 'assistant',
            ...(patch.projectIds !== undefined
              ? { projectIds: patch.projectIds }
              : stored?.projectIds
                ? { projectIds: stored.projectIds }
                : {}),
            // Approving is approving what is there now: a later edit in the
            // CLI's own configuration takes the server out of service.
            fingerprint: discovered.fingerprint,
          },
        },
      },
    };
  }

  const current = toolServerConfig(config, id);
  const next: ToolServerConfig = {
    ...current,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.audience ? { audience: patch.audience } : {}),
    options: { ...current.options, ...(patch.options ?? {}) },
    env: { ...current.env, ...(patch.env ?? {}) },
    ...(patch.custom ? { custom: patch.custom } : {}),
    ...(patch.projectIds !== undefined ? { projectIds: patch.projectIds } : {}),
  };
  // An empty value removes a key, so a cleared API key does not linger.
  for (const [key, value] of Object.entries(next.env)) if (!value) delete next.env[key];
  const servers = config.tools.servers.filter((server) => server.id !== id);
  servers.push(next);
  return { tools: { ...config.tools, servers } };
}

/**
 * A config patch without one server: custom entries vanish, catalogue entries
 * go back to defaults, and a discovered one forgets that it was ever
 * approved - it keeps being found, it just counts as undecided again.
 */
export function withoutToolServer(config: RookeryConfig, id: string): Partial<RookeryConfig> {
  if (id in config.external.servers) {
    const servers = { ...config.external.servers };
    delete servers[id];
    return { external: { ...config.external, servers } };
  }
  return { tools: { ...config.tools, servers: config.tools.servers.filter((server) => server.id !== id) } };
}

/** A slug for a custom server id; never one of the bundled names. */
export function customToolId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return 'custom-' + (slug || 'server');
}

/** The lines the assistant reads when it asks for the hub. */
export function renderToolServers(states: ToolServerState[]): string {
  if (!states.length) return 'No tool servers.';
  return states
    .map((state) => {
      const status = !state.installed
        ? 'not installed'
        : state.missingEnv.length
          ? 'needs ' + state.missingEnv.join(', ')
          : state.enabled
            ? 'on'
            : 'off';
      return '- ' + state.id + ' (' + state.name + '): ' + status + ', for ' + state.audience +
        (Object.keys(state.options).length
          ? ', ' + Object.entries(state.options).map(([key, value]) => key + '=' + value).join(' ')
          : '');
    })
    .join('\n');
}
