import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSISTANT_MEMORY_OWNER,
  Assistant,
  DEFAULT_CONFIG,
  ProviderRegistry,
  SEEDS_CAP,
  Store,
  fetchFrame,
  scoreFrame,
} from '../dist/index.js';

/**
 * The dream's budget gate as tests (dream stage 1, AP11).
 *
 * The latency measurement lives in scripts/dream-bench.mjs and belongs in
 * the PR description, not in the suite - wall-clock numbers flicker in
 * node:test. What IS deterministic stays here: a wide frame on a
 * mid-size bank stays under `dream.maxFrameBytes`, `|possibleSeeds|` is
 * hard-capped and a capped frame abstains with `seeds-capped` instead of
 * growing (concept 3.1), the recorder costs a bounded number of prepared
 * statements per turn, and turns outside the sample pay nothing at all.
 *
 * Determinism: every bank is built from a seeded PRNG under a frozen
 * clock, so two runs that claim to measure "the same corpus" really do.
 */

const FIXED_NOW = Date.parse('2026-09-17T12:00:00.000Z');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function withFrozenClock(run) {
  const realNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    return run();
  } finally {
    Date.now = realNow;
  }
}

/**
 * The async twin: `recency` decays with the real clock, so two sequential
 * runs drift apart microscopically - enough to flip one borderline second-hop
 * entity and with it one prepared statement. Freezing the clock across the
 * turns makes the read counts comparable, not lucky.
 */
async function withFrozenClockAsync(run) {
  const realNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    return await run();
  } finally {
    Date.now = realNow;
  }
}

const TOPICS = [
  'harbor', 'ledger', 'compiler', 'garden', 'lighthouse', 'ferry', 'archive', 'signal',
  'orchard', 'harvest', 'pipeline', 'theorem', 'cache', 'delta', 'beacon', 'meadow',
];

const KINDS = ['fact', 'fact', 'preference', 'project', 'event', 'summary', 'insight', 'fact'];

function buildBank(store, sizes, rng) {
  const records = [];
  for (let i = 0; i < sizes.memories; i += 1) {
    const a = TOPICS[i % TOPICS.length];
    const b = TOPICS[(i * 7 + 3) % TOPICS.length];
    const kind = KINDS[i % KINDS.length];
    records.push(
      store.upsertMemory({
        kind,
        content:
          'The ' + a + ' report no. ' + i + ' covers ' + b + ' work for quarter ' + (1 + (i % 4)) + '.',
        tags: i % 3 === 0 ? [a] : [],
        importance: kind === 'insight' ? 0.75 + rng() * 0.2 : 0.2 + rng() * 0.6,
        pinned: rng() < 0.06,
        owner: ASSISTANT_MEMORY_OWNER,
      }),
    );
  }
  const entities = [];
  for (let e = 0; e < sizes.entities; e += 1) {
    entities.push(store.upsertEntity({ owner: ASSISTANT_MEMORY_OWNER, name: TOPICS[e % TOPICS.length] + ' ' + Math.floor(e / TOPICS.length) }));
  }
  for (let e = 0; e < entities.length; e += 1) {
    for (let k = 0; k < sizes.linksPerEntity; k += 1) {
      store.linkEntity(records[(e + k * entities.length + Math.floor(e / 8)) % records.length].id, entities[e].id);
    }
  }
  let written = 0;
  for (let i = 0; written < sizes.edges; i += 1) {
    const src = records[i % records.length];
    const dst = records[(i * 13 + 7) % records.length];
    const relation = written % 12 === 11 ? 'contradicts' : written % 2 === 0 ? 'refines' : 'caused_by';
    if (src.id === dst.id) continue;
    if (store.addEdge({ owner: ASSISTANT_MEMORY_OWNER, srcId: src.id, dstId: dst.id, relation, weight: 0.3 + (written % 7) * 0.1 })) written += 1;
  }
  return records;
}

function createFakeProvider() {
  return {
    id: 'claude',
    displayName: 'Fake Claude',
    models: () => ['fake'],
    async status() {
      return { id: 'claude', available: true, binary: 'fake', authenticated: true };
    },
    async *run(opts) {
      if ((opts.prompt ?? '').includes('EXCHANGE\n')) {
        yield { type: 'done', text: '[]' };
        return;
      }
      yield { type: 'text', delta: 'Noted.' };
      yield { type: 'done', text: 'Noted.' };
    },
  };
}

