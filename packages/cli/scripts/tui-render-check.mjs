#!/usr/bin/env node
/**
 * Render check for the Ink TUI.
 *
 * The TUI cannot be driven from a pipe - Ink needs a TTY - so this renders the
 * component tree to a string with Ink's own `renderToString` and asserts on
 * what comes out. Every component is a pure function of props, and the live
 * assignment state is built by feeding real `assignment` events through the
 * same `applyEvent` reducer the app uses, so this exercises the actual render
 * path rather than a parallel mock of it.
 *
 * Run: node packages/cli/scripts/tui-render-check.mjs
 */

import { createElement as h } from 'react';
import { Box, renderToString } from 'ink';
import { ThemeProvider } from '@inkjs/ui';

import { StatusLine } from '../dist/tui/components/StatusLine.js';
import { InputBox } from '../dist/tui/components/InputBox.js';
import { SlashPalette } from '../dist/tui/components/SlashPalette.js';
import { Scrollback } from '../dist/tui/components/Scrollback.js';
import { AssignmentsView } from '../dist/tui/components/AssignmentsView.js';
import { QuestionView } from '../dist/tui/components/QuestionView.js';
import { WatchView } from '../dist/tui/components/WatchView.js';
import { parseAnswer } from '../dist/repl.js';
import { SLASH_COMMANDS, commandWord } from '../dist/tui/hooks/useSlash.js';
import { applyEvent, LiveBlocks, toEntries } from '../dist/tui/hooks/useTurn.js';
import { foldWatchEvent } from '../dist/tui/hooks/useWatch.js';
import { historyEntries } from '../dist/tui/history.js';
import { inkUiTheme } from '../dist/tui/inkTheme.js';
import { cachedModelCatalogue, modelName, prettifyModelId } from '../dist/ui/modelNames.js';

/** Render a component the way the app does: under the branded ink-ui theme. */
function themed(node) {
  return h(ThemeProvider, { theme: inkUiTheme }, node);
}

const COLUMNS = 96;
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*m', 'g');

let failures = 0;
let checks = 0;

function strip(text) {
  return text.replace(ANSI, '');
}

function show(title, output) {
  const rule = '─'.repeat(COLUMNS);
  console.log('\n' + rule);
  console.log('  ' + title);
  console.log(rule);
  console.log(output);
}

function expect(output, needle, label) {
  checks += 1;
  const ok = strip(output).includes(needle);
  if (!ok) failures += 1;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + '   [' + needle + ']');
}

/** The inverse: the output must NOT carry this text. */
function refute(output, needle, label) {
  checks += 1;
  const ok = !strip(output).includes(needle);
  if (!ok) failures += 1;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + '   [not: ' + needle + ']');
}
/* ------------------------------ status line ----------------------------- */

const statusIdle = renderToString(
  themed(
    h(StatusLine, {
      assistantName: 'jarvis',
      provider: 'claude',
      model: 'sonnet',
      permission: 'write',
      title: 'Rewire the CLI terminal',
      project: 'Rookery',
      sessionId: '2f9c41ab-0000-4000-8000-000000000000',
      busy: false,
      elapsedMs: 0,
      columns: COLUMNS,
      contextTokens: 96400,
      contextWindow: 200000,
      usage: {
        inputTokens: 128400,
        outputTokens: 9120,
        cachedInputTokens: 41000,
        reasoningTokens: 0,
        costUsd: 0.42,
        turns: 6,
      },
      quota: {
        provider: 'claude',
        windows: [{ kind: 'five_hour', label: '5 hr', percent: 42 }],
        fetchedAt: Date.now(),
      },
    }),
  ),
  { columns: COLUMNS },
);

const statusBusy = renderToString(
  themed(
    h(StatusLine, {
      assistantName: 'jarvis',
      provider: 'codex',
      permission: 'full',
      title: 'Rewire the CLI terminal',
      busy: true,
      elapsedMs: 7400,
      label: 'delegating',
      columns: COLUMNS,
      voice: true,
      verbose: true,
    }),
  ),
  { columns: COLUMNS },
);

