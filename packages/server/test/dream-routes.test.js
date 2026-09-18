import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { ASSISTANT_MEMORY_OWNER, Assistant, ProviderRegistry, Store } from '@rookery/core';
import { registerDreamRoutes } from '../dist/routes/dream.js';
import { registerMemoryRoutes } from '../dist/routes/memories.js';
import { buildServer } from '../dist/server.js';

/**
 * The dream's HTTP surface (AP13, concept 9.6): what is in force per slot,
 * a version's history, the manual promote/revert doors, the evaluation and
 * episode listings, and the night trigger under `/api/dream/run`.
 *
 * The first test drives the real, full server (`buildServer`) the way
 * `questions.test.js` does, because `routes/dream.ts` adds no auth or
 * same-origin guard of its own - exactly like its neighbours
 * `routes/memories.ts` and `routes/sleep.ts` - so what protects it is the
 * global hooks `server.ts` registers, and only the full server has those.
 * The rest drive `registerDreamRoutes` directly on a bare Fastify instance,
 * against a real in-memory `Store` but a scripted `assistant.sleep` /
 * `assistant.sleepNow` - the same scoped style `cron.test.js` and
 * `profile.test.js` use for routes that do not need a whole running
 * assistant to prove their own logic.
 */

async function authedServer(token) {
  const home = mkdtempSync(join(tmpdir(), 'rookery-dream-auth-'));
  const assistant = new Assistant({
    store: new Store(':memory:'),
    registry: new ProviderRegistry([]),
    config: { home, logLevel: 'silent', token, memory: { enabled: false, autoExtract: false }, org: { autoReview: false } },
  });
  const app = await buildServer(assistant, { quiet: true });
  return {
    app,
    async dispose() {
      await app.close();
      assistant.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test('dream routes require the same bearer token and same origin as every other /api route, and answer before the SPA fallback would', async (t) => {
  const token = 'dream-test-token';
  const { app, dispose } = await authedServer(token);
  t.after(dispose);
  const auth = { authorization: 'Bearer ' + token, origin: 'http://localhost:80' };

  const routes = [
    ['GET', '/api/dream/policies'],
    ['GET', '/api/dream/policies/recall/history'],
    ['POST', '/api/dream/policies/none/promote'],
    ['POST', '/api/dream/policies/none/revert'],
    ['GET', '/api/dream/evals'],
    ['GET', '/api/dream/traces'],
    ['POST', '/api/dream/run'],
  ];

  for (const [method, url] of routes) {
    const unauthenticated = await app.inject({ method, url });
    assert.equal(unauthenticated.statusCode, 401, method + ' ' + url + ' without a bearer token');
  }

  // GET/HEAD are not gated by same-origin (server.ts:131-137, 144); only the
  // mutating routes are, so only those are exercised cross-origin here.
  for (const [method, url] of routes.filter(([m]) => m !== 'GET')) {
    const crossOrigin = await app.inject({
      method,
      url,
      headers: { ...auth, origin: 'https://untrusted.example' },
    });
    assert.equal(crossOrigin.statusCode, 403, method + ' ' + url + ' from a foreign origin');
  }

  // Real JSON, not the SPA's index.html: proof the routes are registered
  // ahead of `registerStatic` the way concept 9.6 requires.
  const policies = await app.inject({ method: 'GET', url: '/api/dream/policies', headers: auth });
  assert.equal(policies.statusCode, 200);
  assert.match(policies.headers['content-type'], /json/);
  assert.deepEqual(
    policies.json().map((row) => row.slot),
    ['recall', 'budget', 'retry'],
  );

  const history = await app.inject({ method: 'GET', url: '/api/dream/policies/recall/history', headers: auth });
  assert.equal(history.statusCode, 200);
  assert.deepEqual(history.json(), []);

  const badSlot = await app.inject({ method: 'GET', url: '/api/dream/policies/nope/history', headers: auth });
  assert.equal(badSlot.statusCode, 400);
});

/** A bare Fastify around `registerDreamRoutes`, a real in-memory Store, and a scripted sleep/sleepNow. */
function fixture(overrides = {}) {
  const store = new Store(':memory:');
  const warnings = [];
  const context = {
    assistant: {
      store,
      sleep: { isRunning: () => false, cancel: () => false, activeOwners: [] },
      sleepNow: async (owner) => ({ owner, started: true }),
      ...overrides,
    },
    log: { warn: (message, meta) => warnings.push({ message, meta }), info() {} },
  };
  return { store, context, warnings };
}

async function buildApp(context) {
  const app = Fastify();
  await registerDreamRoutes(app, context);
  return app;
}

function makeVersion(store, { slot = 'recall', measured = false, owner = ASSISTANT_MEMORY_OWNER } = {}) {
  return store.createPolicyVersion({
    owner,
    slot,
    params: { k: 1 },
    box: { k: [1, 1] },
    origin: 'dream',
    ...(measured
      ? { replayScore: 0.61, replayN: 40, baselineScore: 0.55, auditDelta: 0.02, auditCiLow: 0.01 }
      : {}),
  });
}

test('every slot starts with no active policy, and history is newest-version-first', async (t) => {
  const { store, context } = fixture();
  const app = await buildApp(context);
  t.after(() => app.close());

  const listed = (await app.inject({ url: '/api/dream/policies' })).json();
  assert.deepEqual(listed.map((row) => [row.slot, row.active]), [
    ['recall', null],
    ['budget', null],
    ['retry', null],
  ]);
  for (const row of listed) assert.deepEqual(row.state, { owner: ASSISTANT_MEMORY_OWNER, slot: row.slot });

  const v1 = makeVersion(store);
  const v2 = makeVersion(store);
  const history = (await app.inject({ url: '/api/dream/policies/recall/history' })).json();
  assert.deepEqual(history.map((row) => row.id), [v2.id, v1.id]);

  const limited = (await app.inject({ url: '/api/dream/policies/recall/history?limit=1' })).json();
  assert.equal(limited.length, 1);
  assert.equal(limited[0].id, v2.id);
});

test('promote only accepts a measured, never-promoted-or-retired version, and retires whatever it replaces', async (t) => {
  const { store, context } = fixture();
  const app = await buildApp(context);
  t.after(() => app.close());

  const missing = await app.inject({ method: 'POST', url: '/api/dream/policies/no-such-id/promote' });
  assert.equal(missing.statusCode, 404);

  const unmeasured = makeVersion(store, { measured: false });
  const blocked = await app.inject({ method: 'POST', url: '/api/dream/policies/' + unmeasured.id + '/promote' });
  assert.equal(blocked.statusCode, 409);

  const v1 = makeVersion(store, { measured: true });
  const first = await app.inject({ method: 'POST', url: '/api/dream/policies/' + v1.id + '/promote' });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().ok, true);
  assert.equal(first.json().version.promotedAt !== undefined, true);
  assert.equal(first.json().prevActiveId, null);
  assert.equal(store.activePolicy(ASSISTANT_MEMORY_OWNER, 'recall').id, v1.id);

  const again = await app.inject({ method: 'POST', url: '/api/dream/policies/' + v1.id + '/promote' });
  assert.equal(again.statusCode, 409, 'already in force');

  const v2 = makeVersion(store, { measured: true });
  const second = await app.inject({ method: 'POST', url: '/api/dream/policies/' + v2.id + '/promote' });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().prevActiveId, v1.id);
  assert.equal(store.activePolicy(ASSISTANT_MEMORY_OWNER, 'recall').id, v2.id);
  assert.equal(store.policyVersion(v1.id).retiredAt !== undefined, true, 'the replaced version is retired');

  const retiredAgain = await app.inject({ method: 'POST', url: '/api/dream/policies/' + v1.id + '/promote' });
  assert.equal(retiredAgain.statusCode, 409, 'a retired version cannot be promoted directly');
});

test('revert takes a promotion back over prevActiveId, refuses what it cannot, and honours the owner filter', async (t) => {
  const { store, context } = fixture();
  const app = await buildApp(context);
  t.after(() => app.close());

  const missing = await app.inject({ method: 'POST', url: '/api/dream/policies/no-such-id/revert' });
  assert.equal(missing.statusCode, 404);

  const v1 = makeVersion(store, { measured: true });
  const neverPromoted = await app.inject({ method: 'POST', url: '/api/dream/policies/' + v1.id + '/revert' });
  assert.equal(neverPromoted.statusCode, 409);

  await app.inject({ method: 'POST', url: '/api/dream/policies/' + v1.id + '/promote' });
  const v2 = makeVersion(store, { measured: true });
  await app.inject({ method: 'POST', url: '/api/dream/policies/' + v2.id + '/promote' });
  assert.equal(store.activePolicy(ASSISTANT_MEMORY_OWNER, 'recall').id, v2.id);

  const foreignOwner = await app.inject({
    method: 'POST',
    url: '/api/dream/policies/' + v2.id + '/revert?owner=agent:someone-else',
  });
  assert.equal(foreignOwner.statusCode, 404);

  const reverted = await app.inject({ method: 'POST', url: '/api/dream/policies/' + v2.id + '/revert' });
  assert.equal(reverted.statusCode, 200);
  assert.equal(reverted.json().ok, true);
  assert.equal(reverted.json().restored.id, v1.id, 'prevActiveId comes back in force');
  assert.equal(store.activePolicy(ASSISTANT_MEMORY_OWNER, 'recall').id, v1.id);

  const twice = await app.inject({ method: 'POST', url: '/api/dream/policies/' + v2.id + '/revert' });
  assert.equal(twice.statusCode, 409, 'already retired');
});

test('evals list newest first and filter by slot, policy, owner and promoted', async (t) => {
  const { store, context } = fixture();
  const app = await buildApp(context);
  t.after(() => app.close());

  const version = makeVersion(store, { measured: true });
  const baseEval = (overrides) => ({
    sleepRunId: 'run-1',
    policyId: version.id,
    slot: 'recall',
    traces: 40,
    closed: 32,
    abstained: 8,
    abstainReasons: {},
    reachableRate: 0.8,
    labelCoverage: 0.5,
    costOnlyShare: 0.1,
    score: 0.62,
    baseline: 0.55,
    delta: 0.07,
    ciLow: 0.01,
    ciHigh: 0.13,
    evalMs: 120,
    traceSetHash: 'hash-a',
    signAgree: null,
    promoted: false,
    ...overrides,
  });
  const older = store.recordDreamEval(baseEval({ createdAt: Date.now() - 1000, traceSetHash: 'hash-a' }));
  const newer = store.recordDreamEval(baseEval({ createdAt: Date.now(), promoted: true, traceSetHash: 'hash-b' }));

  const all = (await app.inject({ url: '/api/dream/evals' })).json();
  assert.deepEqual(all.map((row) => row.id), [newer.id, older.id]);

  const promotedOnly = (await app.inject({ url: '/api/dream/evals?promoted=1' })).json();
  assert.deepEqual(promotedOnly.map((row) => row.id), [newer.id]);

  const byPolicy = (await app.inject({ url: '/api/dream/evals?policyId=' + version.id })).json();
  assert.equal(byPolicy.length, 2);

  const wrongSlotIgnored = (await app.inject({ url: '/api/dream/evals?slot=not-a-slot' })).json();
  assert.equal(wrongSlotIgnored.length, 2, 'an unrecognised slot is dropped, not a 400');

  const foreignOwner = (await app.inject({ url: '/api/dream/evals?owner=agent:someone-else' })).json();
  assert.deepEqual(foreignOwner, []);
});

test('traces read the episode index by holdout/audit/slot, and never the frame payload', async (t) => {
  const { store, context } = fixture();
  const app = await buildApp(context);
  t.after(() => app.close());

  store.recordDreamEpisode({
    id: 'turn-1',
    owner: ASSISTANT_MEMORY_OWNER,
    kind: 'turn',
    sessionId: 'session-1',
    slot: 'recall',
    steps: 3,
    outcome: 'success',
    holdout: true,
    audit: false,
    startedAt: Date.now() - 500,
  });
  store.recordDreamEpisode({
    id: 'turn-2',
    owner: ASSISTANT_MEMORY_OWNER,
    kind: 'turn',
    sessionId: 'session-2',
    slot: 'budget',
    steps: 1,
    outcome: 'failure',
    holdout: false,
    audit: true,
    startedAt: Date.now(),
  });

  const all = (await app.inject({ url: '/api/dream/traces' })).json();
  assert.equal(all.length, 2);
  // `finishedAt` is `undefined` for a still-open episode, which `app.inject`'s
  // JSON round trip drops rather than nulls - the absence itself is the
  // proof no frame payload rode along disguised as an extra field.
  assert.deepEqual(Object.keys(all[0]).sort(), [
    'audit',
    'createdAt',
    'holdout',
    'id',
    'kind',
    'outcome',
    'owner',
    'sessionId',
    'slot',
    'startedAt',
    'steps',
  ]);

  const holdoutOnly = (await app.inject({ url: '/api/dream/traces?holdout=1' })).json();
  assert.deepEqual(holdoutOnly.map((row) => row.id), ['turn-1']);

  const auditOnly = (await app.inject({ url: '/api/dream/traces?audit=1' })).json();
  assert.deepEqual(auditOnly.map((row) => row.id), ['turn-2']);

  const bySlot = (await app.inject({ url: '/api/dream/traces?slot=budget' })).json();
  assert.deepEqual(bySlot.map((row) => row.id), ['turn-2']);
});

test('run mirrors /api/sleep/run: 409 while already sleeping, otherwise fire-and-forget 202 or an awaited result under ?wait=1', async (t) => {
  {
    const { context } = fixture({ sleep: { isRunning: () => true, cancel: () => false, activeOwners: [ASSISTANT_MEMORY_OWNER] } });
    let called = false;
    context.assistant.sleepNow = async () => {
      called = true;
      return { ok: true };
    };
    const app = await buildApp(context);
    t.after(() => app.close());
    const busy = await app.inject({ method: 'POST', url: '/api/dream/run' });
    assert.equal(busy.statusCode, 409);
    assert.equal(called, false, 'a bank already sleeping is never asked to sleep again');
  }

  {
    const calls = [];
    const { context, warnings } = fixture();
    context.assistant.sleepNow = async (owner) => {
      calls.push(owner);
      return { owner, finished: true };
    };
    const app = await buildApp(context);
    t.after(() => app.close());

    const fired = await app.inject({ method: 'POST', url: '/api/dream/run', payload: { owner: 'agent:writer' } });
    assert.equal(fired.statusCode, 202);
    assert.deepEqual(fired.json(), { started: true, owner: 'agent:writer' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['agent:writer']);
    assert.deepEqual(warnings, [], 'a successful fire-and-forget run logs nothing');

    const waited = await app.inject({ method: 'POST', url: '/api/dream/run?wait=1' });
    assert.equal(waited.statusCode, 200);
    assert.deepEqual(waited.json(), { owner: ASSISTANT_MEMORY_OWNER, finished: true });
    assert.deepEqual(calls, ['agent:writer', ASSISTANT_MEMORY_OWNER]);
  }

  {
    const { context, warnings } = fixture();
    context.assistant.sleepNow = async () => {
      throw new Error('provider unavailable');
    };
    const app = await buildApp(context);
    t.after(() => app.close());
    const fired = await app.inject({ method: 'POST', url: '/api/dream/run' });
    assert.equal(fired.statusCode, 202, 'the failure surfaces later, not as a bad response to the trigger');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /Dream run failed/);
  }
});

/*
 * `routes/memories.ts` also belongs to AP13 this wave (the actor parameter,
 * S5; the feedback route, S6), and the package owns no other server test
 * file to put its coverage in - it lives here, next to the routes it was
 * built alongside.
 */

function memoryApp() {
  const store = new Store(':memory:');
  const context = { assistant: { store } };
  const app = Fastify();
  return { store, context, ready: registerMemoryRoutes(app, context).then(() => app) };
}

test('PATCH and DELETE pass the user actor through, so only the HTTP path ever leaves a user label', async (t) => {
  const { store, ready } = memoryApp();
  const app = await ready;
  t.after(() => app.close());

  // `#writeUserLabel` (store.ts) attributes to the memory's own source
  // session and writes nothing without one (concept 4.2b) - a memory with
  // no session behind it has no locator to write a label against at all.
  const memory = store.upsertMemory({
    kind: 'fact',
    content: 'Loopback binds by default.',
    sourceSessionId: 'session-1',
  });

  const pinned = await app.inject({ method: 'PATCH', url: '/api/memories/' + memory.id, payload: { pinned: true } });
  assert.equal(pinned.statusCode, 200);
  const pinLabels = store.db
    .prepare("SELECT relevance, scope, source FROM dream_labels WHERE target = ? AND evidence = 'updateMemory:user'")
    .all(memory.id)
    .map((row) => ({ ...row }));
  assert.deepEqual(pinLabels, [{ relevance: 1, scope: 'session', source: 'user' }]);

  const forgotten = await app.inject({ method: 'DELETE', url: '/api/memories/' + memory.id });
  assert.equal(forgotten.statusCode, 200);
  const forgetLabels = store.db
    .prepare("SELECT relevance, scope, source FROM dream_labels WHERE target = ? AND evidence = 'forgetMemory:user'")
    .all(memory.id)
    .map((row) => ({ ...row }));
  assert.deepEqual(forgetLabels, [{ relevance: 0, scope: 'session', source: 'user' }]);
});

test('the feedback route writes a turn-scoped user label from the chat highlight, and validates its body', async (t) => {
  const { store, ready } = memoryApp();
  const app = await ready;
  t.after(() => app.close());

  const missing = await app.inject({
    method: 'POST',
    url: '/api/memories/no-such-id/feedback',
    payload: { turnId: 'turn-1', verdict: 'point' },
  });
  assert.equal(missing.statusCode, 404);

  const memory = store.upsertMemory({
    kind: 'fact',
    content: 'The user prefers dark mode.',
    sourceSessionId: 'session-7',
  });

  for (const bad of [{}, { turnId: 'turn-1' }, { turnId: '', verdict: 'point' }, { turnId: 'turn-1', verdict: 'meh' }]) {
    const rejected = await app.inject({ method: 'POST', url: '/api/memories/' + memory.id + '/feedback', payload: bad });
    assert.equal(rejected.statusCode, 400, JSON.stringify(bad));
  }

  const point = await app.inject({
    method: 'POST',
    url: '/api/memories/' + memory.id + '/feedback',
    payload: { turnId: 'turn-42', verdict: 'point' },
  });
  assert.equal(point.statusCode, 200);
  assert.deepEqual(point.json(), { ok: true });

  const row = { ...store.db
    .prepare('SELECT turn_id, target, source, relevance, scope, session_id, owner FROM dream_labels WHERE turn_id = ?')
    .get('turn-42') };
  assert.deepEqual(row, {
    turn_id: 'turn-42',
    target: memory.id,
    source: 'user',
    relevance: 1,
    scope: 'turn',
    session_id: 'session-7',
    owner: ASSISTANT_MEMORY_OWNER,
  });

  const ballast = await app.inject({
    method: 'POST',
    url: '/api/memories/' + memory.id + '/feedback',
    payload: { turnId: 'turn-43', verdict: 'ballast' },
  });
  assert.equal(ballast.statusCode, 200);
  const relevance = store.db.prepare('SELECT relevance FROM dream_labels WHERE turn_id = ?').get('turn-43');
  assert.equal(relevance.relevance, 0);
});
