import { useEffect, useSyncExternalStore } from 'react';
import { toApiError, type ApiError } from '../lib/api';

/**
 * A list the whole app holds once, outside any component.
 *
 * Tools, skills, gateways and listeners hang on no socket broadcast, so their
 * pages share one module-level copy that refetches after a mutation and
 * whenever the tab becomes visible again. The list page and the detail page
 * read the same rows; the detail page used to pull the whole catalogue a
 * second time just to find one entry.
 */

export interface SharedListSnapshot<T> {
  items: T[];
  loading: boolean;
  error: ApiError | null;
  /** False until the first response, so a second mount does not refetch. */
  loaded: boolean;
}

export interface SharedList<T> {
  /** The latest snapshot, for code that runs outside a render (a mutation, a rollback). */
  snapshot(): SharedListSnapshot<T>;
  /** Replace the rows; loading and error stay as they are. */
  setItems(items: T[]): void;
  /** One request at a time; concurrent callers share the flight. */
  load(): Promise<void>;
  /** Subscribes the calling component to the snapshot. */
  use(): SharedListSnapshot<T>;
}

interface SharedListOptions {
  /**
   * An eager list loads on the first mount and again whenever the tab becomes
   * visible, and reports `loading` only until its first answer. A lazy one
   * (the public skill catalogue: a network call to GitHub's side of the
   * world) loads only when asked, and reports `loading` on every load.
   */
  lazy?: boolean;
}

export function createSharedList<T>(
  fetchItems: () => Promise<T[]>,
  { lazy = false }: SharedListOptions = {},
): SharedList<T> {
  let current: SharedListSnapshot<T> = { items: [], loading: !lazy, error: null, loaded: false };
  const listeners = new Set<() => void>();
  let inflight: Promise<void> | null = null;

  function publish(next: Partial<SharedListSnapshot<T>>): void {
    current = { ...current, ...next };
    for (const listener of listeners) listener();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function load(): Promise<void> {
    if (inflight) return inflight;
    if (lazy) publish({ loading: true });
    inflight = (async () => {
      try {
        publish({ items: await fetchItems(), error: null, loading: false, loaded: true });
      } catch (caught) {
        publish({ error: toApiError(caught), loading: false, loaded: true });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function useSharedList(): SharedListSnapshot<T> {
    const state = useSyncExternalStore(subscribe, () => current);

    useEffect(() => {
      if (!lazy && !current.loaded) void load();
    }, []);

    useEffect(() => {
      if (lazy) return;
      const onVisible = (): void => {
        if (document.visibilityState === 'visible') void load();
      };
      document.addEventListener('visibilitychange', onVisible);
      return () => document.removeEventListener('visibilitychange', onVisible);
    }, []);

    return state;
  }

  return {
    snapshot: () => current,
    setItems: (items) => publish({ items }),
    load,
    use: useSharedList,
  };
}