show('StatusLine - idle', statusIdle);
expect(statusIdle, 'jarvis', 'assistant name');
expect(statusIdle, 'CLAUDE', 'provider badge');
expect(statusIdle, 'sonnet', 'model');
expect(statusIdle, 'write', 'permission level');
expect(statusIdle, 'Rookery', 'active project');
expect(statusIdle, 'Rewire the CLI terminal', 'session title');
expect(statusIdle, '2f9c41ab', 'session id');
expect(statusIdle, 'ready', 'idle marker');
expect(statusIdle, '96.4k/200k Context', 'context readout');
expect(statusIdle, '48%', 'context share of the window');
expect(statusIdle, '█', 'context gauge');
expect(statusIdle, '↑ 128k', 'input tokens spent');
expect(statusIdle, '↓ 9.1k', 'output tokens spent');
expect(statusIdle, '$0.42', 'what the conversation cost');
expect(statusIdle, '5 hr 42%', 'the account limit window');

show('StatusLine - running', statusBusy);
expect(statusBusy, 'delegating 7s', 'spinner label + elapsed seconds');
expect(statusBusy, '⠋', 'spinner frame');
expect(statusBusy, 'FULL', 'permission badge');
expect(statusBusy, 'Voice', 'voice flag');
expect(statusBusy, 'verbose', 'verbose flag');
refute(statusBusy, 'Context', 'a turn that reported nothing yet shows no meter row');

/* -------------------------------- input box ----------------------------- */

const inputEmpty = renderToString(
  h(InputBox, {
    value: '',
    cursor: 0,
    placeholder: 'Ask anything, or / for commands',
    hint: 'Enter send · Shift+Enter newline · / Commands · Ctrl+D exit',
  }),
  { columns: COLUMNS },
);

const inputMulti = renderToString(
  h(InputBox, {
    value: 'explain the plan\nthen write it up',
    cursor: 21,
    hint: 'Ctrl+C interrupts',
  }),
  { columns: COLUMNS },
);

show('InputBox - empty with placeholder', inputEmpty);
expect(inputEmpty, '╭', 'top border');
expect(inputEmpty, '╰', 'bottom border');
expect(inputEmpty, '❯', 'prompt marker');
expect(inputEmpty, 'Ask anything, or / for commands', 'placeholder');
expect(inputEmpty, 'Shift+Enter newline', 'hint line');

show('InputBox - two lines, caret on line 2', inputMulti);
expect(inputMulti, 'explain the plan', 'first line');
expect(inputMulti, 'then write it up', 'second line');
expect(inputMulti, '▌ then', 'continuation marker on line 2');
expect(inputMulti, 'Ctrl+C interrupts', 'busy hint');

/* ------------------------------ slash palette --------------------------- */

const typed = '/me';
const word = commandWord(typed, typed.length);
const matches = SLASH_COMMANDS.filter((command) => command.name.slice(1).startsWith(word.slice(1)));

const palette = renderToString(
  h(
    Box,
    { flexDirection: 'column' },
    h(InputBox, { value: typed, cursor: typed.length }),
    h(SlashPalette, { matches, selected: 0 }),
  ),
  { columns: COLUMNS },
);

const paletteAll = renderToString(
  h(SlashPalette, { matches: [...SLASH_COMMANDS], selected: 2, limit: 6 }),
  { columns: COLUMNS },
);

show('SlashPalette - filtered by "/me"', palette);
expect(palette, '/memory <query>', 'filtered command with args');
expect(palette, 'search long-term memory', 'command description');
expect(palette, 'Tab complete', 'palette hint');
checks += 1;
if (matches.length !== 1) {
  failures += 1;
  console.log('  FAIL  "/me" filters to exactly one command   [got ' + matches.length + ']');
} else {
  console.log('  PASS  "/me" filters to exactly one command   [/memory]');
}

show('SlashPalette - windowed list, third row selected', paletteAll);
expect(paletteAll, '/sessions', 'third command is highlighted row');
expect(paletteAll, 'more', 'overflow counter');

checks += 1;
if (SLASH_COMMANDS.some((command) => command.name === '/assign')) {
  console.log('  PASS  the catalogue offers /assign   [/assign]');
} else {
  failures += 1;
  console.log('  FAIL  the catalogue offers /assign   [missing]');
}

