/**
 * One conversation turn.
 *
 * A user turn keeps its own words verbatim behind an amber caret - echoing
 * someone's markdown back at them as rendered markdown is confusing. An
 * assistant turn gets a thin meta line naming who answered, on what, how long
 * it took and what it cost, and then the answer itself through the markdown
 * renderer, indented into the same gutter every other block hangs off.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { TurnUsage } from '@rookery/core';
import { GUTTER, STREAM_CURSOR, glyph, ui } from '../theme.js';
import { Markdown } from './Markdown.js';
import { money, tokens } from './StatusLine.js';
import { formatDuration } from '../../ui/render.js';

export interface UserMessageProps {
  text: string;
}

export function UserMessage({ text }: UserMessageProps): React.JSX.Element {
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text color={ui.amber} bold>
        {glyph.prompt + ' '}
      </Text>
      <Box flexGrow={1} flexDirection="column">
        {text.split('\n').map((line, index) => (
          // Lines of a user turn have no identity beyond their position.
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
  /** What this one turn cost, when the provider reported it. */
  usage?: TurnUsage;
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
  usage,
  streaming,
  cursorVisible,
}: AssistantMessageProps): React.JSX.Element {
  const trailing =
    streaming && cursorVisible ? <Text color={ui.amber}>{STREAM_CURSOR}</Text> : null;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={ui.amber} bold>
          {speaker}
        </Text>
        {provider ? <Text color={ui.faint}>{'  ' + provider}</Text> : null}
        {durationMs !== undefined ? (
          <Text color={ui.faint}>{'  ' + formatDuration(durationMs)}</Text>
        ) : null}
        {usage ? <Text color={ui.faint}>{'  ' + turnCost(usage)}</Text> : null}
        {aborted ? <Text color={ui.warn}>{'  cancelled'}</Text> : null}
      </Box>
      <Box paddingLeft={GUTTER} flexDirection="column">
        <Markdown trailing={trailing}>{text}</Markdown>
      </Box>
    </Box>
  );
}

/** `↑1.2k ↓840 · $0.02`, leaving out whatever the provider did not report. */
function turnCost(usage: TurnUsage): string {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(glyph.up + tokens(usage.inputTokens));
  if (usage.outputTokens !== undefined) parts.push(glyph.down + tokens(usage.outputTokens));
  const head = parts.join(' ');
  if (usage.costUsd === undefined || usage.costUsd <= 0) return head;
  return head ? head + ' ' + glyph.dot + ' ' + money(usage.costUsd) : money(usage.costUsd);
}
