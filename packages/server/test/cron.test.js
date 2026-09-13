import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Assistant, ProviderRegistry, Store } from '@rookery/core';
import { registerCronRoutes } from '../dist/routes/cron.js';

test('script cron API protects source and execution from cross-origin requests and requires explicit full access', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'rookery-script-api-'));
  const assistant = new Assistant({ store: new Store(':memory:'), registry: new ProviderRegistry([]), config: { home, logLevel: 'silent', memory: { enabled: false } } });
  const app = Fastify();
  t.after(async () => { await app.close(); assistant.close(); rmSync(home, { recursive: true, force: true }); });
  await registerCronRoutes(app, { assistant, log: { warn() {} } });
  const directory = join(home, 'imported-scripts');
  mkdirSync(directory);
  const path = join(directory, 'watcher.cjs');
  writeFileSync(path, 'console.log("harmless test")');
  const job = assistant.cron.create({ orgId: assistant.org.activeOrganization().id, name: 'Script', schedule: '* * * * *', prompt: '', kind: 'script', script: { path, runtime: 'node', noAgent: true }, enabled: false, permission: 'chat', createdBy: 'user' });
  const url = '/api/cron/' + job.id;
  for (const [method, route, payload] of [['GET', url], ['POST', url + '/run', {}], ['PATCH', url, { permission: 'full', enabled: true }], ['DELETE', url]]) {
    const response = await app.inject({ method, url: route, headers: { origin: 'https://untrusted.example' }, payload });
    assert.equal(response.statusCode, 403, method);
  }
  assert.equal((await app.inject({ url })).json().scriptSource, 'console.log("harmless test")');
  assert.equal((await app.inject({ method: 'POST', url: url + '/run' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url, payload: { enabled: true } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url, payload: { permission: 'full' } })).statusCode, 200);
  assert.equal(assistant.cron.get(job.id).enabled, false, 'review does not enable or run the script');
  assert.equal(assistant.cron.runs(job.id).length, 0);
  const edit = await app.inject({ method: 'PATCH', url, payload: { name: 'Edited', kind: 'script', agentId: null, prompt: '' } });
  assert.equal(edit.statusCode, 200);
  assert.equal(edit.json().kind, 'script');
  assert.deepEqual(edit.json().script, job.script);
});
