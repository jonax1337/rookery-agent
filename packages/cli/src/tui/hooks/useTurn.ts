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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TurnBlocks } from '@rookery/core';
import type { Assistant, AssignInput, ChatInput } from '@rookery/core';
import type { AgentEvent, AssignmentView, ProviderQuota, TurnUsage } from '@rookery/core';
import { glyph, ui } from '../theme.js';
import { shortId, shorten } from '../../ui/render.js';
import { amendLastAssistant, segmentEntries } from '../history.js';
import { blockSegments, memoryText, speakerName, statusText } from '../types.js';
import type {
  AssignmentsState,
  AssignmentsSummary,
  BlockSegment,
  Entry,
  LiveBlock,
  NoteActivity,
  SessionState,
  ToolTiming,
} from '../types.js';
import { createCoalescer } from './coalescer.js';

/** Widths the dim side-channel lines are cut to. */
const TASK_TITLE_WIDTH = 60;
const NOTE_WIDTH = 90;
const ANSWER_WIDTH = 80;

/** What an interrupted turn that said nothing shows in its place. */
const NO_OUTPUT = '(no output)';

/** A question the assistant asked, exactly as core streamed it. */
export type OpenQuestion = Extract<AgentEvent, { type: 'question' }>;

export interface LiveTurn {
  busy: boolean;
  /** Streamed assistant text for the turn in flight. */
  text: string;
  /** The ordered transcript: text, thinking, tools and notes interleaved. */
  blocks: LiveBlocks;
  assignments: AssignmentsState | null;
  /**
   * The question the turn is blocked on, while one is open. The turn keeps
   * running - `busy` stays true - it is simply waiting for a person, so the
   * app puts the answer surface where the input box normally sits.
   */
  question: OpenQuestion | null;
  /** Status-bar verb: 'thinking' or 'delegating'. */
  label: string;
  startedAt: number | null;
}

/**
 * The ordered transcript of a running turn, on top of core's `TurnBlocks`.
 *
 * Core folds the text, thinking and tool events - including the start/end
 * merge and the clips. What it cannot know about are this client's
 * side-channel notes, so those are slotted in by arrival: a note remembers
 * how many core blocks existed when it happened and is replayed right there,
 * before whichever block arrives next.
 */
export class LiveBlocks {
  readonly #acc = new TurnBlocks();
  readonly #slots: NoteActivity[][] = [];
  readonly #toolTimes: ToolTiming[] = [];

