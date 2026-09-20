/**
 * Rookery terminal palette.
 *
 * Colour is a progressive enhancement: `NO_COLOR`, `TERM=dumb` and any
 * non-TTY stdout (pipes, CI, `| jq`) all fall back to plain text so the
 * output stays machine-readable.
 */

import chalk from 'chalk';

/**
 * Brand colours, shared with the web UI.
 *
 * These are Atrium, the identity `branding/` builds: evergreen, eucalyptus,
 * celadon and frost. The web app reads the same hexes from
 * `branding/colors.css`, which is why they are spelled out again here - a
 * terminal cannot import a stylesheet, so this is the copy and
 * `branding/colors.json` is the original.
 */
export const BRAND = {
  /** Evergreen: the web app's light-theme primary. In a terminal, a ground. */
  evergreen: '#253A3B',
  /** Eucalyptus: the supporting accent of the identity. */
  eucalyptus: '#6A9185',
  /** Celadon: the brightest brand green, the dark theme's primary. */
  celadon: '#CCDDD1',
  /** Frost: body text on a dark terminal. */
  frost: '#EFF4F0',
} as const;

/**
 * The accent the interface points with.
 *
 * Neither brand green works alone here. Celadon is so light it reads as a
 * second off-white beside frost, and eucalyptus so dark it sinks to the weight
 * of chrome. Halfway between the two sits a green that still carries the
 * identity and holds the place amber held in the ramp - the same contrast
 * against black, to within a rounding error - so nothing legible before became
 * less so.
 */
export const ACCENT = '#9BB7AB';

function detectColor(): boolean {
  const env = process.env;
  // https://no-color.org - any non-empty value disables colour.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  if (env.TERM === 'dumb') return false;
  return Boolean(process.stdout.isTTY);
}

/** True when it is safe to emit ANSI escapes on stdout. */
export const colorEnabled: boolean = detectColor();

/** True when stdout is an interactive terminal (spinners, cursor tricks). */
export const isTty: boolean = Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb';

if (!colorEnabled) {
  chalk.level = 0;
} else if (chalk.level === 0) {
  // FORCE_COLOR on a pipe: chalk would otherwise stay at level 0.
  chalk.level = 1;
}

type Paint = (text: string) => string;

const id: Paint = (text) => text;

/** Every colour the CLI is allowed to use, in one place. */
export const theme = {
  /** Brand green - prompts, headings, the assistant's own identity. */
  accent: colorEnabled ? (text: string) => chalk.hex(ACCENT)(text) : id,
  accentBold: colorEnabled ? (text: string) => chalk.hex(ACCENT).bold(text) : id,
  /** Frost for primary body text on dark terminals. */
  frost: colorEnabled ? (text: string) => chalk.hex(BRAND.frost)(text) : id,
  bold: colorEnabled ? (text: string) => chalk.bold(text) : id,
  dim: colorEnabled ? (text: string) => chalk.dim(text) : id,
  gray: colorEnabled ? (text: string) => chalk.gray(text) : id,
  red: colorEnabled ? (text: string) => chalk.red(text) : id,
  green: colorEnabled ? (text: string) => chalk.green(text) : id,
  yellow: colorEnabled ? (text: string) => chalk.yellow(text) : id,
  cyan: colorEnabled ? (text: string) => chalk.cyan(text) : id,
  underline: colorEnabled ? (text: string) => chalk.underline(text) : id,
} satisfies Record<string, Paint>;

/** Glyphs, with ASCII fallbacks for terminals that cannot render them. */
const ASCII = process.env.ROOKERY_ASCII === '1';

export const glyph = {
  prompt: ASCII ? '>' : '›', // ›
  tool: ASCII ? '*' : '⏺', // ⏺
  memory: ASCII ? '~' : '⟲', // ⟲
  status: ASCII ? '-' : '‹', // ‹
  ok: ASCII ? 'OK' : '✓', // ✓
  fail: ASCII ? 'X' : '✗', // ✗
  warn: ASCII ? '!' : '⚠', // ⚠
  bullet: ASCII ? '-' : '•', // •
  thinking: ASCII ? '|' : '│', // │
  dot: ASCII ? '.' : '·', // ·
  /** An agent working an assignment. */
  agent: ASCII ? '>' : '▸', // ▸
  /** A message between an agent, its manager and the assistant. */
  message: ASCII ? '@' : '✉', // ✉
  /** An entry on the company board. */
  task: ASCII ? '[]' : '☐', // ☐
} as const;
