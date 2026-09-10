/**
 * The shapes the TUI renders.
 *
 * Everything below is plain data on purpose: the components are pure
 * functions of these props, which is what makes `renderToString` a usable
 * test harness (see `scripts/tui-render-check.mjs`).
 */

import type { AssignmentView, EffortLevel, PermissionLevel, ProviderId } from '@rookery/core';

/** One coloured line inside a `notice` entry. */
export interface NoticeLine {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

/** A finished item in the scrollback. Entries are append-only. */
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
    }
  | { kind: 'activity'; id: string; icon: string; text: string; color?: string }
  | { kind: 'notice'; id: string; lines: NoticeLine[] }
  | { kind: 'assignments'; id: string; summary: AssignmentsSummary };

/** A live activity line for the turn that is running right now. */
export interface Activity {
  id: string;
  icon: string;
  text: string;
  color?: string;
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
  /** Context size the provider reported on the newest answer, for the status line. */
  contextTokens?: number;
  contextWindow?: number;
  /** Project this conversation is about; assignments default to it. */
  projectId?: string;
  projectName?: string;
  voice: boolean;
  verbose: boolean;
}