checks += 1;
if (SLASH_COMMANDS.some((command) => command.name === '/watch')) {
  console.log('  PASS  the catalogue offers /watch   [/watch]');
} else {
  failures += 1;
  console.log('  FAIL  the catalogue offers /watch   [missing]');
}

/* ------------------------- assignments: event wiring -------------------- */

const draft = {
  current: {
    busy: true,
    text: '',
    activities: [],
    blocks: new LiveBlocks(),
    assignments: null,
    label: 'thinking',
    startedAt: Date.now() - 21_000,
  },
};
const noop = () => {};

/** One `assignment` event, exactly as core sends it. */
const view = (extra) => ({
  type: 'assignment',
  assignment: {
    agentId: 'ag-1',
    agentSlug: 'backend-dev',
    agentName: 'Ada',
    task: 'Survey the existing REPL',
    depth: 0,
    ...extra,
  },
});

applyEvent(draft, view({ id: 'as1', status: 'pending' }), false, noop);
applyEvent(
  draft,
  view({
    id: 'as2',
    agentId: 'ag-2',
    agentSlug: 'ink-researcher',
    agentName: 'Grace',
    task: 'Inventory the Ink component API',
    status: 'pending',
  }),
  false,
  noop,
);

const pending = renderToString(
  h(AssignmentsView, { state: draft.current.assignments, frame: 0, now: Date.now() }),
  { columns: COLUMNS },
);
show('AssignmentsView - both just handed out', pending);
expect(pending, '2 assignments', 'headline count');
expect(pending, 'backend-dev', 'first agent slug');
expect(pending, 'ink-researcher', 'second agent slug');
expect(pending, 'Survey the existing REPL', 'first task');
expect(pending, 'pending', 'pending status');

/* Now stream a realistic burst of progress. */
applyEvent(draft, view({ id: 'as1', status: 'running', provider: 'claude' }), false, noop);
applyEvent(
  draft,
  view({
    id: 'as2',
    agentId: 'ag-2',
    agentSlug: 'ink-researcher',
    agentName: 'Grace',
    task: 'Inventory the Ink component API',
    status: 'running',
    provider: 'codex',
  }),
  false,
  noop,
);
applyEvent(
  draft,
  view({
    id: 'as1',
    status: 'running',
    provider: 'claude',
    chars: 1840,
    preview: 'readline owns the prompt, so the cursor math has to stay single line',
  }),
  false,
  noop,
);
applyEvent(
  draft,
  view({
    id: 'as3',
    agentId: 'ag-3',
    agentSlug: 'doc-writer',
    agentName: 'Kay',
    task: 'Write the migration notes',
    status: 'failed',
    depth: 1,
    parentId: 'as1',
    provider: 'claude',
    chars: 210,
    durationMs: 4100,
    error: 'provider exited with code 1',
  }),
  false,
  noop,
);

const live = renderToString(
  h(AssignmentsView, { state: draft.current.assignments, frame: 3, now: Date.now() }),
  { columns: COLUMNS },
);
show('AssignmentsView - live, mid-run', live);
expect(live, '⠸ backend-dev', 'spinner on the running assignment');
expect(live, '✗ doc-writer', 'cross on the failed assignment');
expect(live, '1.8k', 'growing character count');
expect(live, '4.1s', 'assignment duration');
expect(live, 'readline owns the prompt', 'dim preview line under the running assignment');
expect(live, 'provider exited with code 1', 'failure reason');
expect(live, '2 running', 'headline running count');
expect(live, '1 failed', 'headline failure count');
expect(live, '3 assignments', 'headline total');

checks += 1;
if (draft.current.label === 'delegating') {
  console.log('  PASS  the status label switches while agents work   [delegating]');
} else {
  failures += 1;
  console.log('  FAIL  the status label switches while agents work   [' + draft.current.label + ']');
}

/* The assistant's own answer streams underneath as ordinary text. */
applyEvent(draft, { type: 'text', delta: '## Findings\n\nThe REPL ' }, false, noop);
applyEvent(draft, { type: 'text', delta: 'is readline-bound.\n\n- one\n- two\n' }, false, noop);
applyEvent(draft, { type: 'text', delta: '\n```ts\nconst ok = true;\n```\n' }, false, noop);

