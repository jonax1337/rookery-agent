/**
 * The boot banner: the mark, who is answering, and what is logged in.
 *
 * It is the first thing on screen and the only place the interface is allowed
 * to be decorative, so it earns its height by answering the three questions a
 * fresh prompt raises - which assistant, on which provider, with how much
 * permission - next to the mark rather than under it. The panel border is the
 * frame language the input box and the palette speak, so the three boxes read
 * as one interface rather than three coincidences.
 *
 * Rendered as a scrollback entry, which means `<Static>` writes it once and it
 * scrolls away like any other turn instead of pinning to the top.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Alert, Badge, StatusMessage } from '@inkjs/ui';
import { glyph, ui } from '../theme.js';
import { Wordmark } from './Wordmark.js';
import type { BannerState } from '../types.js';

export interface BannerProps {
  state: BannerState;
}

export function Banner({ state }: BannerProps): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box
        flexDirection="row"
        borderStyle="round"
        borderColor={ui.faint}
        borderDimColor
        paddingX={1}
      >
        <Box marginRight={3}>
          <Wordmark text={state.wordmark} />
        </Box>

        <Box flexDirection="column" justifyContent="center" flexGrow={1}>
          <Box flexDirection="row">
            <Text color={ui.ivory} bold>
              {state.agent ?? state.assistantName}
            </Text>
            {state.agent ? <Text color={ui.agent}>{'  Direct chat'}</Text> : null}
          </Box>
          <Box flexDirection="row">
            <Badge color={ui.info}>{state.provider}</Badge>
            {state.model ? <Text color={ui.muted}>{' ' + state.model}</Text> : null}
            <Text color={ui.muted}>{'  ' + glyph.dot + '  ' + state.permission}</Text>
          </Box>
          <Text color={ui.faint}>
            {state.project ? 'Project ' + state.project : 'no project selected'}
          </Text>
        </Box>
      </Box>

      <Box flexDirection="row" marginTop={1} paddingX={1}>
        {state.ready.length ? (
          <StatusMessage variant="success">{state.ready.join(' + ') + ' ready'}</StatusMessage>
        ) : (
          <StatusMessage variant="error">
            no provider signed in — run `rookery doctor` for details
          </StatusMessage>
        )}
        {state.offline.length ? (
          <Text color={ui.faint}>{'  ' + state.offline.join(', ') + ' offline'}</Text>
        ) : null}
        <Box flexGrow={1} />
        <Text color={ui.faint}>{'/help ' + glyph.dot + ' Ctrl+D exits'}</Text>
      </Box>

      {state.warnings?.length ? (
        <Box marginTop={1}>
          <Alert variant="warning" title="While starting up">
            {state.warnings.join('\n')}
          </Alert>
        </Box>
      ) : null}
    </Box>
  );
}
