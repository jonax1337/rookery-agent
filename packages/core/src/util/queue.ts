/**
 * An async queue that several producers push into and one consumer drains.
 *
 * A turn's event stream is one async generator, but the events it carries
 * come from more than one place at once: the provider process, and every
 * assignment a tool call started in the meantime. This is how they merge
 * into one ordered stream without any producer blocking another.
 */
export class EventQueue<T> {
  #items: T[] = [];
  #waiters: (() => void)[] = [];
  #closed = false;

  push(item: T): void {
    if (this.#closed) return;
    this.#items.push(item);
    this.#wake();
  }

  close(): void {
    this.#closed = true;
    this.#wake();
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Yield items until the queue is closed and drained. */
  async *drain(): AsyncGenerator<T, void, unknown> {
    for (;;) {
      if (this.#items.length) {
        yield this.#items.shift() as T;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter();
  }
}

/** Clip text to `max` characters, marking the cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '\n[...clipped]';
}

/** One-line preview: whitespace collapsed, cut with an ellipsis. */
export function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, Math.max(0, max - 1)) + '…';
}

/** The last `max` characters of a text. */
export function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(-max);
}

/** Integer in [min, max], or the fallback for anything else. */
export function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}