const answering = renderToString(
  h(
    Box,
    { flexDirection: 'column' },
    h(AssignmentsView, { state: draft.current.assignments, frame: 0, now: Date.now() }),
    h(Scrollback, {
      inline: true,
      entries: [
        {
          kind: 'assistant',
          id: 'live',
          text: draft.current.text,
          speaker: 'jarvis',
          provider: 'claude',
        },
      ],
    }),
  ),
  { columns: COLUMNS },
);

show('AssignmentsView - rows above, the answer streaming below', answering);
expect(answering, 'delegating', 'the block keeps its headline while the answer streams');
expect(answering, 'Findings', 'markdown heading, set rather than echoed');
refute(answering, '# Findings', 'the heading does not keep its hashes');
expect(answering, '• one', 'markdown list');
expect(answering, 'const ok = true;', 'fenced code contents');
expect(answering, 'ts', 'code fence language label');
expect(answering, '▌ const ok = true;', 'code block gutter');

/* -------------------------------- scrollback ---------------------------- */

const scrollback = renderToString(
  themed(
    h(Scrollback, {
      inline: true,
    entries: [
      {
        kind: 'banner',
        id: 'b1',
        banner: {
          assistantName: 'jarvis',
          ready: ['claude', 'codex'],
          offline: [],
          provider: 'claude',
          model: 'sonnet',
          permission: 'write',
          project: 'Rookery',
        },
      },
      { kind: 'user', id: 'u1', text: 'rebuild the terminal as a TUI' },
      {
        kind: 'tools',
        id: 'k1',
        calls: [
          { id: 't1', name: 'Read', detail: 'src/repl.ts', status: 'done', startedAt: 0, durationMs: 120 },
          {
            id: 't2',
            name: 'Bash',
            detail: 'npm run build && node scripts/tui-render-check.mjs',
            status: 'done',
            startedAt: 0,
            durationMs: 8400,
          },
          { id: 't3', name: 'Edit', detail: 'src/tui/theme.ts', status: 'failed', startedAt: 0, durationMs: 300 },
        ],
      },
      { kind: 'activity', id: 'a2', icon: '⟲', text: '3 memories recalled' },
      {
        kind: 'assistant',
        id: 'm1',
        text: '# Plan\n\nSwap readline for Ink.\n\n1. add `ink`\n2. wire `App.tsx`\n',
        speaker: 'jarvis',
        provider: 'claude',
        durationMs: 12_300,
        usage: { inputTokens: 12_800, outputTokens: 840, costUsd: 0.0182 },
      },
      {
        kind: 'assignments',
        id: 'g1',
        summary: {
          total: 3,
          done: 2,
          failed: 1,
          durationMs: 31_800,
          assignments: [
            {
              id: 'as1',
              agentId: 'ag-1',
              agentSlug: 'backend-dev',
              agentName: 'Ada',
              task: 'Survey the existing REPL',
              status: 'done',
              depth: 0,
            },
            {
              id: 'as3',
              agentId: 'ag-3',
              agentSlug: 'doc-writer',
              agentName: 'Kay',
              task: 'Write the migration notes',
              status: 'failed',
              depth: 1,
            },
          ],
        },
      },
    ],
    }),
  ),
  { columns: COLUMNS },
);

show('Scrollback - a whole exchange', scrollback);
expect(scrollback, '❯ rebuild the terminal as a TUI', 'user turn');
expect(scrollback, '███   █████▀', 'the banner draws the Atrium mark');
expect(scrollback, '██▄█▄ ██▀██ ██▀██', 'the wordmark is set beside it, in lowercase');
expect(scrollback, 'claude + codex ready', 'the banner names the logged-in providers');
expect(scrollback, '⏺ Read src/repl.ts', 'a finished tool call');
expect(scrollback, '✗ Edit src/tui/theme.ts', 'a failed tool call');
expect(scrollback, 'npm run build && node scripts/tui-render-check.mjs', 'the full tool argument, not a truncation');
expect(scrollback, '8.4s', 'how long the tool call took');
expect(scrollback, '⟲ 3 memories recalled', 'memory activity line');
expect(scrollback, 'JARVIS', 'assistant header badge');
expect(scrollback, '↑12.8k ↓840', 'what the turn spent');
expect(scrollback, '12.3s', 'turn duration');
expect(scrollback, 'PLAN', 'assistant markdown heading');
expect(scrollback, '1. add', 'ordered list');
expect(scrollback, '3 assignments  ·  2 done  ·  1 failed  ·  31.8s', 'collapsed assignment summary');
expect(scrollback, 'doc-writer', 'the summary names each agent');

