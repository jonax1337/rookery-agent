/**
 * Real model names for the terminal front-ends.
 *
 * A config value like `sonnet` or `gpt-5.2-codex` is a model *id* - what gets
 * passed to the CLI - and printing it verbatim reads as a typo, not as a
 * product. Both CLIs will happily report their catalogue with display names
 * (`Provider.models()`, already shaped by core), but fetching it spawns the
 * CLI, which is too slow to do on every prompt and wrong entirely for piped
 * runs. So the catalogue is fetched at most once per day, kept at
 * `<home>/cache/models.json`, and read back synchronously whenever a fresh
 * copy exists.
 *
 * Everything here degrades quietly: a provider that is not signed in
 * contributes nothing, a failed refresh falls back to the stale cache, and an
 * unknown id falls back to a prettified version of itself. The answer is a
 * display name or undefined - never a thrown error, never a spawn the caller
 * did not ask for.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prettifyModelId } from '@rookery/core';
import type { ProviderId, ProviderRegistry } from '@rookery/core';

export { prettifyModelId };

/** How long a cached catalogue is trusted before the next refresh. */
const TTL_MS = 24 * 60 * 60 * 1000;

/** Give up on a catalogue fetch well before the CLI's own 20s kill timer. */
const FETCH_TIMEOUT_MS = 8000;

export interface ModelCatalogue {
  /** Provider -> model id -> display name, e.g. `sonnet` -> `Sonnet 5`. */
  byProvider: Partial<Record<ProviderId, Record<string, string>>>;
  /** Provider -> display name of the account's own default model. */
  defaults: Partial<Record<ProviderId, string>>;
}

export const EMPTY_MODEL_CATALOGUE: ModelCatalogue = { byProvider: {}, defaults: {} };

interface CachedModel {
  id: string;
  name: string;
  isDefault?: boolean;
}

interface CacheFile {
  fetchedAt: number;
  providers: Partial<Record<ProviderId, CachedModel[]>>;
}

function cachePath(home: string): string {
  return join(home, 'cache', 'models.json');
}

function fromCache(file: CacheFile): ModelCatalogue {
  const catalogue: ModelCatalogue = { byProvider: {}, defaults: {} };
  for (const [provider, models] of Object.entries(file.providers ?? {})) {
    if (!Array.isArray(models)) continue;
    const names: Record<string, string> = {};
    for (const model of models) {
      if (typeof model?.id !== 'string' || typeof model?.name !== 'string') continue;
      names[model.id] = model.name;
      if (model.isDefault) catalogue.defaults[provider as ProviderId] = model.name;
    }
    catalogue.byProvider[provider as ProviderId] = names;
  }
  return catalogue;
}

function readCacheFile(home: string): CacheFile | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cachePath(home), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as CacheFile;
  } catch {
    return null;
  }
}

/** A cache entry without a usable timestamp counts as stale. */
function isFresh(file: CacheFile): boolean {
  return Date.now() - file.fetchedAt <= TTL_MS;
}

/**
 * The catalogue from disk, but only while it is fresh. For code that must not
 * spawn anything - a piped REPL, a `/model` echo - this is the whole story.
 */
export function cachedModelCatalogue(home: string): ModelCatalogue {
  const file = readCacheFile(home);
  if (!file || !isFresh(file)) return EMPTY_MODEL_CATALOGUE;
  return fromCache(file);
}

/**
 * The catalogue, refreshed when the cached copy has gone stale.
 *
 * Providers that are not logged in are skipped rather than fought; a fetch
 * that fails or hangs leaves the stale cache in place, because yesterday's
 * model names beat none at all.
 */
export async function loadModelCatalogue(
  registry: ProviderRegistry,
  home: string,
): Promise<ModelCatalogue> {
  const cached = readCacheFile(home);
  if (cached && isFresh(cached)) return fromCache(cached);

  const statuses = await registry.statuses();
  const providers: CacheFile['providers'] = {};

  await Promise.all(
    statuses
      .filter((status) => status.available && status.authenticated)
      .map(async (status) => {
        // Keep whatever the stale cache knew about this provider, if anything.
        const models = await fetchModels(registry, status.id).catch(() => cached?.providers?.[status.id]);
        if (models) providers[status.id] = models;
      }),
  );

  if (Object.keys(providers).length) {
    const fresh: CacheFile = { fetchedAt: Date.now(), providers };
    writeCacheFile(home, fresh);
    return fromCache(fresh);
  }

  return cached ? fromCache(cached) : EMPTY_MODEL_CATALOGUE;
}

async function fetchModels(registry: ProviderRegistry, id: ProviderId): Promise<CachedModel[]> {
  const models: unknown = await withTimeout(Promise.resolve(registry.get(id).models()), FETCH_TIMEOUT_MS);
  // A provider may answer with bare ids; those gain nothing over the
  // prettified fallback, so only shaped entries are worth caching.
  return (Array.isArray(models) ? models : [])
    .filter(
      (model): model is CachedModel =>
        typeof model === 'object' &&
        model !== null &&
        typeof model.id === 'string' &&
        typeof model.name === 'string',
    )
    .map((model) => ({ id: model.id, name: model.name, isDefault: model.isDefault }));
}

function withTimeout<Value>(work: Promise<Value>, timeoutMs: number): Promise<Value> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('model catalogue timed out')), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function writeCacheFile(home: string, file: CacheFile): void {
  try {
    mkdirSync(join(home, 'cache'), { recursive: true });
    writeFileSync(cachePath(home), JSON.stringify(file));
  } catch {
    // A read-only home must not take the interface down with it.
  }
}

/**
 * The name to show for a model.
 *
 * An id that is in the catalogue gets its display name; an id that is not
 * (something hand-set via `/model`, a brand-new model) gets prettified rather
 * than thrown away; no id at all means the provider's default, whose name the
 * catalogue usually knows - that is the model the account actually runs.
 */
export function modelName(
  catalogue: ModelCatalogue,
  provider: ProviderId,
  id: string | undefined,
): string | undefined {
  if (!id) return catalogue.defaults[provider];
  return catalogue.byProvider[provider]?.[id] ?? prettifyModelId(id);
}
