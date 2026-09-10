/**
 * The inline command palette that appears while a `/` command is being typed.
 * Arrow keys move the highlight, Tab or Enter completes it.
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
  const width = Math.max(...matches.map((command) => command.name.length + (command.args ? command.args.length + 1 : 0)));

  return (
    <Box flexDirection="column" paddingX={2}>
      {visible.map((command, index) => {
        const absolute = Math.max(0, start) + index;
        const active = absolute === selected;
        const label = command.name + (command.args ? ' ' + command.args : '');
        return (
          <Box key={command.name} flexDirection="row">
            <Text color={active ? ui.amber : ui.muted} bold={active}>
              {active ? glyph.prompt + ' ' : '  '}
              {label.padEnd(width + 2)}
            </Text>
            <Text color={ui.muted} dimColor>
              {command.description}
            </Text>
          </Box>
        );
      })}
      {hidden > 0 ? (
        <Text color={ui.muted} dimColor>
          {'  +' + hidden + ' more'}
        </Text>
      ) : null}
      <Text color={ui.muted} dimColor>
        {'  ↑↓ select ' + glyph.dot + ' Tab complete ' + glyph.dot + ' Esc dismiss'}
      </Text>
    </Box>
  );
}
