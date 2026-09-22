import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, reindex, SCHEMA_VERSION } from '../dist/index.js';

/**
 * Schema 21 (the dream, stage 1) through schema 24 (stage 2+ AP1: policy
 * versions, slot state, evaluations, the episode index) and the connection
 * hygiene that comes with it.
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

test('schema 25 is what a fresh database writes into meta', () => {
  const db = openDatabase(':memory:');
  assert.equal(SCHEMA_VERSION, 25);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  assert.equal(row.value, String(SCHEMA_VERSION));
  db.close();
});

test('the four stage-1 dream tables exist, dream_labels included', () => {
  const db = openDatabase(':memory:');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  for (const table of ['dream_traces', 'dream_frames', 'dream_labels', 'memory_touches']) {
    assert.ok(names.includes(table), `${table} should exist`);
  }
  db.close();
});

test('the four stage-2+ dream tables exist with their columns', () => {
  const db = openDatabase(':memory:');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  for (const table of ['policy_versions', 'dream_slot_state', 'dream_evals', 'dream_episodes']) {
    assert.ok(names.includes(table), `${table} should exist`);
  }
  const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);

  const policyColumns = columnsOf('policy_versions');
  for (const column of [
    'id', 'owner', 'slot', 'version', 'params', 'box', 'origin', 'parent_id',
    'prev_active_id', 'sleep_run_id', 'rationale', 'replay_score', 'replay_n',
    'baseline_score', 'audit_delta', 'audit_ci_low', 'online_score',
    'promoted_at', 'retired_at', 'created_at',
  ]) {
    assert.ok(policyColumns.includes(column), `policy_versions.${column} should exist`);
  }

  const slotStateColumns = columnsOf('dream_slot_state');
  for (const column of ['owner', 'slot', 'frozen_at', 'frozen_reason', 'cooldown_until', 'last_promoted']) {
    assert.ok(slotStateColumns.includes(column), `dream_slot_state.${column} should exist`);
  }

  const evalColumns = columnsOf('dream_evals');
  for (const column of [
    'id', 'sleep_run_id', 'policy_id', 'slot', 'traces', 'closed', 'abstained',
    'abstain_reasons', 'reachable_rate', 'label_coverage', 'cost_only_share',
    'score', 'baseline', 'delta', 'ci_low', 'ci_high', 'audit_delta',
    'audit_ci_low', 'delta_live', 'sign_agree', 'eval_ms', 'trace_set_hash',
    'evidence_digest', 'promoted', 'detail', 'created_at',
  ]) {
    assert.ok(evalColumns.includes(column), `dream_evals.${column} should exist`);
  }

  const episodeColumns = columnsOf('dream_episodes');
  for (const column of [
    'id', 'owner', 'kind', 'session_id', 'slot', 'steps', 'outcome', 'holdout',
    'audit', 'started_at', 'finished_at', 'created_at',
  ]) {
    assert.ok(episodeColumns.includes(column), `dream_episodes.${column} should exist`);
  }
  db.close();
});

test('dream_episodes is an index, not a second verbatim store', () => {
  // It carries no query text, no memory content, no evidence quote - just the
  // shape of an episode over the existing turn_events journal.
  const db = openDatabase(':memory:');
  const columns = db.prepare('PRAGMA table_info(dream_episodes)').all().map((row) => row.name);
  for (const verbatim of ['query', 'text', 'content', 'evidence', 'payload']) {
    assert.ok(!columns.includes(verbatim), `dream_episodes.${verbatim} should not exist`);
  }
  db.close();
});

test('dream_evals cascades away when its policy version is deleted', () => {
  const db = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO policy_versions (id, owner, slot, version, params, box, origin, created_at)
     VALUES ('policy-1', 'assistant', 'recall', 1, '{}', '{}', 'default', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO dream_evals
       (id, sleep_run_id, policy_id, slot, traces, closed, abstained, abstain_reasons,
        reachable_rate, label_coverage, cost_only_share, score, baseline, delta,
        ci_low, ci_high, eval_ms, trace_set_hash, created_at)
     VALUES
       ('eval-1', 'run-1', 'policy-1', 'recall', 10, 8, 2, '{}',
        0.8, 0.5, 0.1, 0.6, 0.5, 0.1,
        -0.1, 0.3, 5, 'hash', 1)`,
  ).run();
  db.exec("DELETE FROM policy_versions WHERE id = 'policy-1'");
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dream_evals').get().n, 0);
  db.close();
});

test('the promotion index on dream_evals exists', () => {
  const db = openDatabase(':memory:');
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name);
  assert.ok(indexes.includes('idx_dream_evals_run'));
  db.close();
});

test('the stage-2+ turn-locator columns and indexes exist', () => {
  const db = openDatabase(':memory:');
  for (const [table, column] of [
    ['corrections', 'turn_id'],
    ['dream_labels', 'owner'],
    ['dream_labels', 'session_id'],
    ['messages', 'turn_id'],
    ['sleep_runs', 'dream_promoted'],
    ['sleep_runs', 'dream_labels_written'],
  ]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    assert.ok(columns.includes(column), `${table}.${column} should exist`);
  }
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name);
  for (const index of ['idx_dream_labels_source', 'idx_corrections_turn', 'idx_messages_turn']) {
    assert.ok(indexes.includes(index), `${index} should exist`);
  }
  db.close();
});

test('sleep_runs.dream_promoted and dream_labels_written default to 0, NOT NULL', () => {
  const db = openDatabase(':memory:');
  const rows = db.prepare('PRAGMA table_info(sleep_runs)').all();
  for (const column of ['dream_promoted', 'dream_labels_written']) {
    const row = rows.find((row) => row.name === column);
    assert.ok(row, `${column} should exist`);
    assert.equal(row.notnull, 1, `${column} should be NOT NULL`);
    assert.equal(row.dflt_value, '0', `${column} should default to 0`);
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

test('the sweep cut columns carry their age indexes', () => {
  const db = openDatabase(':memory:');
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name);
  // sweepDreamFrames and sweepDreamTraces delete in LIMIT batches on
  // created_at < ?; without these indexes every batch full-scans its table.
  for (const index of ['idx_dream_frames_age', 'idx_dream_traces_age']) {
    assert.ok(indexes.includes(index), `${index} should exist`);
  }
  db.close();
});

test('a contended write waits instead of failing immediately', () => {
  const db = openDatabase(':memory:');
  // The pragma reports its value under the bare column name `timeout`.
  const row = db.prepare('PRAGMA busy_timeout').get();
  assert.equal(row.timeout, 5000);
  db.close();
});

test('sleep_runs carries the three stage-1 dream counters with defaults', () => {
  const db = openDatabase(':memory:');
  const rows = db.prepare('PRAGMA table_info(sleep_runs)').all();
  for (const column of ['dream_traces_seen', 'dream_frames_scored', 'dream_candidates']) {
    const row = rows.find((row) => row.name === column);
    assert.ok(row, `${column} should exist`);
    assert.equal(row.notnull, 1, `${column} should be NOT NULL`);
    assert.equal(row.dflt_value, '0', `${column} should default to 0`);
  }
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

test('reindex marks the corpus as invalidated', () => {
  const db = openDatabase(':memory:');
  const before = db.prepare("SELECT value FROM meta WHERE key = 'dream.corpus_invalidated_at'").get();
  assert.equal(before, undefined);
  reindex(db);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'dream.corpus_invalidated_at'").get();
  assert.ok(Number(row.value) > 0, 'the invalidation stamp should carry a timestamp');
  db.close();
});

test('an existing schema-23 database migrates to 24 without losing rows', (t) => {
  const path = tempPath(t);
  // A bare schema-23 shape, hand-built with node:sqlite directly rather than
  // through openDatabase: only the tables this migration touches need to be
  // present to prove nothing already sitting in them is lost on the way to
  // schema 24 (corrections.turn_id, dream_labels.owner/session_id,
  // messages.turn_id, sleep_runs.dream_promoted/dream_labels_written, and the
  // four new tables).
  const seed = new DatabaseSync(path);
  seed.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE corrections (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, text TEXT NOT NULL, quote TEXT NOT NULL,
      session_id TEXT, created_at INTEGER NOT NULL, consumed_at INTEGER
    );
    CREATE TABLE dream_labels (
      turn_id TEXT NOT NULL, target TEXT NOT NULL, source TEXT NOT NULL,
      relevance REAL NOT NULL, scope TEXT NOT NULL, evidence TEXT, dead_at INTEGER,
      created_at INTEGER NOT NULL, PRIMARY KEY (turn_id, target, source)
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
      provider TEXT, model TEXT, agent TEXT, usage TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE sleep_runs (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL,
      started_at INTEGER NOT NULL, finished_at INTEGER, duration_ms INTEGER,
      read_count INTEGER NOT NULL DEFAULT 0, merged_count INTEGER NOT NULL DEFAULT 0,
      dormant_count INTEGER NOT NULL DEFAULT 0, edge_count INTEGER NOT NULL DEFAULT 0,
      insight_count INTEGER NOT NULL DEFAULT 0, conflict_count INTEGER NOT NULL DEFAULT 0,
      model_calls INTEGER NOT NULL DEFAULT 0, resolved_count INTEGER NOT NULL DEFAULT 0,
      report TEXT, error TEXT, undone_at INTEGER
    );
  `);
  seed.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '23')").run();
  seed.prepare(
    'INSERT INTO corrections (id, owner, text, quote, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('correction-1', 'assistant', 'wrong', 'the quote', 'session-1', 1);
  seed.prepare(
    'INSERT INTO dream_labels (turn_id, target, source, relevance, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('turn-1', 'memory-1', 'correction', 1, 'turn', 1);
  seed.prepare(
    'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('message-1', 'session-1', 'user', 'hi', 1);
  seed.close();

  const db = openDatabase(path);
  const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  assert.equal(version.value, String(SCHEMA_VERSION));
  assert.equal(SCHEMA_VERSION, 25);

  // Schema 25: a card can name the schedule that made it, so a run that
  // appeared overnight is not indistinguishable from one the user asked for.
  const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map((column) => column.name);
  assert.ok(taskColumns.includes('schedule_id'), 'the card carries its origin');

  // Nothing that was already there is gone.
  assert.equal(db.prepare("SELECT text FROM corrections WHERE id = 'correction-1'").get().text, 'wrong');
  assert.equal(db.prepare("SELECT content FROM messages WHERE id = 'message-1'").get().content, 'hi');
  assert.equal(
    db.prepare("SELECT relevance FROM dream_labels WHERE turn_id = 'turn-1'").get().relevance,
    1,
  );

  for (const [table, column] of [
    ['corrections', 'turn_id'],
    ['dream_labels', 'owner'],
    ['dream_labels', 'session_id'],
    ['messages', 'turn_id'],
    ['sleep_runs', 'dream_promoted'],
    ['sleep_runs', 'dream_labels_written'],
  ]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    assert.ok(columns.includes(column), `${table}.${column} should exist after migration`);
  }
  for (const table of ['policy_versions', 'dream_slot_state', 'dream_evals', 'dream_episodes']) {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    assert.ok(row, `${table} should exist after migration`);
  }
  db.close();
});
