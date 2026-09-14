import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { ProviderProfile } from '../types.js';
import { resolveBinary, spawnCli, type ResolvedBinary, type SpawnHandle } from './process.js';

const DEFAULT_PORT = 3456;
const ROUTER_HOME = join(homedir(), '.claude-code-router');

/**
 * Manages a local `claude-code-router` (`ccr`) process: one long-lived HTTP
 * gateway shared by every `via: 'router'` profile, translating the Anthropic
 * Messages API to whatever backend each profile names. Rookery starts it
 * lazily and keeps it running; `via: 'direct'` profiles (GLM today) never
 * touch it.
 *
 * The config.json shape written here follows the router's documented
 * provider/route model; verify it against the installed `ccr` version's own
 * schema (`ccr ui` renders the same file) before relying on a `via: 'router'`
 * profile - this path has no automated test coverage yet.
 */
export class RouterManager {
  #binary: ResolvedBinary | null | undefined;
  #handle: SpawnHandle | undefined;
  #port = DEFAULT_PORT;

  #resolve(): ResolvedBinary | null {
    if (this.#binary === undefined) this.#binary = resolveBinary('ccr');
    return this.#binary;
  }

  get baseUrl(): string {
    return 'http://127.0.0.1:' + this.#port;
  }

  async #healthy(): Promise<boolean> {
    try {
      const response = await fetch(this.baseUrl, { signal: AbortSignal.timeout(2000) });
      return response.status < 500;
    } catch {
      return false;
    }
  }

  /**
   * Write the router's config from every enabled `via: 'router'` profile,
   * then start the process if it is not already answering health checks.
   * A no-op when no profile currently needs it.
   */
  async ensureRunning(profiles: ProviderProfile[], port = DEFAULT_PORT): Promise<void> {
    const routed = profiles.filter((profile) => profile.via === 'router');
    if (!routed.length) return;
    this.#port = port;
    this.#writeConfig(routed);
    if (await this.#healthy()) return;

    const binary = this.#resolve();
    if (!binary) {
      throw new Error(
        'The ccr CLI is not on PATH. Install it with: npm install -g @musistudio/claude-code-router',
      );
    }
    this.#handle = spawnCli(binary, { args: ['start'] });
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      if (await this.#healthy()) return;
    }
    throw new Error('claude-code-router did not become healthy within 7.5s of starting.');
  }

  #writeConfig(profiles: ProviderProfile[]): void {
    mkdirSync(ROUTER_HOME, { recursive: true });
    const config = {
      Providers: profiles.map((profile) => ({
        name: profile.id,
        api_base_url: profile.baseUrl,
        api_key: profile.authToken,
        models: profile.defaultModel ? [profile.defaultModel] : [],
      })),
      Router: {
        default: profiles[0] ? profiles[0].id + ',' + (profiles[0].defaultModel ?? '') : '',
      },
    };
    writeFileSync(join(ROUTER_HOME, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
  }

  /** Stop the process this instance started. Safe to call when nothing is running. */
  stop(): void {
    this.#handle?.child.kill();
    this.#handle = undefined;
  }
}

/** One router process serves every `via: 'router'` profile; they share this instance. */
export const sharedRouterManager = new RouterManager();
