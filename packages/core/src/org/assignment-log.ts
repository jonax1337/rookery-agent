import type { AgentEvent, AssignmentLogEntry } from '../types.js';

/** How much of one assignment's live log is kept, in JSON bytes. */
const ASSIGNMENT_LOG_BYTES = 256 * 1024;

/**
 * The live log of one running assignment: a ring buffer capped in bytes and
 * the watchers following it. It exists only while the run does - once the
 * assignment ends, watchers learn it from the `assignment` broadcast and the
 * buffer goes away, so watching never grows anything on disk.
 */
export class AssignmentLogBuffer {
  /** Buffered entries in arrival order; the oldest go when the cap is hit. */
  readonly entries: AssignmentLogEntry[] = [];
  /** Set once whole entries were dropped to stay under the cap. */
  overflowed = false;
  readonly listeners = new Set<(entry: AssignmentLogEntry) => void>();
  #seq = 0;
  #bytes = 0;
  #done = false;
  readonly #waiters: (() => void)[] = [];

  /** Append one event; returns the numbered entry the watchers receive. */
  push(event: AgentEvent): AssignmentLogEntry {
    const entry: AssignmentLogEntry = { seq: (this.#seq += 1), event };
    this.entries.push(entry);
    this.#bytes += byteSize(entry);
    this.#dropOldestOverCap();
    for (const listener of [...this.listeners]) listener(entry);
    this.#wake();
    return entry;
  }

  /**
   * A provider switch starts the transcript over: the dead attempt's half
   * output would only read as a broken restart. `seq` keeps counting, so a
   * client ordering by it stays whole across the gap.
   */
  reset(): void {
    this.entries.length = 0;
    this.#bytes = 0;
    this.overflowed = false;
  }

  /** The run is over: generators drain what is left and then end. */
  end(): void {
    this.#done = true;
    this.#wake();
  }

  /** Replay the buffer, then follow it live until the run ends. */
  async *stream(): AsyncGenerator<AssignmentLogEntry, void, unknown> {
    let lastSeq = 0;
    for (;;) {
      // The cap shifts the oldest entries out from under any index, and a
      // reset empties the list entirely - the cursor is the last seq
      // yielded, never a position.
      const next = this.entries.find((entry) => entry.seq > lastSeq);
      if (next) {
        lastSeq = next.seq;
        yield next;
        continue;
      }
      if (this.#done) return;
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }

  /**
   * Over the cap, whole entries go, oldest first - but never the one just
   * pushed: a single huge line is better kept than silently dropped.
   */
  #dropOldestOverCap(): void {
    while (this.#bytes > ASSIGNMENT_LOG_BYTES && this.entries.length > 1) {
      const dropped = this.entries.shift();
      if (!dropped) break;
      this.#bytes -= byteSize(dropped);
      this.overflowed = true;
    }
  }

  #wake(): void {
    // splice, never length = 0 before the loop: both names point at the
    // same array here, and emptying it first would leave nothing to iterate.
    for (const waiter of this.#waiters.splice(0)) waiter();
  }
}

function byteSize(entry: AssignmentLogEntry): number {
  return Buffer.byteLength(JSON.stringify(entry));
}
