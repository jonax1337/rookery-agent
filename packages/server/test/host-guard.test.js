import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Assistant, ProviderRegistry, Store } from '@rookery/core';
import { buildServer } from '../dist/server.js';

/**
 * What stands between a web page in the person's browser and the local API
 * when no token is set: the Host guard (DNS rebinding), the Origin check on
 * writes, and the absence of CORS headers (reads from another origin).
 */

async function server(config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'rookery-host-'));
  const assistant = new Assistant({
    store: new Store(':memory:'),
    registry: new ProviderRegistry([]),
    config: { home, logLevel: 'silent', memory: { enabled: false, autoExtract: false }, org: { autoReview: false }, ...config },
  });
  const app = await buildServer(assistant, { quiet: true });
  return {
    app,
    async dispose() {
      await app.close();
      assistant.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test('a rebound domain is refused without a token, names the person allowed are not', async (t) => {
  const { app, dispose } = await server({ allowedHosts: ['Rookery.Tailnet.ts.net'] });
  t.after(dispose);
  const get = (host) => app.inject({ method: 'GET', url: '/api/health', headers: { host } });

  for (const host of ['localhost:4317', '127.0.0.1:4317', '[::1]:4317', '192.168.1.20:4317', 'app.localhost:4317']) {
    assert.equal((await get(host)).statusCode, 200, host + ' is this machine');
  }
  assert.equal((await get('rookery.tailnet.ts.net')).statusCode, 200, 'a configured name, whatever its case');

  // The page an attacker serves from their own domain, pointed at 127.0.0.1
  // after the browser has looked it up: same origin as far as the browser knows.
  const rebound = await get('evil.example:4317');
  assert.equal(rebound.statusCode, 403);
  assert.match(rebound.json().message, /allowedHosts/);
});

test('with a token the host name no longer matters, because the token does', async (t) => {
  const { app, dispose } = await server({ token: 'secret' });
  t.after(dispose);
  const headers = { host: 'mypc.lan:4317' };

  assert.equal((await app.inject({ method: 'GET', url: '/api/health', headers })).statusCode, 401);
  const ok = await app.inject({ method: 'GET', url: '/api/health', headers: { ...headers, authorization: 'Bearer secret' } });
  assert.equal(ok.statusCode, 200);
});

test('no response invites another origin to read it', async (t) => {
  const { app, dispose } = await server();
  t.after(dispose);

  const read = await app.inject({
    method: 'GET',
    url: '/api/health',
    headers: { host: 'localhost:4317', origin: 'https://evil.example' },
  });
  assert.equal(read.headers['access-control-allow-origin'], undefined);

  const preflight = await app.inject({
    method: 'OPTIONS',
    url: '/api/config',
    headers: {
      host: 'localhost:4317',
      origin: 'https://evil.example',
      'access-control-request-method': 'PATCH',
    },
  });
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);
});

test('a write must come from the server\'s own host, over http or https', async (t) => {
  const { app, dispose } = await server();
  t.after(dispose);
  const write = (origin) =>
    app.inject({
      method: 'POST',
      url: '/api/dream/policies/none/revert',
      headers: { host: 'localhost:4317', origin },
    });

  assert.equal((await write('https://evil.example')).statusCode, 403);
  assert.equal((await write('http://localhost:4318')).statusCode, 403, 'another port is another origin');
  assert.equal((await write('null')).statusCode, 403);
  // A TLS-terminating proxy in front of this plain-HTTP server: the browser says https.
  assert.notEqual((await write('https://localhost:4317')).statusCode, 403);
  assert.notEqual((await write('http://localhost:4317')).statusCode, 403);
});
