import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { DEFAULT_CONFIG, ensureProfile, Store } from '@rookery/core';
import { registerProfileRoutes } from '../dist/routes/profile.js';
import { createAuthHook } from '../dist/auth.js';

test('profile files require authentication and same origin, and only allow bounded Markdown edits', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'rookery-profile-api-'));
  const config = { ...structuredClone(DEFAULT_CONFIG), home, workspace: join(home, 'workspace'), token: 'profile-test-token' };
  ensureProfile(config);
  const app = Fastify({ bodyLimit: 16 * 1024 * 1024 });
  t.after(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); });
  const context = { config };
  app.addHook('preHandler', createAuthHook(context));
  await registerProfileRoutes(app, context);
  const headers = { authorization: 'Bearer profile-test-token', origin: 'http://localhost:80' };
  const read = () => app.inject({ url: '/api/profile', headers });
  const patch = (name, payload, extraHeaders = {}) => app.inject({ method: 'PATCH', url: '/api/profile/' + encodeURIComponent(name), headers: { ...headers, ...extraHeaders }, payload });

  assert.equal((await app.inject({ url: '/api/profile' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/migration/preview', payload: { source: 'hermes' } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/migration/import', payload: { source: 'hermes' } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/profile/SOUL.md', payload: { content: 'blocked' } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/profile', headers: { ...headers, origin: 'https://untrusted.example' } })).statusCode, 403);
  assert.equal((await patch('SOUL.md', { content: 'blocked' }, { origin: 'null' })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/profile', headers: { authorization: headers.authorization, 'sec-fetch-site': 'cross-site' } })).statusCode, 403);
  assert.equal((await read()).statusCode, 200);
  assert.deepEqual((await read()).json().files.map((file) => file.name).sort(), ['AGENTS.md', 'IDENTITY.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md', 'USER.md']);
  assert.equal((await patch('../config.json', { content: '{}' })).statusCode, 400);
  assert.equal((await patch('config.json', { content: '{}' })).statusCode, 400);
  assert.equal((await patch('SOUL.md', { content: 4 })).statusCode, 400);
  assert.equal((await patch('SOUL.md', { content: 'x'.repeat(1024 * 1024 + 1) })).statusCode, 400);
  assert.equal((await patch('SOUL.md', { content: '# Personality\nWarm and curious.\n' })).statusCode, 200);
  assert.equal(readFileSync(join(config.workspace, 'SOUL.md'), 'utf8'), '# Personality\nWarm and curious.\n');
  assert.equal((await read()).json().files.find((file) => file.name === 'SOUL.md').content, '# Personality\nWarm and curious.\n');
});

test('migration preview is read-only and import requires an unchanged preview with backups', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'rookery-migration-api-'));
  const config = { ...structuredClone(DEFAULT_CONFIG), home, workspace: join(home, 'workspace') };
  ensureProfile(config);
  const originalSoul = readFileSync(join(config.workspace, 'SOUL.md'), 'utf8');
  const sourcePath = join(home, 'openclaw');
  mkdirSync(sourcePath);
  writeFileSync(join(sourcePath, 'SOUL.md'), '# Soul\nExisting companion.\n');
  writeFileSync(join(sourcePath, '.env'), 'SHOULD_NOT_IMPORT=secret');
  const app = Fastify();
  t.after(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); });
  await registerProfileRoutes(app, { config });
  const post = (route, payload, headers = {}) => app.inject({ method: 'POST', url: '/api/migration/' + route, payload, headers });
  assert.equal((await post('preview', { source: 'other', sourcePath })).statusCode, 400);
  assert.equal((await post('preview', { source: 'openclaw', sourcePath: 'bad\0path' })).statusCode, 400);
  assert.equal((await post('preview', { source: 'openclaw', sourcePath }, { origin: 'https://untrusted.example' })).statusCode, 403);
  assert.equal((await post('import', { source: 'openclaw', sourcePath })).statusCode, 400);
  const missing = await post('preview', { source: 'openclaw', sourcePath: join(home, 'missing') });
  assert.equal(missing.json().canImport, false);
  const first = await post('preview', { source: 'openclaw', sourcePath });
  assert.equal(first.statusCode, 200, first.body);
  const preview = first.json();
  assert.equal(preview.canImport, true);
  assert.ok(preview.files.some((file) => file.targetPath === 'SOUL.md' && file.conflict));
  assert.ok(!first.body.includes('Existing companion'));
  assert.ok(!first.body.includes('SHOULD_NOT_IMPORT'));
  assert.equal(readFileSync(join(config.workspace, 'SOUL.md'), 'utf8'), originalSoul);
  writeFileSync(join(sourcePath, 'SOUL.md'), '# Soul\nChanged companion.\n');
  const stale = await post('import', { source: 'openclaw', sourcePath, expectedFingerprint: preview.fingerprint });
  assert.equal(stale.statusCode, 400, stale.body);
  assert.equal(readFileSync(join(config.workspace, 'SOUL.md'), 'utf8'), originalSoul);
  const fresh = (await post('preview', { source: 'openclaw', sourcePath })).json();
  const imported = await post('import', { source: 'openclaw', sourcePath, expectedFingerprint: fresh.fingerprint });
  assert.equal(imported.statusCode, 200, imported.body);
  assert.ok(imported.json().backupPath);
  assert.equal(readFileSync(join(config.workspace, 'SOUL.md'), 'utf8'), '# Soul\nChanged companion.\n');
  assert.equal(readFileSync(join(sourcePath, 'SOUL.md'), 'utf8'), '# Soul\nChanged companion.\n');
  assert.ok(imported.json().files.includes('SOUL.md'));
  const repeated = await post('import', { source: 'openclaw', sourcePath, expectedFingerprint: fresh.fingerprint });
  assert.equal(repeated.statusCode, 400);
});

