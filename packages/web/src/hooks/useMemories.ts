import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { MemoryKind, MemoryRecord, MemoryStats, ScoredMemory } from '../lib/types';

/** Memory panel state: browse, search, add, forget. */
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

  const forget = useCallback(
    async (id: string, hard = false) => {
      try {
        await api.forgetMemory(id, hard);
      } finally {
        setItems((current) => current.filter((item) => item.id !== id));
      }
    },
    [],
  );

  return { items, stats, query, setQuery, kind, setKind, loading, refresh, add, forget };
}
