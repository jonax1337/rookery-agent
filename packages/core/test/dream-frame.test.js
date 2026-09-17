import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_MEMORY_OWNER,
  DEFAULT_CONFIG,
  Store,
  boxFromOptions,
  coreProfile,
  dropContradicted,
  fetchFrame,
  linkEntities,
  mergeProfile,
  pipelineAgent,
  pipelineAssistant,
  recall,
  renderFromFrame,
  renderMemoryBlock,
  resolvePolicy,
  scoreFrame,
  SEEDS_CAP,
} from '../dist/index.js';
import { byScoreThenId } from '../dist/memory/recall.js';

/**
 * The dream split of recall (stage 1, AP6): `fetchFrame` records the
 * permissive corner of the declared box, `scoreFrame` replays any point
 * inside it, and `recall` is the composition plus the one write it has
 * always had. The acceptance of this package is the equivalence test: for
 * two hundred random draws, element for element including `score`, `hop`
 * and `reason`, the replay must be the live path. If it falls over at a
 * single draw, the split is wrong - not the test.
 *
 * Frozen clock: `recency` reads `Date.now()`, so a live run and a replay
 * drift apart whenever the clock ticks between them. There was no pattern
 * for this in the repo, so this file establishes one - freeze `Date.now`
 * around everything, bank construction included, because a row inserted
 * outside the freeze gets an `updatedAt` far in the future of the frozen
 * `now` and blows the recency term past every threshold.
 */

const FIXED_NOW = Date.parse('2026-09-17T12:00:00.000Z');

function withFrozenClock(run) {
  const realNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    return run();
  } finally {
    Date.now = realNow;
  }
}

/** Deterministic PRNG so a failing draw fails identically on every run. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** A fresh in-memory store per test keeps them independent and fast. */
function makeStore() {
  return new Store(':memory:');
}

const QUERY_VOCAB = [
  'harbor', 'ledger', 'beacon', 'anchor', 'compass', 'tide', 'voyage', 'cargo', 'signal', 'lighthouse',
];
const SHARED_ENTITIES = ['harbor', 'ledger', 'beacon'];

// Profile rows must never match a query: the profile-closure test counts
// profile rows in the merge, and a ranked row colliding with a profile id
// would overwrite it. No vocabulary stems in these sentences.
const PROFILE_LINES = [
  'The user keeps winter tires in the cellar.',
  'The user votes for the neighbourhood council every spring.',
  'The user drinks black tea in the afternoon.',
  'The user walks the dog along the eastern dike.',
  'The user files paper receipts in a shoebox.',
  'The user prefers wool socks over cotton ones.',
  'The user tunes the piano twice a year.',
  'The user reads one chapter before sleeping.',
];

/**
 * A bank of sixty memories shaped to exercise every path the frame must
 * close over: a queryable shelf with shared and per-row entities, tag hits,
 * a superseded row that still sits in the entity neighbourhoods, an agent
 * row behind the owner boundary, refines/caused_by edges, a contradiction
 * pair inside the profile, and ten profile-worthy rows.
 */
