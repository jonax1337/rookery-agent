import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../dist/memory/store.js';
import { previewMigration, importMigration } from '../dist/migration.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'rookery-cron-migration-test-'));
  const source = join(root, 'source');
  const config = { home: join(root, 'rookery'), workspace: join(root, 'rookery', 'workspace'), assistantName: 'Rookery' };
  mkdirSync(source);
  mkdirSync(config.workspace, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  const saveJobs = jobs => put(join(source, 'cron/jobs.json'), JSON.stringify({ jobs }));
  return { root, source, config, put, saveJobs };
}
const hermesJob = (patch = {}) => ({ id: 'tea', name: ' Tea time ', prompt: '  Remember tea.\n', schedule: { kind: 'cron', expr: '15 8 * * *' }, repeat: { times: null }, state: 'scheduled', enabled: true, ...patch });
const openclawJob = (patch = {}) => ({ id: 'tea', name: 'Tea time', payload: { kind: 'agentTurn', message: 'Remember tea.' }, schedule: { kind: 'cron', expr: '15 8 * * *', staggerMs: 0 }, sessionTarget: 'isolated', enabled: true, ...patch });

test('conditional triggers and pacing are never converted to unconditional schedules', t => {
  const { source, config, saveJobs } = fixture(t);
  saveJobs([openclawJob({ trigger: { script: 'check-something' } }), openclawJob({ id: 'paced', pacing: { min: 1000 } })]);
  const preview = previewMigration(config, 'openclaw', source);
  assert.equal(preview.jobs.length, 0);
  assert.equal(preview.canImport, false);
  assert.ok(preview.warnings.some(warning => /conditional triggers and pacing/.test(warning)));
});

test('Hermes cron-only migration is paused, exact, fingerprinted, idempotent and never due', t => {
  const { source, config, saveJobs } = fixture(t);
  saveJobs([hermesJob()]);
  const preview = previewMigration(config, 'hermes', source);
  assert.equal(preview.canImport, true);
  assert.equal(preview.files.length, 0);
  assert.equal(preview.jobs.length, 1);
  assert.equal(existsSync(join(config.home, 'rookery.db')), false, 'preview is read-only');
  const first = importMigration(config, 'hermes', source, preview.fingerprint);
  assert.equal(first.jobs.length, 1);
  const store = new Store(join(config.home, 'rookery.db'));
  try {
    const job = store.cron.getJob(first.jobs[0]);
    assert.equal(job.name, ' Tea time ');
    assert.equal(job.prompt, '  Remember tea.\n');
    assert.equal(job.schedule, '15 8 * * *');
    assert.equal(job.enabled, false);
    assert.equal(job.permission, 'chat');
    assert.equal(job.nextRunAt, undefined);
    assert.equal(job.runCount, 0);
    assert.deepEqual(store.cron.dueJobs(Number.MAX_SAFE_INTEGER), []);
    assert.deepEqual(store.cron.enabledJobs(), []);
    const second = importMigration(config, 'hermes', source);
    assert.deepEqual(second.jobs, []);
    const fresh = previewMigration(config, 'hermes', source);
    store.cron.updateJob(job.id, { name: 'Locally customized' });
    assert.throws(() => importMigration(config, 'hermes', source, fresh.fingerprint), /changed since the preview/);
    assert.deepEqual(importMigration(config, 'hermes', source).jobs, []);
    assert.equal(store.cron.getJob(job.id).name, 'Locally customized');
  } finally { store.close(); }
});

test('unsupported cron semantics are reported without silently changing recurrence', t => {
  const { source, config, saveJobs, put } = fixture(t);
  saveJobs([
    hermesJob(),
    hermesJob({ id: 'once', schedule: { kind: 'once', run_at: '2030-01-01' } }),
    hermesJob({ id: 'interval', schedule: { kind: 'interval', minutes: 10 } }),
    hermesJob({ id: 'finite', repeat: { times: 3, completed: 1 } }),
    hermesJob({ id: 'script', script: 'private.py' }),
    hermesJob({ id: 'done', state: 'completed' }),
    hermesJob({ id: 'agent', agentId: 'different-agent' }),
    hermesJob({ id: 'tz', schedule: { kind: 'cron', expr: '15 8 * * *', tz: 'Invalid/Timezone' } }),
  ]);
  const preview = previewMigration(config, 'hermes', source);
  assert.equal(preview.jobs.length, 2);
  assert.equal(preview.warnings.filter(warning => warning.startsWith('Skipped schedule')).length, 6);
  put(join(source, 'config.yaml'), 'private_token: never-copy-this\ntimezone: Invalid/Timezone\n');
  const timezone = previewMigration(config, 'hermes', source);
  assert.equal(timezone.jobs.length, 0);
  assert.equal(timezone.warnings.join(' ').includes('never-copy-this'), false);
});

