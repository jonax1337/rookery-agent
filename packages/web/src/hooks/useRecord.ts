import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '@/lib/api';
import { failureMessage } from '@/lib/errors';

/**
 * One record, fetched by id, with the one distinction the detail pages kept
 * getting wrong: gone is not broken.
 *
 * Four detail pages wrote this by hand in four versions. Three of them told a
 * 404 apart from an outage; the agent page did not, so a deleted agent ended
 * up behind `ServerOffline` with a "Try again" button that could never
 * work, and the "This agent does not exist" state next to it was
 * unreachable code. `missing` is what brings that branch back.
 *
 * Reloading after a socket event stays the page's business - it knows which
 * events concern its record. Call `reload()` from there.
 */

export interface RecordHandle<T> {
  record: T | null;
  /** True until the first answer arrives, and again on an explicit reload. */
  loading: boolean;
  /** The server said 404: the record is gone. Show an `EmptyState`, not an error. */
  missing: boolean;
  /** Anything else that went wrong, already turned into one sentence. */
  error: string | null;
  reload(): Promise<void>;
}

interface Outcome<T> {
  id: string;
  record: T | null;
  missing: boolean;
  error: string | null;
}

export function useRecord<T>(
  id: string | undefined,
  fetcher: (id: string) => Promise<T>,
): RecordHandle<T> {
  // What the last answer said, and for which id: an answer about another id
  // is never shown, so navigating from one record to the next cannot flash
  // the old record under the new URL.
  const [outcome, setOutcome] = useState<Outcome<T> | null>(null);
  const [loading, setLoading] = useState(true);

  // The fetcher is usually written inline (`(key) => api.agent(key)`), so it
  // changes identity on every render. Keeping it in a ref stops `load` from
  // doing the same, which would turn the effect below into a fetch loop.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Sequence guard: `load` runs from the effect below and from the page's own
  // reload calls; only the newest run may write state, so a slow answer for
  // the previous id cannot land on the record on screen now.
  const loadSeq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current;
    if (!id) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const record = await fetcherRef.current(id);
      if (seq !== loadSeq.current) return;
      setOutcome({ id, record, missing: false, error: null });
    } catch (caught) {
      if (seq !== loadSeq.current) return;
      // A 404 is not an outage: the record was deleted, and the page has to say
      // so instead of offering a retry that will never work.
      if (caught instanceof ApiError && caught.status === 404) {
        setOutcome({ id, record: null, missing: true, error: null });
      } else {
        // A failed reload keeps the record the page already shows.
        setOutcome((previous) => ({
          id,
          record: previous?.id === id ? previous.record : null,
          missing: false,
          error: failureMessage(caught),
        }));
      }
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = outcome?.id === id ? outcome : null;
  return {
    record: current?.record ?? null,
    // Between a new id and its first answer there is nothing to show yet.
    loading: loading || (Boolean(id) && current === null),
    missing: current?.missing ?? false,
    error: current?.error ?? null,
    reload: load,
  };
}
