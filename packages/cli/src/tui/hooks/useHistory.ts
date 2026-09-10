/**
 * Prompt history for the input box.
 *
 * Behaves the way a shell does: Up walks back through what was sent, Down
 * walks forward, and stepping past the newest entry restores whatever draft
 * was being typed before the walk started.
 */

import { useCallback, useRef, useState } from 'react';

export interface HistoryApi {
  /** Record a submitted line. Consecutive duplicates are collapsed. */
  push: (line: string) => void;
  /**
   * Walk the history. `delta` of -1 is older (Up), +1 is newer (Down).
   * Returns the line to show, or null when there is nowhere to go.
   */
  walk: (delta: number, draft: string) => string | null;
  /** Called on any edit: the next Up starts a fresh walk from the draft. */
  reset: () => void;
  entries: readonly string[];
}

export function useHistory(initial: readonly string[] = [], limit = 250): HistoryApi {
  const [entries, setEntries] = useState<string[]>(() => [...initial]);
  /** -1 means "not walking"; otherwise an index from the end, 0 = newest. */
  const offset = useRef(-1);
  const stashed = useRef('');

  const push = useCallback(
    (line: string) => {
      offset.current = -1;
      stashed.current = '';
      const trimmed = line.trim();
      if (!trimmed) return;
      setEntries((current) => {
        if (current[current.length - 1] === trimmed) return current;
        const next = [...current, trimmed];
        return next.length > limit ? next.slice(next.length - limit) : next;
      });
    },
    [limit],
  );

  const reset = useCallback(() => {
    offset.current = -1;
    stashed.current = '';
  }, []);

  const walk = useCallback(
    (delta: number, draft: string): string | null => {
      if (!entries.length) return null;

      if (offset.current === -1) {
        // Only Up can start a walk; Down at rest has nothing older to show.
        if (delta >= 0) return null;
        stashed.current = draft;
        offset.current = 0;
        return entries[entries.length - 1] ?? null;
      }

      // delta -1 (older) moves the offset further from the end.
      const next = offset.current + (delta < 0 ? 1 : -1);
      if (next < 0) {
        offset.current = -1;
        const restored = stashed.current;
        stashed.current = '';
        return restored;
      }
      if (next >= entries.length) return null;

      offset.current = next;
      return entries[entries.length - 1 - next] ?? null;
    },
    [entries],
  );

  return { push, walk, reset, entries };
}
