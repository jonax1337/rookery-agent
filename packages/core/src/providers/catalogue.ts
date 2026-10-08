import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { ProviderId, ProviderModel } from '../types.js';
import { spawnCli, readJsonLines, type ResolvedBinary } from './process.js';

const DISCOVERY_TIMEOUT_MS = 20000;
const MODEL_PAGE_SIZE = 100;

const CLAUDE_DISCOVERY_ARGS = [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
];
const CODEX_DISCOVERY_ARGS = ['app-server'];

interface DiscoverySession {
  send(frame: unknown): void;
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/** Query CLI metadata only: no prompt, model turn, or API credentials. */
export async function discoverModels(
  provider: ProviderId,
  binary: ResolvedBinary,
  env?: NodeJS.ProcessEnv,
): Promise<ProviderModel[]> {
  const session = openDiscoverySession(provider, binary, env);
  try {
    return provider === 'claude' ? await discoverClaudeModels(session) : await discoverCodexModels(session);
  } finally {
    await session.close();
  }
}

async function discoverClaudeModels(session: DiscoverySession): Promise<ProviderModel[]> {
  const response = await session.request('initialize', {});
  return parseModels('claude', response.models);
}

async function discoverCodexModels(session: DiscoverySession): Promise<ProviderModel[]> {
  await session.request('initialize', { clientInfo: { name: 'rookery', version: '0.1.0' } });
  session.send({ method: 'initialized', params: {} });
  const { account } = await session.request('account/read', {});
  if ((account as Record<string, unknown> | undefined)?.type !== 'chatgpt') {
    throw new Error('Sign in with codex login to load your models.');
  }
  const models: ProviderModel[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await session.request('model/list', {
      limit: MODEL_PAGE_SIZE,
      includeHidden: false,
      ...(cursor ? { cursor } : {}),
    });
    models.push(...parseModels('codex', page.data));
    cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
    if (cursor && cursors.has(cursor)) throw new Error('The model catalogue repeated a page. Please retry.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return models;
}

function openDiscoverySession(
  provider: ProviderId,
  binary: ResolvedBinary,
  env: NodeJS.ProcessEnv | undefined,
): DiscoverySession {
  const cwd = join(homedir(), '.rookery', 'workspace');
  mkdirSync(cwd, { recursive: true });
  const handle = spawnCli(binary, {
    cwd, interactive: true, env,
    args: provider === 'claude' ? CLAUDE_DISCOVERY_ARGS : CODEX_DISCOVERY_ARGS,
  });
  const timer = setTimeout(() => handle.child.kill(), DISCOVERY_TIMEOUT_MS);
  const lines = readJsonLines(handle.child.stdout);
  // Observe spawn failures immediately, including before the first response.
  let processError: unknown;
  void handle.done.catch((error: unknown) => { processError = error; });
  handle.child.stdin.on('error', () => {});
  let sequence = 0;
  const send = (frame: unknown): void => {
    handle.child.stdin.write(JSON.stringify(frame) + '\n');
  };
  return {
    send,
    async request(method, params) {
      const id = String(++sequence);
      send(requestFrame(provider, id, method, params));
      while (true) {
        const next = await lines.next();
        if (next.done) throw processError ?? new Error('Model discovery ended before the CLI replied. Please retry.');
        const reply = replyTo(provider, next.value, id);
        if (reply) return reply;
      }
    },
    async close() {
      clearTimeout(timer);
      handle.child.stdin.end();
      handle.child.kill();
      await handle.done.catch(() => {});
    },
  };
}

function requestFrame(provider: ProviderId, id: string, method: string, params: Record<string, unknown>): unknown {
  return provider === 'claude'
    ? { type: 'control_request', request_id: id, request: { subtype: method, ...params } }
    : { id, method, params };
}

/** The payload answering request `id`; null for a frame that belongs to something else. */
function replyTo(provider: ProviderId, frame: Record<string, unknown>, id: string): Record<string, unknown> | null {
  if (provider === 'claude') {
    const response = frame.response as Record<string, unknown> | undefined;
    if (frame.type !== 'control_response' || response?.request_id !== id) return null;
    if (response.subtype !== 'success') throw new Error('Claude model discovery failed. Please retry.');
    return (response.response ?? {}) as Record<string, unknown>;
  }
  if (String(frame.id) !== id) return null;
  if (frame.error) throw new Error('Codex model discovery failed. Please retry.');
  return (frame.result ?? {}) as Record<string, unknown>;
}

export function parseModels(provider: ProviderId, value: unknown): ProviderModel[] {
  if (!Array.isArray(value)) throw new Error('The CLI returned no model catalogue. Please retry.');
  const defaultRow = provider === 'claude' ? value.find((row) => row?.value === 'default') : undefined;
  const defaultTarget = defaultRow && value.find((row) => row?.value !== 'default' &&
    typeof row?.resolvedModel === 'string' && row.resolvedModel === defaultRow.resolvedModel);
  return value.flatMap((row: Record<string, unknown>) => {
    if (!row || typeof row !== 'object') return [];
    if (row === defaultRow && defaultTarget) return [];
    const id = provider === 'claude' ? (row.value === 'default' ? row.resolvedModel : row.value) : row.model;
    if (typeof id !== 'string' || !id) return [];
    const description = typeof row.description === 'string' ? row.description : undefined;
    // Claude's displayName is a family alias; its description names the actual version.
    const name = provider === 'claude' && description?.includes(' · ')
      ? description.split(' · ')[0]!
      : typeof row.displayName === 'string' ? row.displayName : id;
    return [{ id, name, description, isDefault: row.isDefault === true || row === defaultRow || row === defaultTarget }];
  });
}
