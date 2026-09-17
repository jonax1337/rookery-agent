import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_MEMORY_OWNER,
  Store,
  boxFromOptions,
  fetchFrame,
  linkEntities,
  measure,
  isScalarMultiple,
  normaliseWeights,
  deltaIsLabelBacked,
  pipelineAssistant,
  scoreFrame,
} from '../dist/index.js';
import { WEIGHTS } from '../dist/memory/recall.js';

/**
 * The block measure (dream stage 1, AP8). The acceptance of this package is
 * the falsification test: a candidate that is equal on recall's return value
 * and strictly worse on the block the model read. If that test falls over,
 * the old measure was sufficient and this part of the concept is refuted -
 * not the test.
 *
 * Frozen clock: same pattern as dream-frame.test.js, because `recency` reads
 * `Date.now()` and a row inserted outside the freeze drifts. Where a test
 * depends on the relative order of two rows, it derives its thresholds from
 * the observed scores instead of trusting hand-computed bm25 values - the
 * order is asserted, so a surprise fails loudly, never silently.
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

/** A fresh in-memory store per test keeps them independent and fast. */
function makeStore() {
  return new Store(':memory:');
}

/** Positional discount over an ordered list of gains, one-based. */
function dcgOf(gains) {
  let sum = 0;
  for (let index = 0; index < gains.length; index += 1) sum += gains[index] / Math.log2(index + 2);
  return sum;
}

/** nDCG over recall's return value - the measure stage 1 replaces. */
function ndcgOnReturn(frame, policy, gain) {
  const ranked = scoreFrame(frame, policy);
  assert.ok(ranked.ok);
  const idealGains = Object.values(frame.records)
    .map((record) => gain(record.id))
    .filter((value) => value > 0)
    .sort((a, b) => b - a);
  const idcg = dcgOf(idealGains);
  if (idcg === 0) return 0;
  return dcgOf(ranked.ranked.map((memory) => gain(memory.id))) / idcg;
}

/**
 * The falsification bank: a short relevant A, a long irrelevant B (1800
 * characters), and C (600 characters) that shares B's entity. Under the
 * candidate threshold C enters the ranking, B and C form a group, and the
 * grouped renderer puts the group ahead of loose A - so B's long line eats
 * the budget from the top. The return value keeps A on position one either
 * way; the block does not.
 */
function makeFalsificationBank() {
  const store = makeStore();
  const a = store.upsertMemory({
    kind: 'fact',
    content: 'harbor ledger compact note a',
    importance: 0.5,
    tags: ['harbor'],
  });
  const b = store.upsertMemory({
    kind: 'fact',
    content: 'harbor ledger ' + 'b'.repeat(1786),
    importance: 0.65,
  });
  const c = store.upsertMemory({
    kind: 'fact',
    content: 'harbor ' + 'c'.repeat(593),
    importance: 0.05,
  });
  linkEntities(store, ASSISTANT_MEMORY_OWNER, b.id, ['bulk']);
  linkEntities(store, ASSISTANT_MEMORY_OWNER, c.id, ['bulk']);
  return { store, a, b, c };
}

test('the block measure separates what the return-value measure cannot', () => {
  withFrozenClock(() => {
    const { store, a, b, c } = makeFalsificationBank();
    try {
      const gain = (id) => (id === a.id ? 1 : 0);
      const box = {
        ...boxFromOptions({ text: 'harbor ledger', limit: 8, threshold: 0.05, hopEntity: 0, hopEdge: 0 }),
        threshold: [0, 1],
      };
      const frame = fetchFrame(store, {
        text: 'harbor ledger',
        limit: 8,
        box,
        budgetChars: 2400,
        subject: 'this user',
      });
      assert.equal(frame.degraded, null);

      // Thresholds derived from the observed scores, so the construction
      // holds whatever bm25 did: base keeps C out, candidate lets it in.
      const observed = scoreFrame(frame, { limit: 8, threshold: 0, hopEntity: 0, hopEdge: 0 });
      assert.ok(observed.ok);
      const score = new Map(observed.ranked.map((memory) => [memory.id, memory.score]));
      assert.ok(
        (score.get(a.id) ?? 0) > (score.get(b.id) ?? 0) && (score.get(b.id) ?? 0) > (score.get(c.id) ?? 0),
        'bank construction expects score(a) > score(b) > score(c)',
      );
      const base = { limit: 8, hopEntity: 0, hopEdge: 0, threshold: ((score.get(c.id) ?? 0) + (score.get(b.id) ?? 0)) / 2 };
      const candidate = { limit: 8, hopEntity: 0, hopEdge: 0, threshold: (score.get(c.id) ?? 0) - 1e-9 };

      // Equal on the return value: A stays on position one in both arms.
      assert.equal(ndcgOnReturn(frame, candidate, gain), ndcgOnReturn(frame, base, gain));

      // Strictly worse on the block: B's group renders ahead of A and its
      // 1800 characters rip the budget from the top.
      const onBase = measure(frame, base, gain);
      const onCandidate = measure(frame, candidate, gain);
      assert.ok(onBase.ok && onCandidate.ok);
      assert.ok(onCandidate.score < onBase.score);
      // The base arm delivers the labelled row at position one and the
      // frame-relative ideal agrees with it exactly.
      assert.equal(onBase.ndcg, 1);
      assert.equal(onBase.coverage, 0.5);
    } finally {
      store.close();
    }
  });
});

