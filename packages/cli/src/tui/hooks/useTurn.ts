/**
 * Running one turn and turning its `AgentEvent` stream into render state.
 *
 * Design notes:
 *  - One turn is one AbortController, exactly as in the line-based REPL, so
 *    Ctrl+C kills the provider child process rather than orphaning it.
 *  - Every mutation lands in a ref first and is committed to React state on a
 *    coalescing timer. A fast provider emits hundreds of text deltas a second
 *    and a setState per delta would spend the whole frame budget in the
 *    reconciler instead of in the terminal.
 *  - Nothing is written to the scrollback until the turn ends: activity lines
 *    and the reply must stay in the order they happened, and `<Static>` can
 *    only append.
 *  - A tool call is one record, not two events. Core sends `start` and `end`
 *    separately; they are folded together by id so the interface can show a
 *    row that changes state instead of two lines that have to be paired up by
 *    the reader.
 *  - Assignments are merged by id. Core re-sends the whole view on every
 *    change - handed out, running, a progress tick, done - so the reducer
 *    keeps the latest per id and remembers when each one started running.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Assistant, AssignInput, ChatInput } from '@rookery/core';
import type { AgentEvent, AssignmentView, ProviderQuota, TurnUsage } from '@rookery/core';
import { glyph, ui } from '../theme.js';
import { shorten } from '../../ui/render.js';
import { groupActivities } from '../types.js';
import type {
  Activity,
  AssignmentsState,
  AssignmentsSummary,
  Entry,
  SessionState,
  ToolActivity,
} from '../types.js';

/** How often live state is pushed into React, in milliseconds. */
const FLUSH_MS = 40;
/** Hard cap on live activity lines, so a chatty provider cannot blow up RAM. */
const MAX_ACTIVITIES = 500;
/** How much of a tool's argument summary is kept. Wrapping shows the rest. */
const MAX_TOOL_DETAIL = 400;

export interface LiveTurn {
  busy: boolean;
  /** Streamed assistant text for the turn in flight. */
  text: string;
  /** Tool calls and side-channel notes, in the order they happened. */
  activities: Activity[];
  assignments: AssignmentsState | null;
  /** Status-bar verb: 'thinking' or 'delegating'. */
  label: string;
  startedAt: number | null;
}

export type TurnRequest =
  | { kind: 'chat'; text: string }
  | { kind: 'assign'; agent: string; text: string; projectId?: string };

export interface TurnResult {
  text: string;
  aborted: boolean;
  failed: boolean;
  /** Token accounting of the turn, when the provider reported it. */
  usage?: TurnUsage;
}

export interface UseTurnOptions {
  assistant: Assistant;
  /** Append finished entries to the scrollback. */
  onCommit: (entries: Entry[]) => void;
  /** The runtime told us which session this turn belongs to. */
  onSession: (sessionId: string) => void;
  /** The provider reported the account's own limit windows mid-turn. */
  onQuota?: (quota: ProviderQuota) => void;
  onFinish?: (result: TurnResult) => void;
}

export interface TurnApi extends LiveTurn {
  start: (request: TurnRequest, session: SessionState) => void;
  abort: () => void;
}

const IDLE: LiveTurn = {
  busy: false,
  text: '',
  activities: [],
  assignments: null,
  label: 'thinking',
  startedAt: null,
};

