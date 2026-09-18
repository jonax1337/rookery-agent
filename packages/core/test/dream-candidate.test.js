import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSISTANT_MEMORY_OWNER } from '../dist/index.js';
import {
  buildAggregates,
  parseCandidate,
  proposeCandidates,
  renderCandidatePrompt,
  withIncumbent,
} from '../dist/memory/dream/candidate.js';
import { WEIGHTS } from '../dist/memory/recall.js';

/**
 * The candidate writer (dream stage 2, AP6; concept 6.2).
 *
 * The acceptance of this package is the CONSTRUCTION test below: the writer's
 * whole input is a typed structure of numeric aggregates, and the test walks
 * a real instance of it and refuses anything that is not a number. There is
 * deliberately no "no substring of a trace appears in the prompt" test: a
 * prompt built out of numbers cannot fail one, so it would prove nothing
 * (E13).
 *
 * No frozen clock here, and no store: a frame carries its own `now`, so every
 * function in this module is pure over hand-built frames - the same fixture
 * style dream-recorder-store.test.js uses.
 */

const NOW = Date.parse('2026-09-17T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const BOX = {
  limitMax: 16,
  w: {
    relevance: [0.45, 0.65],
    importance: [0.1, 0.3],
    recency: [0.05, 0.25],
    usage: [0.0, 0.2],
  },
  threshold: [0.05, 0.3],
  hopEntity: [0.0, 0.9],
  hopEdge: [0.4, 0.8],
  kinds: [],
  minImportance: 0,
};

const INCUMBENT = {
  limit: 8,
  threshold: 0.12,
  w: { ...WEIGHTS },
  hopEntity: 0.45,
  hopEdge: 0.6,
  kinds: [],
  minImportance: 0,
  origin: {
    limit: 'default',
    threshold: 'default',
    hopEntity: 'default',
    hopEdge: 'default',
    relevance: 'default',
    importance: 'default',
    recency: 'default',
    usage: 'default',
  },
};

/** The point the aggregates diagnose: the incumbent with the hops switched off. */
const POINT = { limit: 8, threshold: 0.12, w: { ...WEIGHTS }, hopEntity: 0, hopEdge: 0 };

function record(id, overrides = {}) {
  return {
    id,
    kind: 'fact',
    content: 'harbour ledger ' + id,
    tags: [],
    importance: 0.5,
    owner: ASSISTANT_MEMORY_OWNER,
    createdAt: NOW - 3 * DAY,
    updatedAt: NOW - 3 * DAY,
    accessCount: 0,
    forgotten: false,
    origin: 'model',
    pinned: false,
    usefulness: 0,
    ...overrides,
  };
}

function frame(overrides = {}) {
  return {
    v: 1,
    site: 'turn',
    pipeline: 'assistant',
    owner: ASSISTANT_MEMORY_OWNER,
    box: BOX,
    query: {
      text: 'what did we decide about the harbour ledger?',
      matchQuery: 'harbour OR ledger',
      tokens: ['harbour', 'ledger'],
    },
    now: NOW,
    corpusStampId: 'stamp-1',
    maxRelevanceClamped: 6,
    budgetChars: 300,
    subject: 'this user',
    records: {},
    hop1: [],
    possibleSeeds: [],
    entities: {},
    entityNeighbours: {},
    edges: [],
    contradicts: [],
    profile: [],
    degraded: null,
    ...overrides,
  };
}

/**
 * One turn where the character budget ripped before the proven memory: two
 * long lines, room for one. `top` outranks `proven` on relevance and
 * importance, so the renderer never reaches the row the user later proved
 * right.
 */
function budgetCutFrame() {
  const top = record('top', { content: 'T'.repeat(200), importance: 0.9 });
  const proven = record('proven', {
    content: 'P'.repeat(200),
    importance: 0.2,
    tags: ['harbour'],
  });
  return frame({
    records: { top, proven },
    hop1: [
      { id: 'top', relevance: 6 },
      { id: 'proven', relevance: 3 },
    ],
    budgetChars: 300,
  });
}

/**
 * One turn where the proven memory was never in the first hop at all: it
 * hangs off the direct hit's entity, and only the second hop reaches it.
 */
