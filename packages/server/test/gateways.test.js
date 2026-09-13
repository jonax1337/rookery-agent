import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { EventEmitter } from 'node:events';
import { DEFAULT_CONFIG } from '@rookery/core';
import { registerGatewayRoutes } from '../dist/routes/gateways.js';
import { attachGatewayPush } from '../dist/gateways/push.js';

test('script watchdogs stay quiet on empty success while failures still notify', async (t) => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateways.telegram.allowedUserIds = [7];
  Object.assign(config.gateways.telegram.push, { enabled: true, cron: true, quietFrom: '00:00', quietUntil: '00:00', maxPerHour: 0 });
  const assistant = new EventEmitter();
  const sent = [];
  const push = attachGatewayPush({ config, assistant, log: { warn() {} } }, { status: () => ({ running: true }), send: async (_id, text) => { sent.push(text); } });
  t.after(() => push.detach());
  const job = { id: 'watcher', name: 'Watch', kind: 'script' };
  assistant.emit('cron', { type: 'cron', job, run: { id: 'quiet', status: 'done', result: '' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 0);
  assistant.emit('cron', { type: 'cron', job, run: { id: 'broken', status: 'failed', error: 'missing dependency' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /failed/);
});

test('gateway test messages use English and only reach an allowed recipient', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const config = structuredClone(DEFAULT_CONFIG);
  let running = false;
  const sent = [];
  await registerGatewayRoutes(app, {
    config,
    gateways: [{
      id: 'telegram',
      status: () => ({ running }),
      send: async (recipient, text) => { sent.push({ recipient, text }); },
    }],
  });

  const stopped = await app.inject({ method: 'POST', url: '/api/gateways/telegram/test' });
  assert.equal(stopped.statusCode, 400);
  assert.equal(stopped.json().message, 'The gateway is not running.');

  running = true;
  config.gateways.telegram.push.recipients = [99];
  const rejected = await app.inject({ method: 'POST', url: '/api/gateways/telegram/test' });
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.json().message, 'No recipient is configured.');
  assert.deepEqual(sent, []);

  config.gateways.telegram.allowedUserIds = [7];
  const delivered = await app.inject({ method: 'POST', url: '/api/gateways/telegram/test' });
  assert.equal(delivered.statusCode, 200);
  assert.deepEqual(sent, [{
    recipient: 7,
    text: 'Test message from Rookery - if you can read this, the gateway is working.',
  }]);
});