export function useTurn({
  assistant,
  onCommit,
  onSession,
  onQuota,
  onFinish,
}: UseTurnOptions): TurnApi {
  const [live, setLive] = useState<LiveTurn>(IDLE);
  const draft = useRef<LiveTurn>(IDLE);
  const flushTimer = useRef<NodeJS.Timeout | null>(null);
  const controller = useRef<AbortController | null>(null);
  const counter = useRef(0);

  const commitDraft = useCallback(() => {
    flushTimer.current = null;
    setLive({
      ...draft.current,
      activities: draft.current.activities.slice(),
      assignments: draft.current.assignments ? { ...draft.current.assignments } : null,
    });
  }, []);

  const schedule = useCallback(() => {
    if (flushTimer.current) return;
    const timer = setTimeout(commitDraft, FLUSH_MS);
    timer.unref?.();
    flushTimer.current = timer;
  }, [commitDraft]);

  const flushNow = useCallback(() => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    commitDraft();
  }, [commitDraft]);

  // A live turn must not outlive the app: unmounting kills the child process.
  useEffect(
    () => () => {
      controller.current?.abort();
      if (flushTimer.current) clearTimeout(flushTimer.current);
    },
    [],
  );

  const pushActivity = useCallback(
    (icon: string, text: string, color?: string) => {
      counter.current += 1;
      const activity: Activity = color
        ? { kind: 'note', id: 'a' + counter.current, icon, text, color }
        : { kind: 'note', id: 'a' + counter.current, icon, text };
      draft.current.activities = capped([...draft.current.activities, activity]);
      schedule();
    },
    [schedule],
  );

  const abort = useCallback(() => {
    controller.current?.abort();
  }, []);

  const start = useCallback(
    (request: TurnRequest, session: SessionState) => {
      if (controller.current) return;

      const signal = new AbortController();
      controller.current = signal;

      draft.current = {
        busy: true,
        text: '',
        activities: [],
        assignments: null,
        label: request.kind === 'assign' ? 'delegating' : 'thinking',
        startedAt: Date.now(),
      };
      flushNow();

      void (async () => {
        let failed = false;
        let usage: TurnUsage | undefined;

        try {
          const stream =
            request.kind === 'assign'
              ? assistant.assign(assignInput(request, session, signal.signal))
              : assistant.chat(chatInput(request, session, signal.signal));

          for await (const event of stream) {
            if (event.type === 'session') onSession(event.sessionId);
            if (event.type === 'done') usage = event.usage;
            if (event.type === 'quota') onQuota?.(event.quota);
            if (event.type === 'error' && event.fatal && !signal.signal.aborted) failed = true;
            applyEvent(draft, event, session.verbose, pushActivity, (id) =>
              assistant.store.org.getAgent(id)?.slug ?? id.slice(0, 8),
            );
            schedule();
          }
        } catch (error) {
          if (!signal.signal.aborted) {
            failed = true;
            pushActivity(glyph.fail, (error as Error).message, ui.danger);
          }
        }

        const aborted = signal.signal.aborted;
        closeOpenTools(draft.current, aborted);
        const finished = draft.current;
        const durationMs = Date.now() - (finished.startedAt ?? Date.now());

        onCommit(toEntries(finished, session, request, durationMs, aborted, counter, usage));

        controller.current = null;
        draft.current = IDLE;
        flushNow();
        onFinish?.({ text: finished.text, aborted, failed, ...(usage ? { usage } : {}) });
      })();
    },
    [assistant, flushNow, onCommit, onFinish, onQuota, onSession, pushActivity, schedule],
  );

  return { ...live, start, abort };
}

/* ------------------------------- plumbing ------------------------------ */

function capped(activities: Activity[]): Activity[] {
  return activities.length > MAX_ACTIVITIES ? activities.slice(-MAX_ACTIVITIES) : activities;
}

function chatInput(
  request: Extract<TurnRequest, { kind: 'chat' }>,
  session: SessionState,
  signal: AbortSignal,
): ChatInput {
  return {
    text: request.text,
    sessionId: session.sessionId,
    provider: session.provider,
    model: session.model,
    effort: session.effort,
    permission: session.permission,
    projectId: session.projectId,
    // Only honoured for a new conversation; a resumed session keeps its own
    // counterpart, which core enforces rather than trusting the caller.
    agentId: session.agentId,
    voice: session.voice,
    signal,
  };
}

function assignInput(
  request: Extract<TurnRequest, { kind: 'assign' }>,
  session: SessionState,
  signal: AbortSignal,
): AssignInput {
  return {
    agent: request.agent,
    task: request.text,
    projectId: request.projectId ?? session.projectId,
    sessionId: session.sessionId,
    signal,
  };
}