test('source cron edits invalidate previews including source timezone changes', t => {
  const { source, config, saveJobs, put } = fixture(t);
  saveJobs([hermesJob()]);
  const first = previewMigration(config, 'hermes', source);
  saveJobs([hermesJob({ prompt: 'Different prompt' })]);
  assert.throws(() => importMigration(config, 'hermes', source, first.fingerprint), /changed since the preview/);
  const second = previewMigration(config, 'hermes', source);
  put(join(source, 'config.yaml'), 'timezone: UTC\n');
  assert.throws(() => importMigration(config, 'hermes', source, second.fingerprint), /changed since the preview|No supported/);
  assert.equal(existsSync(join(config.home, 'rookery.db')), false);
});

test('database insertion failure rolls back already written Markdown and all inserted schedules', t => {
  const { source, config, put, saveJobs } = fixture(t);
  put(join(source, 'SOUL.md'), 'new soul');
  put(join(config.workspace, 'SOUL.md'), 'old soul');
  saveJobs([hermesJob(), hermesJob({ id: 'fail', name: 'fail' })]);
  const store = new Store(join(config.home, 'rookery.db'));
  try {
    store.db.exec("CREATE TRIGGER migration_test_failure BEFORE INSERT ON cron_jobs WHEN NEW.name='fail' BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END");
    assert.throws(() => importMigration(config, 'hermes', source), /files were restored.*simulated insert failure/);
    assert.equal(readFileSync(join(config.workspace, 'SOUL.md'), 'utf8'), 'old soul');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS total FROM cron_jobs').get().total, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS total FROM organizations').get().total, 0);
    assert.equal(readFileSync(join(source, 'SOUL.md'), 'utf8'), 'new soul');
    const backup = readdirSync(join(config.home, 'migration-backups'))[0];
    assert.equal(JSON.parse(readFileSync(join(config.home, 'migration-backups', backup, 'manifest.json'), 'utf8')).status, 'rolled-back');
  } finally { store.close(); }
});

test('OpenClaw exports accept assistant prompts and reject system events and implicit staggering', t => {
  const { source, config, put } = fixture(t);
  put(join(source, 'jobs.json'), JSON.stringify({ jobs: [
    openclawJob({ agentId: 'main' }),
    openclawJob({ id: 'system', payload: { kind: 'systemEvent', text: 'inject event' } }),
    openclawJob({ id: 'stagger', schedule: { kind: 'cron', expr: '0 * * * *' } }),
    openclawJob({ id: 'custom', sessionTarget: 'session:private-session' }),
  ] }));
  const preview = previewMigration(config, 'openclaw', source);
  assert.equal(preview.jobs.length, 1);
  assert.equal(preview.warnings.filter(warning => warning.startsWith('Skipped schedule')).length, 3);
  assert.equal(importMigration(config, 'openclaw', source, preview.fingerprint).jobs.length, 1);
});

test('OpenClaw SQLite imports only the exact workspace partition and leaves source files unchanged', t => {
  const { root, config, put } = fixture(t);
  const state = join(root, 'openclaw');
  const workspace = join(state, 'workspace');
  const dbPath = join(state, 'state/openclaw.sqlite');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE cron_jobs (store_key TEXT,job_id TEXT,job_json TEXT)');
    const insert = db.prepare('INSERT INTO cron_jobs VALUES (?,?,?)');
    insert.run(resolve(state, 'cron/jobs.json'), 'tea', JSON.stringify(openclawJob()));
    insert.run(resolve(state, 'cron/custom.json'), 'private', JSON.stringify(openclawJob({ id: 'private', name: 'Unrelated agent' })));
    const beforeNames = readdirSync(dirname(dbPath)).sort();
    const before = new Map(beforeNames.map(name => [name, readFileSync(join(dirname(dbPath), name))]));
    const preview = previewMigration(config, 'openclaw', workspace);
    assert.equal(preview.canImport, true, preview.warnings.join('\n'));
    assert.deepEqual(preview.jobs.map(job => job.sourceId), ['tea']);
    assert.equal(importMigration(config, 'openclaw', workspace, preview.fingerprint).jobs.length, 1);
    assert.deepEqual(readdirSync(dirname(dbPath)).sort(), beforeNames);
    for (const [name, bytes] of before) assert.deepEqual(readFileSync(join(dirname(dbPath), name)), bytes, name);
  } finally { db.close(); }
});
