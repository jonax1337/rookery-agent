/**
 * Prompt history for the input box.
 *
 * Behaves the way a shell does: Up walks back through what was sent, Down
 * walks forward, and stepping past the newest entry restores whatever draft
 * was being typed before the walk started.
 */

import { useCallback, useRef, useState } from 'react';

/** How many submitted lines are remembered. */
const HISTORY_LIMIT = 250;

/** Walk direction: toward older entries (Up). */
export const OLDER = -1;
/** Walk direction: toward newer entries (Down). */
export const NEWER = 1;

export interface HistoryApi {
  /** Record a submitted line. Consecutive duplicates are collapsed. */
  push: (line: string) => void;
  /**
   * Walk the history in `OLDER` or `NEWER` direction.
   * Returns the line to show, or null when there is nowhere to go.
   */
  walk: (direction: typeof OLDER | typeof NEWER, draft: string) => string | null;
  /** Called on any edit: the next Up starts a fresh walk from the draft. */
  reset: () => void;
}

export function useHistory(): HistoryApi {
  const [entries, setEntries] = useState<string[]>([]);
  /** -1 means "not walking"; otherwise an index from the end, 0 = newest. */
  const offset = useRef(-1);
  const stashed = useRef('');

  const reset = useCallback(() => {
    offset.current = -1;
    stashed.current = '';
  }, []);

  const push = useCallback(
    (line: string) => {
      reset();
      const trimmed = line.trim();
      if (!trimmed) return;
      setEntries((current) => {
        if (current[current.length - 1] === trimmed) return current;
        return [...current, trimmed].slice(-HISTORY_LIMIT);
      });
    },
    [reset],
  );

  const walk = useCallback(
    (direction: typeof OLDER | typeof NEWER, draft: string): string | null => {
      if (!entries.length) return null;

      if (offset.current === -1) {
        // Only Up can start a walk; Down at rest has nothing older to show.
        if (direction === NEWER) return null;
        stashed.current = draft;
        offset.current = 0;
        return entries[entries.length - 1] ?? null;
      }

      // Older moves the offset further from the end.
      const next = offset.current + (direction === OLDER ? 1 : -1);
      if (next < 0) {
        const restored = stashed.current;
        reset();
        return restored;
      }
      if (next >= entries.length) return null;

      offset.current = next;
      return entries[entries.length - 1 - next] ?? null;
    },
    [entries, reset],
  );

  return { push, walk, reset };
}