/**
 * Fold one event into the live draft. Mutates in place; the caller flushes.
 * `agentSlug` turns an agent id into the handle a human recognises; it falls
 * back to a short id so the reducer stays usable without a store.
 */
export function applyEvent(
  draft: { current: LiveTurn },
  event: AgentEvent,
  verbose: boolean,
  pushActivity: (icon: string, text: string, color?: string) => void,
  agentSlug: (agentId: string) => string = (id) => id.slice(0, 8),
): void {
  const live = draft.current;

  switch (event.type) {
    case 'text': {
      if (!event.delta) return;
      live.text += event.delta;
      return;
    }

    case 'thinking': {
      if (!verbose) return;
      const line = event.delta.split('\n').map((part) => part.trim()).filter(Boolean).pop();
      if (line) pushActivity(glyph.thinking, shorten(line, 96));
      return;
    }

    case 'tool': {
      applyTool(live, event);
      return;
    }

    case 'memory': {
      const word = event.count === 1 ? 'memory' : 'memories';
      const verb = event.action === 'recalled' ? 'recalled' : 'stored';
      pushActivity(glyph.memory, event.count + ' ' + word + ' ' + verb);
      return;
    }

    case 'status': {
      pushActivity(
        glyph.status,
        event.label + (event.detail ? ' ' + glyph.dot + ' ' + event.detail : ''),
      );
      return;
    }

    case 'assignment': {
      const view = event.assignment;
      const state: AssignmentsState = live.assignments ?? {
        byId: {},
        order: [],
        startedAt: {},
        since: live.startedAt ?? Date.now(),
      };
      if (!state.byId[view.id]) state.order = [...state.order, view.id];
      if (view.status === 'running' && state.startedAt[view.id] === undefined) {
        state.startedAt = { ...state.startedAt, [view.id]: Date.now() };
      }
      state.byId = { ...state.byId, [view.id]: view };
      live.assignments = state;
      // The status bar says what the turn is actually doing: as long as an
      // agent is working somewhere, the assistant is delegating, not thinking.
      live.label = Object.values(state.byId).some((entry) => entry.status === 'running')
        ? 'delegating'
        : 'thinking';
      return;
    }

    case 'task': {
      // The board is a side channel, exactly like the assignments: one line
      // saying what moved and where it stands.
      const task = event.task;
      const bits = [shorten(task.title, 60), task.status];
      if (task.assigneeId) bits.push(agentSlug(task.assigneeId));
      pushActivity(glyph.task, bits.join(' ' + glyph.dot + ' '));
      return;
    }

    case 'message': {
      pushActivity(glyph.message, shorten(event.message.content, 90));
      return;
    }

    case 'error': {
      pushActivity(glyph.fail, event.message, ui.danger);
      return;
    }

    case 'done': {
      if (event.text) live.text = event.text;
      return;
    }

    case 'quota':
    case 'session':
    default:
      return;
  }
}

/**
 * Fold a `tool` event into the row it belongs to.
 *
 * `start` opens a row; `end` closes the newest still-open row with that id.
 * An `end` whose `start` was never seen - a provider that only reports
 * completions - opens and closes a row in one go, so the call is still shown.
 */