function makeBank() {
  const store = makeStore();
  const earlyIds = [];
  for (let index = 0; index < 49; index += 1) {
    const words = [
      QUERY_VOCAB[index % 10],
      QUERY_VOCAB[(index * 3 + 1) % 10],
      QUERY_VOCAB[(index * 7 + 2) % 10],
    ];
    const memory = store.upsertMemory({
      kind: 'fact',
      content: 'Note ' + index + ' keeps the ' + words.join(' ') + ' in sight.',
      importance: 0.1 + (index % 6) * 0.08,
      tags: index % 7 === 0 ? [words[0]] : [],
    });
    if (index < 4) earlyIds.push(memory.id);
    linkEntities(
      store,
      ASSISTANT_MEMORY_OWNER,
      memory.id,
      index % 2 === 0 ? [SHARED_ENTITIES[index % 3]] : [SHARED_ENTITIES[index % 3], 'extra-' + (index % 5)],
    );
  }

  // Superseded on purpose: the neighbour SQL does not filter superseded_by,
  // so this row must ride along in the recorded neighbourhoods and be
  // dropped again by the replay's offer filter, exactly as live does.
  const superseded = store.upsertMemory({
    kind: 'fact',
    content: 'Note 49 keeps the harbor ledger beacon in sight.',
    importance: 0.9,
  });
  linkEntities(store, ASSISTANT_MEMORY_OWNER, superseded.id, ['harbor']);
  store.db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run('ghost-row', superseded.id);

  const profileIds = [];
  for (let index = 0; index < PROFILE_LINES.length; index += 1) {
    const memory = store.upsertMemory({
      kind: 'fact',
      content: PROFILE_LINES[index],
      importance: 0.75 + index * 0.02,
    });
    profileIds.push(memory.id);
    if (index < 2) linkEntities(store, ASSISTANT_MEMORY_OWNER, memory.id, ['household']);
  }
  const pinned = store.upsertMemory({
    kind: 'fact',
    content: 'The user pinned the garden watering rota.',
    importance: 0.4,
    pinned: true,
  });
  const insight = store.upsertMemory({
    kind: 'insight',
    content: 'The user trusts slow steady progress over sprints.',
    importance: 0.85,
  });

  // An agent row on a shared entity: the owner filter must keep it out of
  // the assistant's frontier and neighbourhoods on both sides of the split.
  const agentNote = store.upsertMemory({
    kind: 'fact',
    content: 'Agent note keeps the harbor manifest close.',
    importance: 0.95,
    owner: 'agent-releng',
  });
  linkEntities(store, 'agent-releng', agentNote.id, ['harbor']);

  store.addEdge({ owner: ASSISTANT_MEMORY_OWNER, srcId: earlyIds[0], dstId: earlyIds[1], relation: 'refines', weight: 0.7 });
  store.addEdge({ owner: ASSISTANT_MEMORY_OWNER, srcId: earlyIds[2], dstId: earlyIds[3], relation: 'caused_by', weight: 0.5 });
  store.addEdge({ owner: ASSISTANT_MEMORY_OWNER, srcId: profileIds[0], dstId: profileIds[1], relation: 'contradicts', weight: 0.9 });

  return { store, pinned, insight };
}

function snapshotCounters(store) {
  return store.db.prepare('SELECT id, access_count, usefulness FROM memories ORDER BY id').all();
}

test('recall equals scoreFrame over fetchFrame for 200 draws, on both pipelines', () => {
  withFrozenClock(() => {
    const { store } = makeBank();
    const random = makeRandom(20260917);
    try {
      for (const pipeline of ['assistant', 'agent']) {
        for (let draw = 0; draw < 200; draw += 1) {
          const tokenCount = 1 + Math.floor(random() * 3);
          const tokens = [];
          for (let token = 0; token < tokenCount; token += 1) {
            tokens.push(QUERY_VOCAB[Math.floor(random() * QUERY_VOCAB.length)]);
          }
          const options = {
            text: tokens.join(' '),
            limit: 4 + Math.floor(random() * 13),
            threshold: Math.round(random() * 50) / 100,
            hopEntity: Math.round(random() * 100) / 100,
            hopEdge: Math.round(random() * 100) / 100,
          };
          const live = recall(store, { ...options, touch: false });
          const frame = fetchFrame(store, { ...options, box: boxFromOptions(options), pipeline });
          const replay = scoreFrame(frame, options);
          assert.ok(replay.ok, 'draw ' + draw + ' (' + pipeline + ') must not abstain');
          assert.deepEqual(
            live,
            replay.ranked,
            'draw ' + draw + ' (' + pipeline + ') for ' + JSON.stringify(options),
          );
        }
      }
    } finally {
      store.close();
    }
  });
});

