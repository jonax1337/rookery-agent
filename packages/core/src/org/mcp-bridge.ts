#!/usr/bin/env node
/**
 * The stdio MCP server a provider CLI starts for Rookery's tools.
 *
 * Deliberately tiny: it speaks just enough of the Model Context Protocol
 * (initialize, tools/list, tools/call, ping) and forwards every call over
 * the local pipe named in ROOKERY_BRIDGE_PATH, authenticated by the turn's
 * ROOKERY_BRIDGE_TOKEN. All real behaviour lives in the Rookery process.
 */

import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';

const PIPE = process.env.ROOKERY_BRIDGE_PATH ?? '';
const TOKEN = process.env.ROOKERY_BRIDGE_TOKEN ?? '';
const PROTOCOL_FALLBACK = '2025-06-18';

interface JsonRpc {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

type Pending = { resolve(value: Record<string, unknown>): void; reject(error: Error): void };

/* ------------------------------ pipe client ------------------------------ */

let socket: Socket | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function pipe(): Promise<Socket> {
  if (socket && !socket.destroyed) return Promise.resolve(socket);
  return new Promise((resolve, reject) => {
    const client = connect(PIPE);
    let buffer = '';
    client.setEncoding('utf8');
    client.once('connect', () => {
      socket = client;
      resolve(client);
    });
    client.on('error', (error) => {
      reject(error);
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    });
    client.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) dispatch(line);
        index = buffer.indexOf('\n');
      }
    });
  });
}

function dispatch(line: string): void {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const waiter = pending.get(Number(message.id));
  if (!waiter) return;
  pending.delete(Number(message.id));
  if (message.error) {
    waiter.reject(new Error(String((message.error as { message?: string }).message ?? 'bridge error')));
  } else {
    waiter.resolve((message.result ?? {}) as Record<string, unknown>);
  }
}

async function request(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const client = await pipe();
  const id = nextId;
  nextId += 1;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    client.write(JSON.stringify({ id, method, token: TOKEN, ...payload }) + '\n');
  });
}

/* ------------------------------- MCP server ------------------------------- */

function send(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}

async function handle(message: JsonRpc): Promise<void> {
  const { id, method, params } = message;
  // Notifications carry no id and expect no reply.
  if (id === undefined) return;

  try {
    switch (method) {
      case 'initialize':
        send({
          id,
          result: {
            protocolVersion: (params?.protocolVersion as string | undefined) ?? PROTOCOL_FALLBACK,
            capabilities: { tools: {} },
            serverInfo: { name: 'rookery', version: '0.2.0' },
          },
        });
        return;
      case 'ping':
        send({ id, result: {} });
        return;
      case 'tools/list': {
        const result = await request('hello', {});
        send({ id, result: { tools: result.tools ?? [] } });
        return;
      }
      case 'tools/call': {
        const name = String(params?.name ?? '');
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        const result = await request('call', { name, args });
        send({
          id,
          result: {
            content: [{ type: 'text', text: String(result.text ?? '') }],
            isError: Boolean(result.isError),
          },
        });
        return;
      }
      default:
        send({ id, error: { code: -32601, message: 'Method not found: ' + method } });
    }
  } catch (error) {
    send({ id, error: { code: -32000, message: (error as Error).message } });
  }
}

if (!PIPE || !TOKEN) {
  process.stderr.write('rookery mcp-bridge: ROOKERY_BRIDGE_PATH and ROOKERY_BRIDGE_TOKEN are required\n');
  process.exit(2);
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (!line.trim()) return;
  let message: JsonRpc;
  try {
    message = JSON.parse(line) as JsonRpc;
  } catch {
    return;
  }
  void handle(message);
});
input.on('close', () => {
  socket?.end();
  process.exit(0);
});
