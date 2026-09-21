import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { sharedCodexSession, type CodexSession } from './codex-auth.js';
import { codexModels } from './provider-catalog.js';
import {
  TurnTranslator,
  readServerSentEvents,
  toResponsesRequest,
  type AnthropicRequest,
} from './codex-translate.js';

/**
 * A local Anthropic-Messages endpoint backed by the ChatGPT Codex backend.
 *
 * This is what lets the `claude` binary answer from a ChatGPT subscription:
 * Rookery points ANTHROPIC_BASE_URL at this server, it translates the turn,
 * calls the same endpoint the Codex CLI calls with the same session, and
 * streams the answer back in Anthropic's own event shape.
 *
 * It binds to loopback on a port the OS picks and requires the token minted at
 * startup - in `Authorization`, in `x-api-key`, or in `BRIDGE_TOKEN_HEADER` -
 * so nothing else on the machine can borrow the session through it.
 */

const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses';
/** Where a Claude slug goes in passthrough mode: Anthropic's own API, verbatim. */
const ANTHROPIC_URL = 'https://api.anthropic.com';
/** What the Codex CLI identifies as; see codex-rs/login/src/auth/default_client.rs. */
const ORIGINATOR = 'codex_cli_rs';
/** Stand-in release date for the model list; the Codex cache reports none. */
const MODEL_CREATED_AT = '1970-01-01T00:00:00Z';
/**
 * Where a passthrough caller carries the bridge token.
 *
 * `Authorization` cannot: in passthrough mode it holds `claude`'s own Anthropic
 * OAuth bearer, which the bridge deliberately neither reads nor manages. A
 * wrapper therefore puts the minted token in this header via the binary's
 * `ANTHROPIC_CUSTOM_HEADERS`, and both reach the bridge side by side.
 * Lowercase because `IncomingMessage.headers` is lowercased.
 */
export const BRIDGE_TOKEN_HEADER = 'x-openai-claude-bridge';

export interface CodexBridgeOptions {
  /**
   * Serve both accounts off one endpoint.
   *
   * Off (the default, and what every caller inside Rookery wants): every turn
   * goes to ChatGPT, and a model name the backend does not serve falls back to
   * the account's first slug. That is right for a session started deliberately
   * for GPT.
   *
   * On: only the account's own GPT slugs go to ChatGPT. Everything else -
   * `claude-*`, an unknown name, any path other than `POST /v1/messages` - is
   * forwarded to `api.anthropic.com` byte for byte, caller's credentials
   * included. That is what lets `claude` be wrapped permanently without the
   * wrapper taking over someone's Anthropic session.
   */
  passthrough?: boolean;
}

export class CodexBridge {
  #server: Server | undefined;
  #starting: Promise<{ baseUrl: string; token: string }> | undefined;
  #token = '';
  #baseUrl = '';
  readonly #session: CodexSession;
  readonly #passthrough: boolean;

  constructor(session: CodexSession = sharedCodexSession, options: CodexBridgeOptions = {}) {
    this.#session = session;
    this.#passthrough = options.passthrough === true;
  }

