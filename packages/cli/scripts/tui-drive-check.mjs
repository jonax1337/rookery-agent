#!/usr/bin/env node
/**
 * Drive the real Ink app through fake TTY streams.
 *
 * `tui-render-check.mjs` proves each component renders; this proves the app
 * actually runs: it mounts `<App>` with `render()`, feeds real keystrokes into
 * a stdin that claims to be a TTY, and asserts on what lands on stdout -
 * including the slash palette, Tab completion, a streamed chat turn, Ctrl+C
 * aborting that turn, a delegated `/assign`, and Ctrl+C at an idle prompt
 * exiting.
 *
 * The assistant is stubbed so nothing is spawned, nothing is billed and no
 * session or memory is written to ~/.rookery.
 *
 * Run: node packages/cli/scripts/tui-drive-check.mjs
 */

import { PassThrough } from 'node:stream';
import { createElement as h } from 'react';
import { render } from 'ink';

import { App } from '../dist/tui/App.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;?]*[a-zA-Z]', 'g');
const CTRL_C = String.fromCharCode(3);
const CR = String.fromCharCode(13);
/** Strip the escapes and carriage returns so a captured frame prints as text. */
const clean = (text) => text.replace(ANSI, '').split(CR).join('');

/** The last `count` lines of a capture that actually carry ink. */
const preview = (text, count) =>
  text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .slice(-count)
    .join('\n');

let failures = 0;
let checks = 0;

function expect(haystack, needle, label) {
  checks += 1;
  const ok = haystack.includes(needle);
  if (!ok) failures += 1;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + '   [' + needle + ']');
}

function refute(haystack, needle, label) {
  checks += 1;
  const ok = !haystack.includes(needle);
  if (!ok) failures += 1;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + '   [not: ' + needle + ']');
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* --------------------------- fake TTY streams --------------------------- */

function fakeStdout() {
  const chunks = [];
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.columns = 96;
  stream.rows = 40;
  stream.on('data', (chunk) => chunks.push(chunk.toString('utf8')));
  stream.readAll = () => clean(chunks.join(''));
  stream.since = (mark) => clean(chunks.slice(mark).join(''));
  stream.mark = () => chunks.length;
  // Ink rewrites the whole frame each time, so the last chunk is the last frame.
  stream.lastFrame = () => clean(chunks[chunks.length - 1] ?? '');
  return stream;
}

/**
 * Ink 7 reads stdin with `addListener('readable')` + `read()`, so this has to
 * be a real paused Readable, not a bare EventEmitter that fakes 'data'.
 */
function fakeStdin() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.setRawMode = () => stream;
  stream.ref = () => stream;
  stream.unref = () => stream;
  return stream;
}

/* ------------------------------ stub runtime ---------------------------- */

const ORGANIZATION = { id: 'org-1', name: 'Jarvis & Co.', createdAt: 0, updatedAt: 0 };

const AGENTS = [
  {
    id: 'ag-1',
    orgId: ORGANIZATION.id,
    slug: 'backend-dev',
    name: 'Ada',
    title: 'Backend Engineer',
    instructions: 'Write the server side.',
    archived: false,
  },
  {
    id: 'ag-2',
    orgId: ORGANIZATION.id,
    slug: 'ink-researcher',
    name: 'Grace',
    title: 'Terminal Researcher',
    instructions: 'Read the Ink source.',
    archived: false,
  },
];

/** One assignment view, exactly as core sends it. */
const view = (extra) => ({
  agentId: 'ag-1',
  agentSlug: 'backend-dev',
  agentName: 'Ada',
  task: 'rebuild the terminal',
  depth: 0,
  ...extra,
});

