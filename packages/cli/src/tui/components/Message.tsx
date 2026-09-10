/**
 * One conversation turn.
 *
 * User turns get an amber gutter bar and stay verbatim - echoing a user's own
 * markdown back at them as rendered markdown is confusing. Assistant turns go
 * through the markdown renderer.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyph, STREAM_CURSOR, ui } from '../theme.js';
import { Markdown } from './Markdown.js';
import { formatDuration } from '../../ui/render.js';

export interface UserMessageProps {
  text: string;
}

export function UserMessage({ text }: UserMessageProps): React.JSX.Element {
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text color={ui.amber} bold>
        {glyph.prompt}{' '}
      </Text>
      <Box flexGrow={1} flexDirection="column">
        {text.split('\n').map((line, index) => (
          <Text key={index} color={ui.ivory} wrap="wrap">
            {line || ' '}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

export interface AssistantMessageProps {
  text: string;
  speaker: string;
  provider?: string;
  durationMs?: number;
  aborted?: boolean;
  /** Render the blinking cursor at the tail: the turn is still streaming. */
  streaming?: boolean;
  cursorVisible?: boolean;
}

export function AssistantMessage({
  text,
  speaker,
  provider,
  durationMs,
  aborted,
  streaming,
  cursorVisible,
}: AssistantMessageProps): React.JSX.Element {
  const meta = [speaker, provider].filter(Boolean).join(' ' + glyph.dot + ' ');
  const trailing =
    streaming && cursorVisible ? <Text color={ui.amber}>{STREAM_CURSOR}</Text> : null;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={ui.amber} bold>
          {glyph.bullet}{' '}
        </Text>
        <Text color={ui.muted} dimColor>
          {meta}
          {durationMs !== undefined ? '  ' + formatDuration(durationMs) : ''}
          {aborted ? '  interrupted' : ''}
        </Text>
      </Box>
      <Box paddingLeft={2} flexDirection="column">
        <Markdown trailing={trailing}>{text}</Markdown>
      </Box>
    </Box>
  );
}