function hopTwoFrame() {
  const top = record('top2', { content: 'short direct hit', importance: 0.9 });
  const neighbour = record('neighbour', { content: 'the proven neighbour', importance: 0.5 });
  return frame({
    records: { top2: top, neighbour },
    hop1: [{ id: 'top2', relevance: 6 }],
    possibleSeeds: ['top2'],
    entities: { top2: [{ entityId: 'e1', name: 'harbour', mentions: 3 }] },
    entityNeighbours: { e1: ['neighbour'] },
    budgetChars: 2400,
  });
}

/** A turn the pipeline cannot replay at all: counted, never diagnosed. */
function degradedFrame() {
  return frame({ degraded: 'no-tokens' });
}

/** Everything the aggregates are allowed to contain, checked one field deep at a time. */
function assertNumbersAllTheWayDown(value, path) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNumbersAllTheWayDown(entry, path + '[' + index + ']'));
    return;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    assert.ok(keys.length > 0, path + ' is an empty object, so it asserts nothing');
    for (const key of keys) assertNumbersAllTheWayDown(value[key], path + '.' + key);
    return;
  }
  assert.equal(typeof value, 'number', path + ' is a ' + typeof value + ', not a number');
  assert.ok(Number.isFinite(value), path + ' is not a finite number');
}

test('the writer sees numbers only - every field of the aggregates, recursively', () => {
  const gain = (id) => (id === 'proven' || id === 'neighbour' ? 1 : 0);
  const aggregates = buildAggregates(
    [budgetCutFrame(), hopTwoFrame(), degradedFrame()],
    gain,
    POINT,
  );

  // The frames carry a question, memory content, tags and ids; the structure
  // built from them carries none of it - not as a field, not nested, not in
  // an array (S15/E13).
  assertNumbersAllTheWayDown(aggregates, 'aggregates');
  assert.equal(aggregates.cases, 2, 'both replayable turns missed a proven memory');
  assert.equal(aggregates.abstained, 1, 'the degraded turn is counted, not diagnosed');
});

test('a case names the components of what should have been on top against what was', () => {
  const gain = (id) => (id === 'proven' ? 1 : 0);
  const aggregates = buildAggregates([budgetCutFrame()], gain, POINT);

  assert.equal(aggregates.frames, 1);
  assert.equal(aggregates.scored, 1);
  assert.equal(aggregates.cases, 1);
  assert.equal(aggregates.missedRows, 1);
  assert.equal(aggregates.renderedRows, 1, 'the budget left room for one line');
  assert.equal(aggregates.coverage, 0, 'the one rendered row carries no label');

  assert.equal(aggregates.missed.relevance, 0.5, 'bm25 over the clamped normaliser');
  assert.equal(aggregates.missed.importance, 0.2);
  assert.equal(aggregates.missed.usage, 0);
  assert.equal(aggregates.missed.tagHit, 0.1, 'the question used one of its tags');
  assert.equal(aggregates.delivered.relevance, 1);
  assert.equal(aggregates.delivered.importance, 0.9);
  assert.equal(aggregates.delivered.tagHit, 0);
  assert.equal(
    aggregates.missed.recency,
    aggregates.delivered.recency,
    'both rows were touched at the same moment',
  );
});

test('the budget rip and the missing second hop are two different diagnoses', () => {
  const cut = buildAggregates([budgetCutFrame()], (id) => (id === 'proven' ? 1 : 0), POINT);
  assert.deepEqual(cut.firstHitRanks, [0], 'no proven row reached the prompt');
  assert.equal(cut.budgetCutShare, 1, 'the ranking had it, the renderer never got there');
  assert.equal(cut.hop2Share, 0, 'it was a direct hit - the second hop had nothing to do with it');

  const hop = buildAggregates([hopTwoFrame()], (id) => (id === 'neighbour' ? 1 : 0), POINT);
  assert.deepEqual(hop.firstHitRanks, [0]);
  assert.equal(hop.budgetCutShare, 0, 'the ranking never had it, so no budget ripped before it');
  assert.equal(hop.hop2Share, 1, 'at the widest hop the entity would have delivered it');
});

test('a turn whose block held the proven row is no case at all', () => {
  const aggregates = buildAggregates([budgetCutFrame()], (id) => (id === 'top' ? 1 : 0), POINT);
  assert.equal(aggregates.scored, 1);
  assert.equal(aggregates.cases, 0, 'nothing proven was left out');
  assert.equal(aggregates.coverage, 1);
  assert.deepEqual(aggregates.firstHitRanks, []);
  assertNumbersAllTheWayDown(aggregates, 'aggregates');
});

/* -------------------------------- parsing ------------------------------- */