/* ------------------------ interleaved turn transcript -------------------- */

const interleave = {
  current: {
    busy: true,
    text: '',
    activities: [],
    blocks: new LiveBlocks(),
    assignments: null,
    label: 'thinking',
    startedAt: Date.now() - 6_000,
  },
};

// The hook pushes side-channel notes into both the activities and the
// transcript; this mirrors it so the walk sees what the app would see.
let interleaveNotes = 0;
const interleaveNote = (icon, text, color) => {
  interleaveNotes += 1;
  const note = { kind: 'note', id: 'a' + interleaveNotes, icon, text, ...(color ? { color } : {}) };
  interleave.current.activities.push(note);
  interleave.current.blocks.pushNote(note);
};

applyEvent(interleave, { type: 'text', delta: 'Reading the plan first.\n\n' }, false, interleaveNote);
applyEvent(interleave, { type: 'tool', name: 'Read', status: 'start', id: 't1', detail: 'docs/plan.md' }, false, interleaveNote);
applyEvent(interleave, { type: 'tool', name: 'Read', status: 'end', id: 't1' }, false, interleaveNote);
applyEvent(interleave, { type: 'status', label: 'provider switch', detail: 'claude -> codex' }, false, interleaveNote);
applyEvent(interleave, { type: 'tool', name: 'Bash', status: 'start', id: 't2', detail: 'npm run build' }, false, interleaveNote);
applyEvent(interleave, { type: 'tool', name: 'Bash', status: 'end', id: 't2', isError: true }, false, interleaveNote);
applyEvent(interleave, { type: 'text', delta: 'Done, with a failure in the middle.' }, false, interleaveNote);

const interleaveSession = {
  sessionId: undefined,
  title: 'Interleaving',
  assistantName: 'jarvis',
  counterpart: 'jarvis',
  provider: 'claude',
  model: undefined,
  effort: undefined,
  permission: 'write',
  usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
  voice: false,
  verbose: false,
};

const turnEntries = toEntries(
  interleave.current,
  interleaveSession,
  { kind: 'chat', text: 'go' },
  6_000,
  false,
  { current: 0 },
  { inputTokens: 1_200, outputTokens: 90, costUsd: 0.01 },
);

const interleaved = renderToString(
  themed(h(Scrollback, { inline: true, entries: turnEntries })),
  { columns: COLUMNS },
);

show('Scrollback - text, tools and notes interleaved', interleaved);
expect(interleaved, 'Reading the plan first', 'text segment before the tool group');
expect(interleaved, '⏺ Read docs/plan.md', 'finished tool call between the texts');
expect(interleaved, '✗ Bash npm run build', 'failed tool call');
expect(interleaved, 'provider switch · claude -> codex', 'side-channel note between the groups');
expect(interleaved, 'Done, with a failure in the middle', 'text segment after the tool group');
expect(interleaved, '↑1.2k ↓90', 'usage lands on the last assistant entry');

const flat = strip(interleaved);
const firstText = flat.indexOf('Reading the plan first');
const readTool = flat.indexOf('⏺ Read docs/plan.md');
const switchNote = flat.indexOf('provider switch');
const lastText = flat.indexOf('Done, with a failure in the middle');
check(firstText >= 0 && readTool > firstText, 'text precedes the tool group', firstText + ' < ' + readTool);
check(readTool >= 0 && switchNote > readTool, 'the note follows the tool group', readTool + ' < ' + switchNote);
check(switchNote >= 0 && lastText > switchNote, 'the trailing text keeps its arrival position', switchNote + ' < ' + lastText);
check(
  flat.split('JARVIS').length - 1 === 2,
  'each text segment is its own assistant entry',
  String(flat.split('JARVIS').length - 1),
);

