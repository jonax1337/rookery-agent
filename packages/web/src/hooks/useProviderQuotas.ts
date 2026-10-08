import { useEffect, useState } from 'react';

import { api } from '@/lib/api';
import type { ProviderId, ProviderQuota, ProviderStatus } from '@/lib/types';

export type ProviderQuotas = Partial<Record<ProviderId, ProviderQuota>>;

/**
 * The subscription quota of every provider that is signed in.
 *
 * Only a provider that is actually signed in has a quota to report, and the
 * server caches each answer for a minute, so this runs once per status list.
 */
export function useProviderQuotas(providers: readonly ProviderStatus[]): ProviderQuotas {
  const [quotas, setQuotas] = useState<ProviderQuotas>({});

  useEffect(() => {
    const ready = providers.filter((entry) => entry.available && entry.authenticated);
    let cancelled = false;
    for (const entry of ready) {
      void api
        .providerUsage(entry.id)
        .then((quota) => {
          if (!cancelled) setQuotas((current) => ({ ...current, [entry.id]: quota }));
        })
        // A provider without a usage endpoint simply gets no bars. It is not
        // an error worth putting on the page.
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [providers]);

  return quotas;
}
