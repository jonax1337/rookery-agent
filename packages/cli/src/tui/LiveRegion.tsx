/**
 * The live region: what the turn in flight has produced so far. Only this
 * repaints while a turn streams; a finished turn moves to the scrollback.
 */

import React from 'react';
import { Box } from 'ink';
import { ActivityLine } from './components/ActivityLine.js';
import { AssignmentsView } from './components/AssignmentsView.js';
import { AssistantMessage } from './components/Message.js';
import { ToolGroup } from './components/ToolGroup.js';
import type { LiveTurn } from './hooks/useTurn.js';
import { glyph } from './theme.js';
import { blockSegments, speakerName, thinkingLines } from './types.js';
import type { BlockSegment, SessionState } from './types.js';

export interface LiveRegionProps {
  turn: LiveTurn;
  session: SessionState;
  frame: number;
  now: number;
  caretVisible: boolean;
}

export function LiveRegion({
  turn,
  session,
  frame,
  now,
  caretVisible,
}: LiveRegionProps): React.JSX.Element {
  // The live region walks exactly the `blockSegments` the committed scrollback
  // will be built from, so a finished turn never visibly re-flows. The
  // accumulator hands out a fresh array per read, so this recomputes on every
  // flush by design - the walk is cheap and the data is always current.
  const segments = blockSegments(turn.blocks.blocks, {
    streaming: turn.busy,
    toolTimes: turn.blocks.toolTimes,
  });

  return (
    <Box flexDirection="column">
      {segments.map((segment, index) => {
        if (segment.kind === 'tools') {
          return <ToolGroup key={'g' + index} calls={segment.calls} frame={frame} now={now} />;
        }
        if (segment.kind === 'note') return <NoteLine key={segment.note.id} segment={segment} />;
        if (segment.kind === 'thinking') {
          return session.verbose ? <ThinkingLines key={'y' + index} text={segment.text} /> : null;
        }
        return (
          <AssistantMessage
            key={'m' + index}
            text={segment.text}
            speaker={speakerName(session)}
            provider={session.provider}
            streaming={segment.streaming}
            cursorVisible={caretVisible}
          />
        );
      })}

      {turn.assignments ? <AssignmentsView state={turn.assignments} frame={frame} now={now} /> : null}
    </Box>
  );
}

function NoteLine({
  segment,
}: {
  segment: Extract<BlockSegment, { kind: 'note' }>;
}): React.JSX.Element {
  const { icon, text, color } = segment.note;
  return <ActivityLine icon={icon} text={text} {...(color ? { color } : {})} />;
}

function ThinkingLines({ text }: { text: string }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {thinkingLines(text).map((line, at) => (
        <ActivityLine key={at} icon={glyph.thinking} text={line} />
      ))}
    </Box>
  );
}