/* -------------------------------- watch view ----------------------------- */

const watchBlocks = [
  { type: 'text', text: 'Surveying the REPL first.\n\n' },
  { type: 'tool', call: { type: 'tool', name: 'Grep', status: 'end', id: 'w1', detail: 'readline' } },
  { type: 'note', note: { kind: 'note', id: 'w2', icon: '‹', text: 'switching provider · quota' } },
  { type: 'thinking', text: 'The cursor math must stay single-line.' },
  { type: 'text', text: 'Halfway through.' },
  { type: 'tool', call: { type: 'tool', name: 'Bash', status: 'start', id: 'w3', detail: 'npm test' } },
];

const watchFeed = {
  state: {
    blocks: watchBlocks,
    toolTimes: [
      { startedAt: Date.now() - 1_400, durationMs: 1_400 },
      { startedAt: Date.now() - 700 },
    ],
    ended: false,
    startedAt: Date.now() - 9_000,
  },
  frame: 5,
  now: Date.now(),
};

const watchLive = renderToString(
  themed(h(WatchView, { assignmentId: 'a1b2c3d4e5f6', feed: watchFeed, verbose: true })),
  { columns: COLUMNS },
);

show('WatchView - a run in flight', watchLive);
expect(watchLive, 'watching a1b2c3d4', 'the header names the watched assignment');
expect(watchLive, 'Surveying the REPL first', 'text segment');
expect(watchLive, 'Grep readline', 'tool call between the texts');
expect(watchLive, 'switching provider', 'dim status note');
expect(watchLive, 'The cursor math must stay single-line', 'dim thinking line in verbose');
expect(watchLive, 'npm test', 'the call that is still running');
expect(watchLive, 'Esc leaves', 'how to leave the watch');

const watchPlain = strip(watchLive);
check(
  watchPlain.indexOf('Surveying the REPL first') < watchPlain.indexOf('Grep readline'),
  'the watch keeps the arrival order',
  'text < tool',
);

const watchDone = renderToString(
  themed(
    h(WatchView, {
      assignmentId: 'a1b2c3d4e5f6',
      feed: { state: { ...watchFeed.state, ended: true }, frame: 9, now: Date.now() },
      verbose: false,
    }),
  ),
  { columns: COLUMNS },
);

show('WatchView - the run has finished', watchDone);
expect(watchDone, 'run finished', 'end status');
expect(watchDone, 'Esc leaves', 'the exit hint stays');
refute(watchDone, 'The cursor math', 'thinking stays hidden without verbose');

const watchEmpty = renderToString(
  themed(
    h(WatchView, {
      assignmentId: 'a1b2c3d4e5f6',
      feed: { state: { blocks: [], toolTimes: [], ended: true, startedAt: Date.now() - 500 }, frame: 0, now: Date.now() },
      verbose: false,
    }),
  ),
  { columns: COLUMNS },
);

show('WatchView - nothing streamed', watchEmpty);
expect(watchEmpty, 'no live output', 'the empty watch explains itself rather than sitting blank');

/* ------------------------------ the question ----------------------------- */

const NOW = Date.now();

/** One `question` event, exactly as core sends it. */
const questionEvent = {
  type: 'question',
  id: 'q1',
  header: 'Deploy target',
  question: 'Which environment should this release go to?',
  options: [
    { label: 'staging', description: 'safe, nobody is on it' },
    { label: 'production', description: 'the live site' },
  ],
  multiSelect: false,
  expiresAt: NOW + 9 * 60_000,
};

const questionSingle = renderToString(
  themed(h(QuestionView, { question: questionEvent, now: NOW, onAnswer: () => {} })),
  { columns: COLUMNS },
);

show('QuestionView - a single-choice question', questionSingle);
expect(questionSingle, 'Deploy target', 'the header names what is being decided');
expect(questionSingle, 'Which environment should this release go to?', 'the question itself');
expect(questionSingle, 'staging', 'first option');
expect(questionSingle, 'safe, nobody is on it', 'the option description rides its label');
expect(questionSingle, '9m left', 'how long the turn keeps waiting');
expect(questionSingle, 'Enter answers', 'how to answer');
expect(questionSingle, 'Esc skips', 'how to decline');
refute(questionSingle, 'Space picks', 'a single-choice question does not offer Space');

