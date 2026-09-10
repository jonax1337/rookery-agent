/**
 * The live view of everything the current turn delegated.
 *
 * One row per assignment, in the order the company handed them out, indented
 * by delegation depth so a chain reads as a chain. Rows update in place, so
 * the block keeps its height from the first `assignment` event to the last.
 *
 * Core only reports `durationMs` once an assignment finishes, so the live
 * clock comes from the moment the row first went `running` - tracked by the
 * caller and passed in, which keeps this component a pure function of props.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { AssignmentView } from '@rookery/core';
import { ASSIGNMENT_COLOR, ASSIGNMENT_MARK, glyph, SPINNER_FRAMES, ui } from '../theme.js';
import { formatChars, formatDuration, shorten } from '../../ui/render.js';
import type { AssignmentsState, AssignmentsSummary } from '../types.js';

export interface AssignmentsViewProps {
  state: AssignmentsState;
  /** Animation tick for the running spinner. */
  frame: number;
  /** Clock used for the live elapsed columns. Injectable so tests are stable. */
  now?: number;
}

export function AssignmentsView({
  state,
  frame,
  now = Date.now(),
}: AssignmentsViewProps): React.JSX.Element | null {
  const rows = state.order
    .map((id) => state.byId[id])
    .filter((view): view is AssignmentView => Boolean(view));
  if (!rows.length) return null;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Headline rows={rows} now={now} since={state.since} />
      {rows.map((view) => (
        <AssignmentRow
          key={view.id}
          view={view}
          frame={frame}
          elapsedMs={elapsedFor(state, view, now)}
        />
      ))}
    </Box>
  );
}

/* --------------------------------- rows -------------------------------- */

function AssignmentRow({
  view,
  frame,
  elapsedMs,
}: {
  view: AssignmentView;
  frame: number;
  elapsedMs: number | undefined;
}): React.JSX.Element {
  const running = view.status === 'running';
  const mark = running ? SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? '-' : ASSIGNMENT_MARK[view.status];
  const color = ASSIGNMENT_COLOR[view.status];
  const indent = '  '.repeat(Math.max(0, view.depth));

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={color}>{'  ' + indent + mark + ' '}</Text>
        <Text color={ui.agent}>{shorten(view.agentSlug, 15).padEnd(16)}</Text>
        <Box flexGrow={1}>
          <Text color={view.status === 'pending' ? ui.muted : ui.ivory} wrap="truncate-end">
            {shorten(view.task, 44)}
          </Text>
        </Box>
        <Text color={ui.muted} dimColor>
          {' ' + view.status.padEnd(10)}
          {formatChars(view.chars).padStart(6)}
          {' '}
          {(elapsedMs === undefined ? '' : formatDuration(elapsedMs)).padStart(6)}
        </Text>
      </Box>

      {running && view.preview ? (
        <Text color={ui.muted} dimColor>
          {'      ' + indent + glyph.prompt + ' ' + shorten(view.preview, 82)}
        </Text>
      ) : null}

      {view.status === 'failed' && view.error ? (
        <Text color={ui.danger} dimColor>
          {'      ' + indent + glyph.fail + ' ' + shorten(view.error, 82)}
        </Text>
      ) : null}
    </Box>
  );
}

/* ------------------------------- headline ------------------------------ */

function Headline({
  rows,
  now,
  since,
}: {
  rows: AssignmentView[];
  now: number;
  since: number;
}): React.JSX.Element {
  const done = rows.filter((view) => view.status === 'done').length;
  const failed = rows.filter((view) => view.status === 'failed').length;
  const running = rows.filter((view) => view.status === 'running').length;

  const bits = [rows.length + (rows.length === 1 ? ' assignment' : ' assignments')];
  if (running) bits.push(running + ' running');
  if (done) bits.push(done + ' done');
  if (failed) bits.push(failed + ' failed');
  bits.push(formatDuration(Math.max(0, now - since)));

  return (
    <Box flexDirection="row">
      <Text color={ui.amber} bold>
        {glyph.agent + ' delegated '}
      </Text>
      <Text color={ui.muted} dimColor>
        {bits.join(' ' + glyph.dot + ' ')}
      </Text>
    </Box>
  );
}

/* ------------------------------- collapsed ----------------------------- */

export interface AssignmentsSummaryViewProps {
  summary: AssignmentsSummary;
}

/** What a finished turn's delegation leaves in the scrollback: one line. */
export function AssignmentsSummaryView({ summary }: AssignmentsSummaryViewProps): React.JSX.Element {
  const bits = [
    summary.total + (summary.total === 1 ? ' assignment' : ' assignments'),
    summary.done + ' done',
  ];
  if (summary.failed) bits.push(summary.failed + ' failed');
  bits.push(formatDuration(summary.durationMs));

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={summary.failed ? ui.warn : ui.ok}>
          {(summary.failed ? glyph.warn : glyph.ok) + ' '}
        </Text>
        <Text color={ui.amber} bold>
          delegated{' '}
        </Text>
        <Text color={ui.muted} dimColor>
          {bits.join(' ' + glyph.dot + ' ')}
        </Text>
      </Box>
      {summary.assignments.map((view) => (
        <Box key={view.id} flexDirection="row">
          <Text color={ui.agent}>
            {'  ' + '  '.repeat(Math.max(0, view.depth)) + shorten(view.agentSlug, 15).padEnd(16)}
          </Text>
          <Text color={ui.ivory}>{shorten(view.task, 52)}</Text>
          <Text color={ASSIGNMENT_COLOR[view.status]} dimColor>
            {'  ' + view.status}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

/* -------------------------------- helpers ------------------------------ */

function elapsedFor(
  state: AssignmentsState,
  view: AssignmentView,
  now: number,
): number | undefined {
  if (view.durationMs !== undefined) return view.durationMs;
  const startedAt = state.startedAt[view.id];
  if (view.status === 'running' && startedAt !== undefined) return Math.max(0, now - startedAt);
  return undefined;
}
