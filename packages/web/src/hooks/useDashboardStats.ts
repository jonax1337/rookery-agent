import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api';
import type { RookerySocket } from '@/lib/socket';
import type { Assignment, StatsSnapshot } from '@/lib/types';

/**
 * The calendar's window: a whole year, straight up to the server's cap for
 * one stats call. Fifty-three week columns fill the card's width at a
 * readable cell size - the ninety days this fetched before stretched each
 * day into a bar once the calendar became the page's only activity view.
 */
const CALENDAR_DAYS = 366;

/** Org broadcasts arrive in bursts while work runs; one refetch per burst. */
const REFETCH_DEBOUNCE_MS = 400;

export interface DashboardStats {
  stats: StatsSnapshot | null;
  statsFailed: boolean;
  recentRuns: Assignment[] | null;
  runsFailed: boolean;
  reload(): Promise<void>;
}

/**
 * The year's counts and the newest runs - the two things the dashboard has no
 * hook of its own for - kept current whenever anything on the socket changes.
 */
export function useDashboardStats(socket: RookerySocket, runLimit: number): DashboardStats {
  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [statsFailed, setStatsFailed] = useState(false);
  const [recentRuns, setRecentRuns] = useState<Assignment[] | null>(null);
  const [runsFailed, setRunsFailed] = useState(false);
  // Sequence guard: the debounced socket refetch can overtake a load that is
  // still in flight; only the newest run may write state.
  const loadSeq = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current;
    const [snapshot, runs] = await Promise.allSettled([
      api.stats({ days: CALENDAR_DAYS }),
      api.assignments({ limit: runLimit }),
    ]);
    if (seq !== loadSeq.current) return;
    if (snapshot.status === 'fulfilled') {
      setStats(snapshot.value);
      setStatsFailed(false);
    } else {
      setStatsFailed(true);
    }
    if (runs.status === 'fulfilled') {
      setRecentRuns(runs.value);
      setRunsFailed(false);
    } else {
      setRunsFailed(true);
    }
  }, [runLimit]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Anything the company does moves at least one of these counts, and a
  // dashboard that needs a reload to be current is a screenshot.
  useEffect(() => {
    let timer: number | undefined;
    const unsubscribe = socket.onChanged(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void reload(), REFETCH_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
    };
  }, [socket, reload]);

  return { stats, statsFailed, recentRuns, runsFailed, reload };
}
