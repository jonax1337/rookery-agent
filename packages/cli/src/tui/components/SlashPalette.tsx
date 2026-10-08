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

/** Rows shown before the palette scrolls. */
const DEFAULT_ROW_LIMIT = 8;

/** Blank columns between the longest command label and its description. */
const LABEL_GAP = 2;

export function SlashPalette({
  matches,
  selected,
  limit = DEFAULT_ROW_LIMIT,
}: SlashPaletteProps): React.JSX.Element | null {
  if (!matches.length) return null;

  // Keep the highlighted row inside the window as the user arrows past it.
  const start = Math.max(0, Math.min(selected - limit + 1, matches.length - limit));
  const visible = matches.slice(start, start + limit);
  const hidden = matches.length - visible.length;
  const labelWidth = Math.max(...matches.map((command) => labelOf(command).length)) + LABEL_GAP;

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor={ui.faint}
      borderDimColor
      paddingX={1}
    >
      {visible.map((command, index) => (
        <PaletteRow
          key={command.name}
          command={command}
          active={start + index === selected}
          labelWidth={labelWidth}
        />
      ))}
      {hidden > 0 ? <Text color={ui.faint}>{'  +' + hidden + ' more'}</Text> : null}
      <Text color={ui.faint}>
        {'  ↑↓ select ' + glyph.dot + ' Tab complete ' + glyph.dot + ' Esc close'}
      </Text>
    </Box>
  );
}

function PaletteRow({
  command,
  active,
  labelWidth,
}: {
  command: SlashCommand;
  active: boolean;
  labelWidth: number;
}): React.JSX.Element {
  return (
    <Box flexDirection="row">
      <Text color={active ? ui.accent : ui.faint}>{(active ? glyph.prompt : ' ') + ' '}</Text>
      <Text color={active ? ui.accent : ui.muted} bold={active}>
        {labelOf(command).padEnd(labelWidth)}
      </Text>
      <Box flexGrow={1}>
        <Text color={ui.faint} wrap="truncate-end">
          {command.description}
        </Text>
      </Box>
    </Box>
  );
}

function labelOf(command: SlashCommand): string {
  return command.name + (command.args ? ' ' + command.args : '');
}
