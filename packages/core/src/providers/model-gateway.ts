import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { ProviderProfile } from '../types.js';
import { BRIDGE_TOKEN_HEADER, isCodexModel, relayRequest, sharedCodexBridge } from './codex-bridge.js';

/**
 * One Anthropic-Messages endpoint for every model Rookery knows.
 *
 * Claude Code sends every request to a single `ANTHROPIC_BASE_URL`, so a
 * terminal started on Claude could never reach GPT or GLM - `/model` inside
 * the TUI only ever picked among one backend's names. This gateway sits in
 * that one slot and routes each turn by the model it names:
 *
 * - a ChatGPT slug goes to the Codex bridge (the `codex login` session);
 * - a model a directly reachable profile serves (z.ai's `glm-*`, say) goes
 *   to that profile's endpoint, with that profile's key in place of the
 *   caller's credential;
 * - everything else - every `claude-*`, the aliases, count_tokens, whatever
 *   Claude Code asks along the way - goes to `api.anthropic.com` untouched,
 *   the caller's own Claude.ai login included.
 *
 * The last point is what makes it usable at all: Claude Code keeps sending
 * its subscription login to a custom base URL as long as no API key is set,
 * so the Claude models stay on the person's own plan.
 *
 * The routes that spend somebody else's session (ChatGPT, a profile's key)
 * require the gateway's token, which rides in `BRIDGE_TOKEN_HEADER` via
 * `ANTHROPIC_CUSTOM_HEADERS`; loopback is shared with every other process on
 * the machine. The Anthropic route needs none - Anthropic checks the
 * caller's own credential.
 */

/** Where one model's turns go. */
export type GatewayRoute =
  | { kind: 'anthropic' }
  | { kind: 'codex' }
  | { kind: 'profile'; profile: ProviderProfile };

export interface ModelGatewayOptions {
  /** Profiles reachable directly (`via: 'direct'`), with the model ids each serves. */
  profiles: () => { profile: ProviderProfile; models: string[] }[];
}

export class ModelGateway {
  #server: Server | undefined;
  #starting: Promise<{ baseUrl: string; token: string }> | undefined;
  #token = '';
  readonly #options: ModelGatewayOptions;

  constructor(options: ModelGatewayOptions) {
    this.#options = options;
  }

  /** Start once; where to point Claude Code, and the token its header must carry. */
  start(): Promise<{ baseUrl: string; token: string }> {
    this.#starting ??= new Promise((resolve, reject) => {
      this.#token = randomUUID();
      const server = createServer((request, response) => {
        void this.#handle(request, response);
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('The model gateway could not determine its own port.'));
          return;
        }
        this.#server = server;
        resolve({ baseUrl: 'http://127.0.0.1:' + address.port, token: this.#token });
      });
    });
    return this.#starting;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#starting = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Which backend a model name belongs to. Unknown names are Anthropic's. */
  route(model: string | undefined): GatewayRoute {
    if (!model) return { kind: 'anthropic' };
    if (isCodexModel(model)) return { kind: 'codex' };
    for (const entry of this.#options.profiles()) {
      if (entry.models.includes(model)) return { kind: 'profile', profile: entry.profile };
    }
    return { kind: 'anthropic' };
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const raw = request.method === 'POST' ? await readBody(request) : '';
      const path = (request.url ?? '').split('?')[0] ?? '';
      const model = path.startsWith('/v1/messages') ? modelOf(raw) : undefined;
      const route = this.route(model);

      if (route.kind !== 'anthropic' && request.headers[BRIDGE_TOKEN_HEADER] !== this.#token) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
        return;
      }

      if (route.kind === 'codex') {
        const bridge = await sharedCodexBridge.start();
        await relayRequest(request, raw, response, bridge.baseUrl, (headers) => {
          headers.delete('authorization');
          headers.delete('x-api-key');
          headers.set(BRIDGE_TOKEN_HEADER, bridge.token);
        });
        return;
      }

      if (route.kind === 'profile') {
        const { profile } = route;
        await relayRequest(request, raw, response, profile.baseUrl, (headers) => {
          headers.delete('x-api-key');
          headers.set('authorization', 'Bearer ' + profile.authToken);
          // The subscription login marks itself in the beta list; a backend
          // with its own key has no use for it and may refuse the unknown flag.
          const beta = (headers.get('anthropic-beta') ?? '')
            .split(',')
            .map((flag) => flag.trim())
            .filter((flag) => flag && !flag.startsWith('oauth'));
          if (beta.length) headers.set('anthropic-beta', beta.join(','));
          else headers.delete('anthropic-beta');
        });
        return;
      }

      await relayRequest(request, raw, response, 'https://api.anthropic.com');
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ type: 'error', error: { type: 'api_error', message: (error as Error).message } }),
        );
      } else {
        response.end();
      }
    }
  }
}

function modelOf(raw: string): string | undefined {
  try {
    const body = JSON.parse(raw) as { model?: unknown };
    return typeof body.model === 'string' ? body.model : undefined;
  } catch {
    return undefined;
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
