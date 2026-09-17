import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, reindex, SCHEMA_VERSION } from '../dist/index.js';

/**
 * Schema 19 (the dream) and the connection hygiene that comes with it.
 *
 * The reopen cases need a real file - a downgrade brake and idempotent
 * migration cannot be observed on `:memory:` - so they get a throwaway
 * directory like migration.test.js, never the developer's own database.
 */

/** A throwaway file path, removed when the test ends. */
function tempPath(t) {
  const root = mkdtempSync(join(tmpdir(), 'rookery-dream-schema-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'state.db');
}

test('schema 19 is what a fresh database writes into meta', () => {
  const db = openDatabase(':memory:');
  assert.equal(SCHEMA_VERSION, 19);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  assert.equal(row.value, '19');
  db.close();
});

test('the four dream tables exist, dream_labels included', () => {
  const db = openDatabase(':memory:');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  for (const table of ['dream_traces', 'dream_frames', 'dream_labels', 'memory_touches']) {
    assert.ok(names.includes(table), `${table} should exist`);
  }
  db.close();
});

test('the dream can read document frequencies through fts5vocab', () => {
  const db = openDatabase(':memory:');
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories_fts_v'").all();
  assert.equal(rows.length, 1);
  // The vocabulary table tracks its parent index: term plus doc count.
  const columns = db.prepare('PRAGMA table_info(memories_fts_v)').all().map((row) => row.name);
  assert.ok(columns.includes('term'));
  assert.ok(columns.includes('doc'));
  db.close();
});

test('a contended write waits instead of failing immediately', () => {
  const db = openDatabase(':memory:');
  // The pragma reports its value under the bare column name `timeout`.
  const row = db.prepare('PRAGMA busy_timeout').get();
  assert.equal(row.timeout, 5000);
  db.close();
});

test('sleep_runs carries the three dream counters with defaults', () => {
  const db = openDatabase(':memory:');
  const rows = db.prepare('PRAGMA table_info(sleep_runs)').all();
  for (const column of ['dream_traces_seen', 'dream_frames_scored', 'dream_candidates']) {
    const row = rows.find((row) => row.name === column);
    assert.ok(row, `${column} should exist`);
    assert.equal(row.notnull, 1, `${column} should be NOT NULL`);
    assert.equal(row.dflt_value, '0', `${column} should default to 0`);
  }
  // No counter without a writer: Stage 1 promotes nothing.
  assert.ok(!rows.some((row) => row.name === 'dream_promoted'));
  db.close();
});

test('a database from a newer build refuses to open', (t) => {
  const path = tempPath(t);
  const first = openDatabase(path);
  first.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
  first.close();
  assert.throws(() => openDatabase(path), /newer/);
});

test('a fresh file opens without the downgrade brake firing', (t) => {
  const path = tempPath(t);
  assert.doesNotThrow(() => {
    const db = openDatabase(path);
    db.close();
  });
});

test('deleting a trace cascades into its touches', () => {
  const db = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO dream_traces (id, turn_id, owner, kind, site, pipeline, policy_set, started_at, created_at)
     VALUES ('trace-1', 'turn-1', 'assistant', 'turn', 'turn', 'assistant', '{}', 1, 1)`,
  ).run();
  const touch = db.prepare(
    'INSERT INTO memory_touches (id, owner, memory_id, trace_id, at) VALUES (?, ?, ?, ?, ?)',
  );
  touch.run('touch-1', 'assistant', 'memory-1', 'trace-1', 1);
  touch.run('touch-2', 'assistant', 'memory-2', 'trace-1', 1);
  db.exec('DELETE FROM dream_traces');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_touches').get().n, 0);
  db.close();
});

test('opening the same file twice does not throw', (t) => {
  const path = tempPath(t);
  const first = openDatabase(path);
  first.close();
  assert.doesNotThrow(() => {
    const second = openDatabase(path);
    second.close();
  });
});
