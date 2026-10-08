/**
 * Coalesced pushes of mutable live state into React.
 *
 * A fast provider emits hundreds of events a second; a setState per event
 * would spend the whole frame budget in the reconciler instead of in the
 * terminal. Mutations land in a ref first and `schedule` commits them at most
 * once per `FLUSH_MS`.
 */

/** How often live state is pushed into React, in milliseconds. */
const FLUSH_MS = 40;

export interface Coalescer {
  /** Commit soon, unless a commit is already pending. */
  schedule: () => void;
  /** Commit now and drop any pending commit. */
  flushNow: () => void;
  /** Drop any pending commit without committing. */
  cancel: () => void;
}

export function createCoalescer(commit: () => void): Coalescer {
  let timer: NodeJS.Timeout | null = null;

  const cancel = (): void => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  return {
    schedule: () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        commit();
      }, FLUSH_MS);
      timer.unref?.();
    },
    flushNow: () => {
      cancel();
      commit();
    },
    cancel,
  };
}
