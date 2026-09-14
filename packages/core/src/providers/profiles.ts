import type { ProviderProfile, RookeryConfig } from '../types.js';

/**
 * Upsert one provider profile by id. `patch` is layered over the existing
 * entry (or these defaults, for a new one) the same way `withToolServer`
 * does for MCP servers - the route decides what counts as "unset".
 */
export function withProviderProfile(
  config: RookeryConfig,
  id: string,
  patch: Partial<Omit<ProviderProfile, 'id'>>,
): Partial<RookeryConfig> {
  const existing = config.providerProfiles.find((profile) => profile.id === id);
  const next: ProviderProfile = {
    id,
    displayName: patch.displayName ?? existing?.displayName ?? id,
    baseUrl: patch.baseUrl ?? existing?.baseUrl ?? '',
    authToken: patch.authToken ?? existing?.authToken ?? '',
    defaultModel: patch.defaultModel ?? existing?.defaultModel,
    via: patch.via ?? existing?.via ?? 'direct',
  };
  return {
    providerProfiles: [...config.providerProfiles.filter((profile) => profile.id !== id), next],
  };
}

export function withoutProviderProfile(config: RookeryConfig, id: string): Partial<RookeryConfig> {
  return { providerProfiles: config.providerProfiles.filter((profile) => profile.id !== id) };
}

/** What the browser sees: never the token itself, only whether one is set. */
export function publicProviderProfile(profile: ProviderProfile): Record<string, unknown> {
  const { authToken, ...rest } = profile;
  return { ...rest, authTokenSet: Boolean(authToken) };
}
