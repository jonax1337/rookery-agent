// Run after building the server: node --test packages/server/test/static.test.js
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { registerStatic } from '../dist/static.js';

test('serves rebuilt assets without restarting and keeps API and missing assets out of the SPA', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rookery-static-'));
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'assets'));
  await mkdir(join(root, 'api'));
  await mkdir(join(root, 'ws'));
  await writeFile(join(root, 'index.html'), '<html>Initial build</html>');
  await writeFile(join(root, 'assets', 'initial.js'), 'initial();');
  await writeFile(join(root, 'api', 'missing.json'), '{"static":true}');
  await writeFile(join(root, 'ws', 'missing.json'), '{"static":true}');
  app.get('/api/health', () => ({ ok: true }));
  await registerStatic(app, { log: { info() {} } }, root);
  await app.ready();

  assert.equal((await app.inject('/assets/initial.js')).body, 'initial();');
  // Vite replaces index.html and emits a different asset hash after startup.
  await writeFile(join(root, 'assets', 'rebuilt.js'), 'rebuilt();');
  await writeFile(join(root, 'index.html'), '<html><script src="/assets/rebuilt.js"></script></html>');
  await rm(join(root, 'assets', 'initial.js'));
  assert.match((await app.inject('/')).body, /rebuilt\.js/);
  const asset = await app.inject('/assets/rebuilt.js?version=2');
  assert.equal(asset.statusCode, 200);
  assert.match(asset.headers['content-type'], /javascript/);
  assert.equal(asset.body, 'rebuilt();');
  assert.match((await app.inject('/tasks/task-123')).body, /rebuilt\.js/);
  assert.deepEqual((await app.inject('/api/health')).json(), { ok: true });

  for (const url of ['/assets/initial.js', '/assets/missing.css', '/api/missing.json', '/api/missing', '/ws/missing.json', '/ws/missing']) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 404, url);
    assert.match(response.headers['content-type'], /application\/json/, url);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/tasks/task-123' })).statusCode, 404);
});