/**
 * Eight rows of identical shape: six labelled (importance 0.6), two not
 * (importance 0.3). `linkAll` decides the structure: one shared entity
 * groups everything, per-row singleton entities leave everything loose.
 */
function makeStructureBank(linkAll) {
  const store = makeStore();
  const ids = [];
  for (let index = 0; index < 8; index += 1) {
    const memory = store.upsertMemory({
      kind: 'fact',
      content: 'Note ' + index + ' files the harbor ledger log.',
      importance: index < 6 ? 0.6 : 0.3,
    });
    ids.push(memory.id);
    if (linkAll) linkEntities(store, ASSISTANT_MEMORY_OWNER, memory.id, ['bulk']);
    else linkEntities(store, ASSISTANT_MEMORY_OWNER, memory.id, ['solo-' + index]);
  }
  return { store, ids };
}

test('the ideal is rendered with the same renderer as P (R14)', () => {
  withFrozenClock(() => {
    // Budget 278 with 35-character contents: the grouped arm keeps five of
    // the six labelled rows, the loose arm keeps six - and because P and the
    // ideal pay the same structural cost within each frame, both nDCGs are
    // exactly 1. A flat ideal would fit a sixth line into the concentrated
    // frame's denominator and push its nDCG below the spread one.
    const results = [];
    for (const linkAll of [true, false]) {
      const { store, ids } = makeStructureBank(linkAll);
      try {
        const gain = (id) => (ids.indexOf(id) < 6 ? 1 : 0);
        const options = { text: 'harbor ledger', limit: 8, threshold: 0.05 };
        const frame = fetchFrame(store, {
          ...options,
          box: boxFromOptions(options),
          budgetChars: 278,
          subject: 'this user',
        });
        const policy = { ...options, expand: false };
        const run = pipelineAssistant(frame, policy);
        assert.ok(run.ok);
        assert.equal(run.lines.length, linkAll ? 5 : 6, 'the budget bites as designed');
        const result = measure(frame, policy, gain);
        assert.ok(result.ok);
        assert.equal(result.ndcg, 1);
        results.push(result);
      } finally {
        store.close();
      }
    }
    assert.ok(Math.abs(results[0].ndcg - results[1].ndcg) < 1e-9);
  });
});

/** Two short labelled rows and one long unlabelled tail, all loose. */
function makeCostBank() {
  const store = makeStore();
  const one = store.upsertMemory({ kind: 'fact', content: 'harbor ledger gain one', importance: 0.6 });
  const two = store.upsertMemory({ kind: 'fact', content: 'harbor ledger gain two', importance: 0.6 });
  store.upsertMemory({ kind: 'fact', content: 'harbor ' + 'z'.repeat(1793), importance: 0.2 });
  return { store, one, two };
}

test('the measure is not scale-invariant: halving hits and characters moves it (H8)', () => {
  withFrozenClock(() => {
    const { store, one, two } = makeCostBank();
    try {
      const gain = (id) => (id === one.id || id === two.id ? 1 : 0);
      const options = { text: 'harbor ledger', limit: 8, threshold: 0.05, expand: false };
      const full = fetchFrame(store, {
        ...options,
        box: boxFromOptions(options),
        budgetChars: 2400,
        subject: 'this user',
      });
      // The same frame under half the budget: the long tail no longer fits,
      // the used characters drop, and the score must move - a ratio of hits
      // per character would not care.
      const half = { ...full, budgetChars: 1200 };
      const onFull = measure(full, options, gain);
      const onHalf = measure(half, options, gain);
      assert.ok(onFull.ok && onHalf.ok);
      assert.equal(onFull.ndcg, 1);
      assert.equal(onHalf.ndcg, 1);
      assert.ok(onHalf.chars < onFull.chars);
      assert.notEqual(onHalf.score, onFull.score);
    } finally {
      store.close();
    }
  });
});

