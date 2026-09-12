import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { DEFAULT_CONFIG } from '@rookery/core';
import { registerGatewayRoutes } from '../dist/routes/gateways.js';

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