test('both pipelines reproduce the turn merges byte for byte', () => {
  withFrozenClock(() => {
    const { store } = makeBank();
    try {
      const options = { text: 'harbor ledger beacon', limit: 8, threshold: 0.1 };
      const matched = recall(store, { ...options, touch: false });

      // The assistant merge exactly as runtime.ts walks it: profile rows
      // first, the ranking overwriting on a clash, contradiction drop, sort.
      const profile = coreProfile(store, { limit: Math.max(3, Math.floor(options.limit / 2)) });
      const byId = new Map(profile.map((memory) => [memory.id, memory]));
      for (const memory of matched) byId.set(memory.id, memory);
      const assistantHand = dropContradicted(store, [...byId.values()]).sort(byScoreThenId);
      const assistantExpected = renderMemoryBlock(assistantHand, 2400, 'this user', store);

      const assistantFrame = fetchFrame(store, {
        ...options,
        box: boxFromOptions(options),
        budgetChars: 2400,
        subject: 'this user',
      });
      const assistant = pipelineAssistant(assistantFrame, options);
      assert.ok(assistant.ok);
      assert.equal(assistant.block, assistantExpected);
      assert.ok(assistant.lines.length > 0, 'the block had rows that fit');
      assert.ok(assistant.lines.every((line) => assistantHand.some((memory) => memory.id === line.id)));

      // The agent merge exactly as org/controller.ts walks it: profile
      // capped at the literal 3, no contradiction drop, flat rendering.
      const agentProfile = coreProfile(store, { limit: 3 });
      const agentById = new Map(agentProfile.map((memory) => [memory.id, memory]));
      for (const memory of matched) agentById.set(memory.id, memory);
      const agentHand = [...agentById.values()].sort(byScoreThenId);
      const agentExpected = renderMemoryBlock(agentHand, 2400, 'your work');

      const agentFrame = fetchFrame(store, {
        ...options,
        box: boxFromOptions(options),
        budgetChars: 2400,
        subject: 'your work',
      });
      const agent = pipelineAgent(agentFrame, options);
      assert.ok(agent.ok);
      assert.equal(agent.block, agentExpected);
      assert.deepEqual(
        agent.lines.map((memory) => memory.id),
        agentHand.filter((memory) => agent.block.includes(memory.content)).map((memory) => memory.id),
      );
    } finally {
      store.close();
    }
  });
});

test('the seeds the second hop used are inside possibleSeeds, and every reached row is recorded', () => {
  withFrozenClock(() => {
    const { store } = makeBank();
    try {
      const options = { text: 'harbor beacon', limit: 8, threshold: 0.1, hopEntity: 0.8, hopEdge: 0.7 };
      const frame = fetchFrame(store, { ...options, box: boxFromOptions(options) });
      const replay = scoreFrame(frame, options);
      assert.ok(replay.ok);

      // The realised seeds are the top three direct rows; the second hop
      // cannot have used anything outside possibleSeeds.
      const usedSeeds = replay.ranked.filter((memory) => memory.hop === 'direct').slice(0, 3).map((memory) => memory.id);
      assert.ok(usedSeeds.length > 0);
      assert.ok(
        usedSeeds.every((id) => frame.possibleSeeds.includes(id)),
        'every realised seed must be a possible seed',
      );
      assert.ok(replay.ranked.every((memory) => frame.records[memory.id] !== undefined));
      const neighbourIds = new Set(Object.values(frame.entityNeighbours).flat());
      assert.ok(
        replay.ranked
          .filter((memory) => memory.hop === 'entity')
          .every((memory) => neighbourIds.has(memory.id) || frame.possibleSeeds.includes(memory.id)),
        'entity rows must come from the recorded neighbourhoods',
      );
      assert.ok(
        replay.ranked
          .filter((memory) => memory.hop === 'edge')
          .every((memory) => frame.edges.some((edge) => edge.dstId === memory.id)),
        'edge rows must come from the recorded edges',
      );
    } finally {
      store.close();
    }
  });
});

