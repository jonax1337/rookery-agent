import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSISTANT_MEMORY_OWNER, DEFAULT_CONFIG, Store } from '../dist/index.js';
import { factoryPolicy, resolvePolicy } from '../dist/memory/dream/policy.js';

/**
 * The resolver (dream stage 3, AP10; concept 9.3, S18, S23).
 *
 * Four load-bearing behaviours, each its own test:
 *
 * - With no promoted `policy_versions` row, `resolvePolicy` is exactly
 *   stage 1's no-op: every value comes from the config or the factory
 *   literal, every origin is `'default'`.
 * - A promoted version wins over a config value still sitting at its
 *   factory default - that field's origin becomes `'dream'`.
 * - A config value that has moved off its factory default wins over a
 *   promoted version for the *same* field (9.3's settings-page collision):
 *   the promoted number is never even looked at, and the origin is
 *   `'user'`, not `'dream'`.
 * - Config read through `rookery config set` bypasses zod entirely, so an
 *   out-of-range config value is clamped here at read time (E21/S23), on
 *   the identical range `packages/server/src/schemas.ts` enforces on the
 *   HTTP patch path (recallLimit: int 0..50, recallThreshold: 0..1).
 *
 * `factoryPolicy()` is checked separately: it must stay the literal set
 * regardless of what the live config or the promoted version say, because
 * AP9's audit comparison (condition 2b) depends on it never drifting.
 */

const OWNER = ASSISTANT_MEMORY_OWNER;

// The weights `recall.ts` ships as `WEIGHTS` - no config surface exists for
// them, so they are the only fixed point a promotion can move away from.
const FACTORY_WEIGHTS = { relevance: 0.55, importance: 0.2, recency: 0.15, usage: 0.1 };

function makeStore() {
  return new Store(':memory:');
}

function promote(store, params, overrides = {}) {
  const version = store.createPolicyVersion({
    owner: OWNER,
    slot: 'recall',
    params,
    box: { limitMax: 50 },
    origin: 'dream',
    ...overrides,
  });
  store.promotePolicyVersion(version.id, {});
  return version;
}

test('no promoted version is stage 1, byte for byte', () => {
  const store = makeStore();
  const policy = resolvePolicy(store, DEFAULT_CONFIG, OWNER, 'recall');

  assert.equal(policy.limit, DEFAULT_CONFIG.memory.recallLimit);
  assert.equal(policy.threshold, DEFAULT_CONFIG.memory.recallThreshold);
  assert.equal(policy.hopEntity, DEFAULT_CONFIG.memory.graph.hopEntity);
  assert.equal(policy.hopEdge, DEFAULT_CONFIG.memory.graph.hopEdge);
  assert.deepEqual(policy.w, FACTORY_WEIGHTS);
  assert.deepEqual(policy.origin, {
    limit: 'default',
    threshold: 'default',
    hopEntity: 'default',
    hopEdge: 'default',
    relevance: 'default',
    importance: 'default',
    recency: 'default',
    usage: 'default',
  });
  store.close();
});

test('a promoted version wins over a config value still at its default', () => {
  const store = makeStore();
  promote(store, {
    limit: 12,
    threshold: 0.2,
    hopEntity: 0.3,
    hopEdge: 0.4,
    w: { relevance: 0.5, importance: 0.25, recency: 0.15, usage: 0.1 },
  });

  const policy = resolvePolicy(store, DEFAULT_CONFIG, OWNER, 'recall');

  assert.equal(policy.limit, 12);
  assert.equal(policy.threshold, 0.2);
  assert.equal(policy.hopEntity, 0.3);
  assert.equal(policy.hopEdge, 0.4);
  assert.deepEqual(policy.w, { relevance: 0.5, importance: 0.25, recency: 0.15, usage: 0.1 });
  assert.deepEqual(policy.origin, {
    limit: 'dream',
    threshold: 'dream',
    hopEntity: 'dream',
    hopEdge: 'dream',
    relevance: 'dream',
    importance: 'dream',
    recency: 'dream',
    usage: 'dream',
  });
  store.close();
});

test('a user-set config value wins over a promoted version for that field', () => {
  const store = makeStore();
  promote(store, { limit: 12, threshold: 0.2 });

  // recallLimit deviates from the factory default (8); recallThreshold does
  // not, so threshold is free to take the promoted value.
  const config = {
    ...DEFAULT_CONFIG,
    memory: { ...DEFAULT_CONFIG.memory, recallLimit: 20 },
  };
  const policy = resolvePolicy(store, config, OWNER, 'recall');

  assert.equal(policy.limit, 20, 'the user value, not the promoted 12');
  assert.equal(policy.origin.limit, 'user');
  assert.equal(policy.threshold, 0.2, 'threshold was still at its default, so the promotion wins');
  assert.equal(policy.origin.threshold, 'dream');
  store.close();
});

