/**
 * The inline command palette that appears while a `/` command is being typed.
 * Arrow keys move the highlight, Tab or Enter completes it.
 *
 * Drawn as a framed popover - the same round border the input box and the
 * banner panel use - so it reads as a menu that opened over the transcript,
 * not as more transcript. The selected row is the only coloured thing in the
 * list: a palette where every row competes for attention is a menu, not a
 * completion.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyph, ui } from '../theme.js';
import type { SlashCommand } from '../hooks/useSlash.js';

export interface SlashPaletteProps {
  matches: SlashCommand[];
  selected: number;
  /** Cap on rows so a wide-open palette never eats the scrollback. */
  limit?: number;
}

export function SlashPalette({
  matches,
  selected,
  limit = 8,
}: SlashPaletteProps): React.JSX.Element | null {
  if (!matches.length) return null;

  // Keep the highlighted row inside the window as the user arrows past it.
  const start = Math.max(0, Math.min(selected - limit + 1, matches.length - limit));
  const visible = matches.slice(Math.max(0, start), Math.max(0, start) + limit);
  const hidden = matches.length - visible.length;
  const width = Math.max(
    ...matches.map((command) => command.name.length + (command.args ? command.args.length + 1 : 0)),
  );

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor={ui.faint}
      borderDimColor
      paddingX={1}
    >
      {visible.map((command, index) => {
        const absolute = Math.max(0, start) + index;
        const active = absolute === selected;
        const label = command.name + (command.args ? ' ' + command.args : '');
        return (
          <Box key={command.name} flexDirection="row">
            <Text color={active ? ui.accent : ui.faint}>
              {(active ? glyph.prompt : ' ') + ' '}
            </Text>
            <Text color={active ? ui.accent : ui.muted} bold={active}>
              {label.padEnd(width + 2)}
            </Text>
            <Box flexGrow={1}>
              <Text color={ui.faint} wrap="truncate-end">
                {command.description}
              </Text>
            </Box>
          </Box>
        );
      })}
      {hidden > 0 ? <Text color={ui.faint}>{'  +' + hidden + ' more'}</Text> : null}
      <Text color={ui.faint}>
        {'  ↑↓ select ' + glyph.dot + ' Tab complete ' + glyph.dot + ' Esc close'}
      </Text>
    </Box>
  );
}