const openAssistants = [];
const openDirs = [];

function createAssistant(fake, memoryOverrides) {
  const home = mkdtempSync(join(tmpdir(), 'rookery-dream-budget-'));
  mkdirSync(join(home, 'run'), { recursive: true });
  openDirs.push(home);
  const store = new Store(':memory:');
  const assistant = new Assistant({
    store,
    registry: new ProviderRegistry([fake]),
    config: {
      home,
      logLevel: 'silent',
      memory: { enabled: true, autoExtract: false, ...memoryOverrides },
      org: { autoReview: false },
    },
  });
  openAssistants.push(assistant);
  return { assistant, store };
}

after(() => {
  for (const assistant of openAssistants) {
    try {
      assistant.close();
    } catch {
      // already closed
    }
  }
  for (const home of openDirs) rmSync(home, { recursive: true, force: true });
});

async function runTurn(assistant, text, sessionId) {
  let used = sessionId;
  for await (const event of assistant.chat(sessionId ? { text, sessionId } : { text })) {
    if (event.type === 'error' && event.fatal) assert.fail(event.message);
    if (event.type === 'session' && !used) used = event.sessionId;
  }
  assert.ok(used, 'the turn reported its session');
  return used;
}

function count(store, table) {
  return store.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
}

/**
 * The corpus both counted runs replay: one bank, built once and snapshotted,
 * so every run sees the same rows under the same ids. Ids matter - the
 * tie-breakers resolve equal scores by id, so two independently built banks
 * can differ by a borderline second-hop query without anything being wrong.
 * A frozen clock alone does not close that hole; a shared snapshot does.
 */
function bankSnapshot() {
  const template = new Store(':memory:');
  withFrozenClock(() => buildBank(template, { memories: 300, entities: 50, linksPerEntity: 4, edges: 100 }, mulberry32(71)));
  const snapshot = template.db.serialize();
  template.close();
  return snapshot;
}

/**
 * One instrumented run: prepared statements per turn, counted by wrapping
 * `store.db.prepare` - the plan's counter, and the honest proxy for the
 * read budget. The clock is frozen across the turns because `recency`
 * decays with the real one and would drift two sequential runs apart.
 */
async function countedRun(snapshot, dream, texts) {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake, dream ? { dream } : {});
  store.db.deserialize(snapshot);
  const db = store.db;
  const original = db.prepare.bind(db);
  let prepares = 0;
  db.prepare = (...sql) => {
    prepares += 1;
    return original(...sql);
  };
  const reads = [];
  await withFrozenClockAsync(async () => {
    let sessionId;
    for (const text of texts) {
      const before = prepares;
      sessionId = await runTurn(assistant, text, sessionId);
      reads.push(prepares - before);
    }
  });
  return reads;
}

test('a wide frame on a 500-memory bank stays under dream.maxFrameBytes', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake, { dream: { enabled: true, record: true, frameRate: 1 } });
  withFrozenClock(() => buildBank(store, { memories: 500, entities: 50, linksPerEntity: 4, edges: 120 }, mulberry32(101)));

  const sessionId = await runTurn(assistant, 'What does the harbor report say about the ledger, item 1?');
  await runTurn(assistant, 'Remind me what we decided about the ferry and the archive in round 2.', sessionId);

  const rows = store.framesFor(ASSISTANT_MEMORY_OWNER);
  assert.equal(rows.length, 2, 'both traced turns saved their frame');
  assert.equal(count(store, 'dream_traces'), rows.length, 'no frame was refused for size');
  for (const row of rows) {
    assert.ok(row.frame.bytes >= 20000, 'the frame carries the wide frontier, not a stub: ' + row.frame.bytes);
    assert.ok(
      row.frame.bytes < DEFAULT_CONFIG.memory.dream.maxFrameBytes,
      'frame of ' + row.frame.bytes + ' bytes stays under the ceiling',
    );
  }
});