test('migration API imports only selected files and jobs and rejects invalid or empty selections before writes', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'rookery-migration-selection-api-'));
  const config = { ...structuredClone(DEFAULT_CONFIG), home, workspace: join(home, 'workspace') };
  ensureProfile(config);
  const originalSoul = readFileSync(join(config.workspace, 'SOUL.md'), 'utf8');
  const originalUser = readFileSync(join(config.workspace, 'USER.md'), 'utf8');
  const sourcePath = join(home, 'hermes');
  mkdirSync(join(sourcePath, 'cron'), { recursive: true });
  writeFileSync(join(sourcePath, 'SOUL.md'), 'Selected personality');
  writeFileSync(join(sourcePath, 'USER.md'), 'Do not import this user');
  writeFileSync(join(sourcePath, 'cron/jobs.json'), JSON.stringify({ jobs: ['selected-job', 'excluded-job'].map(id => ({
    id, name: id, prompt: 'Remember tea.', schedule: { kind: 'cron', expr: '15 8 * * *' },
    repeat: { times: null }, state: 'scheduled', enabled: true,
  })) }));
  const app = Fastify();
  t.after(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); });
  const announcements = [];
  await registerProfileRoutes(app, { config, assistant: {
    cron: { get(id) {
      const store = new Store(join(home, 'rookery.db'));
      try { return store.cron.getJob(id); } finally { store.close(); }
    } },
    emit: (channel, event) => announcements.push({ channel, event }),
  } });
  const post = (route, payload) => app.inject({ method: 'POST', url: '/api/migration/' + route, payload });
  const preview = (await post('preview', { source: 'hermes', sourcePath })).json();
  assert.equal(preview.jobs.length, 2);
  const input = { source: 'hermes', sourcePath, expectedFingerprint: preview.fingerprint };
  for (const selection of [
    { files: [], jobs: [] },
    { files: ['missing.md'], jobs: [] },
    { files: [], jobs: ['unknown-job'] },
    { files: ['SOUL.md'], jobs: [], unexpected: true },
    { files: ['SOUL.md'] },
  ]) {
    const rejected = await post('import', { ...input, selection });
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.equal(readFileSync(join(config.workspace, 'SOUL.md'), 'utf8'), originalSoul);
    assert.equal(existsSync(join(home, 'migration-backups')), false);
  }
  const selectedJob = preview.jobs.find(job => job.name === 'selected-job');
  const imported = await post('import', { ...input, selection: { files: ['SOUL.md'], jobs: [selectedJob.sourceId] } });
  assert.equal(imported.statusCode, 200, imported.body);
  assert.deepEqual(imported.json().files, ['SOUL.md']);
  assert.equal(imported.json().jobs.length, 1);
  assert.equal(announcements.length, 1, 'imported jobs become visible in connected clients without reloading');
  assert.equal(announcements[0].channel, 'cron');
  assert.equal(announcements[0].event.type, 'cron');
  assert.equal(announcements[0].event.job.id, imported.json().jobs[0]);
  assert.equal(announcements[0].event.job.enabled, false);
  assert.equal(readFileSync(join(config.workspace, 'SOUL.md'), 'utf8'), 'Selected personality');
  assert.equal(readFileSync(join(config.workspace, 'USER.md'), 'utf8'), originalUser);
  const backupPath = imported.json().backupPath;
  assert.equal(readFileSync(join(backupPath, 'SOUL.md'), 'utf8'), originalSoul);
  assert.equal(existsSync(join(backupPath, 'USER.md')), false);
  const manifest = JSON.parse(readFileSync(join(backupPath, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.files.map(file => file.targetPath), ['SOUL.md']);
  assert.deepEqual(manifest.jobs.map(job => job.sourceId), [selectedJob.sourceId]);
  const store = new Store(join(home, 'rookery.db'));
  try {
    assert.equal(store.db.prepare('SELECT COUNT(*) AS total FROM cron_jobs').get().total, 1);
    assert.equal(store.cron.getJob(imported.json().jobs[0]).name, 'selected-job');
    assert.equal(store.cron.getJob(imported.json().jobs[0]).enabled, false);
  } finally { store.close(); }
});
