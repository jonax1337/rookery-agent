import type { McpServerSpec, ProviderId, RookeryConfig, ToolServerAudience, ToolServerConfig } from '../types.js';
import { TOOL_CATALOG, catalogEntry, type ToolCatalogEntry } from './catalog.js';

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
  install: 'bundled' | 'on-demand' | 'custom';
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
  entry?: ToolCatalogEntry;
  custom?: ToolServerConfig['custom'];
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
      entry,
      custom: stored.custom,
    });
  }
  return states;
}

const serves = (audience: ToolServerAudience, who: 'assistant' | 'agent'): boolean =>
  audience === 'both' || (who === 'assistant' ? audience === 'assistant' : audience === 'agents');

/** The servers one audience gets this turn, and the prompt paragraphs that go with them. */
export function toolServersFor(
  config: RookeryConfig,
  who: 'assistant' | 'agent',
  provider?: ProviderId,
): { specs: McpServerSpec[]; hints: string[] } {
  const specs: McpServerSpec[] = [];
  const hints: string[] = [];
  for (const state of toolServerStates(config)) {
    if (!state.active || !serves(state.audience, who)) continue;
    const stored = toolServerConfig(config, state.id);
    let spec: McpServerSpec | null = null;
    let hint = '';
    if (state.entry) {
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
 * that needs the user on the Werkzeuge page; only the second is a real wall,
 * and then the model can say exactly what is missing.
 *
 * Agents get nothing here: only the assistant may flip a switch.
 */
export function dormantToolsHint(config: RookeryConfig, who: 'assistant' | 'agent'): string {
  if (who !== 'assistant') return '';
  const ready: string[] = [];
  const blocked: string[] = [];
  for (const state of toolServerStates(config)) {
    if (state.active && serves(state.audience, 'assistant')) continue;
    const what = state.id + ' (' + state.name + ')';
    if (!state.installed) blocked.push(what + ': not installed on this machine');
    else if (state.missingEnv.length) blocked.push(what + ': needs ' + state.missingEnv.join(', '));
    else ready.push(what);
  }
  if (!ready.length && !blocked.length) return '';

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
      'out of reach until the user acts on the Werkzeuge page: ' + blocked.join('; ') + '.',
      'When one of these is the only route left, name exactly what is missing.',
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
  onError?: (id: string, error: Error) => void,
): Promise<void> {
  const jobs = toolServerStates(config)
    .filter((state) => state.active && serves(state.audience, who) && state.entry?.ensure)
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

/** A new `tools` block with one server changed; pure, so callers decide how to persist it. */
export function withToolServer(
  config: RookeryConfig,
  id: string,
  patch: Partial<Pick<ToolServerConfig, 'enabled' | 'audience' | 'options' | 'env' | 'custom'>>,
): RookeryConfig['tools'] {
  const current = toolServerConfig(config, id);
  const next: ToolServerConfig = {
    ...current,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.audience ? { audience: patch.audience } : {}),
    options: { ...current.options, ...(patch.options ?? {}) },
    env: { ...current.env, ...(patch.env ?? {}) },
    ...(patch.custom ? { custom: patch.custom } : {}),
  };
  // An empty value removes a key, so a cleared API key does not linger.
  for (const [key, value] of Object.entries(next.env)) if (!value) delete next.env[key];
  const servers = config.tools.servers.filter((server) => server.id !== id);
  servers.push(next);
  return { ...config.tools, servers };
}

/** A `tools` block without one server: custom entries vanish, catalogue entries go back to defaults. */
export function withoutToolServer(config: RookeryConfig, id: string): RookeryConfig['tools'] {
  return { ...config.tools, servers: config.tools.servers.filter((server) => server.id !== id) };
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
