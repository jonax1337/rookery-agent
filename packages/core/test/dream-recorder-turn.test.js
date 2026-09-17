import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSISTANT_MEMORY_OWNER,
  Assistant,
  ProviderRegistry,
  Store,
  coreProfile,
  dropContradicted,
} from '../dist/index.js';
import { byScoreThenId } from '../dist/memory/recall.js';

/**
 * The recorder at the call site (dream stage 1, AP9).
 *
 * The load-bearing assertion is the unchanged prompt: a turn with the
 * recorder on renders byte for byte the memory block the same turn renders
 * with the recorder off, because a recorder that changes the turn it records
 * measures a world that never existed. Around that: only the assistant's
 * conversational turns are framed (R18), the sample is drawn per session and
 * never per trace, one turn groups its calls under one turn id (R19), frames
 * die with their session (R17), and both turn merges are totally ordered on
 * score ties (R11).
 *
 * Frozen clock (pattern from dream-frame.test.js): `recency` and the profile
 * read `Date.now()`, so a recorder-on and a recorder-off turn drift apart
 * whenever the clock ticks between them. Freezing it around both turns makes
 * the byte comparison honest instead of lucky.
 */

const FIXED_NOW = Date.parse('2026-09-17T12:00:00.000Z');

async function withFrozenClock(run) {
  const realNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    return await run();
  } finally {
    Date.now = realNow;
  }
}

/**
 * A provider that answers plain text and captures every run's system prompt,
 * which is where the memory block under test lives. Extraction prompts are
 * answered with an empty list should anything ever run one.
 */
function createFakeProvider() {
  const runs = [];
  const provider = {
    id: 'claude',
    displayName: 'Fake Claude',
    models: () => ['fake'],
    async status() {
      return { id: 'claude', available: true, binary: 'fake', authenticated: true };
    },
    async *run(opts) {
      runs.push(opts);
      if ((opts.prompt ?? '').includes('EXCHANGE\n')) {
        yield { type: 'done', text: '[]' };
        return;
      }
      yield { type: 'text', delta: 'Noted.' };
      yield { type: 'done', text: 'Noted.' };
    },
  };
  return { provider, runs };
}

const openAssistants = [];
after(() => {
  for (const assistant of openAssistants) {
    try {
      assistant.close();
    } catch {
      // already closed
    }
  }
});

function createAssistant(fake, overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'rookery-dream-turn-'));
  mkdirSync(join(home, 'run'), { recursive: true });
  const store = new Store(':memory:');
  const assistant = new Assistant({
    store,
    registry: new ProviderRegistry([fake.provider]),
    config: {
      home,
      logLevel: 'silent',
      memory: { enabled: true, autoExtract: false, ...overrides.memory },
      org: { autoReview: false },
    },
  });
  openAssistants.push(assistant);
  return { assistant, store, home };
}

/** The dream on and sampling every session, unless overridden. */
function dreamOn(extra = {}) {
  return { memory: { dream: { enabled: true, record: true, frameRate: 1, ...extra } } };
}

function seedBank(store) {
  store.upsertMemory({ kind: 'fact', content: 'The harbor manifest lists every incoming cargo.', tags: ['harbor'], importance: 0.9 });
  store.upsertMemory({ kind: 'preference', content: 'The user keeps the harbor logbook locked away.', tags: ['harbor'], importance: 0.5, pinned: true });
  store.upsertMemory({ kind: 'fact', content: 'The ledger records the tides at the quay.', tags: ['ledger'], importance: 0.55 });
}

function count(store, table) {
  return store.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
}

function traces(store) {
  return store.db.prepare('SELECT * FROM dream_traces ORDER BY started_at ASC, id').all();
}

/** Run one turn and collect the session id it ran in. */
async function runTurn(assistant, text, sessionId) {
  let used = sessionId;
  for await (const event of assistant.chat(sessionId ? { text, sessionId } : { text })) {
    if (event.type === 'error' && event.fatal) assert.fail(event.message);
    if (event.type === 'session' && !used) used = event.sessionId;
  }
  assert.ok(used, 'the turn reported its session');
  return used;
}

/** The memory section of a system prompt, extracted verbatim. */
function memorySection(systemPrompt) {
  const start = systemPrompt.indexOf('What you already know');
  if (start < 0) return '';
  const marker = '\nUse this naturally. Do not announce that you are reading from memory.';
  const end = systemPrompt.indexOf(marker, start);
  assert.ok(end > 0, 'the memory block carries its closing line');
  return systemPrompt.slice(start, end + marker.length);
}

