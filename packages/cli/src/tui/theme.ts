/**
 * Palette, glyphs and typography for the Ink TUI.
 *
 * Ink takes colours as plain strings and hands them to chalk itself, so this
 * module deliberately exports raw values instead of the pre-painted functions
 * `src/ui/theme.ts` exposes for the line-based renderer. The brand hexes are
 * the single source of truth and are re-exported from there so the two
 * front-ends can never drift apart.
 *
 * Everything visual the TUI does is named here: the semantic colour roles, the
 * glyph set (with an ASCII fallback for terminals that cannot draw it) and the
 * few layout constants - gutter width, gauge width - that keep the columns of
 * the transcript lined up with the columns of the status bar.
 */

import { BRAND, glyph as baseGlyph } from '../ui/theme.js';

export { BRAND };

const ASCII = process.env.ROOKERY_ASCII === '1';

/**
 * Semantic colours.
 *
 * Two accents carry the whole interface: brand amber for anything Rookery
 * itself says, and a dusty blue for anything a provider or a model says. The
 * three greys are a real ramp - `ivory` reads as white, `muted` as secondary,
 * `faint` as chrome - which is what stops a dense transcript from turning
 * into an undifferentiated wall.
 */
export const ui = {
  /** Brand amber: the prompt, headings, the assistant's own identity. */
  amber: BRAND.amber,
  /** Lighter amber for the one thing on screen that should catch the eye. */
  amberSoft: '#F0C88A',
  /** Warm off-white: body text. */
  ivory: BRAND.ivory,
  /** Brand ink, only useful as a background. */
  ink: BRAND.ink,
  /** Secondary text: metadata, tool arguments, timings. */
  muted: '#8A8F98',
  /** Chrome: borders, rules, separators. Never carries information alone. */
  faint: '#565C66',
  ok: '#7FB88A',
  warn: '#E0B85C',
  danger: '#D8776B',
  /** Providers, models, links, inline code. */
  info: '#7FA9CE',
  /** Agents of the company, in the assignments view and direct chats. */
  agent: '#B79BD6',
} as const;

/** Braille spinner, same frames the line-based spinner uses. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Slower, heavier spinner for a single running tool call. */
export const PULSE_FRAMES = ASCII
  ? (['-', '\\', '|', '/'] as const)
  : (['◐', '◓', '◑', '◒'] as const);

/** Cursor block shown while the assistant is still typing. */
export const STREAM_CURSOR = '▋';

/**
 * Glyphs. The base set is shared with the line-based renderer; the TUI adds
 * the few it needs for gutters, gauges and tool results.
 */
export const glyph = {
  ...baseGlyph,
  /** The prompt caret, in the input box and in front of a user turn. */
  prompt: ASCII ? '>' : '❯',
  /** Left gutter bar of a quote, a code block or the assistant's answer. */
  bar: ASCII ? '|' : '▌',
  /** Hangs a result line under the tool call it belongs to. */
  branch: ASCII ? '\\_' : '⎿',
  /** Filled and empty cell of the context gauge. */
  gaugeOn: ASCII ? '#' : '█',
  gaugeOff: ASCII ? '-' : '░',
  /** Separates two segments of the status bar. */
  sep: ASCII ? '|' : '│',
  /** Horizontal rule. */
  rule: ASCII ? '-' : '─',
  /** Tokens in and out, in the usage readout. */
  up: ASCII ? '^' : '↑',
  down: ASCII ? 'v' : '↓',
  /** Nested list bullet, one level in. */
  bulletSub: ASCII ? '-' : '◦',
  /** Unchecked and checked task-list item. */
  boxOff: ASCII ? '[ ]' : '☐',
  boxOn: ASCII ? '[x]' : '☑',
} as const;

/**
 * Width of the left gutter every transcript block hangs off.
 *
 * The marker sits in column 0 and the content starts here, so a user turn, a
 * tool call and an answer all share one vertical text edge. Changing this
 * moves all three together, which is the point.
 */
export const GUTTER = 2;

/** Cells in the context gauge. */
export const GAUGE_WIDTH = 10;

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

/**
 * A horizontal gauge, e.g. `████░░░░░░`.
 *
 * `fraction` is clamped, so a provider that reports more context used than the
 * window holds draws a full bar instead of overflowing the layout.
 */
export function gauge(fraction: number, width = GAUGE_WIDTH): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return glyph.gaugeOn.repeat(filled) + glyph.gaugeOff.repeat(Math.max(0, width - filled));
}

/** Green under two thirds, amber past it, red when the window is nearly full. */
export function gaugeColor(fraction: number): string {
  if (fraction >= 0.9) return ui.danger;
  if (fraction >= 0.66) return ui.warn;
  return ui.ok;
}
