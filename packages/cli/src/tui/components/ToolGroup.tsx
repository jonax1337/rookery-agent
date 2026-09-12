/**
 * A run of the provider's own tool calls, rendered as one block.
 *
 * Two things were wrong with printing one dim line per event. Tool calls came
 * out as an undifferentiated ribbon with nothing separating one turn's work
 * from the next, and each line was cut to a fixed number of characters, so a
 * shell command or a long path was simply lost off the right edge.
 *
 * So: consecutive calls are grouped, the group is set off by a blank line and
 * a name column the rows share, and the argument summary wraps instead of
 * being truncated. A call is one row that changes state - the marker goes from
 * a pulse to a dot to a cross - rather than a `start` line and an `end` line
 * the reader has to pair up.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { PULSE_FRAMES, glyph, ui } from '../theme.js';
import { formatDuration } from '../../ui/render.js';
import type { ToolCall } from '../types.js';

/** Widest the shared name column is allowed to get before names are cut. */
const NAME_COLUMN = 12;

/** Detail lines shown under a call before the rest is summarised away. */
const MAX_DETAIL_LINES = 4;

export interface ToolGroupProps {
  calls: ToolCall[];
  /** Animation tick, for the pulse on a call that is still running. */
  frame?: number;
  /** Clock for the live elapsed time; omit for a finished group. */
  now?: number;
}

export function ToolGroup({ calls, frame = 0, now }: ToolGroupProps): React.JSX.Element | null {
  if (!calls.length) return null;

  // One column width for the whole group, so the arguments line up.
  const width = Math.min(NAME_COLUMN, Math.max(...calls.map((call) => call.name.length)));

  return (
    <Box flexDirection="column" marginTop={1}>
      {calls.map((call) => (
        <ToolCallRow
          key={call.id}
          call={call}
          width={width}
          frame={frame}
          {...(now !== undefined ? { now } : {})}
        />
      ))}
    </Box>
  );
}

export interface ToolCallRowProps {
  call: ToolCall;
  /** Width of the shared name column. */
  width: number;
  frame?: number;
  now?: number;
}

export function ToolCallRow({ call, width, frame = 0, now }: ToolCallRowProps): React.JSX.Element {
  const [head = '', ...rest] = (call.detail ?? '').split('\n');
  const extra = rest.filter((line) => line.trim()).slice(0, MAX_DETAIL_LINES - 1);
  const hidden = rest.filter((line) => line.trim()).length - extra.length;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={markColor(call)}>{mark(call, frame) + ' '}</Text>
        <Box marginRight={1}>
          <Text color={call.status === 'failed' ? ui.danger : ui.ivory} bold>
            {cut(call.name, width).padEnd(width)}
          </Text>
        </Box>
        <Box flexGrow={1}>
          <Text color={ui.muted} wrap="wrap">
            {head}
          </Text>
        </Box>
        <Text color={ui.faint}>{' ' + clock(call, now)}</Text>
      </Box>

      {extra.map((line, index) => (
        // Continuation lines have no identity beyond their position.
        <Box key={index} flexDirection="row" paddingLeft={2}>
          <Text color={ui.faint}>{glyph.branch + ' '}</Text>
          <Box flexGrow={1}>
            <Text color={ui.faint} wrap="wrap">
              {line.trim()}
            </Text>
          </Box>
        </Box>
      ))}

      {hidden > 0 ? (
        <Box paddingLeft={2}>
          <Text color={ui.faint} dimColor>
            {glyph.branch + ' +' + hidden + ' more lines'}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** Running pulses, finished is a filled dot, failed is a cross. */
function mark(call: ToolCall, frame: number): string {
  if (call.status === 'running') return PULSE_FRAMES[frame % PULSE_FRAMES.length] ?? glyph.dot;
  return call.status === 'failed' ? glyph.fail : glyph.tool;
}

function markColor(call: ToolCall): string {
  if (call.status === 'running') return ui.amber;
  return call.status === 'failed' ? ui.danger : ui.ok;
}

/**
 * How long the call took, or has been taking.
 *
 * A call that has been running for under a second shows nothing: a number that
 * flickers between `0ms` and `40ms` is noise, not information.
 */
function clock(call: ToolCall, now: number | undefined): string {
  if (call.durationMs !== undefined) return formatDuration(call.durationMs);
  if (now === undefined) return '';
  const elapsed = now - call.startedAt;
  return elapsed >= 1000 ? formatDuration(elapsed) : '';
}

function cut(text: string, width: number): string {
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…';
}