test('a positive scalar multiple is recognised as no change, a different vector is not (H9)', () => {
  assert.equal(isScalarMultiple({ r: 1.1, i: 0.4, c: 0.3, u: 0.2 }, { r: 0.55, i: 0.2, c: 0.15, u: 0.1 }), true);
  assert.equal(isScalarMultiple({ r: 0.9, i: 0.4, c: 0.3, u: 0.2 }, { r: 0.55, i: 0.2, c: 0.15, u: 0.1 }), false);
  assert.equal(isScalarMultiple({ r: -1.1, i: -0.4, c: -0.3, u: -0.2 }, { r: 0.55, i: 0.2, c: 0.15, u: 0.1 }), false);
  assert.equal(isScalarMultiple({ r: 0, i: 0, c: 0, u: 0 }, { r: 0.55, i: 0.2, c: 0.15, u: 0.1 }), false);
  assert.equal(isScalarMultiple({ r: 1.1, i: 0.4, c: 0.3 }, { r: 0.55, i: 0.2, c: 0.15, u: 0.1 }), false);
});

test('normalising the incumbent weights is a null step, and doubling halves back to them (R13)', () => {
  assert.deepEqual(normaliseWeights(WEIGHTS), WEIGHTS);
  assert.deepEqual(
    normaliseWeights({ relevance: 1.1, importance: 0.4, recency: 0.3, usage: 0.2 }),
    WEIGHTS,
  );
});

test('a delta that is predominantly unlabelled positions is not label-backed (R2)', () => {
  assert.equal(deltaIsLabelBacked([]), true);
  assert.equal(
    deltaIsLabelBacked([
      { id: 'm1', labelPossible: true },
      { id: 'm2', labelPossible: true },
    ]),
    true,
  );
  assert.equal(
    deltaIsLabelBacked([
      { id: 'm1', labelPossible: true },
      { id: 'm2', labelPossible: false },
    ]),
    false,
  );
  assert.equal(
    deltaIsLabelBacked([
      { id: 'm1', labelPossible: false },
      { id: 'm2', labelPossible: false },
      { id: 'm3', labelPossible: true },
    ]),
    false,
  );
});

test('coverage is reported, and an empty label set abstains', () => {
  withFrozenClock(() => {
    const { store, one, two } = makeCostBank();
    try {
      const options = { text: 'harbor ledger', limit: 8, threshold: 0.05, expand: false };
      const frame = fetchFrame(store, {
        ...options,
        box: boxFromOptions(options),
        budgetChars: 2400,
        subject: 'this user',
      });
      const partial = measure(frame, options, (id) => (id === one.id ? 1 : 0));
      assert.ok(partial.ok);
      assert.equal(typeof partial.coverage, 'number');
      assert.equal(partial.coverage, 1 / 3);
      assert.equal(partial.reachableRate, 1);

      const none = measure(frame, options, () => 0);
      assert.deepEqual(none, { ok: false, abstain: 'no-reachable-label' });
    } finally {
      store.close();
    }
  });
});

test('three worlds, not two: a legitimate empty ranking is scored, a degraded turn abstains', () => {
  withFrozenClock(() => {
    const { store, one, two } = makeCostBank();
    try {
      const gain = (id) => (id === one.id || id === two.id ? 1 : 0);
      // World three: rows came, all fell below the threshold. Scored, not
      // abstained - and never inferred from an empty list.
      const miss = fetchFrame(store, {
        text: 'harbor ledger',
        limit: 8,
        threshold: 50,
        box: boxFromOptions({ text: 'harbor ledger', limit: 8, threshold: 50 }),
      });
      assert.equal(miss.degraded, null);
      assert.ok(miss.hop1.length > 0);
      const scored = measure(miss, { limit: 8, threshold: 50 }, gain);
      assert.ok(scored.ok);
      assert.equal(scored.ndcg, 0);
      assert.equal(scored.score, 0);

      // World one: a query out of stop words alone abstains.
      const stop = fetchFrame(store, { text: 'the a of is', limit: 8 });
      assert.equal(stop.degraded, 'no-tokens');
      assert.deepEqual(measure(stop, { limit: 8 }, gain), { ok: false, abstain: 'degraded-turn' });
    } finally {
      store.close();
    }
  });
});