test('a config value at its factory default is not "user" even with a promotion active', () => {
  const store = makeStore();
  promote(store, { hopEntity: 0.33 });

  const policy = resolvePolicy(store, DEFAULT_CONFIG, OWNER, 'recall');

  assert.equal(policy.hopEdge, DEFAULT_CONFIG.memory.graph.hopEdge);
  assert.equal(policy.origin.hopEdge, 'default', 'untouched field, no promotion for it either');
  assert.equal(policy.hopEntity, 0.33);
  assert.equal(policy.origin.hopEntity, 'dream');
  store.close();
});

test('out-of-range config is clamped on read, never trusted', () => {
  const store = makeStore();

  // `rookery config set` bypasses the patch schema entirely (E21); a value
  // like this can genuinely land in the config file.
  const config = {
    ...DEFAULT_CONFIG,
    memory: {
      ...DEFAULT_CONFIG.memory,
      recallLimit: 999,
      recallThreshold: -4,
      graph: { hopEntity: 7, hopEdge: -1 },
    },
  };
  const policy = resolvePolicy(store, config, OWNER, 'recall');

  assert.equal(policy.limit, 50, 'clamped to the schemas.ts ceiling');
  assert.equal(policy.threshold, 0, 'clamped to the schemas.ts floor');
  assert.equal(policy.hopEntity, 1, 'hop weights clamp to 0..1 the same way');
  assert.equal(policy.hopEdge, 0);
  // Every one of these deviates from its factory default once clamped, so
  // each still counts as a user value - a promotion still must not win here.
  assert.deepEqual(policy.origin, {
    limit: 'user',
    threshold: 'user',
    hopEntity: 'user',
    hopEdge: 'user',
    relevance: 'default',
    importance: 'default',
    recency: 'default',
    usage: 'default',
  });
  store.close();
});

test('an out-of-range promoted value is clamped on read too', () => {
  const store = makeStore();
  promote(store, { w: { relevance: 3, importance: -1, recency: 0.15, usage: 0.1 } });

  const policy = resolvePolicy(store, DEFAULT_CONFIG, OWNER, 'recall');

  assert.equal(policy.w.relevance, 1, 'a promoted weight is clamped exactly like a config value');
  assert.equal(policy.w.importance, 0);
  assert.equal(policy.origin.relevance, 'dream');
  store.close();
});

test('a retired promotion is invisible again', () => {
  const store = makeStore();
  const version = promote(store, { limit: 30 });
  store.retirePolicyVersion(version.id);

  const policy = resolvePolicy(store, DEFAULT_CONFIG, OWNER, 'recall');

  assert.equal(policy.limit, DEFAULT_CONFIG.memory.recallLimit);
  assert.equal(policy.origin.limit, 'default');
  store.close();
});

test('a malformed or missing promoted field falls back to the default, not a crash', () => {
  const store = makeStore();
  promote(store, { limit: 'a lot', w: 'not an object' });

  const policy = resolvePolicy(store, DEFAULT_CONFIG, OWNER, 'recall');

  assert.equal(policy.limit, DEFAULT_CONFIG.memory.recallLimit);
  assert.equal(policy.origin.limit, 'default');
  assert.deepEqual(policy.w, FACTORY_WEIGHTS);
  assert.equal(policy.origin.relevance, 'default');
  store.close();
});

test('a promotion never leaks across owners or slots', () => {
  const store = makeStore();
  promote(store, { limit: 33 }, { owner: 'agent:scribe' });

  const policy = resolvePolicy(store, DEFAULT_CONFIG, OWNER, 'recall');

  assert.equal(policy.limit, DEFAULT_CONFIG.memory.recallLimit, 'a different owner, no promotion here');
  assert.equal(policy.origin.limit, 'default');
  store.close();
});

test('factoryPolicy() ignores both the live config and any promotion', () => {
  const store = makeStore();
  promote(store, { limit: 40, threshold: 0.9, hopEntity: 0.9, hopEdge: 0.9 });
  const config = {
    ...DEFAULT_CONFIG,
    memory: { ...DEFAULT_CONFIG.memory, recallLimit: 40, recallThreshold: 0.9 },
  };

  // factoryPolicy takes no store and no config - it cannot see either.
  const factory = factoryPolicy();

  assert.equal(factory.limit, DEFAULT_CONFIG.memory.recallLimit);
  assert.equal(factory.threshold, DEFAULT_CONFIG.memory.recallThreshold);
  assert.equal(factory.hopEntity, DEFAULT_CONFIG.memory.graph.hopEntity);
  assert.equal(factory.hopEdge, DEFAULT_CONFIG.memory.graph.hopEdge);
  assert.deepEqual(factory.w, FACTORY_WEIGHTS);
  assert.deepEqual(factory.origin, {
    limit: 'default',
    threshold: 'default',
    hopEntity: 'default',
    hopEdge: 'default',
    relevance: 'default',
    importance: 'default',
    recency: 'default',
    usage: 'default',
  });

  // Prove the fixtures above were not accidentally no-ops.
  const live = resolvePolicy(store, config, OWNER, 'recall');
  assert.notEqual(live.limit, factory.limit);
  store.close();
});
