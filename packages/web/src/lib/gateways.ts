import type { GatewayStatus } from './types';
import { lookOf, type State, type StateLook } from './state-look';

/**
 * Shared vocabulary of the Gateway overview and its detail page - both draw
 * the same badge for the same four words, so the mapping lives here instead
 * of in a component one of them would have to import from the other (see
 * `lib/tools.ts`, which does the same for the MCP hub).
 */

/**
 * One word about a gateway's state.
 *
 * Order is the point: a channel turned off says so even if its last start
 * failed - the failure stopped mattering the moment someone switched it off.
 * One still running says so even though it once errored, because "running" is
 * what a reader actually needs to know first.
 */
export function gatewayState(status: GatewayStatus): State {
  if (!status.enabled) return { label: 'Off', tone: 'off' };
  if (status.running) return { label: 'Running', tone: 'running' };
  // Ahead of the generic error: "Error" reads as something that might pass,
  // and this is the state that has stopped trying and waits for a person.
  if (status.blocked) return { label: 'Stopped', tone: 'error' };
  if (status.lastError) return { label: 'Error', tone: 'error' };
  return { label: 'Configured', tone: 'ready' };
}

/** How that state looks as a badge. Both pages draw the same one. */
export function gatewayStateLook(status: GatewayStatus): StateLook {
  return lookOf(gatewayState(status));
}
