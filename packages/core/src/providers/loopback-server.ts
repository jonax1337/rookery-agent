import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface LoopbackEndpoint {
  baseUrl: string;
  token: string;
}

type RequestHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

/**
 * An HTTP server on a loopback port the OS picks, started once and shared by
 * every caller. Each start mints a fresh token: loopback is shared with every
 * other process on the machine, so whoever serves a credential through this
 * endpoint checks the token before spending it.
 */
export class LoopbackServer {
  #server: Server | undefined;
  #starting: Promise<LoopbackEndpoint> | undefined;
  #token = '';
  readonly #label: string;
  readonly #handle: RequestHandler;

  constructor(label: string, handle: RequestHandler) {
    this.#label = label;
    this.#handle = handle;
  }

  /** Empty until the first start. */
  get token(): string {
    return this.#token;
  }

  /** Start once; a failed start is forgotten so the next call tries again. */
  start(): Promise<LoopbackEndpoint> {
    this.#starting ??= this.#listen().catch((error: unknown) => {
      this.#starting = undefined;
      throw error;
    });
    return this.#starting;
  }

  #listen(): Promise<LoopbackEndpoint> {
    return new Promise((resolve, reject) => {
      this.#token = randomUUID();
      const server = createServer((request, response) => {
        void this.#handle(request, response);
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          reject(new Error('The ' + this.#label + ' could not determine its own port.'));
          return;
        }
        this.#server = server;
        resolve({ baseUrl: 'http://127.0.0.1:' + address.port, token: this.#token });
      });
    });
  }

  async close(): Promise<void> {
    const starting = this.#starting;
    this.#starting = undefined;
    if (!starting) return;
    // A start still in flight finishes listening first; closing a server that
    // is not listening yet would leave it to bind afterwards.
    try {
      await starting;
    } catch {
      return;
    }
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    // `close` alone waits for every open connection to end, and a client that
    // keeps its socket alive - `claude` does - never ends it. Without this the
    // process hangs after the last turn instead of exiting.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** An error in Anthropic's `{ type: 'error', error: {...} }` envelope. */
export function sendError(response: ServerResponse, status: number, type: string, message?: string): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

/** Report a failed request: as an error while nothing is sent yet, else by cutting the stream. */
export function sendFailure(response: ServerResponse, status: number, error: unknown): void {
  if (response.headersSent) response.end();
  else sendError(response, status, 'api_error', (error as Error).message);
}

/**
 * Aborts when the client leaves before the answer is complete, so the
 * upstream request - and the subscription quota it spends - stops with it.
 */
export function abortWhenClientLeaves(response: ServerResponse): AbortSignal {
  const controller = new AbortController();
  response.once('close', () => {
    if (!response.writableFinished) controller.abort();
  });
  return controller.signal;
}
