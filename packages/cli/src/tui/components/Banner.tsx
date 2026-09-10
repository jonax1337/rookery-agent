/**
 * The boot banner: the mark, who is answering, and what is logged in.
 *
 * It is the first thing on screen and the only place the interface is allowed
 * to be decorative, so it earns its height by answering the three questions a
 * fresh prompt raises - which assistant, on which provider, with how much
 * permission - next to the mark rather than under it.
 *
 * Rendered as a scrollback entry, which means `<Static>` writes it once and it
 * scrolls away like any other turn instead of pinning to the top.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyph, ui } from '../theme.js';
import { Wordmark } from './Wordmark.js';
import type { BannerState } from '../types.js';

export interface BannerProps {
  state: BannerState;
}

export function Banner({ state }: BannerProps): React.JSX.Element {
  const facts: string[] = [state.provider];
  if (state.model) facts.push(state.model);
  facts.push(state.permission);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Box marginRight={3}>
          <Wordmark text={state.wordmark} />
        </Box>

        <Box flexDirection="column" justifyContent="center">
          <Box flexDirection="row">
            <Text color={ui.ivory} bold>
              {state.agent ?? state.assistantName}
            </Text>
            {state.agent ? <Text color={ui.agent}>{'  Direktchat'}</Text> : null}
          </Box>
          <Text color={ui.muted}>{facts.join('  ' + glyph.dot + '  ')}</Text>
          <Text color={ui.faint}>
            {state.project ? 'Projekt ' + state.project : 'kein Projekt gewählt'}
          </Text>
        </Box>
      </Box>

      <Box
        marginTop={1}
        borderStyle="single"
        borderColor={ui.faint}
        borderDimColor
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
      />

      <Box flexDirection="row" marginTop={1}>
        {state.ready.length ? (
          <Text color={ui.ok}>{glyph.ok + ' ' + state.ready.join(' + ') + ' bereit'}</Text>
        ) : (
          <Text color={ui.danger}>
            {glyph.fail + ' kein Provider angemeldet — `rookery doctor` sagt, was fehlt'}
          </Text>
        )}
        {state.offline.length ? (
          <Text color={ui.faint}>{'  ' + state.offline.join(', ') + ' offline'}</Text>
        ) : null}
        <Box flexGrow={1} />
        <Text color={ui.faint}>{'/help ' + glyph.dot + ' Ctrl+D beendet'}</Text>
      </Box>

      {state.warnings?.length
        ? state.warnings.map((warning, index) => (
            // Warnings have no identity beyond their position in the list.
            <Text key={index} color={ui.warn}>
              {glyph.warn + ' ' + warning}
            </Text>
          ))
        : null}
    </Box>
  );
}
