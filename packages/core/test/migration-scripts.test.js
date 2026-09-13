import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, previewMigration, importMigration, Store } from '../dist/index.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'rookery-selected-import-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'hermes');
  mkdirSync(join(source, 'scripts'), { recursive: true });
  mkdirSync(join(source, 'cron'));
  const config = loadConfig({ home: join(root, 'rookery') });
  const save = jobs => writeFileSync(join(source, 'cron', 'jobs.json'), JSON.stringify({ jobs }));
  const job = { id: 'watch', name: 'Mail-Watcher fixture', script: 'watch.py', no_agent: false, prompt: 'Summarize the script result.', schedule: { kind: 'cron', expr: '*/10 7-22 * * *' }, repeat: { times: 10, completed: 7 } };
  writeFileSync(join(source, 'SOUL.md'), 'A different persona.');
  writeFileSync(join(source, 'scripts', 'watch.py'), 'import helper\nSTATE = "watch_state.json"\nprint(helper.result)\n');
  writeFileSync(join(source, 'scripts', 'helper.py'), 'result = "fixture only"\nTOKEN_FILE = "access_token.json"\n');
  writeFileSync(join(source, 'scripts', 'watch_state.json'), '{"seen":["already-seen"]}');
  writeFileSync(join(source, 'scripts', 'access_token.json'), '{"access_token":"not-copied"}');
  save([job, { ...job, id: 'other', name: 'Unselected job' }]);
  return { config, source, job, save };
}

test('selecting a script job imports its exact code, local helpers and state without changing identity or other jobs', t => {
  const { config, source } = fixture(t);
  const soul = readFileSync(join(config.workspace, 'SOUL.md'), 'utf8');
  const preview = previewMigration(config, 'hermes', source);
  assert.equal(preview.jobs[0].kind, 'script');
  assert.equal(preview.jobs[0].remainingRuns, 3);
  assert.equal(preview.jobs[0].assets.length, 3);
  assert.ok(!JSON.stringify(preview).includes('not-copied'));
  assert.ok(preview.warnings.some(w => /Credential-like sidecar/.test(w)));
  const result = importMigration(config, 'hermes', source, preview.fingerprint, { files: [], jobs: ['watch'] });
  assert.equal(result.jobs.length, 1);
  assert.equal(readFileSync(join(config.workspace, 'SOUL.md'), 'utf8'), soul);
  assert.deepEqual(readFileSync(preview.jobs[0].script.path), readFileSync(join(source, 'scripts/watch.py')));
  assert.ok(!existsSync(join(preview.jobs[0].script.path, '..', 'access_token.json')));
  const db = new Store(join(config.home, 'rookery.db'));
  try {
    const imported = db.cron.getJob(result.jobs[0]);
    assert.equal(imported.kind, 'script');
    assert.equal(imported.enabled, false);
    assert.equal(imported.permission, 'chat');
    assert.equal(imported.remainingRuns, 3);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM cron_jobs').get().count, 1);
    assert.deepEqual(db.cron.dueJobs(Date.now() + 86400000), []);
  } finally { db.close(); }
  const manifest = JSON.parse(readFileSync(join(result.backupPath, 'manifest.json')));
  assert.ok(manifest.files.every(file => file.targetRoot === config.home));
  assert.ok(!manifest.files.some(file => file.targetPath === 'SOUL.md'));
});

test('file-only and rejected selections never copy scripts or create schedules', t => {
  const { config, source } = fixture(t);
  const p = previewMigration(config, 'hermes', source);
  for (const selection of [{ files: [], jobs: [] }, { files: ['../config.json'], jobs: [] }, { files: [], jobs: ['missing'] }, { files: ['SOUL.md', 'SOUL.md'], jobs: [] }]) {
    assert.throws(() => importMigration(config, 'hermes', source, p.fingerprint, selection));
  }
  assert.ok(!existsSync(join(config.home, 'migration-backups')));
  const imported = importMigration(config, 'hermes', source, p.fingerprint, { files: ['SOUL.md'], jobs: [] });
  assert.deepEqual(imported.files, ['SOUL.md']);
  assert.deepEqual(imported.jobs, []);
  assert.ok(!existsSync(join(config.home, 'rookery.db')));
  assert.ok(!existsSync(join(config.home, 'imported-scripts')));
});

