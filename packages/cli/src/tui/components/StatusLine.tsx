/**
 * The status bar between the scrollback and the input.
 *
 * Two rows, and they answer different questions. The first is about identity:
 * who is answering, on what, with how much permission, in which conversation.
 * The second is about cost: how full the context window is, how many tokens
 * this conversation has spent, what that came to, and how much of the
 * account's own limit window is left.
 *
 * The meter row hides itself until a turn has actually reported something, so
 * a fresh prompt is one clean line rather than a row of zeroes.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Badge, Spinner } from '@inkjs/ui';
import type { ProviderQuota } from '@rookery/core';
import { gauge, gaugeColor, glyph, ui } from '../theme.js';
import { shorten } from '../../ui/render.js';
import type { SessionUsage } from '../types.js';

/** Below this width the bar drops everything but the essentials. */
const NARROW = 80;

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
  /** What the turn is currently doing, e.g. 'thinking', 'delegating'. */
  label?: string;
  voice?: boolean;
  verbose?: boolean;
  /** Context the provider reported on the newest answer. */
  contextTokens?: number;
  contextWindow?: number;
  /** Tokens and cost across the whole conversation. */
  usage?: SessionUsage;
  /** The account's own limit windows, when the provider reported them. */
  quota?: ProviderQuota;
  /** Terminal width, so the bar can drop segments instead of wrapping. */
  columns?: number;
}

export function StatusLine(props: StatusLineProps): React.JSX.Element {
  const {
    assistantName,
    counterpartTitle,
    provider,
    model,
    effort,
    permission,
    title,
    project,
    sessionId,
    busy,
    elapsedMs,
    label,
    voice,
    verbose,
    contextTokens,
    contextWindow,
    usage,
    quota,
    columns = 100,
  } = props;

  const wide = columns >= NARROW;
  const seconds = Math.floor(elapsedMs / 1000);
  const flags = [voice ? 'Voice' : '', verbose ? 'verbose' : ''].filter(Boolean);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" paddingX={1}>
        {busy ? (
          // The library spinner animates on its own clock; the seconds come
          // from the app's ticker.
          <Spinner label={(label ?? 'thinking') + ' ' + seconds + 's'} />
        ) : (
          <Text color={ui.ok}>{glyph.bullet + ' ready'}</Text>
        )}

        <Text color={ui.ivory} bold>
          {'  ' + assistantName}
        </Text>
        {counterpartTitle && wide ? (
          <Text color={ui.agent}>{' ' + shorten(counterpartTitle, 20)}</Text>
        ) : null}

        <Separator />
        <Badge color={ui.info}>{provider}</Badge>
        {model ? <Text color={ui.muted}>{' ' + model}</Text> : null}
        {effort && wide ? <Text color={ui.faint}>{' ' + effort}</Text> : null}

        <Separator />
        {permission === 'full' ? (
          <Badge color={ui.warn}>{permission}</Badge>
        ) : (
          <Text color={ui.muted}>{permission}</Text>
        )}

        {project && wide ? (
          <>
            <Separator />
            <Text color={ui.agent}>{shorten(project, 20)}</Text>
          </>
        ) : null}

        <Box flexGrow={1} />

        {flags.length && wide ? (
          <Text color={ui.faint}>{flags.join(' ' + glyph.dot + ' ') + '  '}</Text>
        ) : null}
        <Text color={ui.faint} wrap="truncate-start">
          {shorten(title, 30) + (sessionId ? ' ' + glyph.dot + ' ' + sessionId.slice(0, 8) : '')}
        </Text>
      </Box>

      <MeterRow
        {...(contextTokens !== undefined ? { contextTokens } : {})}
        {...(contextWindow !== undefined ? { contextWindow } : {})}
        {...(usage ? { usage } : {})}
        {...(quota ? { quota } : {})}
        wide={wide}
      />
    </Box>
  );
}

function Separator(): React.JSX.Element {
  return <Text color={ui.faint}>{'  ' + glyph.sep + '  '}</Text>;
}

interface MeterRowProps {
  contextTokens?: number;
  contextWindow?: number;
  usage?: SessionUsage;
  quota?: ProviderQuota;
  wide: boolean;
}

/**
 * Context gauge, token totals, cost and the account's limit window.
 *
 * Every segment is optional and every one of them is left out entirely rather
 * than shown empty, because a provider that reports no cost and a turn that
 * cost nothing must not look the same.
 */
function MeterRow({
  contextTokens,
  contextWindow,
  usage,
  quota,
  wide,
}: MeterRowProps): React.JSX.Element | null {
  const spent = usage && usage.turns > 0 ? usage : undefined;
  const window = quota?.windows?.[0];
  if (contextTokens === undefined && !spent && !window) return null;

  const fraction =
    contextTokens !== undefined && contextWindow ? contextTokens / contextWindow : undefined;

  return (
    <Box flexDirection="row" paddingX={1}>
      {contextTokens !== undefined ? (
        <>
          {fraction !== undefined ? (
            <Text color={gaugeColor(fraction)}>{gauge(fraction) + ' '}</Text>
          ) : null}
          <Text color={ui.muted}>
            {fraction !== undefined ? Math.round(fraction * 100) + '% ' : ''}
            {tokens(contextTokens)}
            {contextWindow ? '/' + tokens(contextWindow) : ''}
            {' Context'}
          </Text>
        </>
      ) : null}

      {spent ? (
        <>
          {contextTokens !== undefined ? <Separator /> : null}
          <Text color={ui.faint}>
            {glyph.up +
              ' ' +
              tokens(spent.inputTokens) +
              '  ' +
              glyph.down +
              ' ' +
              tokens(spent.outputTokens)}
          </Text>
          {spent.cachedInputTokens > 0 && wide ? (
            <Text color={ui.faint}>
              {'  ' + glyph.dot + '  ' + tokens(spent.cachedInputTokens) + ' Cache'}
            </Text>
          ) : null}
          {spent.costUsd > 0 ? (
            <Text color={ui.amberSoft}>{'  ' + glyph.dot + '  ' + money(spent.costUsd)}</Text>
          ) : null}
        </>
      ) : null}

      <Box flexGrow={1} />

      {window ? (
        <Text color={gaugeColor(window.percent / 100)}>
          {window.label + ' ' + Math.round(window.percent) + '%'}
        </Text>
      ) : null}
    </Box>
  );
}

/** `840`, `12.3k`, `1.2M` - the shortest form that is still unambiguous. */
export function tokens(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return (thousands >= 100 ? String(Math.round(thousands)) : thousands.toFixed(1)) + 'k';
  }
  return (value / 1_000_000).toFixed(1) + 'M';
}

/** Cents matter under a dollar; past that they are noise. */
export function money(value: number): string {
  if (value < 0.01) return '<$0.01';
  return '$' + (value < 10 ? value.toFixed(2) : value.toFixed(1));
}
