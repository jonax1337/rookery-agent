import { useMemo } from 'react';
import { api, type ApiError } from '../lib/api';
import type { ListenerStatus } from '../lib/types';
import { createSharedList } from './shared-list';

/**
 * What every listener's connection is doing, held once for the whole app.
 *
 * Same shape as `useGateways`, and for the same reason: a listener connects,
 * loses its mailbox or is rejected by the server on its own, and no socket
 * frame tells the browser about it. So the roster refetches whenever the tab
 * becomes visible again, and after a settings save.
 */

const listenerList = createSharedList<ListenerStatus>(api.getListeners);

export interface UseListenersResult {
  listeners: ListenerStatus[];
  loading: boolean;
  error: ApiError | null;
  refresh(): Promise<void>;
  listenerById(id: string): ListenerStatus | undefined;
}

export function useListeners(): UseListenersResult {
  const state = listenerList.use();

  return useMemo<UseListenersResult>(
    () => ({
      listeners: state.items,
      loading: state.loading,
      error: state.error,
      refresh: listenerList.load,
      listenerById: (id) => state.items.find((entry) => entry.id === id),
    }),
    [state],
  );
}
