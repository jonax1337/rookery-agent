/**
 * The Rookery lockup: the Atrium mark beside the wordmark.
 *
 * A terminal application cannot choose the font it is rendered in - that
 * belongs to the user's terminal profile. What it can choose is the lettering
 * of its own name, which is what this is. Both pieces are pre-rendered rather
 * than drawn at run time: the mark is `branding/source/atrium.json` rasterised
 * into half-blocks, and the wordmark is set in ANSI Compact, the one block face
 * that has real lowercase with an ascender on the k and a descender on the y -
 * which is what the brand's lowercase `rookery` needs.
 *
 * The mark is sampled with each half-block covering about 1.15 times more image
 * height than width, because a terminal cell is taller than two cells are
 * wide. Rastered as a perfect square the mark comes out visibly too tall.
 *
 * Wordmark: ANSI Compact by Loic Cressot, MIT licensed.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { ASCII, ui } from '../theme.js';

/** The Atrium mark: two offset corners opening a room. */
const MARK: readonly string[] = [
  " ▄▄███████████",
  "███▀▀▀▀▀▀▀▀▀▀▀",
  "███        ▄▄▄",
  "███        ███",
  "███   ▄▄▄▄███▀",
  "███   █████▀",
];

/** `rookery`, lowercase, in the same weight as the mark. */
const WORDMARK: readonly string[] = [
  "▄▄▄▄   ▄▄▄   ▄▄▄  ▄▄ ▄▄ ▄▄▄▄▄ ▄▄▄▄  ▄▄ ▄▄",
  "██▄█▄ ██▀██ ██▀██ ██▄█▀ ██▄▄  ██▄█▄ ▀███▀",
  "██ ██ ▀███▀ ▀███▀ ██ ██ ██▄▄▄ ██ ██   █",
];

/**
 * Rows the wordmark is pushed down so it sits optically centred against the
 * mark. Three rows inside six leave half a row over; of the two whole-row
 * positions this is the one that clears the mark's upper band.
 */
const WORDMARK_OFFSET = 2;

/** Columns between the mark and what stands beside it: the wordmark, or the caption alone. */
const LOCKUP_GAP = 3;
const MARK_ONLY_GAP = 2;

/** Rows the caption is pushed down when it stands beside the mark alone. */
const MARK_ONLY_OFFSET = 1;

/** Columns the full lockup needs, mark plus gap plus wordmark. */
export const LOCKUP_COLUMNS =
  Math.max(...MARK.map((row) => row.length)) +
  LOCKUP_GAP +
  Math.max(...WORDMARK.map((row) => row.length));

function Art({ rows, color }: { rows: readonly string[]; color: string }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {rows.map((row, index) => (
        // A row has no identity beyond its position in the drawing.
        <Text key={index} color={color}>
          {row}
        </Text>
      ))}
    </Box>
  );
}

export interface LogoProps {
  /** Drop the wordmark and show the mark alone, for a narrow terminal. */
  markOnly?: boolean;
  /**
   * Set under the wordmark, in its column rather than the mark's.
   *
   * The lockup leaves the space below the wordmark empty - the mark is six
   * rows, the wordmark three - so a caption costs no extra height, and hanging
   * it off the wordmark's left edge keeps the mark reading as one clean
   * column instead of a heading for the text.
   */
  children?: React.ReactNode;
}

/**
 * The lockup. On a terminal that cannot draw block characters it degrades to
 * letterspaced caps, which is still a deliberate piece of typography rather
 * than a broken one.
 */
export function Logo({ markOnly = false, children }: LogoProps): React.JSX.Element {
  if (ASCII) {
    return (
      <Box flexDirection="column">
        <Text bold color={ui.accent}>
          {[...'ROOKERY'].join(' ')}
        </Text>
        {children}
      </Box>
    );
  }

  return (
    <Box flexDirection="row">
      <Art rows={MARK} color={ui.accent} />
      <Box
        flexDirection="column"
        marginLeft={markOnly ? MARK_ONLY_GAP : LOCKUP_GAP}
        marginTop={markOnly ? MARK_ONLY_OFFSET : WORDMARK_OFFSET}
      >
        {markOnly ? null : <Art rows={WORDMARK} color={ui.accent} />}
        {children}
      </Box>
    </Box>
  );
}
