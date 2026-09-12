import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { api, ApiError } from '../lib/api';
import type { GatewayId, GatewayStatus, GatewayTestResult } from '../lib/types';

/**
 * The gateway roster, held once for the whole app - same shape as `useTools`.
 *
 * A gateway's `running` state changes on its own (Telegram connects, a token
 * goes missing) without any socket telling the browser, so the list refetches
 * after every mutation and whenever the tab becomes visible again, exactly
 * like the tool hub.
 */

interface GatewaysSnapshot {
  gateways: GatewayStatus[];
  loading: boolean;
  error: ApiError | null;
  /** False until the first response, so a second mount does not refetch. */
  loaded: boolean;
}

let snapshot: GatewaysSnapshot = { gateways: [], loading: true, error: null, loaded: false };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function publish(next: Partial<GatewaysSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** One request at a time; concurrent callers share the flight. */
function load(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const gateways = await api.getGateways();
      publish({ gateways, error: null, loading: false, loaded: true });
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

export interface UseGatewaysResult {
  gateways: GatewayStatus[];
  loading: boolean;
  error: ApiError | null;
  refresh(): Promise<void>;
  gatewayById(id: string | undefined): GatewayStatus | undefined;
  /** Sends a test push; refreshes afterwards, since it can clear `lastError`. */
  test(id: GatewayId): Promise<GatewayTestResult>;
}

export function useGateways(): UseGatewaysResult {
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

  return useMemo<UseGatewaysResult>(
    () => ({
      gateways: state.gateways,
      loading: state.loading,
      error: state.error,
      refresh: load,
      gatewayById: (id) => (id ? state.gateways.find((entry) => entry.id === id) : undefined),
      test: async (id) => {
        const result = await api.testGateway(id);
        await load();
        return result;
      },
    }),
    [state],
  );
}

/**
 * Named for the hook, not for the domain: `lib/gateways.ts` owns the word
 * "state" for what a channel is doing (läuft, aus, angehalten), and two
 * different `GatewayState`s in one feature is one too many.
 */
export interface UseGatewayResult extends UseGatewaysResult {
  /** Undefined while loading, and for an id the roster does not know. */
  gateway: GatewayStatus | undefined;
}

/**
 * One entry out of the shared list. There is no `GET /api/gateways/:id`, and
 * with the roster already in memory there is no reason to want one.
 */
export function useGateway(id: string | undefined): UseGatewayResult {
  const state = useGateways();
  return useMemo(() => ({ ...state, gateway: state.gatewayById(id) }), [state, id]);
}
