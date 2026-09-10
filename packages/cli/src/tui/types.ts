/**
 * The shapes the TUI renders.
 *
 * Everything below is plain data on purpose: the components are pure
 * functions of these props, which is what makes `renderToString` a usable
 * test harness (see `scripts/tui-render-check.mjs`).
 */

import type {
  AssignmentView,
  EffortLevel,
  PermissionLevel,
  ProviderId,
  ProviderQuota,
  TurnUsage,
} from '@rookery/core';

/** One coloured line inside a `notice` entry. */
export interface NoticeLine {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

/** Where one of the provider's own tool calls stands. */
export type ToolStatus = 'running' | 'done' | 'failed';

/**
 * One tool call of the provider, from `start` to `end`.
 *
 * The two `tool` events core emits are folded into this single record by id,
 * so a call is one row that changes state rather than two rows that have to be
 * read together.
 */
export interface ToolCall {
  id: string;
  name: string;
  /** Argument summary the provider sent, e.g. a path or a shell command. */
  detail?: string;
  status: ToolStatus;
  startedAt: number;
  /** Set once the call ends. */
  durationMs?: number;
}

/** A dim side-channel line: memory recall, a routing decision, an error. */
export interface NoteActivity {
  kind: 'note';
  id: string;
  icon: string;
  text: string;
  color?: string;
}

export interface ToolActivity extends ToolCall {
  kind: 'tool';
}

/** One thing that happened next to the answer, in the order it happened. */
export type Activity = NoteActivity | ToolActivity;

/** A run of consecutive tool calls, or a single note between two such runs. */
export type ActivityGroup =
  | { kind: 'note'; note: NoteActivity }
  | { kind: 'tools'; id: string; calls: ToolCall[] };

/**
 * Collapse consecutive tool calls into one group.
 *
 * Both the live region and the committed scrollback need this and they must
 * agree, or a turn would visibly re-flow the moment it finishes.
 */
export function groupActivities(activities: Activity[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  let calls: ToolCall[] = [];

  const flush = (): void => {
    if (!calls.length) return;
    groups.push({ kind: 'tools', id: 'k' + (calls[0]?.id ?? groups.length), calls });
    calls = [];
  };

  for (const activity of activities) {
    if (activity.kind === 'tool') {
      const { kind, ...call } = activity;
      void kind;
      calls.push(call);
      continue;
    }
    flush();
    groups.push({ kind: 'note', note: activity });
  }
  flush();

  return groups;
}

/**
 * A finished item in the scrollback. Entries are append-only.
 *
 * Tool calls arrive as a `tools` group rather than one entry each: a turn that
 * reads six files should read as one block of six rows, not as six unrelated
 * lines wedged between everything else.
 */
export type Entry =
  | { kind: 'user'; id: string; text: string }
  | {
      kind: 'assistant';
      id: string;
      text: string;
      speaker: string;
      provider?: ProviderId;
      durationMs?: number;
      aborted?: boolean;
      usage?: TurnUsage;
    }
  | { kind: 'activity'; id: string; icon: string; text: string; color?: string }
  | { kind: 'tools'; id: string; calls: ToolCall[] }
  | { kind: 'notice'; id: string; lines: NoticeLine[] }
  | { kind: 'banner'; id: string; banner: BannerState }
  | { kind: 'assignments'; id: string; summary: AssignmentsSummary };

/** Everything the boot banner shows. */
export interface BannerState {
  /** Product name, set in the block face. */
  wordmark: string;
  /** Who answers in this conversation. */
  assistantName: string;
  /** Providers that are logged in and usable. */
  ready: string[];
  /** Providers that are configured but unavailable. */
  offline: string[];
  provider: string;
  model?: string;
  permission: string;
  project?: string;
  /** Agent slug when the conversation is a direct chat. */
  agent?: string;
  /** Anything that went wrong while starting up. */
  warnings?: string[];
}

/**
 * Everything the turn delegated, rebuilt from `assignment` events.
 *
 * Views are merged by id, because core re-sends the whole view on every
 * change: a task handed out, then running, then a progress tick, then done.
 */
export interface AssignmentsState {
  /** Latest view per assignment id. */
  byId: Record<string, AssignmentView>;
  /** Insertion order, so rows never jump around mid-run. */
  order: string[];
  /**
   * When each assignment first went `running`, by id. Core only reports
   * `durationMs` once one finishes, so the live clock is kept here.
   */
  startedAt: Record<string, number>;
  /** When the first assignment of this turn appeared. */
  since: number;
}

/** What a turn that delegated leaves behind in the scrollback. */
export interface AssignmentsSummary {
  total: number;
  done: number;
  failed: number;
  durationMs: number;
  assignments: AssignmentView[];
}

/**
 * Token and cost accounting for the whole conversation.
 *
 * Core reports usage per turn; the status bar wants the running total, so the
 * app adds each finished turn into this.
 */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  /** Turns that actually reported usage, so an average stays honest. */
  turns: number;
}

export const EMPTY_USAGE: SessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  turns: 0,
};

/** Add one turn's report into the running total. */
export function addUsage(total: SessionUsage, usage: TurnUsage): SessionUsage {
  return {
    inputTokens: total.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: total.outputTokens + (usage.outputTokens ?? 0),
    cachedInputTokens: total.cachedInputTokens + (usage.cachedInputTokens ?? 0),
    reasoningTokens: total.reasoningTokens + (usage.reasoningTokens ?? 0),
    costUsd: total.costUsd + (usage.costUsd ?? 0),
    turns: total.turns + 1,
  };
}

/** Everything the status line needs to know. */
export interface SessionState {
  sessionId: string | undefined;
  title: string;
  /** The assistant's own name, kept even while an agent holds the floor. */
  assistantName: string;
  /**
   * The agent this conversation is with, when it is not the assistant. A
   * direct chat runs in that agent's voice, with its memory and its provider,
   * like a direct message in a company chat.
   */
  agentId?: string;
  /** Job title of that agent, shown next to its name in the status line. */
  agentTitle?: string;
  /** Who is being talked to: an agent's slug, or the assistant's name. */
  counterpart: string;
  provider: ProviderId;
  model: string | undefined;
  /** Reasoning effort; undefined leaves the provider's own default. */
  effort: EffortLevel | undefined;
  permission: PermissionLevel;
  /** Context size the provider reported on the newest answer, for the gauge. */
  contextTokens?: number;
  contextWindow?: number;
  /** Tokens and cost across the whole conversation. */
  usage: SessionUsage;
  /** The account's own limit windows, when the provider reported them. */
  quota?: ProviderQuota;
  /** Project this conversation is about; assignments default to it. */
  projectId?: string;
  projectName?: string;
  voice: boolean;
  verbose: boolean;
}
