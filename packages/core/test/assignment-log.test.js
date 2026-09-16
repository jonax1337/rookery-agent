import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Assistant, ProviderRegistry, Store, rememberUsageRecovered } from '../dist/index.js';

/**
 * The live log of a running assignment: what a watcher can read while the
 * agent works, and what is left once the run is over. Nothing here talks to
 * a real CLI - the fake provider scripts the event sequence and pauses
 * mid-run, so snapshots, listeners and generators attach while the
 * assignment is in flight.
 *
 * Quota state is module-global per process and the switch test parks
 * `claude`, so it recovers the id first (see provider-fallback.test.js).
 */

const USAGE_FATAL = 'API Error: 429 You have reached your usage limit, please wait';
/** The ring buffer cap, mirrored from the controller to check the budget. */
const LOG_CAP_BYTES = 256 * 1024;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFake(id) {
  const runs = [];
  const provider = {
    id,
    displayName: 'Fake ' + id,
    models: () => ['fake'],
    async status() {
      return { id, available: true, binary: 'fake', authenticated: true };
    },
    async *run(opts) {
      runs.push(opts);
      const text = 'OUTPUT(' + (opts.prompt ?? '').slice(0, 40) + ')';
      yield { type: 'text', delta: text };
      yield { type: 'done', text };
    },
  };
  return { provider, runs };
}

/** Every assistant built by a test; closed at the end so a failed assertion cannot hang the run. */
const openAssistants = [];
after(() => {
  for (const assistant of openAssistants) {
    try {
      assistant.close();
    } catch {
      // already closed by the test
    }
  }
});

function createAssistant(providers, overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'rookery-assignment-log-'));
  mkdirSync(join(home, 'run'), { recursive: true });
  const assistant = new Assistant({
    store: new Store(':memory:'),
    registry: new ProviderRegistry(providers),
    config: {
      home,
      logLevel: 'silent',
      memory: { enabled: false, autoExtract: false },
      org: { autoReview: false },
      ...overrides,
    },
  });
  openAssistants.push(assistant);
  return { assistant, store: assistant.store };
}

function hire(assistant, input = {}) {
  const org = assistant.org.activeOrganization();
  return assistant.store.org.createAgent({ orgId: org.id, instructions: 'Do the work.', title: 'Engineer', ...input });
}

/** Wait until a running assignment shows up whose live log satisfies `ready`. */
async function waitForRunningLog(assistant, store, orgId, ready) {
  for (let i = 0; i < 200; i += 1) {
    const running = store.org.listAssignments(orgId, { status: ['pending', 'running'] })[0];
    if (running && ready(assistant.snapshotAssignmentLog(running.id))) return running.id;
    await sleep(10);
  }
  return null;
}

test('a running assignment exposes an ordered live log that watchers follow and that ends with the run', async () => {
  const fake = createFake('claude');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  fake.provider.run = async function* () {
    yield { type: 'text', delta: 'Hello ' };
    yield { type: 'thinking', delta: 'plan the parser first' };
    yield { type: 'tool', name: 'lookup', id: 't1', status: 'start', detail: 'the repo' };
    await gate;
    yield { type: 'text', delta: 'world' };
    yield { type: 'tool', name: 'tool', id: 't1', status: 'end', result: 'found', isError: false };
    yield { type: 'done', text: 'Hello world' };
  };
  const { assistant, store } = createAssistant([fake.provider]);
  const org = assistant.org.activeOrganization();
  hire(assistant, { name: 'Mara' });

  const run = (async () => {
    for await (const event of assistant.assign({ agent: 'mara', task: 'say it' })) void event;
  })();

  const assignmentId = await waitForRunningLog(assistant, store, org.id, (snapshot) => snapshot.events.length >= 3);
  assert.ok(assignmentId, 'the assignment is running with buffered log lines');

  // The mid-run snapshot is ordered, active, and carries the raw events.
  const snapshot = assistant.snapshotAssignmentLog(assignmentId);
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.overflowed, false);
  assert.deepEqual(
    snapshot.events.map((entry) => entry.event.type),
    ['text', 'thinking', 'tool'],
    'text, thinking and tool all show up, in arrival order',
  );
  const seqs = snapshot.events.map((entry) => entry.seq);
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, 'seq rises with arrival');
  assert.equal(snapshot.events[2].event.detail, 'the repo', 'the log keeps the raw tool event, no [slug] prefix');

  // A live listener attaches now and sees only what happens from here on.
  const seen = [];
  const unwatch = assistant.watchAssignmentLog(assignmentId, (entry) => seen.push(entry));
  // The runtime forwards every push as a frame, for whoever fans them out.
  const frames = [];
  assistant.on('assignment-log', (frame) => frames.push(frame));

  // The generator replays the buffer, then follows live, then ends with the run.
  const followed = [];
  const followedDone = (async () => {
    for await (const entry of assistant.assignmentLog(assignmentId)) followed.push(entry);
  })();

  release();
  await run;
  await followedDone;
  unwatch();

  assert.deepEqual(
    seen.map((entry) => entry.event.type),
    ['text', 'tool'],
    'the listener saw the post-attach events in order',
  );
  assert.deepEqual(
    frames.map((frame) => frame.assignmentId),
    [assignmentId, assignmentId],
    'the runtime forwards each push as a frame for this assignment',
  );
  assert.deepEqual(
    followed.map((entry) => entry.event.type),
    ['text', 'thinking', 'tool', 'text', 'tool'],
    'the generator replayed the buffer and then followed live',
  );
  assert.ok(
    followed.every((entry, index) => index === 0 || entry.seq > followed[index - 1].seq),
    'the generator output stays ordered by seq',
  );

  assert.deepEqual(
    assistant.snapshotAssignmentLog(assignmentId),
    { events: [], overflowed: false, active: false },
    'the log is gone once the run ended; only the persisted result remains',
  );
});