test('a traced turn writes one trace, one frame and the touches it caused', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake, dreamOn());
  seedBank(store);

  await runTurn(assistant, 'What does the harbor manifest list?');

  assert.equal(count(store, 'dream_traces'), 1);
  assert.equal(count(store, 'dream_frames'), 1);
  assert.ok(count(store, 'memory_touches') > 0, 'the ranking touched rows it delivered');

  const trace = traces(store)[0];
  assert.equal(trace.site, 'turn');
  assert.equal(trace.pipeline, 'assistant');
  assert.equal(trace.owner, ASSISTANT_MEMORY_OWNER);
  assert.equal(trace.session_kind, 'chat');
  assert.equal(trace.framed, 1);
  assert.equal(trace.kind, 'turn');
  assert.ok(trace.finished_at > 0, 'the trace closed with the turn');
  assert.equal(trace.degraded, null, 'a scoring query with hits is not degraded');
  const policySet = JSON.parse(trace.policy_set);
  assert.equal(policySet.recall.limit, 8, 'the trace carries the resolved policy');

  const touch = store.db.prepare('SELECT * FROM memory_touches').get();
  assert.equal(touch.turn_id, trace.turn_id, 'touches carry the turn id (R19)');
  assert.equal(touch.trace_id, trace.id);

  const rows = store.framesFor(ASSISTANT_MEMORY_OWNER);
  assert.equal(rows.length, 1);
  const frame = rows[0].frame;
  assert.equal(frame.slot, 'recall');
  assert.equal(frame.payload.site, 'turn');
  assert.equal(frame.payload.pipeline, 'assistant');
  assert.equal(frame.payload.query.text, 'What does the harbor manifest list?');
  assert.equal(frame.payload.box.limitMax, 16, 'the declared box spans the limit range');
  assert.equal(frame.payload.budgetChars, 2400, 'the rendered budget is frozen into the frame');
  assert.equal(frame.payload.subject, 'this user');
  assert.equal(frame.payload.corpusStampId, '', 'no night has stamped a corpus fingerprint yet');
});

test('only the assistant owner is framed: an agent turn leaves no trace', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake, dreamOn());
  const org = assistant.org.activeOrganization();
  const agent = store.org.createAgent({ orgId: org.id, name: 'Mara', title: 'Engineer', instructions: 'Do the work.' });

  for await (const event of assistant.assign({ agent: agent.id, task: 'Check the harbor manifest.' })) {
    if (event.type === 'error' && event.fatal) assert.fail(event.message);
  }

  assert.equal(count(store, 'dream_traces'), 0, 'stage 1 frames no agent bank (R18)');
});

test('a scheduled run is never framed; voice and mail conversations are', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake, dreamOn());
  seedBank(store);

  const scheduled = assistant.createSession({ title: 'Digest', kind: 'schedule' });
  await runTurn(assistant, 'Report on the harbor manifest.', scheduled.id);
  assert.equal(count(store, 'dream_traces'), 0, 'a schedule can never earn a label, so it is never framed');

  const voice = assistant.createSession({ title: 'Call', kind: 'voice' });
  await runTurn(assistant, 'What about the harbor manifest?', voice.id);
  assert.equal(count(store, 'dream_traces'), 1);
  assert.equal(traces(store)[0].session_kind, 'voice');

  const mail = assistant.createSession({ title: 'Mail', kind: 'mail' });
  await runTurn(assistant, 'Harbor manifest question.', mail.id);
  assert.equal(count(store, 'dream_traces'), 2);
  assert.equal(traces(store)[1].session_kind, 'mail');
});

test('the sample is drawn per session, never per trace', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake, dreamOn({ frameRate: 0.25 }));
  seedBank(store);

  const sessionId = await runTurn(assistant, 'Harbor manifest, first look.');
  for (let turn = 2; turn <= 10; turn += 1) {
    await runTurn(assistant, 'Harbor manifest, turn ' + turn + '.', sessionId);
  }
  const framed = count(store, 'dream_traces');
  assert.ok(
    framed === 0 || framed === 10,
    'ten turns of one session are all in or all out, got ' + framed,
  );

  const every = createAssistant(createFakeProvider(), dreamOn({ frameRate: 1 }));
  seedBank(every.store);
  const everyId = await runTurn(every.assistant, 'Harbor manifest, first look.');
  for (let turn = 2; turn <= 10; turn += 1) {
    await runTurn(every.assistant, 'Harbor manifest, turn ' + turn + '.', everyId);
  }
  assert.equal(count(every.store, 'dream_traces'), 10, 'frameRate 1 frames every turn');

  const none = createAssistant(createFakeProvider(), dreamOn({ frameRate: 0 }));
  seedBank(none.store);
  const noneId = await runTurn(none.assistant, 'Harbor manifest, first look.');
  await runTurn(none.assistant, 'Harbor manifest, again.', noneId);
  assert.equal(count(none.store, 'dream_traces'), 0, 'frameRate 0 frames nothing');
});

test('turn ids group a turn and advance with the session (R19)', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake, dreamOn());
  seedBank(store);

  const sessionId = await runTurn(assistant, 'Harbor manifest, first turn.');
  await runTurn(assistant, 'Harbor manifest, second turn.', sessionId);

  const rows = traces(store);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].turn_id, rows[1].turn_id, 'each turn gets its own grouping id');
  assert.notEqual(rows[0].id, rows[1].id);
  assert.ok(rows[1].turn_index > rows[0].turn_index, 'the turn index advances with the session');

  // The grouping contract itself: a second traced call of the same turn (the
  // shape later stages use for the extractor's `site: 'extract'` call) is a
  // row of its own under the same turn id. Stage 1 traces exactly one call
  // per turn, so the second row is begun the way the runtime would begin it.
  const sibling = store.beginTrace({
    turnId: rows[0].turn_id,
    owner: ASSISTANT_MEMORY_OWNER,
    kind: 'turn',
    site: 'turn',
    pipeline: 'assistant',
    sessionId,
    sessionKind: 'chat',
    policySet: { recall: JSON.parse(rows[0].policy_set).recall },
  });
  assert.equal(sibling.turnId, rows[0].turn_id);
  assert.notEqual(sibling.id, rows[0].id);
});

