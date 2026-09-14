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
 * It binds to loopback on a port the OS picks and requires a bearer token
 * minted at startup, so nothing else on the machine can borrow the session
 * through it.
 */

const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses';
/** What the Codex CLI identifies as; see codex-rs/login/src/auth/default_client.rs. */
const ORIGINATOR = 'codex_cli_rs';

export class CodexBridge {
  #server: Server | undefined;
  #starting: Promise<{ baseUrl: string; token: string }> | undefined;
  #token = '';
  #baseUrl = '';
  readonly #session: CodexSession;

  constructor(session: CodexSession = sharedCodexSession) {
    this.#session = session;
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!request.url?.startsWith('/v1/messages') || request.method !== 'POST') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error' } }));
        return;
      }
      const auth = request.headers.authorization ?? '';
      const key = request.headers['x-api-key'];
      const presented = auth.replace(/^Bearer /i, '') || (typeof key === 'string' ? key : '');
      if (presented !== this.#token) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
        return;
      }

      const body = (await readJsonBody(request)) as AnthropicRequest;
      await this.#turn(body, response);
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

    if (body.stream === false) {
      // `claude -p --output-format json` does not stream; collect the turn and
      // answer with one Messages object.
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

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as unknown) : {};
}

/** One bridge per process; every `codex` turn shares it. */
export const sharedCodexBridge = new CodexBridge();
