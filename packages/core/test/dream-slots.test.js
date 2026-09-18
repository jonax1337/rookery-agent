import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NIGHT_PHASES,
  applyBudgetPolicy,
  estimateYield,
  judgeRetry,
  replayBudgetPolicy,
  yieldRates,
} from '../dist/memory/dream/slots.js';

/**
 * The `budget` and `retry` slots (dream stage 2, AP11; concept 7.1, H4/S24).
 *
 * Three groups of tests:
 *
 * - `applyBudgetPolicy`: the allocation is exact - never exceeds `cap`,
 *   never exceeds a phase's demand, and does NOT redistribute a phase's
 *   under-spent quota (the deliberate difference from `sleep.ts`'s
 *   `distribute`, see the module doc on `slots.ts`).
 * - `yieldRates`/`estimateYield`/`replayBudgetPolicy`: an approximate figure
 *   with its spread when the call count was actually observed, and an
 *   abstention - never a guess - the moment a projection would have to
 *   extrapolate past what was observed.
 * - `judgeRetry`: one-sided exact - a verdict for the earlier stop, `abstain`
 *   for the later one, because the attempt that would prove it never ran.
 *
 * The last block does not test this module at all: it reads `sleep.ts` as
 * SOURCE TEXT - the same technique `packages/web/test/sleep-phases.test.mjs`
 * uses - to lock in H4/S24 (`allocateNightBudget`'s `keys` derived from
 * `[...volume, ...judgement]`, never written out as a literal). A property
 * test over random demands cannot find that bug: it lives at source level,
 * not at value level, and `NIGHT_PHASES` above is this module's own mirror
 * of the same six names, checked here against `sleep.ts`'s `NightDemand` so
 * the two cannot quietly drift apart.
 */

function zero() {
  return { condense: 0, resolve: 0, link: 0, reflect: 0, revise: 0, practise: 0 };
}

/* --------------------------------- budget --------------------------------- */

test('applyBudgetPolicy splits an evenly shared cap evenly, floor rounded', () => {
  const demand = { ...zero(), condense: 100, resolve: 100, link: 100, reflect: 100, revise: 100, practise: 100 };
  const policy = { ...zero(), condense: 1, resolve: 1, link: 1, reflect: 1, revise: 1, practise: 1 };
  const funded = applyBudgetPolicy(demand, policy, 12);
  for (const phase of NIGHT_PHASES) assert.equal(funded[phase], 2);
});

test('applyBudgetPolicy never funds a phase past its own demand', () => {
  const demand = { ...zero(), condense: 1 };
  const policy = { ...zero(), condense: 1, resolve: 1 };
  const funded = applyBudgetPolicy(demand, policy, 100);
  assert.equal(funded.condense, 1, 'capped by demand, not by its share of the wallet');
});

test('applyBudgetPolicy does not redistribute an under-spent phase\'s leftover', () => {
  // condense's share alone would buy it 6 calls, but it only has 1 unit of
  // demand; resolve's leftover-eligible share never sees the other 5.
  const demand = { ...zero(), condense: 1, resolve: 100 };
  const policy = { ...zero(), condense: 1, resolve: 1 };
  const funded = applyBudgetPolicy(demand, policy, 12);
  assert.equal(funded.condense, 1);
  assert.equal(funded.resolve, 6, 'resolve gets only its own declared share, not condense\'s unspent quota');
  const total = NIGHT_PHASES.reduce((sum, phase) => sum + funded[phase], 0);
  assert.ok(total < 12, 'the wallet is not fully spent when a share goes unused (no redistribution)');
});

test('applyBudgetPolicy funds nothing under a zero or unshared policy', () => {
  const demand = { ...zero(), condense: 10 };
  assert.deepEqual(applyBudgetPolicy(demand, zero(), 10), zero(), 'every share is zero');
  assert.deepEqual(applyBudgetPolicy(demand, { ...zero(), condense: 1 }, 0), zero(), 'cap is zero');
});

test('applyBudgetPolicy never exceeds the cap, across a handful of fixed cases', () => {
  const cases = [
    [{ ...zero(), condense: 3, resolve: 7, reflect: 2 }, { ...zero(), condense: 5, resolve: 1, revise: 2 }, 5],
    [{ ...zero(), link: 9, practise: 1 }, { ...zero(), link: 1, practise: 100 }, 3],
    [{ ...zero(), condense: 1000 }, { ...zero(), condense: 1 }, 17],
  ];
  for (const [demand, policy, cap] of cases) {
    const funded = applyBudgetPolicy(demand, policy, cap);
    const total = NIGHT_PHASES.reduce((sum, phase) => sum + funded[phase], 0);
    assert.ok(total <= cap, `total ${total} exceeds cap ${cap}`);
    for (const phase of NIGHT_PHASES) {
      assert.ok(funded[phase] <= (demand[phase] ?? 0), `${phase} funded past its own demand`);
    }
  }
});