test('a frame recorded at limitMax 16 reproduces the profile rows for every limit from 4 to 16', () => {
  withFrozenClock(() => {
    const { store } = makeBank();
    try {
      const options = { text: 'harbor ledger', limit: 16, threshold: 0.05 };
      const frame = fetchFrame(store, { ...options, box: boxFromOptions(options) });
      const replay = scoreFrame(frame, options);
      assert.ok(replay.ok);
      assert.equal(frame.profile.length, 8, 'the permissive corner holds eight profile rows');

      const profileIds = new Set(frame.profile.map((entry) => entry.id));
      for (let limit = 4; limit <= 16; limit += 1) {
        const merged = mergeProfile(frame, replay.ranked, limit);
        assert.equal(
          merged.filter((memory) => profileIds.has(memory.id)).length,
          Math.max(3, Math.floor(limit / 2)),
          'profile closure broke at limit ' + limit,
        );
      }
    } finally {
      store.close();
    }
  });
});

test('renderFromFrame is character-equal to renderMemoryBlock, grouped and flat', () => {
  withFrozenClock(() => {
    const { store } = makeBank();
    try {
      const options = { text: 'harbor beacon anchor', limit: 10, threshold: 0.1, hopEntity: 0.7 };
      const frame = fetchFrame(store, { ...options, box: boxFromOptions(options) });
      const hits = recall(store, { ...options, touch: false });
      const byId = new Map(coreProfile(store, { limit: 6 }).map((memory) => [memory.id, memory]));
      for (const memory of hits) byId.set(memory.id, memory);
      const list = [...byId.values()].sort(byScoreThenId);
      assert.ok(list.length > 4, 'the list has grouped and loose rows to render');

      assert.equal(renderFromFrame(frame, list, 2400, 'this user'), renderMemoryBlock(list, 2400, 'this user', store));
      assert.equal(renderFromFrame(frame, list, 2400, 'this user', true), renderMemoryBlock(list, 2400, 'this user'));
      // A budget that rips mid-list exercises the break-not-continue path -
      // the reason a redundant line costs the line behind it.
      assert.equal(renderFromFrame(frame, list, 160, 'this user'), renderMemoryBlock(list, 160, 'this user', store));
    } finally {
      store.close();
    }
  });
});

test('framing and scoring never touch the bank', () => {
  withFrozenClock(() => {
    const { store } = makeBank();
    try {
      const before = snapshotCounters(store);
      const draws = [
        { text: 'harbor', limit: 8, threshold: 0.1 },
        { text: 'ledger beacon anchor', limit: 16, threshold: 0.05, hopEntity: 0.9, hopEdge: 0.8 },
      ];
      for (const options of draws) {
        const frame = fetchFrame(store, { ...options, box: boxFromOptions(options), budgetChars: 2400 });
        const replay = scoreFrame(frame, options);
        if (replay.ok) {
          pipelineAssistant(frame, options);
          pipelineAgent(frame, options);
        }
      }
      assert.deepEqual(snapshotCounters(store), before, 'access_count and usefulness must not move (R6)');
    } finally {
      store.close();
    }
  });
});

test('three degraded worlds, not two', () => {
  withFrozenClock(() => {
    const { store } = makeBank();
    try {
      // World one: a query out of stop words alone.
      const stop = fetchFrame(store, { text: 'the a of is', limit: 8 });
      assert.equal(stop.degraded, 'no-tokens');
      assert.equal(stop.hop1.length, 0);
      assert.deepEqual(scoreFrame(stop, { limit: 8 }), { ok: false, reason: 'degraded-turn' });
      assert.deepEqual(recall(store, { text: 'the a of is', touch: false }), []);

      // World two: the FTS statement itself throws. The turn may not break,
      // at record time or at replay time.
      const realPrepare = store.db.prepare.bind(store.db);
      let thrown = false;
      store.db.prepare = (...args) => {
        if (!thrown) {
          thrown = true;
          throw new Error('fts boom');
        }
        return realPrepare(...args);
      };
      let broke;
      try {
        broke = fetchFrame(store, { text: 'harbor', limit: 8 });
      } finally {
        delete store.db.prepare;
      }
      assert.equal(broke.degraded, 'fts-threw');
      assert.deepEqual(scoreFrame(broke, { limit: 8 }), { ok: false, reason: 'degraded-turn' });

      // World three: rows came, all fell below the threshold. A legitimate
      // miss - scored, not abstained, and never inferred from an empty list.
      const miss = fetchFrame(store, { text: 'harbor', limit: 8, threshold: 50 });
      assert.equal(miss.degraded, null);
      assert.ok(miss.hop1.length > 0);
      const replay = scoreFrame(miss, { limit: 8, threshold: 50 });
      assert.ok(replay.ok);
      assert.deepEqual(replay.ranked, []);
    } finally {
      store.close();
    }
  });
});

