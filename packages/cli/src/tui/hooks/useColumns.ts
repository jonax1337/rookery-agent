/**
 * The terminal's current width, as React state.
 *
 * Ink lays the tree out against `stdout.columns` but does not re-render when
 * that changes, and several components need the number itself rather than a
 * flex rule: a horizontal rule has to know how wide to draw, the status bar
 * has to know how much it may show, and a table has to know what it can fit.
 *
 * The value is clamped from below: under 40 columns the layout is nonsense
 * anyway.
 */

import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

/** Narrowest width the layout still tries to serve. */
export const MIN_COLUMNS = 40;

/** Assumed width when the stream does not report one. */
const DEFAULT_COLUMNS = 80;

export function useColumns(): number {
  const { stdout } = useStdout();
  const [columns, setColumns] = useState(() => Math.max(MIN_COLUMNS, stdout?.columns ?? DEFAULT_COLUMNS));

  useEffect(() => {
    if (!stdout) return;
    const update = (): void => setColumns(Math.max(MIN_COLUMNS, stdout.columns ?? DEFAULT_COLUMNS));
    stdout.on('resize', update);
    update();
    return () => {
      stdout.off('resize', update);
    };
  }, [stdout]);

  return columns;
}
