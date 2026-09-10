import { readFileSync } from 'node:fs';
import type { Assistant, Logger, RookeryConfig } from '@rookery/core';
import type { WebSocket } from '@fastify/websocket';

/**
 * Everything a route needs, handed down explicitly instead of through Fastify
 * decorators so the types stay obvious and `buildServer` remains testable.
 *
 * `config` is mutable on purpose: PATCH /api/config replaces it in place so a
 * setting change takes effect without a restart.
 */
export interface ServerContext {
  readonly assistant: Assistant;
  config: RookeryConfig;
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
