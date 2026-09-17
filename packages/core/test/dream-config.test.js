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

/**
 * The dream's configuration vocabulary (AP4).
 *
 * Two properties are under test: the shape is complete - every key a later
 * package reads exists in the shipped default - and it is honest - no key
 * without a reader, above all no `promote`, which nothing would read in
 * stage 1 (R16). The one assertion that needs the store to write the
 * sleep-run counters is marked todo until AP7 lands them.
 */

/** The key table from the build plan, mirrored here so a stray key fails loudly. */
const EXPECTED_KEYS = [
  'enabled',
  'record',
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
];

test('the dream block ships complete and switched off', () => {
  assert.ok(DEFAULT_CONFIG.memory.dream);
  assert.equal(DEFAULT_CONFIG.memory.dream.enabled, false);
  assert.equal(DEFAULT_CONFIG.memory.dream.record, false);
  // Stage 1 makes no model calls; the run-global ceiling stands anyway.
  assert.equal(DEFAULT_CONFIG.memory.dream.maxCallsPerNight, 0);
});

test('no key without a reader: the dream block is exactly the key table', () => {
  assert.deepEqual(
    Object.keys(DEFAULT_CONFIG.memory.dream).sort(),
    [...EXPECTED_KEYS].sort(),
  );
  assert.ok(!('promote' in DEFAULT_CONFIG.memory.dream), 'promote has no reader in stage 1 (R16)');
});

test('a partial dream patch merges without wiping the rest of the block', () => {
  const home = mkdtempSync(join(tmpdir(), 'rookery-dream-config-'));
  const config = loadConfig({ home });
  assert.equal(config.memory.dream.frameRate, 0.25);

  applyConfig(config, { memory: { dream: { frameRate: 0.5 } } });

  assert.equal(config.memory.dream.frameRate, 0.5);
  assert.equal(config.memory.dream.limitMax, 16, 'an untouched neighbour keeps its value');
});

test('a fresh sleep run carries the dream counters', { todo: true }, () => {
  // TODO(AP7): the counters are optional on SleepRun until the store writes
  // them; AP7 sets them in the createSleepRun literal and lifts this todo.
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
