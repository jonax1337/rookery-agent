import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSISTANT_MEMORY_OWNER,
  DEFAULT_CONFIG,
  Store,
  applyConfig,
  loadConfig,
} from '../dist/index.js';
// The dream config's other half: the zod schema that guards the HTTP PATCH
// (AP2 owns both `packages/core/src/config.ts` and `packages/server/src/
// schemas.ts`, so this is the one core test that reaches into the server
// package's dist - there is no other place both halves can be checked
// against each other). Not a runtime dependency: only this test file
// imports it, and the wave gate always builds every workspace before it
// runs `npm test` (AGENTS.md), so the file is there by the time this runs.
import { patchConfigSchema } from '../../server/dist/schemas.js';

/**
 * The dream's configuration vocabulary, stage 1 and stage 2
 * (dream-stage2plus-buildplan.md, AP2).
 *
 * Three properties are under test: the shape is complete - every key a
 * later package reads exists in the shipped default; it is honest - no key
 * without a reader; and the zod schema that guards the HTTP PATCH agrees
 * with those defaults and actually clamps. The last test needs the store to
 * write the sleep-run counters, which AP7's createSleepRun literal does.
 */

/** The key table from the build plan, mirrored here so a stray key fails loudly. */
const EXPECTED_KEYS = [
  'enabled',
  'record',
  'promote',
  'frameRate',
  'limitMax',
  'gridSize',
  'costWeight',
  'corpusTolerance',
  'maxFrameBytes',
  'maxEvalMs',
  'frameRetainDays',
  'retainDays',
  'maxCallsPerNight',
  'slots',
  'candidates',
  'model',
  'effort',
  'minTraces',
  'margin',
  'coverageFloor',
  'costOnlyCeiling',
  'abstainEps',
  'abstainFloor',
  'reachableFloor',
  'correctionPrecisionFloor',
  'labelModelCalls',
  'userLabelWindow',
  'agreementFloor',
  'calibrationTraces',
  'tolerance',
  'cooldownNights',
  'maxPromotionsPerNight',
  'explorationRate',
  'trialEpisodes',
];

/** Every new stage-2 default, exactly as config.ts's table declares it. */
const EXPECTED_STAGE2_DEFAULTS = {
  promote: false,
  slots: ['recall'],
  candidates: 6,
  model: 'sonnet',
  effort: 'medium',
  minTraces: 200,
  margin: 0.02,
  coverageFloor: 0.3,
  costOnlyCeiling: 0.5,
  abstainEps: 0.05,
  abstainFloor: 0.3,
  reachableFloor: 0.5,
  correctionPrecisionFloor: 0.6,
  labelModelCalls: 0,
  userLabelWindow: 7 * 24 * 60 * 60 * 1000,
  agreementFloor: 0.4,
  calibrationTraces: 50,
  tolerance: 0.05,
  cooldownNights: 7,
  maxPromotionsPerNight: 1,
  explorationRate: 0,
  trialEpisodes: 0,
};

test('the dream block ships complete and switched off', () => {
  assert.ok(DEFAULT_CONFIG.memory.dream);
  assert.equal(DEFAULT_CONFIG.memory.dream.enabled, false);
  assert.equal(DEFAULT_CONFIG.memory.dream.record, false);
  // Three switches, all off (S22/E20 and plan section 1.2 "kein Default an").
  assert.equal(DEFAULT_CONFIG.memory.dream.promote, false);
  // Stage 2 spends model calls on the candidate writer, so the run-global
  // ceiling is no longer zero - it is a real wallet from here on.
  assert.equal(DEFAULT_CONFIG.memory.dream.maxCallsPerNight, 6);
});

test('no key without a reader: the dream block is exactly the key table', () => {
  assert.deepEqual(
    Object.keys(DEFAULT_CONFIG.memory.dream).sort(),
    [...EXPECTED_KEYS].sort(),
  );
});

test('every stage-2 default matches the build plan table', () => {
  for (const [key, value] of Object.entries(EXPECTED_STAGE2_DEFAULTS)) {
    assert.deepEqual(
      DEFAULT_CONFIG.memory.dream[key],
      value,
      `memory.dream.${key} should default to ${JSON.stringify(value)}`,
    );
  }
});

test('a partial dream patch merges without wiping the rest of the block', () => {
  const home = mkdtempSync(join(tmpdir(), 'rookery-dream-config-'));
  const config = loadConfig({ home });
  assert.equal(config.memory.dream.frameRate, 0.25);

  applyConfig(config, { memory: { dream: { frameRate: 0.5 } } });

  assert.equal(config.memory.dream.frameRate, 0.5);
  assert.equal(config.memory.dream.limitMax, 16, 'an untouched neighbour keeps its value');
  assert.equal(config.memory.dream.promote, false, 'and a stage-2 neighbour keeps its value too');
});

test('a fresh sleep run carries the dream counters', () => {
  const store = new Store(':memory:');
  try {
    const run = store.createSleepRun({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'manual' });
    assert.equal(typeof run.dreamTracesSeen, 'number');
    assert.equal(typeof run.dreamFramesScored, 'number');
    assert.equal(typeof run.dreamCandidates, 'number');
  } finally {
    store.close();
  }
});

test('the zod schema accepts the full stage-2 default block', () => {
  const result = patchConfigSchema.safeParse({ memory: { dream: DEFAULT_CONFIG.memory.dream } });
  assert.ok(result.success, result.success ? undefined : JSON.stringify(result.error.issues));
});

test('the zod schema clamps every new range, not just the stage-1 ones', () => {
  const cases = [
    { slots: ['recall', 'gate'] }, // not a DreamSlot - 'gate' left stage 1
    { candidates: -1 },
    { minTraces: -1 },
    { margin: 1.5 },
    { coverageFloor: -0.1 },
    { costOnlyCeiling: 1.1 },
    { abstainEps: -1 },
    { abstainFloor: 2 },
    { reachableFloor: -1 },
    { correctionPrecisionFloor: 2 },
    { labelModelCalls: -1 },
    { userLabelWindow: -1 },
    { agreementFloor: 2 },
    { calibrationTraces: -1 },
    { tolerance: -1 },
    { cooldownNights: -1 },
    { maxPromotionsPerNight: -1 },
    { explorationRate: 2 },
    { trialEpisodes: -1 },
  ];
  for (const patch of cases) {
    const result = patchConfigSchema.safeParse({ memory: { dream: patch } });
    assert.equal(
      result.success,
      false,
      `expected ${JSON.stringify(patch)} to be rejected, it was accepted`,
    );
  }
});

test('slots is replaced wholesale, not merged, on a patch (E21)', () => {
  const home = mkdtempSync(join(tmpdir(), 'rookery-dream-config-slots-'));
  const config = loadConfig({ home });
  assert.deepEqual(config.memory.dream.slots, ['recall']);

  applyConfig(config, { memory: { dream: { slots: ['recall', 'budget'] } } });
  assert.deepEqual(config.memory.dream.slots, ['recall', 'budget']);

  applyConfig(config, { memory: { dream: { slots: ['retry'] } } });
  assert.deepEqual(
    config.memory.dream.slots,
    ['retry'],
    'a new slots array replaces the old one outright, it does not accumulate',
  );
});
