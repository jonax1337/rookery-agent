import type { McpServerSpec, ProviderId, RookeryConfig, ToolServerAudience, ToolServerConfig } from '../types.js';
import { TOOL_CATALOG, catalogEntry, type ToolCatalogEntry } from './catalog.js';
import { externalScan } from '../external/discovery.js';
import type { ExternalMcpServer } from '../external/shared.js';

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
 * Run every active server's `ensure` hook for one audience before a turn:
 * a shared browser comes up here. Failures are logged by the caller's
 * silence; a server that cannot prepare simply behaves as before.
 */
export async function ensureToolServers(
  config: RookeryConfig,
  who: 'assistant' | 'agent',
  provider?: ProviderId,
  projectId?: string,
  onError?: (id: string, error: Error) => void,
): Promise<void> {
  const jobs = toolServerStates(config)
    .filter(
      (state) => state.active && serves(state.audience, who) && scoped(state.projectIds, projectId) && state.entry?.ensure,
    )
    .map(async (state) => {
      const stored = toolServerConfig(config, state.id);
      try {
        await state.entry?.ensure?.({ config, options: state.options, env: stored.env, provider });
      } catch (error) {
        onError?.(state.id, error as Error);
      }
    });
  await Promise.all(jobs);
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
