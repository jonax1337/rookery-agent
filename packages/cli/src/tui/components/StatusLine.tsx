/**
 * The one-line status strip that sits between the scrollback and the input.
 *
 * It answers, at a glance, the four questions a running turn raises: who is
 * answering (agent), on what (provider/model), how much it is allowed to touch
 * (permission) and which conversation this is (session title). While a turn
 * runs it also carries the spinner and the elapsed clock.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyph, SPINNER_FRAMES, ui } from '../theme.js';
import { shorten } from '../../ui/render.js';

export interface StatusLineProps {
  /**
   * Who you are talking to: the assistant's name, or an agent's slug for a
   * direct chat. Whatever it says, the conversation is with that one
   * counterpart for its whole life.
   */
  assistantName: string;
  /** Job title of the agent holding the floor, when it is not the assistant. */
  counterpartTitle?: string;
  provider: string;
  model?: string;
  /** Reasoning effort, when one is pinned; the provider default otherwise. */
  effort?: string;
  /** Context fill of the newest answer, e.g. "ctx 7%" or "ctx 14.9k". */
  context?: string;
  permission: string;
  title: string;
  /**
   * Project the conversation is about, when one is set. There is no working
   * directory to show: the assistant always runs in the Rookery workspace.
   */
  project?: string;
  sessionId?: string;
  busy: boolean;
  /** Milliseconds since the current turn started. Ignored when idle. */
  elapsedMs: number;
  /** Animation tick; the component picks its own frame from it. */
  frame: number;
  /** What the turn is currently doing, e.g. 'thinking', 'orchestrating'. */
  label?: string;
  voice?: boolean;
  verbose?: boolean;
}

export function StatusLine(props: StatusLineProps): React.JSX.Element {
  const {
    assistantName,
    counterpartTitle,
    provider,
    model,
    effort,
    context,
    permission,
    title,
    project,
    sessionId,
    busy,
    elapsedMs,
    frame,
    label,
    voice,
    verbose,
  } = props;

  const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? '-';
  const seconds = Math.floor(elapsedMs / 1000);
  const flags = [voice ? 'voice' : '', verbose ? 'verbose' : ''].filter(Boolean).join(' ' + glyph.dot + ' ');

  return (
    <Box flexDirection="row" paddingX={1}>
      {busy ? (
        <Text color={ui.amber}>
          {spinner} {label ?? 'thinking'} {seconds}s{'  '}
        </Text>
      ) : (
        <Text color={ui.muted} dimColor>
          {glyph.ok} ready{'  '}
        </Text>
      )}

      <Text color={ui.amber} bold>
        {assistantName}
      </Text>
      {counterpartTitle ? (
        <Text color={ui.agent} dimColor>
          {' ' + shorten(counterpartTitle, 22)}
        </Text>
      ) : null}
      <Text color={ui.muted} dimColor>
        {' ' + glyph.dot + ' '}
      </Text>
      <Text color={ui.info}>{provider}</Text>
      {model ? (
        <Text color={ui.muted} dimColor>
          {' ' + model}
        </Text>
      ) : null}
      {effort ? (
        <Text color={ui.muted} dimColor>
          {' ' + effort}
        </Text>
      ) : null}
      <Text color={ui.muted} dimColor>
        {' ' + glyph.dot + ' '}
      </Text>
      <Text color={permission === 'full' ? ui.warn : ui.muted}>{permission}</Text>

      {context ? (
        <>
          <Text color={ui.muted} dimColor>
            {' ' + glyph.dot + ' '}
          </Text>
          <Text color={ui.muted}>{context}</Text>
        </>
      ) : null}

      {project ? (
        <>
          <Text color={ui.muted} dimColor>
            {' ' + glyph.dot + ' '}
          </Text>
          <Text color={ui.agent}>{shorten(project, 22)}</Text>
        </>
      ) : null}

      <Box flexGrow={1} />

      {flags ? (
        <Text color={ui.muted} dimColor>
          {flags + '  '}
        </Text>
      ) : null}
      <Text color={ui.muted} dimColor>
        {shorten(title, 34)}
        {sessionId ? ' ' + glyph.dot + ' ' + sessionId.slice(0, 8) : ''}
      </Text>
    </Box>
  );
}
