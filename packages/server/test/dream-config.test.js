import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { loadConfig } from '@rookery/core';
import { registerConfigRoutes } from '../dist/routes/config.js';

/**
 * The load-bearing line of the dream config (AP4): `dream: dreamConfigSchema`
 * inside `memoryConfigSchema`. Without it zod strips the branch, the PATCH is
 * answered with a 200, and remote setup is silently broken - the same way
 * `memory.gate` and `memory.graph` are not settable over HTTP today. Nothing
 * falls over when that line is missing, which is exactly why it needs a test.
 *
 * Not part of the root `npm test`; runs via `npm test -w @rookery/server`.
 */

function dreamContext() {
  const home = mkdtempSync(join(tmpdir(), 'rookery-dream-patch-'));
  return {
    config: loadConfig({ home }),
    assistant: {},
    sockets: new Set(),
    assignmentWatchers: new Map(),
    gateways: [],
    listeners: { refresh: async () => {} },
    log: { info() {}, warn() {} },
  };
}

test('a memory.dream PATCH reaches the config instead of being silently dropped', async (t) => {
  const context = dreamContext();
  const app = Fastify();
  t.after(() => app.close());
  await registerConfigRoutes(app, context);

  const before = await app.inject({ method: 'GET', url: '/api/config' });
  assert.equal(before.statusCode, 200);
  assert.equal(before.json().memory.dream.frameRate, 0.25);

  const patched = await app.inject({
    method: 'PATCH',
    url: '/api/config',
    payload: { memory: { dream: { frameRate: 0.5 } } },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(
    patched.json().memory.dream.frameRate,
    0.5,
    'the patched value comes back on the answer',
  );
  assert.equal(
    patched.json().memory.dream.limitMax,
    16,
    'a partial patch does not wipe the rest of the block',
  );

  const after = await app.inject({ method: 'GET', url: '/api/config' });
  assert.equal(after.json().memory.dream.frameRate, 0.5, 'and survives the read-back');
  assert.equal(
    context.config.memory.dream.frameRate,
    0.5,
    'the live object the runtime holds sees it too',
  );
});

test('dream values outside their clamped range are refused, not silently written', async (t) => {
  const context = dreamContext();
  const app = Fastify();
  t.after(() => app.close());
  await registerConfigRoutes(app, context);

  const rejected = await app.inject({
    method: 'PATCH',
    url: '/api/config',
    payload: { memory: { dream: { frameRate: 5 } } },
  });
  assert.equal(rejected.statusCode, 400, 'a share above 1 is not a share');
  assert.equal(
    context.config.memory.dream.frameRate,
    0.25,
    'and the refusal left the stored value alone',
  );
});
