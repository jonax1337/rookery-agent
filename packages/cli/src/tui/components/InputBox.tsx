/**
 * The prompt box.
 *
 * It is a pure renderer: all editing lives in App.tsx, which owns the buffer
 * and the caret offset. That split is what lets the render check assert on an
 * exact caret position without driving a real keyboard.
 *
 * The caret is drawn with `inverse` on the character it sits on, and as an
 * inverted space when it sits at the end of a line, which is the only way to
 * show a caret in a terminal that Ink does not move the real cursor into.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyph, ui } from '../theme.js';

export interface InputBoxProps {
  value: string;
  /** Caret offset into `value`, in characters. */
  cursor: number;
  /** A turn is running: the box stays usable for type-ahead but says so. */
  busy?: boolean;
  placeholder?: string;
  hint?: string;
  /** Dim the caret for one blink phase. */
  caretVisible?: boolean;
}

export function InputBox({
  value,
  cursor,
  busy,
  placeholder,
  hint,
  caretVisible = true,
}: InputBoxProps): React.JSX.Element {
  const lines = value.split('\n');
  const caret = locate(lines, Math.max(0, Math.min(cursor, value.length)));
  const empty = value.length === 0;

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={busy ? ui.faint : ui.amber}
        borderDimColor
        paddingX={1}
      >
        {lines.map((line, index) => (
          // Buffer lines have no identity beyond their position.
          <Box key={index} flexDirection="row">
            <Text color={busy ? ui.faint : ui.amber} bold={index === 0}>
              {index === 0 ? glyph.prompt + ' ' : glyph.bar + ' '}
            </Text>
            <Box flexGrow={1}>
              {empty && index === 0 ? (
                <Text color={ui.faint} italic>
                  {placeholder ?? ''}
                </Text>
              ) : (
                <CaretLine
                  line={line}
                  column={caret.row === index ? caret.column : -1}
                  visible={caretVisible}
                />
              )}
            </Box>
          </Box>
        ))}
      </Box>
      {hint ? (
        <Box paddingX={1}>
          <Text color={ui.faint}>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** One line of the buffer, with the caret drawn in if it lives here. */
function CaretLine({
  line,
  column,
  visible,
}: {
  line: string;
  column: number;
  visible: boolean;
}): React.JSX.Element {
  if (column < 0) {
    return (
      <Text color={ui.ivory} wrap="wrap">
        {line || ' '}
      </Text>
    );
  }

  const before = line.slice(0, column);
  const at = line.slice(column, column + 1) || ' ';
  const after = line.slice(column + 1);

  return (
    <Text color={ui.ivory} wrap="wrap">
      {before}
      <Text inverse={visible} color={ui.ivory}>
        {at}
      </Text>
      {after}
    </Text>
  );
}

/** Turn a flat caret offset into a row/column pair. */
function locate(lines: string[], offset: number): { row: number; column: number } {
  let remaining = offset;
  for (let row = 0; row < lines.length; row += 1) {
    const length = (lines[row] ?? '').length;
    if (remaining <= length) return { row, column: remaining };
    // +1 for the newline that separates this line from the next.
    remaining -= length + 1;
  }
  const row = Math.max(0, lines.length - 1);
  return { row, column: (lines[row] ?? '').length };
}
