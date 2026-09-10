import type { Provider, ProviderId, ProviderStatus } from '../types.js';
import { ClaudeCodeProvider } from './claude-code.js';
import { CodexProvider } from './codex.js';

/**
 * Holds the concrete provider adapters and caches their health probes.
 *
 * Probing is deliberately lazy and cached: the Claude auth probe costs a real
 * (tiny) turn, so we do not want it on every request.
 */
export class ProviderRegistry {
  #providers = new Map<ProviderId, Provider>();
  #cache = new Map<ProviderId, { status: ProviderStatus; at: number }>();
  #ttlMs: number;

  constructor(providers?: Provider[], ttlMs = 5 * 60 * 1000) {
    const list = providers ?? [new ClaudeCodeProvider(), new CodexProvider()];
    for (const provider of list) this.#providers.set(provider.id, provider);
    this.#ttlMs = ttlMs;
  }

  get(id: ProviderId): Provider {
    const provider = this.#providers.get(id);
    if (!provider) {
      throw new Error(
        'Unknown provider "' + id + '". Available: ' + [...this.#providers.keys()].join(', '),
      );
    }
    return provider;
  }

  has(id: ProviderId): boolean {
    return this.#providers.has(id);
  }

  list(): Provider[] {
    return [...this.#providers.values()];
  }

  /** Health for one provider, cached for the registry TTL. */
  async status(id: ProviderId, force = false): Promise<ProviderStatus> {
    const cached = this.#cache.get(id);
    if (!force && cached && Date.now() - cached.at < this.#ttlMs) return cached.status;
    const status = await this.get(id).status();
    this.#cache.set(id, { status, at: Date.now() });
    return status;
  }

  /** Health for every provider, probed in parallel. */
  async statuses(force = false): Promise<ProviderStatus[]> {
    return Promise.all(this.list().map((provider) => this.status(provider.id, force)));
  }

  /**
   * Pick a usable provider: the preferred one when it is logged in, otherwise
   * any other authenticated provider. Returns null when nothing is ready, so
   * callers can show a proper onboarding message instead of a stack trace.
   */
  async resolveUsable(preferred: ProviderId): Promise<ProviderId | null> {
    const statuses = await this.statuses();
    const byId = new Map(statuses.map((status) => [status.id, status]));
    const wanted = byId.get(preferred);
    if (wanted?.available && wanted.authenticated) return preferred;
    const fallback = statuses.find((status) => status.available && status.authenticated);
    return fallback?.id ?? null;
  }

  /** Drop cached probes, e.g. after the user logs in from the UI. */
  invalidate(): void {
    this.#cache.clear();
  }
}
