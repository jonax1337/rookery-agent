/**
 * A clock for animation: a frame counter for spinners and caret blink, and
 * the wall-clock time for elapsed counters.
 *
 * Both advance on one interval so a single state update repaints a screen.
 */

import { useEffect, useState } from 'react';

/** Spinners and carets only ever read `frame` modulo something small. */
const FRAME_WRAP = 100_000;

export interface Tick {
  frame: number;
  now: number;
}

/** Tick every `intervalMs`; `null` holds the clock still. */
export function useTicker(intervalMs: number | null): Tick {
  const [tick, setTick] = useState<Tick>(() => ({ frame: 0, now: Date.now() }));

  useEffect(() => {
    if (intervalMs === null) return;
    const timer = setInterval(() => {
      setTick((current) => ({ frame: (current.frame + 1) % FRAME_WRAP, now: Date.now() }));
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [intervalMs]);

  return tick;
}
