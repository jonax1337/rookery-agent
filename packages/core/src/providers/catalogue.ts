import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { ProviderId, ProviderModel } from '../types.js';
import { spawnCli, readJsonLines, type ResolvedBinary } from './process.js';

/** Query CLI metadata only: no prompt, model turn, or API credentials. */
export async function discoverModels(provider: ProviderId, binary: ResolvedBinary): Promise<ProviderModel[]> {
  const cwd = join(homedir(), '.rookery', 'workspace');
  mkdirSync(cwd, { recursive: true });
  const handle = spawnCli(binary, {
    cwd, interactive: true,
    args: provider === 'claude'
      ? ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
      : ['app-server'],
  });
  const timer = setTimeout(() => handle.child.kill(), 20000);
  const lines = readJsonLines(handle.child.stdout);
  // Observe spawn failures immediately, including before the first response.
  let processError: unknown;
  void handle.done.catch((error: unknown) => { processError = error; });
  handle.child.stdin.on('error', () => {});
  let sequence = 0;
  const send = (frame: unknown) => handle.child.stdin.write(JSON.stringify(frame) + '\n');
  const request = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = String(++sequence);
    send(provider === 'claude'
      ? { type: 'control_request', request_id: id, request: { subtype: method, ...params } }
      : { id, method, params });
    while (true) {
      const next = await lines.next();
      if (next.done) throw processError ?? new Error('Model discovery ended before the CLI replied. Please retry.');
      const frame = next.value;
      if (provider === 'claude') {
        const response = frame.response as Record<string, unknown> | undefined;
        if (frame.type !== 'control_response' || response?.request_id !== id) continue;
        if (response.subtype !== 'success') throw new Error('Claude model discovery failed. Please retry.');
        return response.response as Record<string, unknown>;
      }
      if (String(frame.id) !== id) continue;
      if (frame.error) throw new Error('Codex model discovery failed. Please retry.');
      return frame.result as Record<string, unknown>;
    }
  };
  try {
    if (provider === 'claude') {
      const response = await request('initialize', {});
      return parseModels(provider, response.models);
    }
    await request('initialize', { clientInfo: { name: 'rookery', version: '0.1.0' } });
    send({ method: 'initialized', params: {} });
    const account = await request('account/read', {});
    if (!(account.account as Record<string, unknown> | undefined)?.type ||
        (account.account as Record<string, unknown>).type !== 'chatgpt') {
      throw new Error('Sign in with codex login to load your models.');
    }
    const models: ProviderModel[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      models.push(...parseModels(provider, page.data));
      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
      if (cursor && cursors.has(cursor)) throw new Error('The model catalogue repeated a page. Please retry.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return models;
  } finally {
    clearTimeout(timer);
    handle.child.stdin.end();
    handle.child.kill();
    await handle.done.catch(() => {});
  }
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
