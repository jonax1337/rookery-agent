import type {
  Provider,
  ProviderFallbackConfig,
  ProviderId,
  ProviderModel,
  ProviderStatus,
  RookeryConfig,
} from '../types.js';
import { ClaudeCodeProvider } from './claude-code.js';
import { CODEX_PROFILE, codexModels, profileWithCatalog, providerCatalogEntry } from './provider-catalog.js';
import { providerBlocked, providerLow, rememberProviderProfiles } from './quota.js';

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
  /** Set from config by `sync`; the default matches DEFAULT_CONFIG so a registry asked before its first sync switches too. */
  #fallback: ProviderFallbackConfig = { enabled: true, thresholdPercent: 95, order: [] };

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
   *
   * With fallback switching on, usable also means not out of quota: a
   * provider with a recorded failure or a full window is skipped even as the
   * last resort, and one whose windows report it nearly full is passed over
   * while a roomier one is signed in - though never left behind when every
   * other provider is in the same state. `exclude` takes ids out of the race
   * entirely, which is how a retry after a mid-turn failure avoids landing
   * on the provider that just died.
   */
  async resolveUsable(
    preferred: ProviderId,
    options: { exclude?: readonly ProviderId[] } = {},
  ): Promise<ProviderId | null> {
    const statuses = await this.statuses();
    const byId = new Map(statuses.map((status) => [status.id, status]));
    const usable = (id: ProviderId): boolean => {
      const status = byId.get(id);
      return (
        Boolean(status?.available && status.authenticated) &&
        !options.exclude?.includes(id) &&
        (!this.#fallback.enabled || !providerBlocked(id))
      );
    };
    const candidates = this.#candidates(preferred);
    if (this.#fallback.enabled) {
      const roomy = candidates.find(
        (id) => usable(id) && !providerLow(id, this.#fallback.thresholdPercent),
      );
      if (roomy) return roomy;
    }
    return candidates.find(usable) ?? null;
  }

  /** Preferred first, then the configured fallback order, then the rest. */
  #candidates(preferred: ProviderId): ProviderId[] {
    const ids: ProviderId[] = [preferred];
    for (const id of this.#fallback.order) {
      if (id !== preferred && this.has(id)) ids.push(id);
    }
    for (const provider of this.list()) {
      if (!ids.includes(provider.id)) ids.push(provider.id);
    }
    return ids;
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
    // Tests hand in partial configs; the fallback default then simply stays.
    this.#fallback = config.providerFallback ?? this.#fallback;
    const configured = config.providerProfiles.map(profileWithCatalog);
    // A profile's usage is read with the same key and against the same
    // backend its turns run on, so the quota reader is handed the same list,
    // at the same moment, as the adapters below.
    rememberProviderProfiles(configured);
    const wanted = new Set(configured.map((profile) => profile.id));
    for (const id of [...this.#providers.keys()]) {
      if (BUILTIN_IDS.has(id) || wanted.has(id)) continue;
      this.#providers.delete(id);
      this.#cache.delete(id);
    }
    for (const profile of configured) {
      this.#providers.set(profile.id, new ClaudeCodeProvider(profile));
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
