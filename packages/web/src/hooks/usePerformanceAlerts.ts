import { useEffect, useState } from 'react';

import { api } from '@/lib/api';
import type { OrgPerformanceEntry } from '@/lib/types';

export interface PerformanceAlerts {
  /** Agents past stage 0 of the performance ladder. */
  flagged: number;
  /** Agents with a replacement proposal waiting for a decision. */
  proposals: number;
}

/**
 * How many agents need a look. Fetched once, not through the socket: a
 * performance recalculation is a read-model detail, not something worth a
 * live subscription for.
 */
export function usePerformanceAlerts(): PerformanceAlerts {
  const [performance, setPerformance] = useState<OrgPerformanceEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .orgPerformance()
      .then((rows) => {
        if (!cancelled) setPerformance(rows);
      })
      // No numbers is the quiet answer: the badges simply stay away.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    flagged: performance.filter((row) => row.performance.stage > 0).length,
    proposals: performance.filter((row) => row.pendingProposal).length,
  };
}