  /** Start once and return where to point a CLI. Idempotent. */
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
          reject(new Error('The Codex bridge could not determine its own port.'));
          return;
        }
        this.#server = server;
        this.#baseUrl = 'http://127.0.0.1:' + address.port;
        resolve({ baseUrl: this.#baseUrl, token: this.#token });
      });
    });
    return this.#starting;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#starting = undefined;
    if (!server) return;
    // `close` alone waits for every open connection to end, and a client that
    // keeps its socket alive - `claude` does - never ends it. Without this the
    // process hangs after the last turn instead of exiting.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const path = (request.url ?? '').split('?')[0] ?? '';
      const isMessages = request.method === 'POST' && path.startsWith('/v1/messages');
      // The turn itself, as opposed to `/v1/messages/count_tokens`, which shares
      // the prefix but is not something this bridge can translate.
      const isTurn = request.method === 'POST' && (path === '/v1/messages' || path === '/v1/messages/');
      // What the binary asks for its model list; it sends `/v1/models`,
      // `/v1/models/`, and both with `?limit=`/`?beta=`. Claude Code 2.1.263
      // does not consult it to validate a `/model` switch - it probes with a
      // one-token turn instead - but a bridge that claims to be the Messages
      // API should answer it, and anything reading the list gets the truth.
      const isModels = request.method === 'GET' && (path === '/v1/models' || path === '/v1/models/');

      // The body is read once, here, because the routing decision needs
      // `body.model` and a forwarded request needs the very same bytes.
      const raw = request.method === 'POST' ? await readBody(request) : '';
      const body = isMessages ? (parseJson(raw) as AnthropicRequest) : undefined;

      /**
       * Which account answers this.
       *
       * Deliberately made on the requested name alone, and deliberately made
       * before `resolveModel` ever sees it: `resolveModel` maps everything it
       * does not recognise onto the account's first GPT slug, so asking it
       * first would answer a `claude-*` turn - the one-token probe behind
       * `/model` included - out of ChatGPT and report success for a model that
       * was never asked. Only a slug the ChatGPT account actually serves goes
       * to ChatGPT; the rest is Anthropic's, byte for byte.
       */
      if (this.#passthrough && !(isTurn && isCodexModel(body?.model))) {
        await forwardToAnthropic(request, raw, response);
        return;
      }

      if (!isMessages && !isModels) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error' } }));
        return;
      }
      if (!this.#authorised(request)) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
        return;
      }

      if (isModels) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(modelList()));
        return;
      }

      await this.#turn(body as AnthropicRequest, response);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: (error as Error).message },
          }),
        );
      } else {
        response.end();
      }
    }
  }

  /**
   * Whether this caller may spend the ChatGPT session.
   *
   * One secret either way: the token minted at startup and handed out by
   * `start()`. What changes with passthrough is only where it rides. A caller
   * configured by us puts it in `Authorization` or `x-api-key`; `claude` under
   * the wrapper cannot, because those carry its own Anthropic credentials, so
   * it carries it in `BRIDGE_TOKEN_HEADER` instead.
   *
   * The check itself is not optional: the port is loopback, but every other
   * process on this machine is on loopback too, and without it any of them
   * could spend the ChatGPT subscription through this endpoint. Only turns
   * bound for ChatGPT get here - a forwarded Anthropic turn returns above,
   * authenticated by Anthropic against the caller's own credentials.
   */
  #authorised(request: IncomingMessage): boolean {
    if (this.#token === '') return false;
    const presented = [
      request.headers[BRIDGE_TOKEN_HEADER],
      (request.headers.authorization ?? '').replace(/^Bearer /i, ''),
      request.headers['x-api-key'],
    ];
    return presented.some((value) => value === this.#token);
  }

  async #turn(body: AnthropicRequest, response: ServerResponse): Promise<void> {
    const { accessToken, accountId } = await this.#session.credentials();
    const sessionId = randomUUID();
    const model = resolveModel(body.model);
    const upstream = await fetch(CODEX_URL, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + accessToken,
        'chatgpt-account-id': accountId,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        originator: ORIGINATOR,
        'session-id': sessionId,
      },
      body: JSON.stringify(toResponsesRequest(body, { model, sessionId })),
    });

    if (!upstream.ok || !upstream.body) {
      const detail = (await upstream.text().catch(() => '')).slice(0, 600);
      response.writeHead(upstream.status === 401 ? 401 : 502, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: upstream.status === 401 ? 'authentication_error' : 'api_error',
            message: 'The ChatGPT backend answered ' + upstream.status + '. ' + detail,
          },
        }),
      );
      return;
    }

    const translator = new TurnTranslator(model);

    if (body.stream !== true) {
      // Anything that did not ask to stream gets one Messages object, the
      // Anthropic default for an absent `stream`. Two clients rely on it:
      // `claude -p --output-format json`, which sends `stream: false`, and the
      // model-validation probe behind `/model`, which sends a one-token turn
      // with no `stream` field at all and reads `usage.input_tokens` off the
      // body - an SSE answer there is what made the switch fail.
      let text = '';
      for await (const event of readServerSentEvents(upstream.body)) {
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          text += event.delta;
        }
        translator.handle(event);
      }
      const message = translator.toMessage(text);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(message));
      return;
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const write = (event: { event: string; data: Record<string, unknown> }): void => {
      response.write('event: ' + event.event + '\ndata: ' + JSON.stringify(event.data) + '\n\n');
    };

    let closed = false;
    for await (const event of readServerSentEvents(upstream.body)) {
      for (const out of translator.handle(event)) {
        write(out);
        if (out.event === 'message_stop') closed = true;
      }
    }
    // A stream that ended without `response.completed` still has to be closed
    // properly, or the harness waits for an answer that will never come.
    if (!closed) for (const out of translator.finish()) write(out);
    response.end();
  }
}

