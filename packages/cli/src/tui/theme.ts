/**
 * Palette and glyphs for the Ink TUI.
 *
 * Ink takes colours as plain strings and hands them to chalk itself, so this
 * module deliberately exports raw values instead of the pre-painted functions
 * `src/ui/theme.ts` exposes for the line-based renderer. The brand hexes are
 * the single source of truth and are re-exported from there so the two
 * front-ends can never drift apart.
 */

import { BRAND, glyph } from '../ui/theme.js';

export { BRAND, glyph };

/** Semantic colour names used across the TUI components. */
export const ui = {
  /** Brand amber: prompts, headings, the assistant's own identity. */
  amber: BRAND.amber,
  /** Warm off-white for primary body text. */
  ivory: BRAND.ivory,
  /** Brand ink, only useful as a background. */
  ink: BRAND.ink,
  /** Secondary chrome: borders, metadata, activity lines. */
  muted: 'gray',
  ok: 'green',
  warn: 'yellow',
  danger: 'red',
  info: 'cyan',
  /** Agent / role accents in the assignments view. */
  agent: 'magenta',
} as const;

/** Braille spinner, same frames the line-based spinner uses. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Cursor block shown while the assistant is still typing. */
export const STREAM_CURSOR = '▋';

/** Assignment status -> glyph, shared by the live and the collapsed views. */
export const ASSIGNMENT_MARK = {
  pending: glyph.dot,
  running: SPINNER_FRAMES[0],
  done: glyph.ok,
  failed: glyph.fail,
  cancelled: glyph.warn,
} as const;

export const ASSIGNMENT_COLOR = {
  pending: ui.muted,
  running: ui.amber,
  done: ui.ok,
  failed: ui.danger,
  cancelled: ui.warn,
} as const;