const GOOD_REPLY =
  '{"limit":6,"threshold":0.2,"w":{"relevance":0.6,"importance":0.25,"recency":0.1,"usage":0.05},' +
  '"hopEntity":0.7,"hopEdge":0.5}';

test('a parsed candidate carries the box literals and a dream provenance', () => {
  const parsed = parseCandidate('```json\n' + GOOD_REPLY + '\n```', BOX);
  assert.ok(parsed.ok);
  assert.equal(parsed.policy.limit, 6);
  assert.equal(parsed.policy.threshold, 0.2);
  assert.equal(parsed.policy.w.relevance, 0.6);
  assert.deepEqual(parsed.policy.kinds, BOX.kinds, 'the filters ride from the box, not the model');
  assert.equal(parsed.policy.minImportance, BOX.minImportance);
  assert.equal(parsed.policy.origin.threshold, 'dream');
  assert.equal(parsed.policy.origin.usage, 'dream');
});

test('a box violation is a generation error, and an unreadable answer is not', () => {
  const overThreshold = parseCandidate('{"limit":6,"threshold":0.9,"w":' + weightsJson() + '}', BOX);
  assert.deepEqual(overThreshold, { ok: false, reason: 'out-of-box' });

  const overLimit = parseCandidate('{"limit":99,"threshold":0.2,"w":' + weightsJson() + '}', BOX);
  assert.deepEqual(overLimit, { ok: false, reason: 'out-of-box' });

  const fractional = parseCandidate('{"limit":6.5,"threshold":0.2,"w":' + weightsJson() + '}', BOX);
  assert.deepEqual(fractional, { ok: false, reason: 'out-of-box' }, 'a limit is a whole number');

  assert.deepEqual(parseCandidate('   ', BOX), { ok: false, reason: 'empty' });
  assert.deepEqual(parseCandidate('no idea, sorry', BOX), { ok: false, reason: 'malformed' });
  assert.deepEqual(parseCandidate('{"limit":6,"threshold":0.2}', BOX), {
    ok: false,
    reason: 'malformed',
  });
});

function weightsJson(hops = true) {
  return (
    '{"relevance":0.6,"importance":0.25,"recency":0.1,"usage":0.05}' +
    (hops ? ',"hopEntity":0.7,"hopEdge":0.5' : '')
  );
}

/* ------------------------------- the caller ------------------------------ */

/** A provider that answers each call from a scripted list, and records how it was asked. */
function scriptedProvider(replies) {
  const calls = [];
  return {
    calls,
    provider: {
      id: 'claude',
      displayName: 'Scripted',
      models: () => ['fake'],
      async status() {
        return { id: 'claude', available: true, binary: 'fake', authenticated: true };
      },
      async *run(options) {
        calls.push(options);
        const reply = replies[calls.length - 1];
        if (reply === 'throw') throw new Error('the model fell over');
        if (reply === 'fatal') {
          yield { type: 'error', message: 'rate limited', fatal: true };
          return;
        }
        yield { type: 'done', text: reply ?? '' };
      },
    },
  };
}

function request(overrides = {}) {
  return {
    aggregates: buildAggregates([budgetCutFrame()], (id) => (id === 'proven' ? 1 : 0), POINT),
    box: BOX,
    incumbent: INCUMBENT,
    count: 1,
    model: 'sonnet',
    ...overrides,
  };
}

test('the candidate writer never runs at the housekeeping effort', async () => {
  const scripted = scriptedProvider([GOOD_REPLY]);
  const signal = new AbortController().signal;

  const asked = await proposeCandidates(scripted.provider, request(), signal);
  assert.equal(asked.candidates.length, 1);
  assert.equal(scripted.calls[0].model, 'sonnet');
  assert.notEqual(scripted.calls[0].effort, 'low', 'designing a policy is judgement (S16)');
  assert.equal(scripted.calls[0].effort, 'medium', 'and the default says so on its own');
  assert.equal(scripted.calls[0].permission, 'chat');

  const louder = scriptedProvider([GOOD_REPLY]);
  await proposeCandidates(louder.provider, request({ effort: 'high' }), signal);
  assert.equal(louder.calls[0].effort, 'high', 'the request decides, not the wiring');
});