  /** The transcript so far, core blocks with notes interleaved. Fresh array. */
  get blocks(): LiveBlock[] {
    const core = this.#acc.blocks;
    const out: LiveBlock[] = [];
    for (let index = 0; index < core.length; index += 1) {
      for (const note of this.#slots[index] ?? []) out.push({ type: 'note', note });
      out.push(core[index]!);
    }
    for (const note of this.#slots[core.length] ?? []) out.push({ type: 'note', note });
    return out;
  }

  /** Wall-clock timing per tool block, in tool-block order. */
  get toolTimes(): ToolTiming[] {
    return this.#toolTimes;
  }

  /** Fold a side-channel note into the transcript where it happened. */
  pushNote(note: NoteActivity): void {
    const slot = this.#slots[this.#acc.blocks.length] ?? (this.#slots[this.#acc.blocks.length] = []);
    slot.push(note);
  }

  /** Fold one streaming event into the core transcript. */
  apply(event: AgentEvent): void {
    if (event.type !== 'tool') {
      this.#acc.apply(event);
      return;
    }

    // The accumulator hands out its live array, so the "before" view has to
    // be copied, not just referenced.
    const before = [...this.#acc.blocks];
    this.#acc.apply(event);
    this.#recordToolTiming(event, before, this.#acc.blocks);
  }

  /** The provider's final text, offered as a correction of what the deltas added up to. */
  reconcile(doneText: string): void {
    this.#acc.reconcile(doneText);
  }

  /**
   * Keep the timings in step with the tool blocks. Core appends a block per
   * start (and per unmatched end) and replaces the merged block in place on a
   * matched end, so the timing follows from which position holds a block
   * object that was not there before.
   */
  #recordToolTiming(
    event: Extract<AgentEvent, { type: 'tool' }>,
    before: LiveBlock[],
    after: LiveBlock[],
  ): void {
    if (after.length > before.length) {
      this.#toolTimes.push({
        startedAt: Date.now(),
        // A completion whose start never arrived took no measurable time.
        ...(event.status === 'end' ? { durationMs: 0 } : {}),
      });
      return;
    }

    const seen = new Set(before);
    const merged = after.findIndex((block) => block.type === 'tool' && !seen.has(block));
    if (merged < 0) return;

    const ordinal = after.slice(0, merged).filter((block) => block.type === 'tool').length;
    const timing = this.#toolTimes[ordinal];
    if (timing && timing.durationMs === undefined) {
      timing.durationMs = Date.now() - timing.startedAt;
    }
  }
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

type PushNote = (icon: string, text: string, color?: string) => void;

const IDLE: LiveTurn = {
  busy: false,
  text: '',
  blocks: new LiveBlocks(),
  assignments: null,
  question: null,
  label: 'thinking',
  startedAt: null,
};

function startingTurn(request: TurnRequest): LiveTurn {
  return {
    busy: true,
    text: '',
    blocks: new LiveBlocks(),
    assignments: null,
    question: null,
    label: request.kind === 'assign' ? 'delegating' : 'thinking',
    startedAt: Date.now(),
  };
}

export function useTurn({
  assistant,
  onCommit,
  onSession,
  onQuota,
  onFinish,
}: UseTurnOptions): TurnApi {
  const [live, setLive] = useState<LiveTurn>(IDLE);
  const draft = useRef<LiveTurn>(IDLE);
  const controller = useRef<AbortController | null>(null);
  const counter = useRef(0);

  const coalescer = useMemo(
    () =>
      createCoalescer(() => {
        setLive({
          ...draft.current,
          assignments: draft.current.assignments ? { ...draft.current.assignments } : null,
        });
      }),
    [],
  );

  // A live turn must not outlive the app: unmounting kills the child process.
  useEffect(
    () => () => {
      controller.current?.abort();
      coalescer.cancel();
    },
    [coalescer],
  );

  const pushNote = useCallback<PushNote>(
    (icon, text, color) => {
      counter.current += 1;
      const note: NoteActivity = {
        kind: 'note',
        id: 'a' + counter.current,
        icon,
        text,
        ...(color ? { color } : {}),
      };
      draft.current.blocks.pushNote(note);
      coalescer.schedule();
    },
    [coalescer],
  );

  const abort = useCallback(() => {
    controller.current?.abort();
  }, []);

  const agentSlug = useCallback(
    (agentId: string) => assistant.store.org.getAgent(agentId)?.slug ?? shortId(agentId),
    [assistant],
  );

  /** Feed the provider's events into the draft until the stream ends. */
  const consume = useCallback(
    async (request: TurnRequest, session: SessionState, signal: AbortSignal) => {
      let failed = false;
      let usage: TurnUsage | undefined;

      try {
        const stream =
          request.kind === 'assign'
            ? assistant.assign(assignInput(request, session, signal))
            : assistant.chat(chatInput(request, session, signal));

        for await (const event of stream) {
          if (event.type === 'session') onSession(event.sessionId);
          if (event.type === 'done') usage = event.usage;
          if (event.type === 'quota') onQuota?.(event.quota);
          if (event.type === 'error' && event.fatal && !signal.aborted) failed = true;
          applyEvent(draft, event, session.verbose, pushNote, agentSlug);
          coalescer.schedule();
        }
      } catch (error) {
        if (!signal.aborted) {
          failed = true;
          pushNote(glyph.fail, (error as Error).message, ui.danger);
        }
      }

      return { failed, usage };
    },
    [agentSlug, assistant, coalescer, onQuota, onSession, pushNote],
  );

  const run = useCallback(
    async (request: TurnRequest, session: SessionState, signal: AbortSignal) => {
      const { failed, usage } = await consume(request, session, signal);

      const aborted = signal.aborted;
      const finished = draft.current;
      const durationMs = Date.now() - (finished.startedAt ?? Date.now());

      onCommit(toEntries(finished, session, request, durationMs, aborted, counter, usage));

      controller.current = null;
      draft.current = IDLE;
      coalescer.flushNow();
      onFinish?.({ text: finished.text, aborted, failed, ...(usage ? { usage } : {}) });
    },
    [coalescer, consume, onCommit, onFinish],
  );

  const start = useCallback(
    (request: TurnRequest, session: SessionState) => {
      if (controller.current) return;

      const turn = new AbortController();
      controller.current = turn;
      draft.current = startingTurn(request);
      coalescer.flushNow();

      void run(request, session, turn.signal);
    },
    [coalescer, run],
  );

  return { ...live, start, abort };
}

/* ------------------------------- plumbing ------------------------------ */

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
  pushNote: PushNote,
  agentSlug: (agentId: string) => string = shortId,
): void {
  const live = draft.current;

  switch (event.type) {
    case 'text': {
      if (!event.delta) return;
      live.text += event.delta;
      live.blocks.apply(event);
      return;
    }

    case 'thinking': {
      // The transcript always carries thinking - it is what the turn actually
      // looked like. Whether it is ever shown is a rendering decision: the
      // live region, the scrollback and the history all dim it behind
      // `verbose`, exactly where the notes used to be.
      if (event.delta) live.blocks.apply(event);
      return;
    }

    case 'tool': {
      live.blocks.apply(event);
      return;
    }

    case 'memory': {
      pushNote(glyph.memory, memoryText(event.count, event.action === 'recalled' ? 'recalled' : 'stored'));
      return;
    }

    case 'status': {
      pushNote(glyph.status, statusText(event));
      return;
    }

    case 'assignment': {
      foldAssignment(live, event.assignment);
      return;
    }

    case 'task': {
      // The board is a side channel, exactly like the assignments: one line
      // saying what moved and where it stands.
      const task = event.task;
      const bits = [shorten(task.title, TASK_TITLE_WIDTH), task.status];
      if (task.assigneeId) bits.push(agentSlug(task.assigneeId));
      pushNote(glyph.task, bits.join(' ' + glyph.dot + ' '));
      return;
    }

    case 'message': {
      pushNote(glyph.message, shorten(event.message.content, NOTE_WIDTH));
      return;
    }

    case 'question': {
      // The surface below the scrollback is transient - it disappears the
      // moment the question closes - so the transcript gets the question as a
      // line of its own. What was asked is part of the conversation.
      live.question = event;
      pushNote(glyph.prompt, shorten(event.header + ' ' + glyph.dot + ' ' + event.question, NOTE_WIDTH));
      return;
    }

    case 'question-closed': {
      // The option labels only exist on the question itself, so they are read
      // off the open one before it is taken away. An answer that came in on
      // another channel closes the card here too - that is what this event is
      // for - and reads exactly like one given at this terminal.
      const asked = live.question?.id === event.id ? live.question : null;
      if (asked) live.question = null;
      const answered = event.reason === 'answered';
      pushNote(
        answered ? glyph.ok : glyph.warn,
        answerOutcome(event, asked),
        answered ? ui.muted : ui.warn,
      );
      return;
    }

    case 'error': {
      pushNote(glyph.fail, event.message, ui.danger);
      return;
    }

    case 'done': {
      if (event.text) live.text = event.text;
      live.blocks.reconcile(event.text);
      return;
    }

    default:
      // `quota` and `session` are the hook's business, not render state.
      return;
  }
}

