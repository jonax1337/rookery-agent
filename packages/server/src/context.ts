import { readFileSync } from 'node:fs';
import type { Assistant, Logger, RookeryConfig } from '@rookery/core';
import type { WebSocket } from '@fastify/websocket';

/**
 * Everything a route needs, handed down explicitly instead of through Fastify
 * decorators so the types stay obvious and `buildServer` remains testable.
 *
 * `config` is the Assistant's own config object, not a copy: PATCH /api/config
 * and the tool switches change it in place through applyConfig, so a setting
 * takes effect without a restart and the two can never drift apart.
 */
export interface ServerContext {
  readonly assistant: Assistant;
  readonly config: RookeryConfig;
  readonly log: Logger;
  /** Every live websocket, used to broadcast background memory events. */
  readonly sockets: Set<WebSocket>;
}

/** Package version, read once from our own package.json. */
export const VERSION: string = readVersion();

function readVersion(): string {
  try {
    const url = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** The subset of the config that is safe to hand to a browser. Never the token. */
export function publicConfig(config: RookeryConfig): Record<string, unknown> {
  return {
    // Where this server listens. Read-only for the browser - PATCH ignores it,
    // because moving the socket while it is being spoken through cannot work.
    // It has to come from here: the page cannot read its own address in
    // development, where it talks to Vite and Vite proxies on to this port.
    host: config.host,
    port: config.port,
    assistantName: config.assistantName,
    userName: config.userName,
    formalAddress: config.formalAddress,
    honorific: config.honorific,
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
    defaultEffort: config.defaultEffort,
    defaultPermission: config.defaultPermission,
    voice: config.voice,
    memory: config.memory,
    org: config.org,
  };
}