test('possibleSeeds is capped when the lower weight bounds approach zero, and the frame abstains', () => {
  const store = new Store(':memory:');
  for (let i = 0; i < 40; i += 1) {
    store.upsertMemory({
      kind: 'fact',
      content: 'Quayside logbook entry ' + i + ' records the tide and the cargo.',
      tags: i % 5 === 0 ? ['quayside'] : [],
      importance: 0.4 + (i % 3) * 0.2,
      owner: ASSISTANT_MEMORY_OWNER,
    });
  }

  // The box the plan names: lower weight bounds tending to zero, so every
  // frontier row's best score clears the collapsed third-largest worst
  // score and the seed list would swallow the whole frontier.
  const openBox = {
    limitMax: 16,
    w: { relevance: [0.001, 0.55], importance: [0.001, 0.2], recency: [0.001, 0.15], usage: [0.001, 0.1] },
    threshold: [0.001, 0.3],
    hopEntity: [0.3, 0.6],
    hopEdge: [0.4, 0.8],
    kinds: [],
    minImportance: 0,
  };
  const frame = fetchFrame(store, { text: 'quayside logbook', owner: ASSISTANT_MEMORY_OWNER, limit: 8, box: openBox });
  assert.ok(frame.hop1.length >= 24, 'the frontier holds enough rows to reach the cap');
  assert.ok(frame.possibleSeeds.length <= SEEDS_CAP, 'the seed list is hard-capped (concept 3.1)');
  assert.equal(frame.possibleSeeds.length, SEEDS_CAP, 'every frontier row qualifies, so the list is cut at the cap');

  const capped = scoreFrame(frame, { limit: 8 });
  assert.equal(capped.ok, false);
  assert.equal(capped.reason, 'seeds-capped', 'a capped frame abstains instead of scoring an incomplete record');

  // The contrast that keeps the cap honest: the same call at its own point
  // box collapses the intervals and does not come near the cap.
  const point = fetchFrame(store, { text: 'quayside logbook', owner: ASSISTANT_MEMORY_OWNER, limit: 8 });
  assert.ok(point.possibleSeeds.length < SEEDS_CAP, 'the point box leaves the seed list small');
  assert.equal(scoreFrame(point, { limit: 8 }).ok, true, 'the point box does not abstain');
  store.close();
});

test('the recorder costs at most 40 additional prepared statements per turn', async () => {
  const texts = [
    'What does the harbor report say about the ledger, item 1?',
    'Remind me what we decided about the ferry and the archive in round 2.',
    'Where do the orchard notes connect to the harvest checklist, item 3?',
    'Summarise the open pipeline items that touch the theorem, batch 4.',
    'What does the beacon report say about the meadow, entry 5?',
    'Remind me what we decided about the cache and the delta in round 6.',
    'Where do the signal notes connect to the garden checklist, item 7?',
    'Summarise the open compiler items that touch the lighthouse, batch 8.',
    'What does the registry report say about the salvage, entry 9?',
    'Remind me what we decided about the harbor and the ferry in round 10.',
  ];
  const snapshot = bankSnapshot();
  const baseline = await countedRun(snapshot, null, texts);
  const framed = await countedRun(snapshot, { enabled: true, record: true, frameRate: 1 }, texts);
  const diffs = framed.map((reads, index) => reads - baseline[index]);
  // Deliberately generous and hard: the bound catches a regression by an
  // order of magnitude, not by ten percent (build plan AP11).
  assert.ok(
    Math.max(...diffs) <= 40,
    'per-turn additional prepared statements: ' + diffs.join(', '),
  );
  assert.ok(diffs.every((diff) => diff > 0), 'a framed turn really did extra work: ' + diffs.join(', '));
});

test('turns outside the sample pay nothing: reads equal the dream-off baseline', async () => {
  const texts = [
    'What does the harbor report say about the ledger, item 1?',
    'Remind me what we decided about the ferry and the archive in round 2.',
    'Where do the orchard notes connect to the harvest checklist, item 3?',
    'Summarise the open pipeline items that touch the theorem, batch 4.',
    'What does the beacon report say about the meadow, entry 5?',
    'Remind me what we decided about the cache and the delta in round 6.',
    'Where do the signal notes connect to the garden checklist, item 7?',
    'Summarise the open compiler items that touch the lighthouse, batch 8.',
  ];
  const snapshot = bankSnapshot();
  const baseline = await countedRun(snapshot, null, texts);
  const unsampled = await countedRun(snapshot, { enabled: true, record: true, frameRate: 0 }, texts);
  assert.deepEqual(unsampled, baseline);
});
