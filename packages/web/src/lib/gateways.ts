import { CircleCheckIcon, TriangleAlertIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { GatewayStatus } from './types';

/**
 * Shared vocabulary of the Gateway overview and its detail page - both draw
 * the same badge for the same four words, so the mapping lives here instead
 * of in a component one of them would have to import from the other (see
 * `lib/tools.ts`, which does the same for the MCP hub).
 */

export type GatewayStateTone = 'running' | 'ready' | 'off' | 'error';

export interface GatewayState {
  label: string;
  tone: GatewayStateTone;
}

/**
 * One word about a gateway's state.
 *
 * Order is the point: a channel turned off says so even if its last start
 * failed - the failure stopped mattering the moment someone switched it off.
 * One still running says so even though it once errored, because "läuft" is
 * what a reader actually needs to know first.
 */
export function gatewayState(status: GatewayStatus): GatewayState {
  if (!status.enabled) return { label: 'Off', tone: 'off' };
  if (status.running) return { label: 'Running', tone: 'running' };
  // Ahead of the generic error: "Fehler" reads as something that might pass,
  // and this is the state that has stopped trying and waits for a person.
  if (status.blocked) return { label: 'Stopped', tone: 'error' };
  if (status.lastError) return { label: 'Error', tone: 'error' };
  return { label: 'Configured', tone: 'ready' };
}

export interface GatewayStateLook extends GatewayState {
  variant: 'default' | 'outline' | 'destructive' | 'secondary';
  /** `null` for the resting states - "Aus" and "Eingerichtet" need no glyph. */
  icon: LucideIcon | null;
  iconClassName?: string;
}

const TONE_VARIANT: Record<GatewayStateTone, GatewayStateLook['variant']> = {
  running: 'default',
  ready: 'outline',
  off: 'secondary',
  error: 'destructive',
};

/** How that state looks as a badge. Both pages draw the same one. */
export function gatewayStateLook(status: GatewayStatus): GatewayStateLook {
  const state = gatewayState(status);
  if (state.tone === 'running') {
    return {
      ...state,
      variant: TONE_VARIANT.running,
      icon: CircleCheckIcon,
      // The filled check reads as "läuft" before the word is read.
      iconClassName: 'fill-status-ok',
    };
  }
  if (state.tone === 'error') {
    return { ...state, variant: TONE_VARIANT.error, icon: TriangleAlertIcon };
  }
  return { ...state, variant: TONE_VARIANT[state.tone], icon: null };
}
