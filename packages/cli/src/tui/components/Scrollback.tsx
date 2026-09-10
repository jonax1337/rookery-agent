/**
 * The conversation so far.
 *
 * Finished entries go through Ink's `<Static>`, which writes them once and
 * never re-renders them. That is what keeps the terminal's own scrollback
 * usable and stops a long conversation from being re-laid-out on every
 * animation frame - the live turn below it is the only thing that repaints.
 */

import React from 'react';
import { Box, Static, Text } from 'ink';
import { ui } from '../theme.js';
import { ActivityLine } from './ActivityLine.js';
import { AssistantMessage, UserMessage } from './Message.js';
import { AssignmentsSummaryView } from './AssignmentsView.js';
import type { Entry } from '../types.js';

export interface ScrollbackProps {
  entries: Entry[];
  /**
   * Render without `<Static>`. `<Static>` writes above the live frame, which
   * `renderToString` cannot show, so the render check turns it off.
   */
  inline?: boolean;
}

export function Scrollback({ entries, inline }: ScrollbackProps): React.JSX.Element {
  if (inline) {
    return (
      <Box flexDirection="column">
        {entries.map((entry) => (
          <EntryView key={entry.id} entry={entry} />
        ))}
      </Box>
    );
  }

  return (
    <Static items={entries}>
      {(entry: Entry) => <EntryView key={entry.id} entry={entry} />}
    </Static>
  );
}

export function EntryView({ entry }: { entry: Entry }): React.JSX.Element {
  switch (entry.kind) {
    case 'user':
      return <UserMessage text={entry.text} />;

    case 'assistant':
      return (
        <AssistantMessage
          text={entry.text}
          speaker={entry.speaker}
          {...(entry.provider ? { provider: entry.provider } : {})}
          {...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {})}
          {...(entry.aborted ? { aborted: true } : {})}
        />
      );

    case 'activity':
      return (
        <ActivityLine
          icon={entry.icon}
          text={entry.text}
          {...(entry.color ? { color: entry.color } : {})}
        />
      );

    case 'assignments':
      return <AssignmentsSummaryView summary={entry.summary} />;

    case 'notice':
    default:
      return (
        <Box flexDirection="column" marginTop={1}>
          {entry.lines.map((line, index) => (
            <Text
              key={index}
              color={line.color ?? ui.muted}
              dimColor={line.dim ?? !line.color}
              bold={line.bold}
              wrap="wrap"
            >
              {line.text || ' '}
            </Text>
          ))}
        </Box>
      );
  }
}