const questionMulti = renderToString(
  themed(
    h(QuestionView, {
      question: { ...questionEvent, id: 'q2', multiSelect: true, expiresAt: NOW + 40_000 },
      now: NOW,
      onAnswer: () => {},
    }),
  ),
  { columns: COLUMNS },
);

show('QuestionView - several answers allowed', questionMulti);
expect(questionMulti, 'Space picks', 'a multi-select says how to pick more than one');
expect(questionMulti, '40s left', 'under a minute counts in seconds');

/* The reducer: a question opens the surface and the close takes it away. */
const asking = {
  current: {
    busy: true,
    text: '',
    activities: [],
    blocks: new LiveBlocks(),
    assignments: null,
    question: null,
    label: 'thinking',
    startedAt: NOW,
  },
};
const askNotes = [];
const askNote = (icon, text) => askNotes.push(icon + ' ' + text);

applyEvent(asking, questionEvent, false, askNote);
check(asking.current.question?.id === 'q1', 'a question opens the surface', String(asking.current.question?.id));
check(
  askNotes.some((line) => line.includes('Deploy target')),
  'the transcript keeps what was asked',
  JSON.stringify(askNotes),
);

applyEvent(
  asking,
  { type: 'question-closed', id: 'q1', reason: 'answered', answer: { selected: [1] } },
  false,
  askNote,
);
check(asking.current.question === null, 'the close takes the surface away', String(asking.current.question));
check(
  askNotes.some((line) => line.includes('answered production')),
  'the outcome resolves back to the label the person saw',
  JSON.stringify(askNotes),
);

/* A close for some other question must not clear the one on screen. */
applyEvent(asking, { ...questionEvent, id: 'q3' }, false, askNote);
applyEvent(asking, { type: 'question-closed', id: 'q-other', reason: 'expired' }, false, askNote);
check(
  asking.current.question?.id === 'q3',
  'a close for another id leaves this question standing',
  String(asking.current.question?.id),
);

/* ---------------------- the plain REPL's answer parser ------------------- */

check(
  JSON.stringify(parseAnswer('2', 3, false)) === JSON.stringify({ selected: [1] }),
  'a number picks the option with that ordinal',
  JSON.stringify(parseAnswer('2', 3, false)),
);
check(
  JSON.stringify(parseAnswer('3 1', 3, true)) === JSON.stringify({ selected: [0, 2] }),
  'a multi-select takes several numbers, in offer order',
  JSON.stringify(parseAnswer('3 1', 3, true)),
);
check(
  JSON.stringify(parseAnswer('3 1', 3, false)) === JSON.stringify({ selected: [2] }),
  'a single-choice question takes the first number and ignores the rest',
  JSON.stringify(parseAnswer('3 1', 3, false)),
);
check(
  parseAnswer('neither, use the sandbox', 3, false)?.text === 'neither, use the sandbox',
  'anything that is not an option index is a free answer',
  JSON.stringify(parseAnswer('neither, use the sandbox', 3, false)),
);
check(
  parseAnswer('9', 3, false)?.text === '9',
  'a number outside the list is text, not an out-of-range pick',
  JSON.stringify(parseAnswer('9', 3, false)),
);
check(parseAnswer('   ', 3, false) === null, 'a blank line declines rather than answering', 'null');

/* --------------------- the watch fold's provider seam -------------------- */