/**
 * The account's models in Anthropic's `GET /v1/models` shape.
 *
 * The query parameters the harness sends (`limit`, `beta`) are ignored: the
 * list is a handful of entries and never pages. `created_at` is a constant -
 * the Codex cache carries no release date per model, and the harness only
 * reads id and display name.
 */
function modelList(): {
  data: { id: string; display_name: string; type: 'model'; created_at: string }[];
  first_id: string | null;
  last_id: string | null;
  has_more: false;
} {
  const data = codexModels().map((model) => ({
    id: model.id,
    display_name: model.name,
    type: 'model' as const,
    created_at: MODEL_CREATED_AT,
  }));
  return {
    data,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
    has_more: false,
  };
}

/**
 * The model to actually ask for.
 *
 * A client that was not told otherwise sends its own default - the auth probe
 * asks for `sonnet` - and the ChatGPT backend rejects a name it does not
 * serve. Anything that is not one of its own slugs therefore falls back to the
 * account's first model rather than being forwarded verbatim.
 */
function resolveModel(requested: string | undefined): string {
  const models = codexModels();
  if (requested && models.some((model) => model.id === requested)) return requested;
  return models[0]?.id ?? 'gpt-5.6-sol';
}

/**
 * Whether the ChatGPT account serves this name.
 *
 * The routing predicate, and the whole of it: an exact match against the
 * account's own slugs, with no fallback. A name this does not know is somebody
 * else's - which, in passthrough mode, means Anthropic's.
 */
function isCodexModel(requested: string | undefined): boolean {
  return requested !== undefined && codexModels().some((model) => model.id === requested);
}

/** Connection-scoped headers, which belong to this hop and must not be relayed. */
const DROP_FROM_REQUEST = new Set([
  'host',
  'connection',
  'keep-alive',
  'upgrade',
  'transfer-encoding',
  'content-length',
  'proxy-authorization',
  'proxy-connection',
  // Ours, and this hop's only: a token that means nothing past this server has
  // no business being handed to Anthropic along with the turn.
  BRIDGE_TOKEN_HEADER,
  // fetch decompresses for us, so a client promised gzip would get plain bytes
  // under a gzip header. Ask upstream for what we can actually relay.
  'accept-encoding',
]);
const DROP_FROM_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'upgrade',
  'transfer-encoding',
  'content-length',
  'content-encoding',
]);

/**
 * A turn that is not ours, relayed untouched.
 *
 * Method, path, query, headers and body all go out exactly as they came in -
 * the caller's own `authorization` and its full `anthropic-beta` list
 * included. Nothing here is normalised on purpose: every field this bridge
 * rewrote would be a way for it to silently change a session it has no
 * business changing, and the caller's credentials are the caller's, never
 * read and never replaced.
 *
 * One thing to know when debugging this by hand: a Claude OAuth bearer replayed
 * against `api.anthropic.com` without Claude Code's own system prompt comes
 * back **429**, not 401. Anthropic rejects the subscription token for a caller
 * it does not recognise as the client, and dresses the rejection as a rate
 * limit. A 429 out of a hand-built curl is therefore not evidence that the
 * quota is exhausted, and not evidence that the forwarding is broken - it is
 * what a correct forward of a credential looks like from outside the binary.
 * Only the real `claude` process gets a 200 through this path.
 */
async function forwardToAnthropic(
  request: IncomingMessage,
  raw: string,
  response: ServerResponse,
): Promise<void> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || DROP_FROM_REQUEST.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }

  const upstream = await fetch(ANTHROPIC_URL + (request.url ?? '/'), {
    method: request.method ?? 'GET',
    headers,
    body: raw === '' ? undefined : raw,
  });

  const out: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (!DROP_FROM_RESPONSE.has(name)) out[name] = value;
  });
  response.writeHead(upstream.status, out);
  // Chunk by chunk rather than buffered: a streamed answer has to reach the
  // caller as it arrives, or the harness sits on a finished turn.
  if (upstream.body) for await (const chunk of upstream.body) response.write(chunk);
  response.end();
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(raw: string): unknown {
  return raw ? (JSON.parse(raw) as unknown) : {};
}

/** One bridge per process; every `codex` turn shares it. */
export const sharedCodexBridge = new CodexBridge();