/** Merge one re-sent assignment view into the turn's delegation state. */
function foldAssignment(live: LiveTurn, view: AssignmentView): void {
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
}

/**
 * The one line a closed question leaves in the transcript.
 *
 * A question that was answered says what was chosen, resolved back to the
 * labels the person actually saw; the indices alone would be unreadable a
 * screen later. Everything else says why the turn stopped waiting.
 */
export function answerOutcome(
  event: Extract<AgentEvent, { type: 'question-closed' }>,
  asked: OpenQuestion | null,
): string {
  if (event.reason === 'expired') return 'no answer — the question expired';
  if (event.reason === 'cancelled') return 'question cancelled';

  const answer = event.answer;
  const labels = (answer?.selected ?? []).map(
    (index) => asked?.options[index]?.label ?? 'option ' + (index + 1),
  );
  if (answer?.text) labels.push(answer.text);
  return labels.length ? 'answered ' + shorten(labels.join(', '), ANSWER_WIDTH) : 'answered';
}

/** Id prefixes of the entries a finished turn commits. */
const ENTRY_ID_PREFIX = { tools: 'k', thinking: 't', text: 'm', assignments: 'g' } as const;

function nextEntryId(prefix: string, counter: { current: number }): string {
  counter.current += 1;
  return prefix + counter.current;
}

