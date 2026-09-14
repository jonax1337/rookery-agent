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
import { SLASH_COMMANDS, commandWord } from '../dist/tui/hooks/useSlash.js';
import { applyEvent } from '../dist/tui/hooks/useTurn.js';
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

/* ------------------------- assignments: event wiring -------------------- */

const draft = {
  current: {
    busy: true,
    text: '',
    activities: [],
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
          wordmark: 'Rookery',
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
expect(scrollback, '█▀▄ █▀█ █▀█', 'the wordmark is set in the block face');
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
