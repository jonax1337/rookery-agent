import { createServer, type Server, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { McpServerSpec } from '../types.js';
import { MCP_SERVER_NAME, type ToolDefinition } from './tools.js';

/**
 * The bridge between a provider CLI and the running Rookery process.
 *
 * A provider CLI can only reach Rookery's tools through an MCP server it
 * starts itself. That server (`mcp-bridge.js`) is a thin stdio process which
 * forwards every call over a local pipe to this listener. Each turn registers
 * a token here; the token decides which tools the caller sees and which
 * handler answers them, so an agent's process can never call the assistant's
 * tools even though both talk to the same pipe.
 *
 * The protocol is newline-delimited JSON:
 *   -> { id, method: "hello", token }
 *   <- { id, result: { tools } }
 *   -> { id, method: "call", token, name, args }
 *   <- { id, result: { text, isError } }  |  { id, error: { message } }
 */

export interface ToolCallResult {
  text: string;
  isError?: boolean;
}

export type ToolHandler = (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>;

interface Registration {
  tools: ToolDefinition[];
  handler: ToolHandler;
}

export interface BridgeOptions {
  /** Where the socket file lives on non-Windows platforms. */
  runDir: string;
}

export class BridgeServer {
  readonly #runDir: string;
  readonly #registrations = new Map<string, Registration>();
  #server: Server | null = null;
  #path: string | null = null;
  #starting: Promise<string> | null = null;

  constructor(options: BridgeOptions) {
    this.#runDir = options.runDir;
  }

  /** The pipe path clients connect to. Starts the listener on first use. */
  async start(): Promise<string> {
    if (this.#path) return this.#path;
    if (this.#starting) return this.#starting;
    this.#starting = new Promise<string>((resolve, reject) => {
      const id = randomUUID();
      const path =
        process.platform === 'win32'
          ? '\\\\.\\pipe\\rookery-' + id
          : join(this.#runDir, 'bridge-' + id + '.sock');
      const server = createServer((socket) => this.#serve(socket));
      const onStartError = (error: Error): void => {
        this.#starting = null;
        reject(error);
      };
      server.on('error', onStartError);
      server.listen(path, () => {
        server.off('error', onStartError);
        this.#server = server;
        this.#path = path;
        resolve(path);
      });
    });
    return this.#starting;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    const path = this.#path;
    this.#path = null;
    this.#starting = null;
    this.#registrations.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (path && process.platform !== 'win32' && existsSync(path)) {
      try {
        unlinkSync(path);
      } catch {
        // Already gone.
      }
    }
  }

  /** Register the tools and handler one provider process may use. */
  register(tools: ToolDefinition[], handler: ToolHandler): string {
    const token = randomUUID();
    this.#registrations.set(token, { tools, handler });
    return token;
  }

  unregister(token: string): void {
    this.#registrations.delete(token);
  }

  /** The MCP server spec a provider adapter passes to its CLI for one token. */
  async spec(token: string): Promise<McpServerSpec> {
    const path = await this.start();
    return {
      name: MCP_SERVER_NAME,
      command: process.execPath,
      args: [bridgeScriptPath()],
      env: { ROOKERY_BRIDGE_PATH: path, ROOKERY_BRIDGE_TOKEN: token },
    };
  }

  #serve(socket: Socket): void {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) void this.#handle(socket, line);
        index = buffer.indexOf('\n');
      }
    });
    socket.on('error', () => {
      // The client went away mid-call; nothing to clean up on this side.
    });
  }

  async #handle(socket: Socket, line: string): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const payload = await this.#answer(message);
    if (socket.destroyed) return;
    socket.write(JSON.stringify({ id: message.id, ...payload }) + '\n');
  }

  async #answer(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const registration = this.#registrations.get(String(message.token ?? ''));
    if (!registration) return { error: { message: 'Unknown or expired bridge token.' } };

    if (message.method === 'hello') {
      const tools = registration.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
      return { result: { tools } };
    }
    if (message.method === 'call') return { result: await callRegisteredTool(registration, message) };
    return { error: { message: 'Unknown method.' } };
  }
}

/** A tool failure is a result the model can read, not a protocol error. */
async function callRegisteredTool(registration: Registration, message: Record<string, unknown>): Promise<ToolCallResult> {
  const name = String(message.name ?? '');
  const args = (message.args && typeof message.args === 'object' ? message.args : {}) as Record<string, unknown>;
  if (!registration.tools.some((tool) => tool.name === name)) return { text: 'Unknown tool: ' + name, isError: true };
  try {
    return await registration.handler(name, args);
  } catch (error) {
    return { text: (error as Error).message, isError: true };
  }
}

/** Absolute path of the compiled bridge executable next to this module. */
export function bridgeScriptPath(): string {
  return fileURLToPath(new URL('./mcp-bridge.js', import.meta.url));
}
