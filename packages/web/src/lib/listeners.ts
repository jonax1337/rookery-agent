
import { BadgeAlertIcon as TriangleAlertIcon, CircleCheckIcon } from "@/components/icons";

import type { ListenerStatus } from './types';
import type { IconComponent } from "@/components/icons";

/**
 * One word about a listener's state, and how that word looks.
 *
 * Deliberately the same vocabulary and the same badge as `lib/gateways.ts`:
 * a held-open IMAP connection and a Telegram bot are the same kind of thing
 * to a reader - something that is either running or is not - and two pages
 * that paint that fact differently make it look like two different facts.
 */

export type ListenerStateTone = 'running' | 'ready' | 'off' | 'error';

export interface ListenerState {
  label: string;
  tone: ListenerStateTone;
}

/**
 * Order is the point: a listener switched off says so even if its last
 * connection failed, and one that is connected says so even though it once
 * errored.
 */
export function listenerState(status: ListenerStatus): ListenerState {
  if (!status.enabled) return { label: 'Off', tone: 'off' };
  if (status.running) return { label: 'Running', tone: 'running' };
  if (status.blocked) return { label: 'Stopped', tone: 'error' };
  if (status.lastError) return { label: 'Error', tone: 'error' };
  if (!status.configured) return { label: 'Needs a password', tone: 'error' };
  return { label: 'Connecting', tone: 'ready' };
}

export interface ListenerStateLook extends ListenerState {
  variant: 'default' | 'outline' | 'destructive' | 'secondary';
  /** `null` for the resting states - they need no glyph. */
  icon: IconComponent | null;
  iconClassName?: string;
}

const TONE_VARIANT: Record<ListenerStateTone, ListenerStateLook['variant']> = {
  running: 'default',
  ready: 'outline',
  off: 'secondary',
  error: 'destructive',
};

export function listenerStateLook(status: ListenerStatus): ListenerStateLook {
  const state = listenerState(status);
  if (state.tone === 'running') {
    return {
      ...state,
      variant: TONE_VARIANT.running,
      icon: CircleCheckIcon,
      iconClassName: 'fill-status-ok',
    };
  }
  if (state.tone === 'error') {
    return { ...state, variant: TONE_VARIANT.error, icon: TriangleAlertIcon };
  }
  return { ...state, variant: TONE_VARIANT[state.tone], icon: null };
}
