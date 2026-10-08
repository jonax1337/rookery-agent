import type { ListenerStatus } from './types';
import { lookOf, type State, type StateLook } from './state-look';

/**
 * One word about a listener's state, and how that word looks.
 *
 * Deliberately the same vocabulary and the same badge as `lib/gateways.ts`
 * (both draw it through `lib/state-look.ts`): a held-open IMAP connection and
 * a Telegram bot are the same kind of thing to a reader.
 */

/**
 * Order is the point: a listener switched off says so even if its last
 * connection failed, and one that is connected says so even though it once
 * errored.
 */
export function listenerState(status: ListenerStatus): State {
  if (!status.enabled) return { label: 'Off', tone: 'off' };
  if (status.running) return { label: 'Running', tone: 'running' };
  if (status.blocked) return { label: 'Stopped', tone: 'error' };
  if (status.lastError) return { label: 'Error', tone: 'error' };
  if (!status.configured) return { label: 'Needs a password', tone: 'error' };
  return { label: 'Connecting', tone: 'ready' };
}

export function listenerStateLook(status: ListenerStatus): StateLook {
  return lookOf(listenerState(status));
}
