/**
 * Rookery terminal palette.
 *
 * Colour is a progressive enhancement: `NO_COLOR`, `TERM=dumb` and any
 * non-TTY stdout (pipes, CI, `| jq`) all fall back to plain text so the
 * output stays machine-readable.
 */

import chalk from 'chalk';

/** Brand colours, shared with the web UI. */
export const BRAND = {
  ink: '#171A1D',
  ivory: '#F2F0EA',
  amber: '#D9A65C',
} as const;

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
  /** Brand amber - prompts, headings, the assistant's own identity. */
  amber: colorEnabled ? (text: string) => chalk.hex(BRAND.amber)(text) : id,
  amberBold: colorEnabled ? (text: string) => chalk.hex(BRAND.amber).bold(text) : id,
  /** Warm off-white for primary body text on dark terminals. */
  ivory: colorEnabled ? (text: string) => chalk.hex(BRAND.ivory)(text) : id,
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
