/**
 * The Rookery wordmark, drawn in a three-row block font.
 *
 * A terminal application cannot choose the font the terminal renders it in -
 * that belongs to the user's terminal profile. What it *can* choose is the
 * lettering of its own name, which is what this is: a small, hand-set block
 * face built out of `█ ▀ ▄` so the banner reads as a mark rather than as one
 * more line of text.
 *
 * Glyphs are variable width (M and W are wider than the rest, as they are in
 * any real face) and unknown characters fall back to the raw character on the
 * middle row, so a custom assistant name never breaks the layout.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { ui } from '../theme.js';

/** Rows of one glyph, top to bottom. All three rows of a glyph are equal width. */
type Glyph = readonly [string, string, string];

/**
 * The face. Three rows on a 3-cell body, with a 5-cell body for the two
 * letters that genuinely need it.
 */
const FACE: Record<string, Glyph> = {
  A: ['█▀█', '█▀█', '▀ ▀'],
  B: ['█▀▄', '█▀▄', '▀▀ '],
  C: ['█▀▀', '█  ', '▀▀▀'],
  D: ['█▀▄', '█ █', '▀▀ '],
  E: ['█▀▀', '█▀▀', '▀▀▀'],
  F: ['█▀▀', '█▀▀', '▀  '],
  G: ['█▀▀', '█ █', '▀▀▀'],
  H: ['█ █', '█▀█', '▀ ▀'],
  I: ['▀█▀', ' █ ', '▀▀▀'],
  J: ['  █', '  █', '▀▀▀'],
  K: ['█ █', '█▀▄', '▀ ▀'],
  L: ['█  ', '█  ', '▀▀▀'],
  M: ['█▀▄▀█', '█ ▀ █', '▀   ▀'],
  N: ['█▄█', '█ █', '▀ ▀'],
  O: ['█▀█', '█ █', '▀▀▀'],
  P: ['█▀█', '█▀▀', '▀  '],
  Q: ['█▀█', '█ █', '▀▀▄'],
  R: ['█▀▄', '█▀▄', '▀ ▀'],
  S: ['█▀▀', '▀▀█', '▀▀▀'],
  T: ['▀█▀', ' █ ', ' ▀ '],
  U: ['█ █', '█ █', '▀▀▀'],
  V: ['█ █', '█ █', ' ▀ '],
  W: ['█   █', '█ ▄ █', '▀▀ ▀▀'],
  X: ['█ █', '▄▀▄', '▀ ▀'],
  Y: ['█ █', '▀█▀', ' ▀ '],
  Z: ['▀▀█', ' ▄▀', '▀▀▀'],
  '0': ['█▀█', '█ █', '▀▀▀'],
  '1': ['▄█ ', ' █ ', '▀▀▀'],
  '2': ['▀▀█', '█▀▀', '▀▀▀'],
  '3': ['▀▀█', ' ▀█', '▀▀▀'],
  '4': ['█ █', '▀▀█', '  ▀'],
  '5': ['█▀▀', '▀▀█', '▀▀▀'],
  '6': ['█▀▀', '█▀█', '▀▀▀'],
  '7': ['▀▀█', '  █', '  ▀'],
  '8': ['█▀█', '█▀█', '▀▀▀'],
  '9': ['█▀█', '▀▀█', '▀▀▀'],
  ' ': ['  ', '  ', '  '],
  '.': ['  ', '  ', '▀ '],
  '-': ['   ', '▀▀▀', '   '],
};

const ASCII = process.env.ROOKERY_ASCII === '1';

/**
 * Set one word in the block face. Returns its three rows.
 *
 * Exported so the render check can assert on the lettering without mounting a
 * component.
 */
export function setWordmark(word: string, tracking = 1): [string, string, string] {
  const rows: [string, string, string] = ['', '', ''];
  const gap = ' '.repeat(Math.max(0, tracking));
  const glyphs = [...word.toUpperCase()].map(
    (character): Glyph =>
      FACE[character] ?? ([character, character, ' '.repeat(character.length)] as Glyph),
  );

  glyphs.forEach((glyph, index) => {
    const separator = index === 0 ? '' : gap;
    rows[0] += separator + glyph[0];
    rows[1] += separator + glyph[1];
    rows[2] += separator + glyph[2];
  });

  return rows;
}

export interface WordmarkProps {
  /** The word to set. Letters, digits, spaces, `.` and `-` have glyphs. */
  text: string;
  /** Colour of the mark; brand amber by default. */
  color?: string;
  /** Cells between two glyphs. */
  tracking?: number;
}

/**
 * The mark itself. On an ASCII terminal it degrades to letterspaced caps,
 * which is still a deliberate piece of typography rather than a broken one.
 */
export function Wordmark({
  text,
  color = ui.amber,
  tracking = 1,
}: WordmarkProps): React.JSX.Element {
  if (ASCII) {
    return (
      <Text bold color={color}>
        {[...text.toUpperCase()].join(' ')}
      </Text>
    );
  }

  const rows = setWordmark(text, tracking);
  return (
    <Box flexDirection="column">
      {rows.map((row, index) => (
        // Rows have no identity beyond their position in the mark.
        <Text key={index} color={color}>
          {row}
        </Text>
      ))}
    </Box>
  );
}
