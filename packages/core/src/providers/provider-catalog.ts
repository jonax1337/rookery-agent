import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderModel, ProviderProfile } from '../types.js';

/**
 * The providers Rookery knows how to set up.
 *
 * Everything technical about a provider lives here rather than in the config:
 * the endpoint, how it is reached, which models it serves. What the user
 * stores is only the part that is theirs - an API key, or where a checkout
 * lives. That is the same split the tool hub uses (catalogue entry plus the
 * user's own state), and it is what keeps the settings page down to one field
 * per provider.
 */
export interface ProviderCatalogEntry {
  id: string;
  name: string;
  description: string;
  baseUrl: string;
  via: ProviderProfile['via'];
  /** What the person has to supply. */
  needs: 'api-key';
  /** One line telling them how to get it. */
  hint: string;
  /**
   * Models this provider serves. Static, because the `claude` binary answers
   * model discovery with Anthropic's own names whatever endpoint it is pointed
   * at - asking it about GLM would list `sonnet` and `opus`.
   */
  models?: ProviderModel[];
  /**
   * Borrow another provider's catalogue instead of declaring one. The Codex
   * proxy fronts the same backend as the `codex` CLI, so the models that CLI
   * reports for the logged-in account are exactly the right list, and never
   * go stale here.
   */
  modelsFrom?: string;
}

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    id: 'glm',
    name: 'GLM (z.ai)',
    description: "Z.ai's GLM models. Speaks Claude Code's own API directly, so no proxy is involved.",
    baseUrl: 'https://api.z.ai/api/anthropic',
    via: 'direct',
    needs: 'api-key',
    hint: 'Create a key at z.ai/manage-apikey/apikey-list, on a GLM Coding Plan.',
    models: [
      { id: 'glm-5.3', name: 'GLM-5.3', description: 'Flagship', isDefault: true },
      { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', description: 'Faster, smaller' },
    ],
  },
];

/**
 * The built-in `codex` provider: ChatGPT models, answered through Rookery's
 * own bridge on the session `codex login` created. It is not in the catalogue
 * above because there is nothing to set up here - either the session exists
 * or it does not - and the id is fixed so older conversations keep resolving.
 */
export const CODEX_PROFILE: ProviderProfile = {
  id: 'codex',
  displayName: 'Codex (ChatGPT)',
  baseUrl: '',
  authToken: '',
  via: 'codex-bridge',
  get defaultModel(): string | undefined {
    // A getter, because the account's model list is read at call time: the
    // Codex CLI rewrites its cache when the backend ships new slugs.
    return codexModels()[0]?.id;
  },
};

interface CachedModel {
  slug: string;
  /** `hide` marks a model the backend serves but does not offer, e.g. `gpt-reserve`. */
  visibility?: string;
  /** Lower comes first; the account's own ordering. */
  priority?: number;
  context_window?: number;
}

/** `gpt-5.6-sol` -> `GPT-5.6-sol`. Shared with the terminal front-ends. */
export function prettifyModelId(id: string): string {
  const prefixed = id.startsWith('gpt-') ? 'GPT' + id.slice(3) : id;
  return prefixed.charAt(0).toUpperCase() + prefixed.slice(1);
}

/**
 * The models the ChatGPT backend itself served, as the Codex CLI cached them
 * in `~/.codex/models_cache.json`. Reading that file rather than hardcoding
 * slugs keeps the list honest - it is written by the same backend the bridge
 * talks to, and a stale constant here would offer models that no longer exist.
 */
export function codexModels(): ProviderModel[] {
  try {
    const home = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const raw = JSON.parse(readFileSync(join(home, 'models_cache.json'), 'utf8')) as {
      models?: Partial<CachedModel>[];
    };
    return (raw.models ?? [])
      .filter((model): model is CachedModel => typeof model.slug === 'string')
      // `hide` is the backend's own "serve it, do not offer it" flag.
      .filter((model) => model.visibility !== 'hide')
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((model, index) => ({
        id: model.slug,
        name: prettifyModelId(model.slug),
        isDefault: index === 0,
      }));
  } catch {
    return [];
  }
}

/** The context window the backend reports for a model, for the harness to respect. */
export function codexContextWindow(slug: string): number | undefined {
  try {
    const home = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const raw = JSON.parse(readFileSync(join(home, 'models_cache.json'), 'utf8')) as {
      models?: Partial<CachedModel>[];
    };
    const entry = raw.models?.find((model) => model.slug === slug);
    return typeof entry?.context_window === 'number' ? entry.context_window : undefined;
  } catch {
    return undefined;
  }
}

export function providerCatalogEntry(id: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.id === id);
}

/**
 * Fill a stored profile in from its catalogue entry. The stored fields win
 * where they are set, so a profile edited by hand in config.json keeps
 * working; everything the settings page no longer asks about comes from here.
 */
export function profileWithCatalog(profile: ProviderProfile): ProviderProfile {
  const entry = providerCatalogEntry(profile.id);
  if (!entry) return profile;
  return {
    ...profile,
    displayName: profile.displayName || entry.name,
    baseUrl: profile.baseUrl || entry.baseUrl,
    via: profile.via ?? entry.via,
    defaultModel: profile.defaultModel ?? entry.models?.find((model) => model.isDefault)?.id,
  };
}
