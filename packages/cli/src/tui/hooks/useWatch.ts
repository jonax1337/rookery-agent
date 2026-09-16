/**
 * Following one running assignment's live log.
 *
 * The org controller keeps a ring buffer per running assignment and hands out
 * a generator that replays it and then follows the run live; this hook is the
 * TUI end of that pipe. It folds the events into the same `LiveBlocks`
 * accumulator a turn of our own uses, on the same coalescing clock, so the
 * watch renders through the identical `blockSegments` walk the live region
 * renders through - watching a run looks like watching a turn.
 *
 * Nothing here is ever committed to the static scrollback: the watch is a
 * window over a run, and when the run ends, only the persisted result
 * remains (which the org views already show).
 */

import { useEffect, useRef, useState } from 'react';
import type { Assistant } from '@rookery/core';
import type { AgentEvent } from '@rookery/core';
import { glyph, ui } from '../theme.js';
import { LiveBlocks } from './useTurn.js';
import type { LiveBlock, NoteActivity, ToolTiming } from '../types.js';

/** How often live watch state is pushed into React, in milliseconds. */
const FLUSH_MS = 40;
/** Spinner and clock cadence while the watch is open, in milliseconds. */
const TICK_MS = 80;

/** What the watch is showing right now. Plain data, so views stay pure. */
export interface WatchState {
  blocks: LiveBlock[];
  toolTimes: ToolTiming[];
  /** True once the generator ended: the run is over or was never active. */
  ended: boolean;
  /** When the watch was opened, for the elapsed clock. */
  startedAt: number;
}

/** The state plus the animation inputs the view renders it with. */
export interface WatchFeed {
  state: WatchState;
  frame: number;
  now: number;
}

const WATCH_IDLE: WatchState = { blocks: [], toolTimes: [], ended: false, startedAt: 0 };

/**
 * Consume an assignment's live log. Pass a null assistant (or empty id) to
 * sit idle - the hook is mounted for the whole app lifetime and only consumes
 * while a watch is actually open.
 */
export function useWatch(assistant: Assistant | null, assignmentId: string): WatchFeed {
  const [state, setState] = useState<WatchState>(WATCH_IDLE);
  const [tick, setTick] = useState({ frame: 0, now: Date.now() });
  const active = Boolean(assistant && assignmentId);

  const latest = useRef({ assistant, assignmentId });
  latest.current = { assistant, assignmentId };

  useEffect(() => {
    if (!assistant || !assignmentId) {
      setState(WATCH_IDLE);
      return;
    }

    const accumulator = new LiveBlocks();
    let ended = false;
    let cancelled = false;
    let timer: NodeJS.Timeout | null = null;
    const startedAt = Date.now();
    let noteSeq = 0;
    const nextNoteId = () => 'w' + (noteSeq += 1);

    const flush = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (cancelled) return;
      setState({
        blocks: accumulator.blocks,
        toolTimes: accumulator.toolTimes.slice(),
        ended,
        startedAt,
      });
    };
    const schedule = (): void => {
      if (timer) return;
      timer = setTimeout(flush, FLUSH_MS);
      timer.unref?.();
    };

    setState({ blocks: [], toolTimes: [], ended: false, startedAt });

    void (async () => {
      try {
        // Reading through the ref keeps the effect's dependency list about
        // identity, not whichever assistant instance render captured.
        const source = latest.current.assistant;
        if (!source) return;
        for await (const entry of source.assignmentLog(assignmentId)) {
          if (cancelled) break;
          foldWatchEvent(accumulator, entry.event, nextNoteId);
          schedule();
        }
      } catch {
        // The run vanishing mid-read ends the watch, not the app.
      }
      ended = true;
      flush();
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [assistant, assignmentId]);

  // The watch keeps its own animation clock: the app's ticker slows to half a
  // second when no turn of ours is running, which would make a busy run's
  // pulses look asleep.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setTick((current) => ({ frame: (current.frame + 1) % 100_000, now: Date.now() }));
    }, TICK_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [active]);

  return { state, frame: tick.frame, now: tick.now };
}

/**
 * Fold one live-log event into the accumulator.
 *
 * Text, thinking and tool events are transcript; the rest of what the log
 * carries becomes dim notes - the provider switch status a run broadcasts
 * when it restarts on a fallback, and fatal errors - so a watcher understands
 * a pause instead of staring at a silent screen. The switch also ends the
 * dead attempt as a transcript: the controller resets its buffer for it, so
 * the retry's first delta opens a fresh block instead of merging into the
 * attempt the watcher just watched fail.
 */
export function foldWatchEvent(
  blocks: LiveBlocks,
  event: AgentEvent,
  nextNoteId: () => string,
): void {
  if (event.type === 'text' || event.type === 'thinking' || event.type === 'tool') {
    blocks.apply(event);
    return;
  }
  if (event.type === 'status') {
    blocks.reconcile('');
    const note: NoteActivity = {
      kind: 'note',
      id: nextNoteId(),
      icon: glyph.status,
      text: event.label + (event.detail ? ' ' + glyph.dot + ' ' + event.detail : ''),
    };
    blocks.pushNote(note);
    return;
  }
  if (event.type === 'error') {
    const note: NoteActivity = {
      kind: 'note',
      id: nextNoteId(),
      icon: glyph.fail,
      text: event.message,
      color: ui.danger,
    };
    blocks.pushNote(note);
  }
}