test('a limit outside the box is a recorder error, not a measurement', () => {
  withFrozenClock(() => {
    const { store } = makeBank();
    try {
      const options = { text: 'harbor', limit: 16 };
      const frame = fetchFrame(store, { ...options, box: boxFromOptions(options) });
      assert.equal(frame.box.limitMax, 16);
      assert.deepEqual(scoreFrame(frame, { ...options, limit: 32 }), { ok: false, reason: 'limit-out-of-box' });
    } finally {
      store.close();
    }
  });
});

test('a box whose lower weight bounds approach zero caps the seeds and abstains', () => {
  withFrozenClock(() => {
    const { store } = makeBank();
    try {
      // 'harbor ledger' reaches 25 frontier rows: the cap at twice the p95
      // budget only bites when the frontier is wide enough to fill it.
      const box = {
        ...boxFromOptions({ text: 'harbor ledger', limit: 16 }),
        w: {
          relevance: [0.0001, 0.55],
          importance: [0.0001, 0.2],
          recency: [0.0001, 0.15],
          usage: [0.0001, 0.1],
        },
        threshold: [0, 0.5],
      };
      const frame = fetchFrame(store, { text: 'harbor ledger', limit: 16, box });
      assert.ok(frame.possibleSeeds.length <= SEEDS_CAP, 'the frame is discarded, not inflated');
      assert.deepEqual(scoreFrame(frame, { limit: 8 }), { ok: false, reason: 'seeds-capped' });
    } finally {
      store.close();
    }
  });
});

test('resolvePolicy is one truth for both paths and honours user config', () => {
  const store = makeStore();
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.memory.graph.hopEntity = 0.9;
    const assistant = resolvePolicy(store, config, ASSISTANT_MEMORY_OWNER, 'recall');
    const agent = resolvePolicy(store, config, 'agent-releng', 'recall');
    // Today the agent path silently runs on the literals; from here both
    // paths get the same answer, whatever the config says.
    assert.equal(assistant.hopEntity, config.memory.graph.hopEntity);
    assert.equal(agent.hopEntity, assistant.hopEntity);
    assert.deepEqual(agent.w, assistant.w);
    assert.equal(assistant.limit, DEFAULT_CONFIG.memory.recallLimit);
    assert.equal(assistant.origin.hopEntity, 'user');
    assert.equal(assistant.origin.threshold, 'default');
    assert.equal(assistant.origin.limit, 'default');

    const tuned = structuredClone(DEFAULT_CONFIG);
    tuned.memory.recallThreshold = 0.5;
    assert.equal(resolvePolicy(store, tuned, ASSISTANT_MEMORY_OWNER, 'recall').origin.threshold, 'user');

    // `rookery config set` bypasses the patch schema entirely, so values are
    // clamped at read, never trusted because they were written (E21).
    const wild = structuredClone(DEFAULT_CONFIG);
    wild.memory.recallLimit = 500;
    wild.memory.recallThreshold = -3;
    wild.memory.graph.hopEdge = 7;
    const clamped = resolvePolicy(store, wild, ASSISTANT_MEMORY_OWNER, 'recall');
    assert.equal(clamped.limit, 50);
    assert.equal(clamped.threshold, 0);
    assert.equal(clamped.hopEdge, 1);
  } finally {
    store.close();
  }
});
