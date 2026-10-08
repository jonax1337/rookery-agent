/**
 * Where the REPL's input lines wait.
 *
 * Lines are queued rather than pulled one `question()` at a time. Piped input
 * (`echo "/help" | rookery`) arrives - and hits EOF - long before the first
 * prompt is drawn, so anything not buffered would be lost. It also gives
 * interactive users free type-ahead during a turn.
 */

type LineWaiter = (line: string | null) => void;

export class LineQueue {
  readonly #lines: string[] = [];
  #closed = false;
  #leaving = false;
  /** The prompt, waiting for the next thing to say. */
  #promptWaiter: LineWaiter | null = null;
  /**
   * Set while a turn is blocked on a question. It outranks the prompt's own
   * waiter: the next line typed is the answer the assistant is waiting for,
   * not the next thing to say.
   */
  #answerWaiter: LineWaiter | null = null;

  /** The input stream has ended. */
  get closed(): boolean {
    return this.#closed;
  }

  /** The user chose to leave; nothing more will be read. */
  get leaving(): boolean {
    return this.#leaving;
  }

  /** A line arrived from the terminal. */
  push(line: string): void {
    if (this.#answerWaiter) this.#settleAnswer(line);
    else if (this.#promptWaiter) this.#settlePrompt(line);
    else this.#lines.push(line);
  }

  /** The input stream ended. Whoever is waiting is told there is nothing more. */
  close(): void {
    this.#closed = true;
    this.#settleAnswer(null);
    this.#settlePrompt(null);
  }

  /** Leave for good: drop type-ahead and release whoever is waiting. */
  leave(): void {
    this.#leaving = true;
    this.#lines.length = 0;
    this.#settleAnswer(null);
    this.#settlePrompt(null);
  }

  /** The next line for the prompt; null once there will be no more. */
  nextLine(): Promise<string | null> {
    return this.#next((waiter) => {
      this.#promptWaiter = waiter;
    });
  }

  /** The next line as the answer to an open question; null once there will be no more. */
  nextAnswerLine(): Promise<string | null> {
    return this.#next((waiter) => {
      this.#answerWaiter = waiter;
    });
  }

  /** Stop waiting for an answer: the question is gone, the prompt gets the keyboard back. */
  cancelAnswer(): void {
    this.#settleAnswer(null);
  }

  /** Take every queued line out, to be put back with `restore`. */
  takeQueued(): string[] {
    return this.#lines.splice(0);
  }

  restore(lines: string[]): void {
    this.#lines.push(...lines);
  }

  /** Give back a line that turned out not to be an answer; it is the next prompt. */
  putBack(line: string): void {
    this.#lines.unshift(line);
  }

  #next(wait: (waiter: LineWaiter) => void): Promise<string | null> {
    const queued = this.#lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#closed || this.#leaving) return Promise.resolve(null);
    return new Promise<string | null>(wait);
  }

  #settlePrompt(line: string | null): void {
    const waiter = this.#promptWaiter;
    this.#promptWaiter = null;
    waiter?.(line);
  }

  #settleAnswer(line: string | null): void {
    const waiter = this.#answerWaiter;
    this.#answerWaiter = null;
    waiter?.(line);
  }
}
