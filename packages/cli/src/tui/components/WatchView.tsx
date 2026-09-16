/**
 * The live terminal for one running assignment.
 *
 * A pure view over a `WatchFeed`: the hook (`useWatch`) consumes the org
 * controller's log generator, and this renders it through the same
 * `blockSegments` walk the live turn region uses - tool groups between text
 * segments, dim notes, dim thinking behind `verbose`. Watching an agent work
 * should read exactly like watching the assistant work.
 *
 * Nothing here is ever committed to the scrollback; when the run ends the
 * view says so and waits for Esc.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { PULSE_FRAMES, STREAM_CURSOR, glyph, ui } from '../theme.js';
import { formatDuration, shortId } from '../../ui/render.js';
import { blockSegments, thinkingLines } from '../types.js';
import { ActivityLine } from './ActivityLine.js';
import { Markdown } from './Markdown.js';
import { ToolGroup } from './ToolGroup.js';
import type { WatchFeed } from '../hooks/useWatch.js';

export interface WatchViewProps {
  assignmentId: string;
  feed: WatchFeed;
  verbose: boolean;
}

/** Ticker frames per caret blink, matching the live region's cadence. */
const TICKS_PER_CARET = 6;

export function WatchView({ assignmentId, feed, verbose }: WatchViewProps): React.JSX.Element {
  const { state, frame, now } = feed;
  const segments = blockSegments(state.blocks, {
    streaming: !state.ended,
    toolTimes: state.toolTimes,
  });
  const elapsed = Math.max(0, now - state.startedAt);
  const caret = !state.ended && Math.floor(frame / TICKS_PER_CARET) % 2 === 0;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={state.ended ? ui.ok : ui.amber}>
          {(state.ended ? glyph.ok : PULSE_FRAMES[frame % PULSE_FRAMES.length] ?? glyph.dot) + ' '}
        </Text>
        <Text color={ui.amber} bold>
          {'watching ' + shortId(assignmentId)}
        </Text>
        <Text color={ui.faint}>{'  ' + formatDuration(elapsed)}</Text>
        <Text color={ui.faint}>{'  Esc leaves'}</Text>
      </Box>

      <Box paddingLeft={2} flexDirection="column">
        {segments.map((segment, index) => {
          if (segment.kind === 'tools') {
            return <ToolGroup key={'g' + index} calls={segment.calls} frame={frame} now={now} />;
          }
          if (segment.kind === 'note') {
            return (
              <ActivityLine
                key={segment.note.id}
                icon={segment.note.icon}
                text={segment.note.text}
                {...(segment.note.color ? { color: segment.note.color } : {})}
              />
            );
          }
          if (segment.kind === 'thinking') {
            if (!verbose) return null;
            return (
              <Box key={'y' + index} flexDirection="column">
                {thinkingLines(segment.text).map((line, at) => (
                  <ActivityLine key={at} icon={glyph.thinking} text={line} />
                ))}
              </Box>
            );
          }
          return (
            <Box key={'m' + index} flexDirection="column">
              <Markdown trailing={segment.streaming && caret
                ? <Text color={ui.amber}>{STREAM_CURSOR}</Text>
                : null}
              >
                {segment.text}
              </Markdown>
            </Box>
          );
        })}

        {state.ended && !segments.length ? (
          <Text color={ui.faint} dimColor>
            no live output — the run finished before the watch started, or runs in another process
          </Text>
        ) : null}

        {state.ended && segments.length ? (
          <Text color={ui.faint} dimColor>
            run finished
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