const seam = new LiveBlocks();
let seamNotes = 0;
const seamNote = () => 'sn' + (seamNotes += 1);
foldWatchEvent(seam, { type: 'text', delta: 'attempt one speaks' }, seamNote);
foldWatchEvent(seam, { type: 'error', message: 'usage limit reached', fatal: true }, seamNote);
foldWatchEvent(
  seam,
  { type: 'status', label: 'provider', detail: 'claude hit its usage limit, continuing on codex' },
  seamNote,
);
foldWatchEvent(seam, { type: 'text', delta: 'the retry answers' }, seamNote);
const seamKinds = seam.blocks.map((block) => block.type);
check(
  JSON.stringify(seamKinds) === JSON.stringify(['text', 'note', 'note', 'text']),
  'a provider switch ends the dead attempt with the notes between the two texts',
  JSON.stringify(seamKinds),
);
const seamTexts = seam.blocks.filter((block) => block.type === 'text').map((block) => block.text);
check(
  JSON.stringify(seamTexts) === JSON.stringify(['attempt one speaks', 'the retry answers']),
  'the retry never glues onto the attempt that died',
  JSON.stringify(seamTexts),
);

/* ---------------------- rehydrated history rendering --------------------- */

let historyIds = 0;
const rehydrated = historyEntries(
  [
    {
      // Pre-blocks row: the flat view kept a call's start beside its end.
      role: 'assistant',
      content: 'flat answer',
      toolCalls: [
        { type: 'tool', name: 'read', status: 'start', id: 't1', detail: 'notes.md' },
        { type: 'tool', name: 'tool', status: 'end', id: 't1', result: 'contents', isError: false },
      ],
    },
    {
      // A blocks row whose turn was interrupted mid-call.
      role: 'assistant',
      content: 'kept its open call',
      blocks: [
        { type: 'text', text: 'kept its open call' },
        { type: 'tool', call: { type: 'tool', name: 'read', status: 'start', id: 't2', detail: 'plan.md' } },
      ],
    },
  ],
  { verbose: false, assistantName: 'Rook', counterpart: 'Rook' },
  () => 'h' + (historyIds += 1),
);
const flatTools = rehydrated.find((entry) => entry.kind === 'tools');
check(
  flatTools?.calls.length === 1 &&
    flatTools.calls[0].name === 'read' &&
    flatTools.calls[0].status === 'done' &&
    flatTools.calls[0].id === 't1',
  'a pre-blocks row renders each call once, merged and settled',
  JSON.stringify(flatTools?.calls.map((call) => [call.id, call.name, call.status])),
);
const openTools = rehydrated.filter((entry) => entry.kind === 'tools')[1];
check(
  openTools?.calls.length === 1 && openTools.calls[0].status === 'done' && openTools.calls[0].name === 'read',
  'a tool an interrupted turn left open rehydrates as done, not spinning',
  JSON.stringify(openTools?.calls.map((call) => [call.name, call.status])),
);

/* ------------------------------ model names ----------------------------- */

function check(ok, label, detail) {
  checks += 1;
  if (ok) {
    console.log('  PASS  ' + label + '   [' + detail + ']');
  } else {
    failures += 1;
    console.log('  FAIL  ' + label + '   [' + detail + ']');
  }
}

const catalogue = {
  byProvider: { claude: { sonnet: 'Sonnet 5', opus: 'Opus 5.1' } },
  defaults: { claude: 'Sonnet 5' },
};

console.log('\n' + '─'.repeat(COLUMNS));
console.log('  Model names');
console.log('─'.repeat(COLUMNS));
check(modelName(catalogue, 'claude', 'sonnet') === 'Sonnet 5', 'catalogue id -> display name', 'Sonnet 5');
check(modelName(catalogue, 'claude', undefined) === 'Sonnet 5', 'no id pinned -> the account default', 'Sonnet 5');
check(modelName(catalogue, 'claude', 'brand-new') === 'Brand-new', 'unknown id -> prettified, not dropped', 'Brand-new');
check(modelName(catalogue, 'codex', undefined) === undefined, 'unknown provider -> no name invented', 'undefined');
check(prettifyModelId('gpt-5.2-codex') === 'GPT-5.2-codex', 'gpt prefix uppercased', 'GPT-5.2-codex');
check(
  cachedModelCatalogue('Z:\\no\\such\\home').byProvider.claude === undefined,
  'missing cache file -> empty catalogue, no throw',
  'empty',
);

/* ---------------------------------- result ------------------------------ */

console.log('\n' + '─'.repeat(COLUMNS));
console.log('  ' + (checks - failures) + '/' + checks + ' checks passed');
console.log('─'.repeat(COLUMNS) + '\n');
process.exit(failures ? 1 : 0);
