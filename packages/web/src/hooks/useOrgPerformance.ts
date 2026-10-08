import { useCallback, useEffect, useState } from 'react';

import { api } from '@/lib/api';
import type { OrgPerformanceEntry } from '@/lib/types';

export interface OrgPerformanceState {
  /** Every agent's standing; `null` until the first answer arrives or after it failed. */
  entries: OrgPerformanceEntry[] | null;
  loading: boolean;
  error: boolean;
  reload(): Promise<void>;
}

/**
 * Fetched once, beside the org state rather than through it: the standing
 * is a nice-to-have on the pages that show it as a badge, and not something the
 * socket needs to keep live for every column in the app.
 */
export function useOrgPerformance(): OrgPerformanceState {
  const [entries, setEntries] = useState<OrgPerformanceEntry[] | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async (): Promise<void> => {
    setError(false);
    try {
      setEntries(await api.orgPerformance());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { entries, loading, error, reload };
}
