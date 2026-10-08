/**
 * The REPL's few line shapes. Everything it prints goes through here so that
 * a status line looks the same wherever it comes from.
 */

import { glyph, theme } from './ui/theme.js';

export function printLine(text = ''): void {
  process.stdout.write(text + '\n');
}

export function printDim(text: string): void {
  printLine(theme.dim(text));
}

/** A confirmation: `✓ new session`. */
export function printOk(text: string): void {
  printDim(glyph.ok + ' ' + text);
}

export function printWarning(error: unknown): void {
  printLine(theme.yellow(glyph.warn + ' ' + (error as Error).message));
}

export function printFailure(error: unknown): void {
  printLine(theme.red(glyph.fail + ' ' + (error as Error).message));
}