test('the live log drops its oldest whole entries above 256 KB and says so', async () => {
  const fake = createFake('claude');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  fake.provider.run = async function* () {
    yield { type: 'text', delta: 'first line' };
    for (let i = 0; i < 30; i += 1) yield { type: 'text', delta: 'x'.repeat(10 * 1024) };
    yield { type: 'text', delta: 'last line' };
    await gate;
    yield { type: 'done', text: 'bulky' };
  };
  const { assistant, store } = createAssistant([fake.provider]);
  const org = assistant.org.activeOrganization();
  hire(assistant, { name: 'Mara' });

  const run = (async () => {
    for await (const event of assistant.assign({ agent: 'mara', task: 'bulky output' })) void event;
  })();

  // 32 pushes happen before the gate: one small, thirty bulky, one small.
  // Overflow may already have eaten the front, so the marker is the newest
  // entry, never a count.
  const assignmentId = await waitForRunningLog(
    assistant,
    store,
    org.id,
    (snapshot) => snapshot.events.length > 0 && snapshot.events.at(-1).event.delta === 'last line',
  );
  assert.ok(assignmentId, 'the run produced its full scripted output');
  const snapshot = assistant.snapshotAssignmentLog(assignmentId);

  assert.equal(snapshot.active, true);
  assert.equal(snapshot.overflowed, true, 'the buffer says its beginning was dropped');
  assert.ok(!snapshot.events.some((entry) => entry.event.delta === 'first line'), 'the oldest entry is gone');
  assert.equal(snapshot.events.at(-1).event.delta, 'last line', 'the newest entry is there');
  assert.equal(snapshot.events.at(-1).seq, 32, 'seq counted every push, dropped or not');
  assert.ok(snapshot.events[0].seq > 1, 'the front of the buffer moved past the dropped entries');
  assert.ok(
    snapshot.events.every((entry, index) => index === 0 || entry.seq > snapshot.events[index - 1].seq),
    'what survives stays ordered',
  );
  const bytes = snapshot.events.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)), 0);
  assert.ok(bytes <= LOG_CAP_BYTES, 'the retained entries fit the cap (got ' + bytes + ' bytes)');

  release();
  await run;
  assert.equal(assistant.snapshotAssignmentLog(assignmentId).active, false);
});

test('a provider switch clears the buffered transcript but keeps the sequence counting', async () => {
  rememberUsageRecovered('claude');
  const dead = createFake('claude');
  const live = createFake('codex');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  dead.provider.run = async function* () {
    yield { type: 'text', delta: 'attempt one speaks' };
    await gate;
    yield { type: 'error', message: USAGE_FATAL, fatal: true };
  };
  const { assistant, store } = createAssistant([dead.provider, live.provider], { defaultProvider: 'claude' });
  const org = assistant.org.activeOrganization();
  hire(assistant, { name: 'Mara', provider: 'claude' });

  const run = (async () => {
    for await (const event of assistant.assign({ agent: 'mara', task: 'survive the switch' })) void event;
  })();

  const assignmentId = await waitForRunningLog(assistant, store, org.id, (snapshot) => snapshot.events.length >= 1);
  assert.ok(assignmentId, 'the first attempt is running');

  const followed = [];
  const followedDone = (async () => {
    for await (const entry of assistant.assignmentLog(assignmentId)) followed.push(entry);
  })();

  release();
  await run;
  await followedDone;

  assert.deepEqual(
    followed.map((entry) => entry.event.type),
    ['text', 'error', 'status', 'text'],
    'the dead attempt, its fatal end, the switch notice and the restart all show up, in order',
  );
  const status = followed[2].event;
  assert.equal(status.label, 'provider');
  assert.match(status.detail, /continuing on codex/);
  assert.deepEqual(
    followed.map((entry) => entry.seq),
    [1, 2, 3, 4],
    'seq stays monotone across the reset instead of restarting',
  );
  assert.equal(store.org.getAssignment(assignmentId).status, 'done', 'the run itself finished on the alternate');
});