test('yieldRates reports a mean with its observed spread, skipping runs that spent no calls', () => {
  const runs = [
    { owner: 'assistant', phase: 'condense', calls: 2, value: 4 }, // 2 per call
    { owner: 'assistant', phase: 'condense', calls: 4, value: 4 }, // 1 per call
    { owner: 'assistant', phase: 'condense', calls: 0, value: 0 }, // skipped: no calls spent
    { owner: 'other', phase: 'condense', calls: 1, value: 1 },
  ];
  const rates = yieldRates(runs);
  const assistantCondense = rates.find((rate) => rate.owner === 'assistant' && rate.phase === 'condense');
  assert.ok(assistantCondense);
  assert.equal(assistantCondense.samples, 2, 'the zero-call run never became a zero-yield observation');
  assert.equal(assistantCondense.low, 1);
  assert.equal(assistantCondense.high, 2);
  assert.ok(Math.abs(assistantCondense.meanPerCall - 1.5) < 1e-9);
  assert.deepEqual(assistantCondense.callsRange, [2, 4]);
  assert.equal(assistantCondense.approximated, true);

  const other = rates.find((rate) => rate.owner === 'other');
  assert.ok(other, 'a different owner keeps its own rate, never pooled with another owner\'s');
});

test('estimateYield abstains outside the observed range instead of extrapolating', () => {
  const runs = [
    { owner: 'assistant', phase: 'link', calls: 3, value: 6 },
    { owner: 'assistant', phase: 'link', calls: 5, value: 5 },
  ];
  const rates = yieldRates(runs);

  const inRange = estimateYield(rates, 'assistant', 'link', 4);
  assert.equal(inRange.ok, true);
  assert.equal(inRange.approximated, true);

  const tooFew = estimateYield(rates, 'assistant', 'link', 2);
  assert.deepEqual(tooFew, { ok: false, reason: 'extrapolated' });

  const tooMany = estimateYield(rates, 'assistant', 'link', 6);
  assert.deepEqual(tooMany, { ok: false, reason: 'extrapolated' });

  const unseenPhase = estimateYield(rates, 'assistant', 'reflect', 4);
  assert.deepEqual(unseenPhase, { ok: false, reason: 'no-observation' });

  const boundaryLow = estimateYield(rates, 'assistant', 'link', 3);
  assert.equal(boundaryLow.ok, true, 'the boundary of the observed range is not itself extrapolation');
  const boundaryHigh = estimateYield(rates, 'assistant', 'link', 5);
  assert.equal(boundaryHigh.ok, true);
});

test('replayBudgetPolicy abstains the whole projection on the first unmeasurable phase', () => {
  const runs = [{ owner: 'assistant', phase: 'condense', calls: 2, value: 6 }];
  const rates = yieldRates(runs);
  const demand = { ...zero(), condense: 2, resolve: 5 };
  const policy = { ...zero(), condense: 1, resolve: 1 };
  // Cap 6 splits 3/3; condense is capped at its demand of 2 (observed),
  // resolve's 3 calls were never observed for this owner/phase at all.
  const result = replayBudgetPolicy(demand, policy, 6, 'assistant', rates);
  assert.deepEqual(result, { ok: false, phase: 'resolve', reason: 'no-observation' });
});

test('replayBudgetPolicy projects a value, with spread, when every funded phase is in range', () => {
  const runs = [
    { owner: 'assistant', phase: 'condense', calls: 1, value: 2 },
    { owner: 'assistant', phase: 'condense', calls: 3, value: 3 },
  ];
  const rates = yieldRates(runs);
  const demand = { ...zero(), condense: 2 };
  const policy = { ...zero(), condense: 1 };
  const result = replayBudgetPolicy(demand, policy, 2, 'assistant', rates);
  assert.equal(result.ok, true);
  assert.equal(result.approximated, true);
  // meanPerCall = (2/1 + 3/3) / 2 = 1.5, over 2 funded calls.
  assert.ok(Math.abs(result.value - 3) < 1e-9);
});

/* ---------------------------------- retry ---------------------------------- */

