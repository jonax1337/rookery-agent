import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { RookerySocket } from '../lib/socket';
import type {
  MemoryEntity,
  MemoryGraph,
  MemoryKind,
  MemoryRecord,
  MemoryStats,
  ScoredMemory,
  SleepRun,
  SleepStatusView,
} from '../lib/types';

/**
 * The server's ceiling for `GET /api/memories`. Asking for more is clamped
 * there, so the list page can say "von 500 geladenen" and mean it.
 */
export const MEMORY_LIST_LIMIT = 500;

/** Browse, search, add, edit and forget what the assistant remembers. */
export function useMemories() {
  const [items, setItems] = useState<(MemoryRecord | ScoredMemory)[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<MemoryKind | ''>('');
  // Forgotten memories are still in the database; the list hides them until
  // someone asks, because they are not what the assistant can recall.
  const [includeForgotten, setIncludeForgotten] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  // Sequence guard: the search debounce can start a new refresh while the
  // previous one is still out; only the newest run may write state, so a slow
  // older answer cannot bring back an outdated result list.
  const refreshSeq = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const seq = ++refreshSeq.current;
    setLoading(true);
    try {
      const [list, counts] = await Promise.all([
        api.memories({
          q: query.trim() || undefined,
          kind: kind || undefined,
          limit: MEMORY_LIST_LIMIT,
          includeForgotten,
        }),
        api.memoryStats(),
      ]);
      if (seq !== refreshSeq.current) return;
      setItems(list);
      setStats(counts);
      setError(false);
    } catch {
      if (seq !== refreshSeq.current) return;
      setItems([]);
      setStats(null);
      setError(true);
    } finally {
      if (seq === refreshSeq.current) setLoading(false);
    }
  }, [includeForgotten, kind, query]);

  // Debounced so typing in the search box does not hammer the API.
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [refresh, query]);

  const add = useCallback(
    async (input: { content: string; kind?: MemoryKind; tags?: string[]; importance?: number }) => {
      try {
        await api.addMemory(input);
        await refresh();
        return true;
      } catch {
        return false;
      }
    },
    [refresh],
  );

  const forget = useCallback(async (id: string, hard = false) => {
    try {
      await api.forgetMemory(id, hard);
    } finally {
      setItems((current) => current.filter((item) => item.id !== id));
    }
  }, []);

  /** Pin, re-word, re-weight, re-file, wake or un-forget a memory. */
  const patch = useCallback(
    async (
      id: string,
      changes: {
        pinned?: boolean;
        importance?: number;
        content?: string;
        kind?: MemoryKind;
        tags?: string[];
        dormant?: boolean;
        forgotten?: boolean;
      },
    ) => {
      const updated = await api.patchMemory(id, changes);
      setItems((current) => current.map((item) => (item.id === id ? { ...item, ...updated } : item)));
      void api.memoryStats().then(setStats).catch(() => undefined);
      return updated;
    },
    [],
  );

  // The list hangs exactly at the server's ceiling: there may be more that no
  // page of this API can reach, and the table footer has to say so. A search
  // answers with a ranked shortlist, which is a different kind of list and
  // never "capped".
  const capped = !query.trim() && items.length >= MEMORY_LIST_LIMIT;

  return {
    items,
    stats,
    query,
    setQuery,
    kind,
    setKind,
    includeForgotten,
    setIncludeForgotten,
    capped,
    loading,
    error,
    refresh,
    add,
    forget,
    patch,
  };
}

/**
 * The graph view's data: entities, memories and the edges between them.
 * Kept apart from the list so switching tabs does not refetch both.
 */
