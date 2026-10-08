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
import { shorten, shortId } from '../../ui/render.js';
import type { SessionUsage } from '../types.js';

/** Below this width the bar drops everything but the essentials. */
const NARROW = 80;

/** Terminal width assumed when the caller does not report one. */
const DEFAULT_COLUMNS = 100;

/** Longest a counterpart title or project name gets in the identity row. */
const MAX_NAME_SEGMENT = 20;

/** Longest the conversation title gets in the identity row. */
const MAX_TITLE = 30;

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
  const { contextTokens, contextWindow, usage, quota, columns = DEFAULT_COLUMNS } = props;
  const wide = columns >= NARROW;

  return (
    <Box flexDirection="column">
      <IdentityRow {...props} wide={wide} />
      <MeterRow
        contextTokens={contextTokens}
        contextWindow={contextWindow}
        usage={usage}
        quota={quota}
        wide={wide}
      />
    </Box>
  );
}

function IdentityRow({
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
  wide,
}: StatusLineProps & { wide: boolean }): React.JSX.Element {
  const seconds = Math.floor(elapsedMs / 1000);
  const flags = [voice ? 'Voice' : '', verbose ? 'verbose' : ''].filter(Boolean);

  return (
    <Box flexDirection="row" paddingX={1}>
      {busy ? (
        // The library spinner animates on its own clock; the seconds come
        // from the app's ticker.
        <Spinner label={(label ?? 'thinking') + ' ' + seconds + 's'} />
      ) : (
        <Text color={ui.ok}>{glyph.bullet + ' ready'}</Text>
      )}

      <Text color={ui.frost} bold>
        {'  ' + assistantName}
      </Text>
      {counterpartTitle && wide ? (
        <Text color={ui.agent}>{' ' + shorten(counterpartTitle, MAX_NAME_SEGMENT)}</Text>
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
          <Text color={ui.agent}>{shorten(project, MAX_NAME_SEGMENT)}</Text>
        </>
      ) : null}

      <Box flexGrow={1} />

      {flags.length && wide ? (
        <Text color={ui.faint}>{flags.join(' ' + glyph.dot + ' ') + '  '}</Text>
      ) : null}
      <Text color={ui.faint} wrap="truncate-start">
        {shorten(title, MAX_TITLE) + (sessionId ? ' ' + glyph.dot + ' ' + shortId(sessionId) : '')}
      </Text>
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

  return (
    <Box flexDirection="row" paddingX={1}>
      {contextTokens !== undefined ? (
        <ContextMeter contextTokens={contextTokens} contextWindow={contextWindow} />
      ) : null}

      {spent ? (
        <>
          {contextTokens !== undefined ? <Separator /> : null}
          <SpendMeter spent={spent} wide={wide} />
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

function ContextMeter({
  contextTokens,
  contextWindow,
}: {
  contextTokens: number;
  contextWindow: number | undefined;
}): React.JSX.Element {
  const fraction = contextWindow ? contextTokens / contextWindow : undefined;

  return (
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
  );
}

function SpendMeter({ spent, wide }: { spent: SessionUsage; wide: boolean }): React.JSX.Element {
  return (
    <>
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
        <Text color={ui.accentSoft}>{'  ' + glyph.dot + '  ' + money(spent.costUsd)}</Text>
      ) : null}
    </>
  );
}

const THOUSAND = 1000;
const MILLION = 1_000_000;

/** From this many thousands on, `k` drops its decimal: `123k`, not `123.4k`. */
const WHOLE_THOUSANDS_FROM = 100;

/** `840`, `12.3k`, `1.2M` - the shortest form that is still unambiguous. */
export function tokens(value: number): string {
  if (value < THOUSAND) return String(Math.round(value));
  if (value < MILLION) {
    const thousands = value / THOUSAND;
    const rounded =
      thousands >= WHOLE_THOUSANDS_FROM ? String(Math.round(thousands)) : thousands.toFixed(1);
    return rounded + 'k';
  }
  return (value / MILLION).toFixed(1) + 'M';
}

const ONE_CENT = 0.01;

/** From this many dollars on, cents drop to a single decimal. */
const TENTHS_OF_A_DOLLAR_FROM = 10;

/** Cents matter under a dollar; past that they are noise. */
export function money(value: number): string {
  if (value < ONE_CENT) return '<$0.01';
  return '$' + (value < TENTHS_OF_A_DOLLAR_FROM ? value.toFixed(2) : value.toFixed(1));
}