test('judgeRetry: stopping at the same point the run actually stopped is no-change', () => {
  const attempts = [{ outcome: 'failure' }, { outcome: 'success' }];
  assert.equal(judgeRetry(attempts, { maxAttempts: 2 }), 'no-change');
});

test('judgeRetry: an earlier stop that would still have hit the success is no-change', () => {
  const attempts = [{ outcome: 'success' }, { outcome: 'failure' }];
  assert.equal(judgeRetry(attempts, { maxAttempts: 1 }), 'no-change');
});

test('judgeRetry: an earlier stop that misses the eventual success would-lose-success', () => {
  const attempts = [{ outcome: 'failure' }, { outcome: 'success' }];
  assert.equal(judgeRetry(attempts, { maxAttempts: 1 }), 'would-lose-success');
});

test('judgeRetry: two failures either way is still no-change, whatever the earlier cutoff', () => {
  const attempts = [{ outcome: 'failure' }, { outcome: 'failure' }];
  assert.equal(judgeRetry(attempts, { maxAttempts: 1 }), 'no-change');
  assert.equal(judgeRetry(attempts, { maxAttempts: 0 }), 'no-change');
});

test('judgeRetry: a later stop than what actually ran abstains - the extra attempt does not exist', () => {
  const attempts = [{ outcome: 'failure' }];
  assert.equal(judgeRetry(attempts, { maxAttempts: 2 }), 'abstain');
});

/* ------------------------- H4/S24 source-level lock-in ------------------------- */

const sleepSrc = readFileSync(new URL('../src/memory/sleep.ts', import.meta.url), 'utf8');

const demandMatch = /export interface NightDemand \{([^}]*)\}/s.exec(sleepSrc);
assert.ok(demandMatch, 'sleep.ts still declares NightDemand');
const demandFields = [...demandMatch[1].matchAll(/^\s*(\w+):\s*number;/gm)].map((match) => match[1]);

const allocateStart = sleepSrc.indexOf('export function allocateNightBudget(');
assert.ok(allocateStart !== -1, 'sleep.ts still declares allocateNightBudget');
const distributeStart = sleepSrc.indexOf('\nfunction distribute(', allocateStart);
assert.ok(distributeStart !== -1, 'allocateNightBudget is still followed by distribute');
const allocateBody = sleepSrc.slice(allocateStart, distributeStart);

const volumeMatch = /const volume = (\[[^\]]*\]) as const;/.exec(allocateBody);
const judgementMatch = /const judgement = (\[[^\]]*\]) as const;/.exec(allocateBody);
assert.ok(volumeMatch && judgementMatch, 'allocateNightBudget still declares its volume/judgement sub-lists');
const volume = JSON.parse(volumeMatch[1].replace(/'/g, '"'));
const judgement = JSON.parse(judgementMatch[1].replace(/'/g, '"'));

test('H4/S24: allocateNightBudget derives keys from [...volume, ...judgement], never a literal tuple', () => {
  assert.match(
    allocateBody,
    /const keys = \[\.\.\.volume, \.\.\.judgement\] as const;/,
    'keys must be spread from the two sub-lists - a hand-written tuple can name a key in neither ' +
      'sub-list (it keeps its uncapped allocation while volume is squeezed) or drop a demand key ' +
      'entirely (it never reaches `funded`, `budgets.x` reads undefined, and the phase runs unbudgeted)',
  );
  assert.doesNotMatch(
    allocateBody,
    /const keys = \[\s*'condense'/,
    'keys must not be restated as a hand-written literal array',
  );
});

test('H4/S24: Object.keys of a canonical NightDemand equals the set [...volume, ...judgement] derives', () => {
  // "Object.keys(demand) eines kanonischen NightDemand" - NightDemand has no
  // runtime presence (it is a type), so the canonical instance is its field
  // list read straight off the interface declaration, the same way
  // `sleep-phases.test.mjs` reads `SleepStage` off its union declaration.
  assert.deepEqual(new Set(demandFields), new Set([...volume, ...judgement]));
  // And a property test over random demands genuinely cannot find this bug:
  // any demand object built from `NightDemand`'s own keys trivially has
  // `Object.keys(demand)` equal to that same key set, by construction -
  // the failure mode lives in how `keys` is WRITTEN in the source, not in
  // any value a random demand could take.
});

test("AP11's own NIGHT_PHASES names the same six phases as sleep.ts's NightDemand", () => {
  assert.deepEqual(new Set(NIGHT_PHASES), new Set(demandFields));
});