test('the prompt is unchanged by the recorder', async () => {
  const fake = createFakeProvider();
  const store = new Store(':memory:');
  seedBank(store);

  const homeFor = (tag) => {
    const home = mkdtempSync(join(tmpdir(), 'rookery-dream-' + tag + '-'));
    mkdirSync(join(home, 'run'), { recursive: true });
    return home;
  };
  const plain = new Assistant({
    store,
    registry: new ProviderRegistry([fake.provider]),
    config: {
      home: homeFor('off'),
      logLevel: 'silent',
      memory: { enabled: true, autoExtract: false },
      org: { autoReview: false },
    },
  });
  const traced = new Assistant({
    store,
    registry: new ProviderRegistry([fake.provider]),
    config: {
      home: homeFor('on'),
      logLevel: 'silent',
      memory: { enabled: true, autoExtract: false, dream: { enabled: true, record: true, frameRate: 1 } },
      org: { autoReview: false },
    },
  });
  openAssistants.push(plain, traced);

  await withFrozenClock(async () => {
    await runTurn(plain, 'What does the harbor manifest list?');
    await runTurn(traced, 'What does the harbor manifest list?');
  });

  assert.equal(count(store, 'dream_traces'), 1, 'the traced turn really was traced');
  const withoutRecorder = memorySection(fake.runs[fake.runs.length - 2].systemPrompt);
  const withRecorder = memorySection(fake.runs[fake.runs.length - 1].systemPrompt);
  assert.ok(withoutRecorder.length > 0, 'the turn carried a memory block at all');
  assert.equal(withRecorder, withoutRecorder);
});

test('deleting a session drops its frames but keeps the small rows (R17)', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake, dreamOn());
  seedBank(store);

  const sessionId = await runTurn(assistant, 'What does the harbor manifest list?');
  assert.equal(count(store, 'dream_frames'), 1);

  assistant.deleteSession(sessionId);

  assert.equal(count(store, 'dream_frames'), 0, 'a verbatim store never outlives its session');
  assert.equal(count(store, 'dream_traces'), 1, 'the trace bookkeeping stays for calibration');
});

test('the enabled switch overrides record', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake, dreamOn({ enabled: false }));
  seedBank(store);

  await runTurn(assistant, 'What does the harbor manifest list?');

  assert.equal(count(store, 'dream_traces'), 0);
  assert.equal(count(store, 'dream_frames'), 0);
});

test('both turn merges are totally ordered on a score tie (R11)', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake, dreamOn());
  seedBank(store);

  // Two rows at a byte-equal score, the profile row inserted first (as the
  // turn merge does) but carrying the higher id: only the id tie-breaker
  // keeps the head of the merge fixed, ten runs out of ten.
  const row = (id, score) => ({
    id,
    kind: 'fact',
    content: 'Row ' + id + '.',
    tags: [],
    importance: 0.5,
    owner: ASSISTANT_MEMORY_OWNER,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    accessCount: 0,
    forgotten: false,
    origin: 'extract',
    score,
    hop: 'direct',
    reason: 'tie',
  });
  const profileRow = row('z-profile', 2);
  const directRow = row('a-direct', 2);

  const assistantMerge = () => {
    const byId = new Map([[profileRow.id, profileRow]]);
    byId.set(directRow.id, directRow);
    return dropContradicted(store, [...byId.values()]).sort(byScoreThenId);
  };
  const runs = Array.from({ length: 10 }, assistantMerge);
  assert.equal(new Set(runs.map((merged) => merged[0].id)).size, 1, 'the merge head never moves');
  assert.equal(runs[0][0].id, 'a-direct', 'a tie resolves by id ascending, not insertion order');

  // The agent merge (org/controller.ts): profile map, ranking overwriting,
  // sort - no contradiction drop.
  const agentMerge = () => {
    const byId = new Map([[profileRow.id, profileRow]]);
    byId.set(directRow.id, directRow);
    return [...byId.values()].sort(byScoreThenId);
  };
  const agentRuns = Array.from({ length: 10 }, agentMerge);
  assert.equal(new Set(agentRuns.map((merged) => merged[0].id)).size, 1);
  assert.equal(agentRuns[0][0].id, 'a-direct');

  // And the wider profile read really is prefix-invariant: sliced wide
  // equals narrow, row for row, which is what the traced turn relies on.
  withFrozenClock(() => {
    const wide = coreProfile(store, { limit: 8 }).slice(0, 4).map((memory) => memory.id);
    const narrow = coreProfile(store, { limit: 4 }).map((memory) => memory.id);
    assert.deepEqual(wide, narrow);
  });
});