/** One board entry, exactly as core shapes it. */
const task = (extra) => ({
  id: 'tk-000001',
  orgId: ORGANIZATION.id,
  title: 'Rebuild the terminal',
  description: 'Rebuild the terminal',
  status: 'open',
  priority: 'normal',
  createdBy: 'user',
  dependsOn: [],
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

/** Everything `/task` writes lands here, so `/tasks` can read it back. */
const BOARD = [];

const orgStore = {
  listAgents: () => AGENTS,
  getAgent: (id) => AGENTS.find((agent) => agent.id === id) ?? null,
  findAgent: (_orgId, ref) =>
    AGENTS.find((agent) => agent.id === ref || agent.slug === ref || agent.name === ref) ?? null,
  listTeams: () => [],
  listProjects: () => [],
  findProject: () => null,
  getProject: () => null,
  listAssignments: () => [],
  listMessages: () => [],
  inbox: () => [],
  listTasks: (_orgId, options = {}) =>
    options.parentId === undefined ? BOARD : BOARD.filter((entry) => entry.parentId === options.parentId),
  createTask: (input) => {
    const created = task({ id: 'tk-00000' + (BOARD.length + 1), ...input });
    BOARD.push(created);
    return created;
  },
};

const assistant = {
  getSession: () => ({ title: 'Driven session', provider: 'claude' }),
  rememberFact: () => ({ id: 'stub0000' }),
  org: {
    activeOrganization: () => ORGANIZATION,
    snapshot: () => ({
      organization: ORGANIZATION,
      teams: [],
      agents: AGENTS,
      projects: [],
      active: [],
    }),
  },
  store: {
    listSessions: () => [],
    listMemories: () => [],
    getMemory: () => null,
    forgetMemory: () => {},
    org: orgStore,
  },
  providers: {
    statuses: async () => [
      { id: 'claude', available: true, authenticated: true, version: '2.0.0', binary: 'claude' },
    ],
  },
  async *chat() {
    yield { type: 'session', sessionId: 'drive-0001', provider: 'claude' };
    yield { type: 'tool', name: 'Read', status: 'start', detail: 'src/repl.ts' };
    // The assistant putting something on the board mid-turn: a side channel,
    // rendered as one activity line rather than inside the answer.
    yield { type: 'task', task: task({ status: 'planned', assigneeId: 'ag-1' }) };
    for (const delta of ['Ink ', 'replaces ', 'readline.']) {
      yield { type: 'text', delta };
      await wait(220);
    }
    yield { type: 'done', text: 'Ink replaces readline.' };
  },
  async *assign() {
    yield { type: 'assignment', assignment: view({ id: 'as1', status: 'pending' }) };
    yield {
      type: 'assignment',
      assignment: view({ id: 'as1', status: 'running', provider: 'claude' }),
    };
    yield {
      type: 'assignment',
      assignment: view({
        id: 'as1',
        status: 'running',
        provider: 'claude',
        chars: 1840,
        preview: 'readline owns the prompt',
      }),
    };
    await wait(1200);
    yield {
      type: 'assignment',
      assignment: view({ id: 'as1', status: 'done', chars: 2100, durationMs: 1200 }),
    };
    yield { type: 'done', text: 'The terminal is rebuilt.' };
  },
};

const config = { voice: { lang: 'en-US', rate: 1, voiceName: '' } };

const initial = {
  sessionId: undefined,
  title: 'New conversation',
  assistantName: 'jarvis',
  agentId: undefined,
  agentTitle: undefined,
  counterpart: 'jarvis',
  provider: 'claude',
  model: undefined,
  permission: 'read',
  projectId: undefined,
  projectName: undefined,
  voice: false,
  verbose: false,
};

/* --------------------------------- drive -------------------------------- */

const stdout = fakeStdout();
const stdin = fakeStdin();

const instance = render(
  h(App, { assistant, config, initial, initialEntries: [] }),
  { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true },
);

const guard = setTimeout(() => {
  console.error('\n  FAIL  the driver hung; unmounting');
  failures += 1;
  instance.unmount();
}, 30_000);
guard.unref?.();

await wait(200);

/* 1. the idle frame */
let frame = stdout.readAll();
console.log('\n--- idle frame ------------------------------------------------');
console.log(preview(frame, 8));
expect(frame, 'jarvis', 'status line shows the assistant');
expect(frame, 'CLAUDE', 'status line shows the provider badge');
expect(frame, 'read', 'status line shows the permission level');
expect(frame, 'Ask anything, or / for commands', 'input box placeholder');
expect(frame, 'Ctrl+D exit', 'hint line');

/* 2. typing `/hel` opens the palette */
let mark = stdout.mark();
stdin.write('/hel');
await wait(200);
frame = stdout.since(mark);
console.log('\n--- after typing "/hel" ---------------------------------------');
console.log(preview(frame, 6));
expect(frame, '/help', 'palette lists /help');
expect(frame, 'Organization commands and roles', 'palette shows the description');
expect(frame, 'Tab complete', 'palette hint');

/* 3. Tab completes it */
mark = stdout.mark();
stdin.write('\t');
await wait(200);
frame = stdout.since(mark);
expect(frame, '/help', 'Tab completed the command into the buffer');

/* 4. Enter runs it */
mark = stdout.mark();
stdin.write('\r');
await wait(400);
frame = stdout.since(mark);
console.log('\n--- after Enter on /help --------------------------------------');
console.log(preview(frame, 14));
expect(frame, 'Commands', '/help printed the command list');
expect(frame, '/permission', '/help lists every command');
expect(frame, '/assign', '/help lists the company commands');

/* 5. a chat turn streams, then Ctrl+C aborts it */
mark = stdout.mark();
stdin.write('does this stream');
await wait(150);
stdin.write('\r');
await wait(450);
frame = stdout.since(mark);
console.log('\n--- mid-stream ------------------------------------------------');
console.log(preview(frame, 10));
expect(frame, 'does this stream', 'the user turn is echoed into the scrollback');
expect(frame, 'Read src/repl.ts', 'the tool activity line appears while streaming');
expect(frame, 'Rebuild the terminal', 'a task event appears as an activity line');
expect(frame, 'backend-dev', 'the task line names the assignee by slug');
expect(frame, 'Ink ', 'assistant text streams in');
expect(frame, 'thinking', 'the status line switches to the running label');

mark = stdout.mark();
stdin.write(CTRL_C);
await wait(500);
frame = stdout.since(mark);
console.log('\n--- after Ctrl+C during the turn -------------------------------');
console.log(preview(frame, 8));
expect(frame, 'cancelled', 'the aborted turn is marked interrupted');
expect(frame, 'ready', 'the status line returns to idle');
refute(stdout.lastFrame(), 'thinking', 'the spinner is gone from the final frame');

/* 6. /assign renders the live assignment rows */
mark = stdout.mark();
stdin.write('/assign backend-dev rebuild the terminal');
await wait(150);
stdin.write('\r');
await wait(400);
frame = stdout.since(mark);
console.log('\n--- /assign, live ---------------------------------------------');
console.log(preview(frame, 12));
expect(frame, 'backend-dev', 'the row names the agent');
expect(frame, 'rebuild the terminal', 'the row shows the task');
expect(frame, 'delegating', 'the block headline');
expect(frame, 'delegating', 'the status line label while an agent works');
await wait(1400);

/* 7. the board: put something on it, then read it back */
mark = stdout.mark();
stdin.write('/task Write the release notes');
await wait(150);
stdin.write('\r');
await wait(300);
frame = stdout.since(mark);
console.log('\n--- /task -----------------------------------------------------');
console.log(preview(frame, 6));
expect(frame, 'task tk-00000', '/task reports the new board entry');
expect(frame, 'Write the release notes', '/task echoes the title');

mark = stdout.mark();
stdin.write('/tasks');
await wait(150);
stdin.write('\r');
await wait(300);
frame = stdout.since(mark);
console.log('\n--- /tasks ----------------------------------------------------');
console.log(preview(frame, 6));
expect(frame, 'OPEN', '/tasks renders the board');
expect(frame, 'Write the release notes', '/tasks lists the task that was just added');

/* 8. /talk switches the counterpart and starts a new conversation */
mark = stdout.mark();
stdin.write('/talk backend-dev');
await wait(150);
stdin.write('\r');
await wait(300);
frame = stdout.since(mark);
console.log('\n--- /talk backend-dev -----------------------------------------');
console.log(preview(frame, 6));
expect(frame, 'talking to Ada, Backend Engineer', '/talk names the agent and its role');
expect(frame, 'backend-dev', 'the status line shows the new counterpart');
expect(frame, 'Backend Engineer', 'the status line shows the job title');

mark = stdout.mark();
stdin.write('/talk assistant');
await wait(150);
stdin.write('\r');
await wait(300);
frame = stdout.since(mark);
expect(frame, 'talking to jarvis', '/talk assistant hands the floor back');
// The idle status line, which only reads this way once the counterpart is the
// assistant again: while the agent held the floor it said "ready  backend-dev".
expect(frame, 'ready  jarvis', 'the status line is back to the assistant');

/* 9. Ctrl+C at an idle prompt leaves */
let exited = false;
instance.waitUntilExit().then(() => {
  exited = true;
});
stdin.write(CTRL_C);
await wait(600);

checks += 1;
if (exited) {
  console.log('  PASS  Ctrl+C at an idle prompt exits   [waitUntilExit resolved]');
} else {
  failures += 1;
  console.log('  FAIL  Ctrl+C at an idle prompt exits   [still running]');
  instance.unmount();
}

clearTimeout(guard);

console.log('\n' + '-'.repeat(64));
console.log('  ' + (checks - failures) + '/' + checks + ' checks passed');
console.log('-'.repeat(64) + '\n');
process.exit(failures ? 1 : 0);
