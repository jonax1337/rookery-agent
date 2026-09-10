/**
 * The terminal's current width, as React state.
 *
 * Ink lays the tree out against `stdout.columns` but does not re-render when
 * that changes, and several components need the number itself rather than a
 * flex rule: a horizontal rule has to know how wide to draw, the status bar
 * has to know how much it may show, and a table has to know what it can fit.
 *
 * The value is clamped: below 40 columns the layout is nonsense anyway, and
 * above 120 a chat transcript reads worse the wider it gets, exactly like a
 * page of prose does.
 */

import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

/** Narrowest width the layout still tries to serve. */
export const MIN_COLUMNS = 40;

/** Widest a body of text is allowed to get before it stops being readable. */
export const MAX_TEXT_COLUMNS = 120;

export function useColumns(): number {
  const { stdout } = useStdout();
  const [columns, setColumns] = useState(() => Math.max(MIN_COLUMNS, stdout?.columns ?? 80));

  useEffect(() => {
    if (!stdout) return;
    const update = (): void => setColumns(Math.max(MIN_COLUMNS, stdout.columns ?? 80));
    stdout.on('resize', update);
    update();
    return () => {
      stdout.off('resize', update);
    };
  }, [stdout]);

  return columns;
}

/** The width prose is set at: the terminal, but never wider than is readable. */
export function textWidth(columns: number, gutter = 0): number {
  return Math.max(20, Math.min(columns - gutter, MAX_TEXT_COLUMNS));
}
