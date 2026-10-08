import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ProviderProfile } from '../types.js';
import {
  ANTHROPIC_URL,
  BRIDGE_TOKEN_HEADER,
  isCodexModel,
  relayRequest,
  sharedCodexBridge,
} from './codex-bridge.js';
import { LoopbackServer, readBody, sendError, sendFailure, type LoopbackEndpoint } from './loopback-server.js';

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
  readonly #loopback = new LoopbackServer('model gateway', (request, response) => this.#handle(request, response));
  readonly #options: ModelGatewayOptions;

  constructor(options: ModelGatewayOptions) {
    this.#options = options;
  }

  /** Start once; where to point Claude Code, and the token its header must carry. */
  start(): Promise<LoopbackEndpoint> {
    return this.#loopback.start();
  }

  close(): Promise<void> {
    return this.#loopback.close();
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

      if (route.kind !== 'anthropic' && request.headers[BRIDGE_TOKEN_HEADER] !== this.#loopback.token) {
        sendError(response, 401, 'authentication_error');
        return;
      }

      if (route.kind === 'codex') await relayToCodex(request, raw, response);
      else if (route.kind === 'profile') await relayToProfile(route.profile, request, raw, response);
      else await relayRequest(request, raw, response, ANTHROPIC_URL);
    } catch (error) {
      sendFailure(response, 502, error);
    }
  }
}

async function relayToCodex(request: IncomingMessage, raw: string, response: ServerResponse): Promise<void> {
  const bridge = await sharedCodexBridge.start();
  await relayRequest(request, raw, response, bridge.baseUrl, (headers) => {
    headers.delete('authorization');
    headers.delete('x-api-key');
    headers.set(BRIDGE_TOKEN_HEADER, bridge.token);
  });
}

async function relayToProfile(
  profile: ProviderProfile,
  request: IncomingMessage,
  raw: string,
  response: ServerResponse,
): Promise<void> {
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
}

function modelOf(raw: string): string | undefined {
  try {
    const body = JSON.parse(raw) as { model?: unknown };
    return typeof body.model === 'string' ? body.model : undefined;
  } catch {
    return undefined;
  }
}
