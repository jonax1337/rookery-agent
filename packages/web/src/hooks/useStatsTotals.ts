import { useEffect, useState } from 'react';

import { api } from '@/lib/api';
import type { RookerySocket } from '@/lib/socket';
import type { StatsTotals } from '@/lib/types';

/**
 * The real counts, from the only aggregate call this API has.
 *
 * `GET /api/stats` is what lets a card print "58 Gespräche" instead of "von
 * 500 geladenen". Five pages fetched it with three different cancel flags, two
 * different catch branches and three different refresh triggers, so the same
 * tile was differently current depending on which page you were standing on.
 *
 * One module-level answer fixes that: everyone reads the same object, an
 * in-flight request is shared rather than repeated, and any org change reloads
 * it once for every listener at once. The window is a single day because only
 * `totals` is read here - pages that draw a curve keep their own `days`.
 */

let cache: StatsTotals | null = null;
let inFlight: Promise<void> | null = null;
const listeners = new Set<(totals: StatsTotals | null) => void>();

function load(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = api
    .stats({ days: 1 })
    .then((snapshot) => {
      cache = snapshot.totals;
    })
    // A missing count costs a footnote, never the page.
    .catch(() => {
      cache = null;
    })
    .finally(() => {
      inFlight = null;
      for (const listener of listeners) listener(cache);
    });
  return inFlight;
}

export function useStatsTotals(socket: RookerySocket): StatsTotals | null {
  const [totals, setTotals] = useState<StatsTotals | null>(cache);

  useEffect(() => {
    listeners.add(setTotals);
    void load();
    return () => {
      listeners.delete(setTotals);
    };
  }, []);

  // A turn, a deletion or a night all change what the counters say.
  useEffect(() => socket.onChanged(() => void load()), [socket]);

  return totals;
}
