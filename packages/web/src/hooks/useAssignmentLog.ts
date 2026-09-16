import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { RookerySocket } from '../lib/socket';
import type { AssignmentLogEntry, AssignmentStatus } from '../lib/types';

/**
 * Merges live frames onto a log snapshot, strictly by `seq`: every sequence
 * number appears once, the snapshot's version of an entry wins over a
 * frame's, and the result is sorted. Frames below the snapshot's oldest
 * entry stay dropped - that is the overflow the server already discarded,
 * and what it dropped must not come back through the wire. A gap in `seq`
 * above that means overflow too, never wire loss, so continuity is never
 * assumed. An empty snapshot keeps every frame: it bounds nothing yet.
 */
export function mergeLogEntries(
  snapshot: readonly AssignmentLogEntry[],
  frames: readonly AssignmentLogEntry[],
): AssignmentLogEntry[] {
  const bySeq = new Map<number, AssignmentLogEntry>();
  let minSeq = Infinity;
  for (const entry of snapshot) {
    bySeq.set(entry.seq, entry);
    if (entry.seq < minSeq) minSeq = entry.seq;
  }
  for (const entry of frames) {
    if (snapshot.length > 0 && entry.seq < minSeq) continue;
    if (!bySeq.has(entry.seq)) bySeq.set(entry.seq, entry);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

const FINISHED = new Set<AssignmentStatus>(['done', 'failed', 'cancelled']);

export interface AssignmentLogState {
  /** The log so far, ordered by `seq`. */
  entries: AssignmentLogEntry[];
  /** True once the run is over - nothing more will arrive. */
  finished: boolean;
  /** True when the server had to drop the oldest entries to stay under its cap. */
  overflowed: boolean;
  error: string | null;
}

/**
 * The live log of one running assignment, as a terminal would show it.
 *
 * Attach protocol, in the order that makes it gap-free: send `watch` first,
 * then ask for the REST snapshot. Frames that beat the snapshot to the client
 * are buffered (push-only frames cannot be replayed) and merged onto it once
 * it resolves; everything after merges in as it arrives. The end of the run
 * is learned from the `org.live` status the caller passes in, or from the
 * snapshot request answering 410 - after the end only the persisted result
 * remains, the buffer is gone by design.
 */
export function useAssignmentLog(
  socket: RookerySocket,
  assignmentId: string,
  options: { liveStatus?: AssignmentStatus } = {},
): AssignmentLogState {
  const [entries, setEntries] = useState<AssignmentLogEntry[]>([]);
  const [overflowed, setOverflowed] = useState(false);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Frames from before the snapshot resolved. Kept in a ref, not state: they
  // are not rendered on their own, they only fill the gap the snapshot left.
  const framesRef = useRef<AssignmentLogEntry[]>([]);
  const snapshotRef = useRef<AssignmentLogEntry[] | null>(null);

  // 1. Watch first, so nothing between here and the snapshot is lost. On a
  // closed socket this remembers the id and re-sends it on the next `open`.
  useEffect(() => {
    framesRef.current = [];
    snapshotRef.current = null;
    setEntries([]);
    setOverflowed(false);
    setGone(false);
    setError(null);
    socket.watchAssignment(assignmentId);
    return () => socket.unwatchAssignment(assignmentId);
  }, [socket, assignmentId]);

  // 2. Then the snapshot, onto which the buffered frames merge.
  useEffect(() => {
    let cancelled = false;
    api
      .assignmentLog(assignmentId)
      .then((snapshot) => {
        if (cancelled) return;
        snapshotRef.current = snapshot.events;
        setOverflowed(snapshot.overflowed);
        setEntries(mergeLogEntries(snapshot.events, framesRef.current));
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (caught instanceof ApiError && (caught.status === 410 || caught.status === 404)) {
          // 410: the run is over, the buffer went with it. 404: the id never
          // existed. Either way the live log is gone for good.
          setGone(true);
          return;
        }
        // A snapshot that could not be fetched must not block the wire: the
        // frames already buffered become the baseline, live ones keep going.
        snapshotRef.current = [];
        setEntries([...framesRef.current]);
        setError(caught instanceof Error ? caught.message : 'Log nicht erreichbar.');
      });
    return () => {
      cancelled = true;
    };
  }, [assignmentId]);

  // 3. Live frames, for this assignment only, merged strictly by seq.
  useEffect(
    () =>
      socket.onAssignmentLog((frame) => {
        if (frame.assignmentId !== assignmentId) return;
        const entry: AssignmentLogEntry = { seq: frame.seq, event: frame.event };
        if (snapshotRef.current === null) {
          framesRef.current.push(entry);
          return;
        }
        setEntries((current) => mergeLogEntries(current, [entry]));
      }),
    [socket, assignmentId],
  );

  const finished =
    gone || (options.liveStatus !== undefined && FINISHED.has(options.liveStatus));

  return { entries, finished, overflowed, error };
}
