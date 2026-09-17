import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { api, ApiError } from '../lib/api';
import type { ListenerStatus } from '../lib/types';

/**
 * What every listener's connection is doing, held once for the whole app.
 *
 * Same shape as `useGateways`, and for the same reason: a listener connects,
 * loses its mailbox or is rejected by the server on its own, and no socket
 * frame tells the browser about it. So the roster refetches whenever the tab
 * becomes visible again, and after a settings save.
 */

interface ListenersSnapshot {
  listeners: ListenerStatus[];
  loading: boolean;
  error: ApiError | null;
  /** False until the first response, so a second mount does not refetch. */
  loaded: boolean;
}

let snapshot: ListenersSnapshot = { listeners: [], loading: true, error: null, loaded: false };
const subscribers = new Set<() => void>();
let inflight: Promise<void> | null = null;

function publish(next: Partial<ListenersSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const subscriber of subscribers) subscriber();
}

function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

/** One request at a time; concurrent callers share the flight. */
function load(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const listeners = await api.getListeners();
      publish({ listeners, error: null, loading: false, loaded: true });
    } catch (caught) {
      publish({
        error: caught instanceof ApiError ? caught : new ApiError(String(caught), 0),
        loading: false,
        loaded: true,
      });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export interface UseListenersResult {
  listeners: ListenerStatus[];
  loading: boolean;
  error: ApiError | null;
  refresh(): Promise<void>;
  listenerById(id: string): ListenerStatus | undefined;
}

export function useListeners(): UseListenersResult {
  const state = useSyncExternalStore(subscribe, () => snapshot);

  useEffect(() => {
    if (!snapshot.loaded) void load();
  }, []);

  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  return useMemo<UseListenersResult>(
    () => ({
      listeners: state.listeners,
      loading: state.loading,
      error: state.error,
      refresh: load,
      listenerById: (id) => state.listeners.find((entry) => entry.id === id),
    }),
    [state],
  );
}
