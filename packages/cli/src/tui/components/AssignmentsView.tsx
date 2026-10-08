/**
 * The live view of everything the current turn delegated.
 *
 * One row per assignment, in the order the company handed them out, indented
 * by delegation depth so a chain reads as a chain. Rows update in place, so
 * the block keeps its height from the first `assignment` event to the last.
 *
 * The row shares its shape with a tool call - marker, name column, subject,
 * numbers on the right - because to a reader they are the same kind of thing:
 * work that was handed off and is either running, finished or broken.
 *
 * Core only reports `durationMs` once an assignment finishes, so the live
 * clock comes from the moment the row first went `running` - tracked by the
 * caller and passed in, which keeps this component a pure function of props.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { AssignmentStatus, AssignmentView } from '@rookery/core';
import { ASSIGNMENT_COLOR, ASSIGNMENT_MARK, SPINNER_FRAMES, glyph, ui } from '../theme.js';
import { formatChars, formatDuration, shorten } from '../../ui/render.js';
import type { AssignmentsState, AssignmentsSummary } from '../types.js';

/** Width of the agent column, shared by the live and the collapsed view. */
const SLUG_COLUMN = 16;

/** Narrowest the agent name gets, however deep the row is nested. */
const MIN_SLUG_WIDTH = 6;

/** Right-hand columns of a live row. */
const STATUS_COLUMN = 11;
const CHARS_COLUMN = 6;
const ELAPSED_COLUMN = 6;

/** What one level of delegation depth indents a row by. */
const DEPTH_INDENT = '  ';

/** Columns a detail line hangs in from the row's own indent. */
const DETAIL_INDENT = 2;

const BULLET_SEPARATOR = '  ' + glyph.dot + '  ';

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
  const mark = running
    ? (SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? '-')
    : ASSIGNMENT_MARK[view.status];
  const color = ASSIGNMENT_COLOR[view.status];
  const indent = indentFor(view.depth);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={color}>{indent + mark + ' '}</Text>
        {/* The indent is taken out of the name column, so a delegation chain
            reads as a chain without pushing every column right of it out of
            line with the rows above. */}
        <Text color={ui.agent}>{slug(view.agentSlug, indent.length)}</Text>
        <Box flexGrow={1}>
          <Text color={view.status === 'pending' ? ui.muted : ui.frost} wrap="truncate-end">
            {view.task}
          </Text>
        </Box>
        <Text color={color}>{' ' + view.status.padEnd(STATUS_COLUMN)}</Text>
        <Text color={ui.faint}>
          {formatChars(view.chars).padStart(CHARS_COLUMN) +
            ' ' +
            (elapsedMs === undefined ? '' : formatDuration(elapsedMs)).padStart(ELAPSED_COLUMN)}
        </Text>
      </Box>

      {running && view.preview ? (
        <DetailLine indent={indent} color={ui.faint} wrap="truncate-end">
          {view.preview}
        </DetailLine>
      ) : null}

      {view.status === 'failed' && view.error ? (
        <DetailLine indent={indent} color={ui.danger} wrap="wrap">
          {view.error}
        </DetailLine>
      ) : null}
    </Box>
  );
}

/** A line hung under its row with the result branch, in the row's own indent. */
function DetailLine({
  indent,
  color,
  wrap,
  children,
}: {
  indent: string;
  color: string;
  wrap: 'wrap' | 'truncate-end';
  children: string;
}): React.JSX.Element {
  return (
    <Box flexDirection="row" paddingLeft={DETAIL_INDENT}>
      <Text color={color}>{indent + glyph.branch + ' '}</Text>
      <Box flexGrow={1}>
        <Text color={color} wrap={wrap}>
          {children}
        </Text>
      </Box>
    </Box>
  );
}

function Headline({
  rows,
  now,
  since,
}: {
  rows: AssignmentView[];
  now: number;
  since: number;
}): React.JSX.Element {
  const running = countWithStatus(rows, 'running');
  const done = countWithStatus(rows, 'done');
  const failed = countWithStatus(rows, 'failed');

  const bits = [count(rows.length)];
  if (running) bits.push(running + ' running');
  if (done) bits.push(done + ' done');
  if (failed) bits.push(failed + ' failed');
  bits.push(formatDuration(Math.max(0, now - since)));

  return (
    <Box flexDirection="row">
      <Text color={ui.accent} bold>
        {glyph.agent + ' delegating '}
      </Text>
      <Text color={ui.muted}>{bits.join(BULLET_SEPARATOR)}</Text>
    </Box>
  );
}

export interface AssignmentsSummaryViewProps {
  summary: AssignmentsSummary;
}

/** What a finished turn's delegation leaves in the scrollback. */
export function AssignmentsSummaryView({
  summary,
}: AssignmentsSummaryViewProps): React.JSX.Element {
  const bits = [count(summary.total), summary.done + ' done'];
  if (summary.failed) bits.push(summary.failed + ' failed');
  bits.push(formatDuration(summary.durationMs));

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={summary.failed ? ui.warn : ui.ok}>
          {(summary.failed ? glyph.warn : glyph.ok) + ' '}
        </Text>
        <Text color={ui.accent} bold>
          {'delegating '}
        </Text>
        <Text color={ui.muted}>{bits.join(BULLET_SEPARATOR)}</Text>
      </Box>
      {summary.assignments.map((view) => (
        <SummaryRow key={view.id} view={view} />
      ))}
    </Box>
  );
}

function SummaryRow({ view }: { view: AssignmentView }): React.JSX.Element {
  const indent = indentFor(view.depth);
  return (
    <Box flexDirection="row">
      <Text color={ui.agent}>{'  ' + indent + slug(view.agentSlug, indent.length)}</Text>
      <Box flexGrow={1}>
        <Text color={ui.frost} wrap="truncate-end">
          {view.task}
        </Text>
      </Box>
      <Text color={ASSIGNMENT_COLOR[view.status]}>{' ' + view.status}</Text>
    </Box>
  );
}

function indentFor(depth: number): string {
  return DEPTH_INDENT.repeat(Math.max(0, depth));
}

function countWithStatus(rows: AssignmentView[], status: AssignmentStatus): number {
  return rows.filter((view) => view.status === status).length;
}

function count(total: number): string {
  return total + (total === 1 ? ' run' : ' runs');
}

/**
 * The agent name, set in what is left of the name column once the row's
 * indentation has been paid for. A deeply nested row gets a short name rather
 * than a wide row.
 */
function slug(agentSlug: string, indent: number): string {
  const width = Math.max(MIN_SLUG_WIDTH, SLUG_COLUMN - indent);
  return shorten(agentSlug, width - 1).padEnd(width);
}

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
