import { useCallback, useEffect, useState } from 'react';
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

/** Browse, search, add, edit and forget what the assistant remembers. */
export function useMemories() {
  const [items, setItems] = useState<(MemoryRecord | ScoredMemory)[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<MemoryKind | ''>('');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [list, counts] = await Promise.all([
        api.memories({
          q: query.trim() || undefined,
          kind: kind || undefined,
          limit: 100,
        }),
        api.memoryStats(),
      ]);
      setItems(list);
      setStats(counts);
    } catch {
      setItems([]);
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, [kind, query]);

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

  /** Pin, re-word, re-weight, or wake a sleeping memory. */
  const patch = useCallback(
    async (
      id: string,
      changes: { pinned?: boolean; importance?: number; content?: string; dormant?: boolean },
    ) => {
      const updated = await api.patchMemory(id, changes);
      setItems((current) => current.map((item) => (item.id === id ? { ...item, ...updated } : item)));
      void api.memoryStats().then(setStats).catch(() => undefined);
      return updated;
    },
    [],
  );

  return { items, stats, query, setQuery, kind, setKind, loading, refresh, add, forget, patch };
}

/**
 * The graph view's data: entities, memories and the edges between them.
 * Kept apart from the list so switching tabs does not refetch both.
 */
export function useMemoryGraph(options: { limit?: number } = {}) {
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [entities, setEntities] = useState<MemoryEntity[]>([]);
  const [entity, setEntity] = useState<string>('');
  const [includeDormant, setIncludeDormant] = useState(false);
  const [loading, setLoading] = useState(false);
  const limit = options.limit ?? 300;

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [data, names] = await Promise.all([
        api.memoryGraph({ entity: entity || undefined, includeDormant, limit }),
        api.entities({ limit: 100 }),
      ]);
      setGraph(data);
      setEntities(names);
    } catch {
      setGraph(null);
      setEntities([]);
    } finally {
      setLoading(false);
    }
  }, [entity, includeDormant, limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { graph, entities, entity, setEntity, includeDormant, setIncludeDormant, loading, refresh };
}

/**
 * The night shift as the page sees it: what it is doing right now, what it
 * did last time, and the whole history with an undo per run.
 *
 * Phases arrive over the socket, so a run started in another tab or by the
 * clock at half past three shows up here exactly the same way.
 */
export function useSleep(socket: RookerySocket, onFinished?: () => void) {
  const [status, setStatus] = useState<SleepStatusView | null>(null);
  const [runs, setRuns] = useState<SleepRun[]>([]);
  const [phase, setPhase] = useState<string>('');
  const [cycle, setCycle] = useState(0);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [state, history] = await Promise.all([api.sleepStatus(), api.sleepRuns(undefined, 20)]);
      setStatus(state);
      setRuns(history);
    } catch {
      setStatus(null);
      setRuns([]);
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

  return { status, runs, phase, cycle, busy, refresh, start, cancel, undo };
}