function applyTool(live: LiveTurn, event: Extract<AgentEvent, { type: 'tool' }>): void {
  const id = event.id ?? event.name + ':' + live.activities.length;

  if (event.status === 'start') {
    const call: ToolActivity = {
      kind: 'tool',
      id,
      name: event.name,
      status: 'running',
      startedAt: Date.now(),
      ...(event.detail ? { detail: event.detail.slice(0, MAX_TOOL_DETAIL) } : {}),
    };
    live.activities = capped([...live.activities, call]);
    return;
  }

  const open = findOpenTool(live.activities, id);
  if (!open) {
    const now = Date.now();
    live.activities = capped([
      ...live.activities,
      {
        kind: 'tool',
        id,
        name: event.name,
        status: 'done',
        startedAt: now,
        durationMs: 0,
        ...(event.detail ? { detail: event.detail.slice(0, MAX_TOOL_DETAIL) } : {}),
      },
    ]);
    return;
  }

  // The row is replaced rather than mutated: the committed React state holds
  // the same objects, and mutating them would change the past silently.
  live.activities = live.activities.map((activity) =>
    activity === open
      ? {
          ...open,
          status: 'done' as const,
          durationMs: Date.now() - open.startedAt,
          // An `end` that carries a better summary than the `start` wins.
          ...(event.detail ? { detail: event.detail.slice(0, MAX_TOOL_DETAIL) } : {}),
        }
      : activity,
  );
}

function findOpenTool(activities: Activity[], id: string): ToolActivity | undefined {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.kind === 'tool' && activity.id === id && activity.status === 'running') {
      return activity;
    }
  }
  return undefined;
}

/**
 * A turn that ends leaves no tool spinning.
 *
 * An interrupted turn marks them failed - that is what happened to them - and
 * a clean end marks them done, because a provider that closes its stream has
 * finished whatever it was doing.
 */
function closeOpenTools(live: LiveTurn, aborted: boolean): void {
  const open = live.activities.some(
    (activity) => activity.kind === 'tool' && activity.status === 'running',
  );
  if (!open) return;

  const now = Date.now();
  live.activities = live.activities.map((activity) =>
    activity.kind === 'tool' && activity.status === 'running'
      ? {
          ...activity,
          status: aborted ? ('failed' as const) : ('done' as const),
          durationMs: now - activity.startedAt,
        }
      : activity,
  );
}

/**
 * Everything a finished turn leaves in the scrollback, in order.
 *
 * Consecutive tool calls collapse into one `tools` entry. That is what turns a
 * ribbon of unrelated lines into a block a reader can take in at a glance -
 * and it is the only place the grouping can happen, because `<Static>` renders
 * each entry on its own and cannot see its neighbours.
 */
function toEntries(
  live: LiveTurn,
  session: SessionState,
  request: TurnRequest,
  durationMs: number,
  aborted: boolean,
  counter: { current: number },
  usage: TurnUsage | undefined,
): Entry[] {
  const entries: Entry[] = [];

  for (const group of groupActivities(live.activities)) {
    if (group.kind === 'tools') {
      counter.current += 1;
      entries.push({ kind: 'tools', id: 'k' + counter.current, calls: group.calls });
      continue;
    }
    const note = group.note;
    entries.push({
      kind: 'activity',
      id: 'e' + note.id,
      icon: note.icon,
      text: note.text,
      ...(note.color ? { color: note.color } : {}),
    });
  }

  if (live.assignments && live.assignments.order.length) {
    counter.current += 1;
    entries.push({
      kind: 'assignments',
      id: 'g' + counter.current,
      summary: summarise(live.assignments, durationMs),
    });
  }

  const text = live.text.trim();
  if (text || aborted) {
    counter.current += 1;
    entries.push({
      kind: 'assistant',
      id: 'm' + counter.current,
      // An assignment's output is the agent's report, not the assistant's
      // voice; a direct chat is the agent speaking for itself.
      speaker:
        request.kind === 'assign' ? request.agent : session.counterpart || session.assistantName,
      text: text || '(no output)',
      provider: session.provider,
      durationMs,
      ...(usage ? { usage } : {}),
      ...(aborted ? { aborted: true } : {}),
    });
  }

  return entries;
}

function summarise(state: AssignmentsState, durationMs: number): AssignmentsSummary {
  const assignments = state.order
    .map((id) => state.byId[id])
    .filter((view): view is AssignmentView => Boolean(view));
  return {
    total: assignments.length,
    done: assignments.filter((view) => view.status === 'done').length,
    failed: assignments.filter((view) => view.status === 'failed').length,
    durationMs,
    assignments,
  };
}
