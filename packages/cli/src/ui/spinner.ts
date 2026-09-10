/**
 * A one-line spinner for the gap between "sent" and "first token".
 *
 * It is deliberately inert on anything that is not an interactive colour
 * terminal, so piping output never produces carriage-return soup.
 */

import { colorEnabled, isTty, theme } from './theme.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 80;

export class Spinner {
  #timer: NodeJS.Timeout | null = null;
  #frame = 0;
  #text: string;
  #width = 0;
  readonly #enabled: boolean;
  readonly #out: NodeJS.WriteStream;

  constructor(text = 'thinking', out: NodeJS.WriteStream = process.stdout) {
    this.#text = text;
    this.#out = out;
    this.#enabled = isTty && colorEnabled;
  }

  get active(): boolean {
    return this.#timer !== null;
  }

  start(text?: string): void {
    if (text) this.#text = text;
    if (!this.#enabled || this.#timer) return;
    this.#render();
    this.#timer = setInterval(() => this.#render(), INTERVAL_MS);
    // Never let the spinner keep the process alive on its own.
    this.#timer.unref?.();
  }

  /** Change the label without restarting the animation. */
  setText(text: string): void {
    this.#text = text;
    if (this.#timer) this.#render();
  }

  /** Erase the spinner line and leave the cursor at column 0. */
  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (!this.#enabled || this.#width === 0) return;
    this.#out.write('\r' + ' '.repeat(this.#width) + '\r');
    this.#width = 0;
  }

  #render(): void {
    const frame = FRAMES[this.#frame % FRAMES.length] ?? '-';
    this.#frame += 1;
    const line = frame + ' ' + this.#text;
    const padding = this.#width > line.length ? ' '.repeat(this.#width - line.length) : '';
    this.#out.write('\r' + theme.dim(line) + padding);
    this.#width = line.length;
  }
}