test('one model call per candidate, and the proposals it has made ride along', async () => {
  const second =
    '{"limit":4,"threshold":0.1,"w":{"relevance":0.5,"importance":0.2,"recency":0.2,"usage":0.1},' +
    '"hopEntity":0.2,"hopEdge":0.8}';
  const scripted = scriptedProvider([GOOD_REPLY, second]);
  const proposal = await proposeCandidates(
    scripted.provider,
    request({ count: 2 }),
    new AbortController().signal,
  );

  assert.equal(proposal.calls, 2, 'one call per candidate (concept 6.2)');
  assert.equal(proposal.candidates.length, 2);
  assert.equal(proposal.failures, 0);
  assert.equal(proposal.rejected, 0);
  assert.ok(
    scripted.calls[1].prompt.length > scripted.calls[0].prompt.length,
    'the second call knows what the first one already proposed',
  );
});

test('an empty answer is a counted failure, never a candidate', async () => {
  const scripted = scriptedProvider(['', '   ', 'here is my thinking, but no JSON']);
  const proposal = await proposeCandidates(
    scripted.provider,
    request({ count: 3 }),
    new AbortController().signal,
  );

  assert.equal(proposal.calls, 3);
  assert.deepEqual(proposal.candidates, []);
  assert.equal(proposal.failures, 3);
  assert.equal(proposal.rejected, 0, 'nothing was generated, so nothing violated the box');
});

test('a box-violating candidate is rejected at parse time, apart from the failures', async () => {
  const outside = '{"limit":6,"threshold":0.9,"w":' + weightsJson() + '}';
  const scripted = scriptedProvider([outside, GOOD_REPLY]);
  const proposal = await proposeCandidates(
    scripted.provider,
    request({ count: 2 }),
    new AbortController().signal,
  );

  assert.equal(proposal.rejected, 1);
  assert.equal(proposal.failures, 0);
  assert.equal(proposal.candidates.length, 1, 'the good one still stands');
});

test('a model error does not break the night', async () => {
  const scripted = scriptedProvider(['throw', 'fatal']);
  const proposal = await proposeCandidates(
    scripted.provider,
    request({ count: 2 }),
    new AbortController().signal,
  );

  assert.equal(proposal.calls, 2);
  assert.equal(proposal.failures, 2, 'a thrown call and a fatal event both count as failures');
  assert.deepEqual(proposal.candidates, []);
});

test('an aborted night asks nothing', async () => {
  const controller = new AbortController();
  controller.abort();
  const scripted = scriptedProvider([GOOD_REPLY]);
  const proposal = await proposeCandidates(scripted.provider, request({ count: 6 }), controller.signal);

  assert.equal(scripted.calls.length, 0);
  assert.deepEqual(proposal, { candidates: [], calls: 0, failures: 0, rejected: 0 });
});

/* ------------------------------ the incumbent ----------------------------- */

test('the incumbent is always a candidate and runs in the same pass', () => {
  const parsed = parseCandidate(GOOD_REPLY, BOX);
  assert.ok(parsed.ok);
  const withBase = withIncumbent([parsed.policy], INCUMBENT);

  assert.equal(withBase.length, 2);
  assert.equal(withBase[0], INCUMBENT, 'it goes first, like the first grid placement');
  assert.equal(withBase[1], parsed.policy);

  const empty = withIncumbent([], INCUMBENT);
  assert.deepEqual(empty, [INCUMBENT], 'a night without a usable answer still has something to score');
});

test('a candidate that repeats a point already in the pass is dropped', () => {
  const twin = {
    ...INCUMBENT,
    w: { ...INCUMBENT.w },
    origin: { ...INCUMBENT.origin, limit: 'dream' },
  };
  const parsed = parseCandidate(GOOD_REPLY, BOX);
  assert.ok(parsed.ok);

  const list = withIncumbent([twin, parsed.policy, parsed.policy], INCUMBENT);
  assert.equal(list.length, 2, 'the same point is not evaluated twice');
  assert.equal(list[0], INCUMBENT);
  assert.equal(list[1], parsed.policy);
});

/* --------------------------------- prompt -------------------------------- */

test('the prompt states the box the answer has to stay inside', () => {
  // Not the leakage proof - that is the construction test at the top. This
  // only catches a render that quietly drops the constraints it was given.
  const aggregates = buildAggregates([budgetCutFrame()], (id) => (id === 'proven' ? 1 : 0), POINT);
  const prompt = renderCandidatePrompt(aggregates, BOX, INCUMBENT);

  assert.match(prompt, /limit 0\.\.16/);
  assert.match(prompt, /threshold 0\.0500\.\.0\.3000/);
  assert.match(prompt, /Reply ONLY with JSON/);
});