/**
 * Everything a finished turn leaves in the scrollback, in order.
 *
 * The entries are computed once, from the final blocks, by the same
 * `blockSegments` walk the live region renders from - so what the reader saw
 * streaming is what stays: text where the model spoke, tool groups where it
 * worked, notes where something happened on the side. Speaker, duration and
 * usage belong to the answer as a whole, so they land on the last assistant
 * entry. `<Static>` is append-only: entries are never re-flowed afterwards.
 */
export function toEntries(
  live: LiveTurn,
  session: SessionState,
  request: TurnRequest,
  durationMs: number,
  aborted: boolean,
  counter: { current: number },
  usage: TurnUsage | undefined,
): Entry[] {
  // An assignment's output is the agent's report, not the assistant's voice;
  // a direct chat is the agent speaking for itself.
  const speaker = request.kind === 'assign' ? request.agent : speakerName(session);

  // A finished turn leaves no tool spinning: open calls close as done, or as
  // failed when the user interrupted them.
  const segments = blockSegments(live.blocks.blocks, {
    toolTimes: closeToolTimes(live.blocks.toolTimes),
    closed: aborted ? 'failed' : 'done',
  });

  const entries = segmentEntries(segments, {
    verbose: session.verbose,
    speaker,
    provider: session.provider,
    nextId: (segment: BlockSegment) =>
      segment.kind === 'note'
        ? 'e' + segment.note.id
        : nextEntryId(ENTRY_ID_PREFIX[segment.kind], counter),
  });

  const answerStats = {
    durationMs,
    ...(usage ? { usage } : {}),
    ...(aborted ? { aborted: true } : {}),
  };
  if (!amendLastAssistant(entries, answerStats)) {
    // No text segment at all: either the provider only reported a final text
    // (`done` without deltas - the accumulator never opened a block), or the
    // turn was interrupted before anything arrived.
    const text = live.text.trim();
    if (text || aborted) {
      entries.push({
        kind: 'assistant',
        id: nextEntryId(ENTRY_ID_PREFIX.text, counter),
        speaker,
        text: text || NO_OUTPUT,
        provider: session.provider,
        ...answerStats,
      });
    }
  }

  if (live.assignments && live.assignments.order.length) {
    entries.push({
      kind: 'assignments',
      id: nextEntryId(ENTRY_ID_PREFIX.assignments, counter),
      summary: summarise(live.assignments, durationMs),
    });
  }

  return entries;
}

/** Stamp a duration onto tool timings that never saw their end event. */
function closeToolTimes(times: ToolTiming[]): ToolTiming[] {
  const now = Date.now();
  return times.map((timing) =>
    timing.durationMs === undefined
      ? { ...timing, durationMs: Math.max(0, now - timing.startedAt) }
      : timing,
  );
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
