import { BadgeAlertIcon as TriangleAlertIcon, CircleCheckIcon } from '@/components/icons';
import type { IconComponent } from '@/components/icons';

/**
 * The badge vocabulary gateways and listeners share (see `lib/gateways.ts`,
 * `lib/listeners.ts`): both are something that is either running or is not,
 * and two pages that paint that fact differently make it look like two
 * different facts.
 */

export type StateTone = 'running' | 'ready' | 'off' | 'error';

export interface State {
  label: string;
  tone: StateTone;
}

export interface StateLook extends State {
  variant: 'default' | 'outline' | 'destructive' | 'secondary';
  /** `null` for the resting states - they need no glyph. */
  icon: IconComponent | null;
  iconClassName?: string;
}

const TONE_VARIANT: Record<StateTone, StateLook['variant']> = {
  running: 'default',
  ready: 'outline',
  off: 'secondary',
  error: 'destructive',
};

/** How a state looks as a badge. */
export function lookOf(state: State): StateLook {
  const variant = TONE_VARIANT[state.tone];
  // The filled check reads as "running" before the word is read.
  if (state.tone === 'running') {
    return { ...state, variant, icon: CircleCheckIcon, iconClassName: 'fill-status-ok' };
  }
  if (state.tone === 'error') return { ...state, variant, icon: TriangleAlertIcon };
  return { ...state, variant, icon: null };
}
