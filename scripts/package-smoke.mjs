// Run against an installed tarball: node scripts/package-smoke.mjs <package-directory>
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

const root = resolve(process.argv[2]);
const home = mkdtempSync(join(tmpdir(), 'rookery-package-'));
const socket = createServer();
await new Promise((done) => socket.listen(0, '127.0.0.1', done));
const port = socket.address().port;
await new Promise((done) => socket.close(done));
writeFileSync(join(home, 'config.json'), JSON.stringify({ port, host: '127.0.0.1', token: '', tools: { servers: [] } }));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ROOKERY_')));
env.ROOKERY_HOME = home;
const run = () => execFileSync(process.execPath, [join(root, 'scripts/rookery.mjs'), 'start'], { env, encoding: 'utf8', timeout: 45000 });
let pid;
try {
  const first = run();
  pid = Number(first.match(/PID (\d+)/)?.[1]);
  assert.ok(pid, first);
  assert.ok(!run().includes('Started server'), 'second start must reuse the listener');
  const url = `http://127.0.0.1:${port}`;
  // This test deliberately kills the server; do not pool sockets across that boundary.
  const page = await fetch(url + '/settings', { headers: { Connection: 'close' } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="root">/);
  const patch = await fetch(url + '/api/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify({ assistantName: 'Install smoke' }) });
  assert.equal(patch.status, 200);
  assert.equal((await patch.json()).assistantName, 'Install smoke');
  process.kill(pid);
  pid = undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { await fetch(url + '/api/config', { headers: { Connection: 'close' }, signal: AbortSignal.timeout(500) }); }
    catch { break; }
    await new Promise((done) => setTimeout(done, 100));
  }
  const restarted = run();
  pid = Number(restarted.match(/PID (\d+)/)?.[1]);
  assert.ok(pid, restarted);
  assert.equal((await (await fetch(url + '/api/config', { headers: { Connection: 'close' } })).json()).assistantName, 'Install smoke');
  console.log('PASS: installed npm package serves Settings, persists configuration across restart without .env, and repeated start is idempotent.');
} finally {
  if (pid) process.kill(pid);
  console.log(`Isolated test data/logs: ${home}`);
}
