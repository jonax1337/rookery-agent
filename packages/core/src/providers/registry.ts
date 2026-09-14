import type { Provider, ProviderId, ProviderModel, ProviderStatus, RookeryConfig } from '../types.js';
import { ClaudeCodeProvider } from './claude-code.js';
import { CODEX_PROFILE, codexModels, profileWithCatalog, providerCatalogEntry } from './provider-catalog.js';

/** Never removed or replaced by `sync()`, whatever the config says. */
const BUILTIN_IDS = new Set<ProviderId>(['claude', 'codex']);

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
    // Both built-ins are the same adapter now: the plain `claude` login, and
    // `codex`, which is the same binary pointed at Rookery's ChatGPT bridge.
    const list = providers ?? [new ClaudeCodeProvider(), new ClaudeCodeProvider(CODEX_PROFILE)];
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

  /**
   * Health for one provider, cached for the registry TTL.
   *
   * An adapter that throws instead of answering is reported as unavailable
   * rather than propagated: `statuses()` fans out over every provider, and one
   * misconfigured profile must not take the whole list - and with it the
   * settings page and the model picker - down with it.
   */
  async status(id: ProviderId, force = false): Promise<ProviderStatus> {
    const cached = this.#cache.get(id);
    if (!force && cached && Date.now() - cached.at < this.#ttlMs) return cached.status;
    const provider = this.get(id);
    let status: ProviderStatus;
    try {
      status = await provider.status();
    } catch (error) {
      status = {
        id,
        displayName: provider.displayName,
        available: false,
        binary: '',
        authenticated: false,
        detail: (error as Error).message,
      };
    }
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

  /**
   * Rebuild the provider-profile-backed entries from config, so adding,
   * editing or removing a profile in the UI takes effect without a restart.
   * `claude` and `codex` are never touched here.
   */
  sync(config: RookeryConfig): void {
    const wanted = new Set(config.providerProfiles.map((profile) => profile.id));
    for (const id of [...this.#providers.keys()]) {
      if (BUILTIN_IDS.has(id) || wanted.has(id)) continue;
      this.#providers.delete(id);
      this.#cache.delete(id);
    }
    for (const profile of config.providerProfiles) {
      this.#providers.set(profile.id, new ClaudeCodeProvider(profileWithCatalog(profile)));
      this.#cache.delete(profile.id);
    }
  }

  /**
   * The models one provider offers, for a picker.
   *
   * A catalogue entry answers for itself, because the `claude` binary reports
   * Anthropic's own model names whatever endpoint it is pointed at - discovery
   * would offer `sonnet` for a GLM profile. It is also answered regardless of
   * login state, so the composer can show what a provider serves before its
   * key is in; the picker greys out what is not usable yet.
   */
  async models(id: ProviderId): Promise<ProviderModel[]> {
    if (id === CODEX_PROFILE.id) return codexModels();
    const entry = providerCatalogEntry(id);
    if (entry?.models) return entry.models;
    if (entry?.modelsFrom && this.has(entry.modelsFrom)) {
      return normalise(await this.get(entry.modelsFrom).models());
    }
    return normalise(await this.get(id).models());
  }
}

function normalise(models: string[] | ProviderModel[]): ProviderModel[] {
  return models.map((model) => (typeof model === 'string' ? { id: model, name: model } : model));
}
