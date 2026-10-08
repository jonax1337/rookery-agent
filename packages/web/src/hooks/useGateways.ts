import { useMemo } from 'react';
import { api, type ApiError } from '../lib/api';
import type { GatewayId, GatewayStatus, GatewayTestResult } from '../lib/types';
import { createSharedList } from './shared-list';

/**
 * The gateway roster, held once for the whole app - same shape as `useTools`.
 *
 * A gateway's `running` state changes on its own (Telegram connects, a token
 * goes missing) without any socket telling the browser, so the list refetches
 * after every mutation and whenever the tab becomes visible again, exactly
 * like the tool hub.
 */

const gatewayList = createSharedList<GatewayStatus>(api.getGateways);

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
  const state = gatewayList.use();

  return useMemo<UseGatewaysResult>(
    () => ({
      gateways: state.items,
      loading: state.loading,
      error: state.error,
      refresh: gatewayList.load,
      gatewayById: (id) => (id ? state.items.find((entry) => entry.id === id) : undefined),
      test: async (id) => {
        const result = await api.testGateway(id);
        await gatewayList.load();
        return result;
      },
    }),
    [state],
  );
}

/**
 * Named for the hook, not for the domain: `lib/gateways.ts` owns the word
 * "state" for what a channel is doing (running, off, stopped), and two
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
