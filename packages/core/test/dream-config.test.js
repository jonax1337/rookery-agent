import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
  'requireUserLabels',
  'calibrationTraces',
  'tolerance',
  'cooldownNights',
  'maxPromotionsPerNight',
  'explorationRate',
  'trialEpisodes',
];

test('no key without a reader: the dream block is exactly the key table', () => {
  assert.deepEqual(
    Object.keys(DEFAULT_CONFIG.memory.dream).sort(),
    [...EXPECTED_KEYS].sort(),
  );
});

test('a partial dream patch merges without wiping the rest of the block', () => {
  const home = mkdtempSync(join(tmpdir(), 'rookery-dream-config-'));
  const config = loadConfig({ home });
  const before = { ...config.memory.dream };

  applyConfig(config, { memory: { dream: { frameRate: 0.5 } } });

  assert.equal(config.memory.dream.frameRate, 0.5);
  assert.deepEqual(
    { ...config.memory.dream, frameRate: before.frameRate },
    before,
    'every other key of the block keeps its value',
  );
});

test('an old config file stops pinning the retired volume-bound defaults', () => {
  const home = mkdtempSync(join(tmpdir(), 'rookery-dream-config-upgrade-'));
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      memory: {
        dream: { enabled: false, frameRate: 0.25, minTraces: 200, coverageFloor: 0.3, calibrationTraces: 25 },
      },
    }),
  );

  const dream = loadConfig({ home }).memory.dream;

  assert.equal(dream.frameRate, DEFAULT_CONFIG.memory.dream.frameRate, 'the retired default moves on');
  assert.equal(dream.minTraces, DEFAULT_CONFIG.memory.dream.minTraces);
  assert.equal(dream.coverageFloor, DEFAULT_CONFIG.memory.dream.coverageFloor);
  assert.equal(dream.calibrationTraces, 25, 'a value somebody chose is not touched');
  assert.equal(dream.enabled, false, 'and neither is a switch somebody turned off');
});

test('a host override outranks the upgrade of a pinned default', () => {
  const home = mkdtempSync(join(tmpdir(), 'rookery-dream-config-override-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ memory: { dream: { minTraces: 200 } } }));

  const dream = loadConfig({ home, memory: { dream: { minTraces: 90 } } }).memory.dream;

  assert.equal(dream.minTraces, 90, 'the file pinned the retired default, the host asked for something else');
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