export function useMemoryGraph(options: { limit?: number } = {}) {
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  // The whole net, unfiltered and with the sleeping memories in: the cortex
  // lays everything out from this and draws only `graph`, so a filter
  // removes bodies without moving the ones that stay.
  const [atlas, setAtlas] = useState<MemoryGraph | null>(null);
  const [entities, setEntities] = useState<MemoryEntity[]>([]);
  const [entity, setEntity] = useState<string>('');
  const [includeDormant, setIncludeDormant] = useState(false);
  const [loading, setLoading] = useState(false);
  const limit = options.limit ?? 300;
  // Sequence guard: night runs and memory edits refresh in the background;
  // a slow answer for a previous entity filter must not repaint the graph.
  const seq = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const run = ++seq.current;
    setLoading(true);
    try {
      const [data, names, whole] = await Promise.all([
        api.memoryGraph({ entity: entity || undefined, includeDormant, limit }),
        api.entities({ limit: 100 }),
        api.memoryGraph({ includeDormant: true, limit }),
      ]);
      if (run !== seq.current) return;
      setGraph(data);
      setEntities(names);
      setAtlas(whole);
    } catch {
      if (run !== seq.current) return;
      setGraph(null);
      setEntities([]);
      setAtlas(null);
    } finally {
      if (run === seq.current) setLoading(false);
    }
  }, [entity, includeDormant, limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { graph, atlas, entities, entity, setEntity, includeDormant, setIncludeDormant, loading, refresh };
}

/**
 * The night shift as the page sees it: what it is doing right now, what it
 * did last time, and the whole history with an undo per run.
 *
 * Phases arrive over the socket, so a run started in another tab or by the
 * clock at half past three shows up here exactly the same way.
 */
export const SLEEP_RUN_LIMIT = 200;

export function useSleep(socket: RookerySocket, onFinished?: () => void) {
  const [status, setStatus] = useState<SleepStatusView | null>(null);
  const [runs, setRuns] = useState<SleepRun[]>([]);
  const [phase, setPhase] = useState<string>('');
  const [cycle, setCycle] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  // Without this the table shows "Noch keine Nacht gelaufen" plus a "Jetzt
  // schlafen" button for the duration of both requests, even when nights exist.
  const [loading, setLoading] = useState(false);

  // Sequence guard: mount, `undo` and the socket can overlap refreshes; only
  // the newest run may write state over status and history.
  const refreshSeq = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const seq = ++refreshSeq.current;
    setLoading(true);
    try {
      // 200 nights is roughly half a year of nightly runs - enough to draw the
      // 90-day curve the Nächte page shows without a second request.
      const [state, history] = await Promise.all([
        api.sleepStatus(),
        api.sleepRuns(undefined, SLEEP_RUN_LIMIT),
      ]);
      if (seq !== refreshSeq.current) return;
      setStatus(state);
      setRuns(history);
      setError(false);
    } catch {
      if (seq !== refreshSeq.current) return;
      setStatus(null);
      setRuns([]);
      setError(true);
    } finally {
      if (seq === refreshSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return socket.onSleep((event) => {
      setPhase(event.phase ?? '');
      setCycle(event.cycle ?? 0);
      setRuns((current) => {
        const rest = current.filter((run) => run.id !== event.run.id);
        return [event.run, ...rest].sort((a, b) => b.startedAt - a.startedAt);
      });
      setStatus((current) =>
        current ? { ...current, running: event.run.status === 'running', lastRun: event.run } : current,
      );
      if (event.phase === 'finished') {
        setPhase('');
        setCycle(0);
        setBusy(false);
        // The bank looks different now: list and graph both want a reload.
        onFinished?.();
      }
    });
  }, [socket, onFinished]);

  const start = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    try {
      await api.startSleep();
      setStatus((current) => (current ? { ...current, running: true } : current));
      return true;
    } catch {
      setBusy(false);
      return false;
    }
  }, []);

  const cancel = useCallback(async (): Promise<void> => {
    try {
      await api.cancelSleep();
    } finally {
      setBusy(false);
    }
  }, []);

  const undo = useCallback(
    async (id: string) => {
      const result = await api.undoSleep(id);
      await refresh();
      onFinished?.();
      return result;
    },
    [onFinished, refresh],
  );

  /** Reshape the nightly run's own schedule from the memory page. */
  const saveSchedule = useCallback(async (patch: { schedule?: string; enabled?: boolean }): Promise<boolean> => {
    try {
      const updated = await api.updateSleepSchedule(patch);
      setStatus((current) => (current ? { ...current, schedule: updated.schedule, config: updated.config } : current));
      return true;
    } catch {
      return false;
    }
  }, []);

  return { status, runs, phase, cycle, busy, error, loading, refresh, start, cancel, undo, saveSchedule };
}