test('script changes invalidate preview and unsafe script paths are explained without execution', t => {
  const { config, source, job, save } = fixture(t);
  const p = previewMigration(config, 'hermes', source);
  writeFileSync(join(source, 'scripts/helper.py'), 'result = "changed"\n');
  assert.throws(() => importMigration(config, 'hermes', source, p.fingerprint, { files: [], jobs: ['watch'] }), /changed since the preview/);
  assert.ok(!existsSync(join(config.home, 'imported-scripts')));
  save([{ ...job, script: '../outside.py' }]);
  const rejected = previewMigration(config, 'hermes', source);
  assert.equal(rejected.jobs.length, 0);
  assert.ok(rejected.warnings.some(w => /inside the source scripts folder/.test(w)));
});

test('failed selected script import restores files across both roots and leaves no schedule', t => {
  const { config, source } = fixture(t);
  const originalSoul = readFileSync(join(config.workspace, 'SOUL.md'), 'utf8');
  const db = new Store(join(config.home, 'rookery.db'));
  try {
    db.db.exec("CREATE TRIGGER reject_script BEFORE INSERT ON cron_jobs BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    const preview = previewMigration(config, 'hermes', source);
    assert.throws(() => importMigration(config, 'hermes', source, preview.fingerprint, { files: ['SOUL.md'], jobs: ['watch'] }), /files were restored.*test failure/);
    assert.equal(readFileSync(join(config.workspace, 'SOUL.md'), 'utf8'), originalSoul);
    assert.ok(preview.jobs.find(job => job.sourceId === 'watch').assets.every(asset => !existsSync(join(config.home, asset.targetPath))));
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM cron_jobs').get().count, 0);
  } finally { db.close(); }
});

test('script-only jobs need no prompt and dependencies cannot smuggle credential files by extension', t => {
  const { config, source, job, save } = fixture(t);
  writeFileSync(join(source, 'scripts/watch.js'), "require('./credentials.JSON'); require('./.env'); require('./private.pem'); console.log('fixture');");
  writeFileSync(join(source, 'scripts/credentials.JSON'), '{"api_key":"never-copy"}');
  writeFileSync(join(source, 'scripts/.env'), 'API_KEY=never-copy');
  writeFileSync(join(source, 'scripts/private.pem'), 'private credential fixture');
  save([{ ...job, script: 'watch.js', no_agent: true, prompt: undefined }]);
  const preview = previewMigration(config, 'hermes', source);
  assert.equal(preview.jobs.length, 1);
  assert.equal(preview.jobs[0].prompt, '');
  assert.deepEqual(preview.jobs[0].assets.map(asset => asset.sourcePath), ['scripts/watch.js']);
  assert.ok(!JSON.stringify(preview).includes('never-copy'));
  assert.ok(preview.warnings.some(w => w.includes('credentials.JSON') && w.includes('not copied')));
  assert.ok(preview.warnings.some(w => w.includes('.env') && w.includes('not copied')));
  assert.ok(preview.warnings.some(w => w.includes('private.pem') && w.includes('not copied')));
});

test('script bundles never target a directory inside the selected source', t => {
  const { config, source, save, job } = fixture(t);
  save([job]);
  const overlapping = { ...config, home: source };
  const preview = previewMigration(overlapping, 'hermes', source);
  assert.equal(preview.jobs.length, 0);
  assert.ok(preview.warnings.some(w => /must not overlap/.test(w)));
  assert.ok(!existsSync(join(source, 'imported-scripts')));
});
