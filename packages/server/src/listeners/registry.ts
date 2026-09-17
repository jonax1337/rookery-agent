import type { ImapListenerConfig } from '@rookery/core';
import type { ServerContext } from '../context.js';
import { createImapListener } from './imap.js';
import type { ListenerHandle, ListenerStatus } from './types.js';

/**
 * Every listener this server holds open, kept in step with the settings.
 *
 * There is no `add` or `remove`: the config is the list, and `refresh()` makes
 * the running connections match it. That is the same contract the Telegram
 * gateway has - one call after `PATCH /api/config`, and whatever needs
 * starting, stopping or reconnecting does.
 */
export interface ListenerRegistry {
  start(): Promise<void>;
  stop(): Promise<void>;
  refresh(): Promise<void>;
  statuses(): ListenerStatus[];
}

export function createListenerRegistry(context: ServerContext): ListenerRegistry {
  const log = context.log.child('listeners');
  const handles = new Map<string, ListenerHandle>();

  /**
   * Reconciliation runs one at a time.
   *
   * `refresh()` arrives from an HTTP request and `start()` from the server
   * booting, so the two overlap easily - and two reconciliations interleaving
   * would have one of them stop a connection the other just opened.
   */
  let queue: Promise<void> = Promise.resolve();

  const entries = (): ImapListenerConfig[] => context.config.listeners.imap;

  /**
   * A handle is a closure over an id that knows nothing until it is started,
   * so making one on demand costs nothing and opens nothing. It means the
   * status list is as long as the settings list even before anything has been
   * started.
   */
  function handleFor(id: string): ListenerHandle {
    const existing = handles.get(id);
    if (existing) return existing;
    const handle = createImapListener(context, id);
    handles.set(id, handle);
    return handle;
  }

  function serial(task: () => Promise<void>): Promise<void> {
    const next = queue.then(task);
    queue = next.catch(() => {});
    return next;
  }

  /**
   * Bring the open connections in line with the settings.
   *
   * Every listener is its own errand. One mailbox whose server is down, whose
   * password is wrong or whose name was typed wrong must not stop the others
   * from starting, and must not fail the request that asked for this.
   */
  async function reconcile(): Promise<void> {
    const wanted = new Set(entries().map((entry) => entry.id));
    for (const [id, handle] of [...handles]) {
      if (wanted.has(id)) continue;
      handles.delete(id);
      try {
        await handle.stop();
      } catch (error) {
        log.warn('Listener did not stop cleanly', { id, error: (error as Error).message });
      }
    }
    for (const entry of entries()) {
      try {
        await handleFor(entry.id).refresh();
      } catch (error) {
        log.warn('Listener could not be brought up to date', { id: entry.id, error: (error as Error).message });
      }
    }
  }

  return {
    /** Starting is the same reconciliation, from nothing. */
    start(): Promise<void> {
      return serial(reconcile);
    },

    refresh(): Promise<void> {
      return serial(reconcile);
    },

    stop(): Promise<void> {
      return serial(async () => {
        for (const [id, handle] of handles) {
          try {
            await handle.stop();
          } catch (error) {
            log.warn('Listener did not stop cleanly', { id, error: (error as Error).message });
          }
        }
        handles.clear();
      });
    },

    statuses(): ListenerStatus[] {
      return entries().map((entry) => handleFor(entry.id).status());
    },
  };
}
