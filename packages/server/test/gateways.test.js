import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { EventEmitter } from 'node:events';
import { DEFAULT_CONFIG } from '@rookery/core';
import { registerGatewayRoutes } from '../dist/routes/gateways.js';
import { attachGatewayPush } from '../dist/gateways/push.js';
import { htmlPieces } from '../dist/gateways/telegram.js';

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

test('mail reaches the phone from the assistant and anyone who leads, from nobody else', async (t) => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateways.telegram.allowedUserIds = [7];
  Object.assign(config.gateways.telegram.push, { enabled: true, quietFrom: '00:00', quietUntil: '00:00', maxPerHour: 0 });

  const agents = {
    lead: { id: 'lead', name: 'Mona', slug: 'mona', managerId: undefined },
    // A head of department: no team of their own, but people report to them.
    head: { id: 'head', name: 'Victor', slug: 'victor', managerId: undefined },
    hand: { id: 'hand', name: 'Pat', slug: 'pat', managerId: 'head' },
  };
  const assistant = new EventEmitter();
  assistant.store = {
    org: {
      getAgent: (id) => agents[id] ?? null,
      listTeams: () => [{ id: 'team', leadId: 'lead' }],
      listAgents: (_orgId, options = {}) =>
        Object.values(agents).filter((agent) => agent.managerId === options.managerId),
    },
  };

  const sent = [];
  const push = attachGatewayPush({ config, assistant, log: { warn() {} } }, {
    status: () => ({ running: true }),
    send: async (_id, text) => { sent.push(text); },
  });
  t.after(() => push.detach());

  const mail = (id, from, recipients) => ({
    type: 'mail',
    mail: {
      id,
      orgId: 'org',
      fromKind: from.kind,
      fromAgentId: from.id,
      subject: 'Subject ' + id,
      body: 'Body ' + id,
      recipients: recipients.map((kind) => ({ recipientKind: kind, box: 'to' })),
    },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  // Agent to agent: the user is not on it, so it is none of the phone's business.
  assistant.emit('mail', mail('m1', { kind: 'agent', id: 'lead' }, ['agent']));
  await settle();
  assert.deepEqual(sent, []);

  // An ordinary agent writing to the user: it lands in the web inbox only.
  assistant.emit('mail', mail('m2', { kind: 'agent', id: 'hand' }, ['user']));
  await settle();
  assert.deepEqual(sent, []);

  assistant.emit('mail', mail('m3', { kind: 'agent', id: 'lead' }, ['user']));
  await settle();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Mona – Subject m3/);
  assert.match(sent[0], /Body m3/);

  assistant.emit('mail', mail('m4', { kind: 'assistant' }, ['user']));
  await settle();
  assert.equal(sent.length, 2);
  assert.match(sent[1], /Assistant – Subject m4/);

  // A head of department leads nothing named "team" and still leads.
  assistant.emit('mail', mail('m7', { kind: 'agent', id: 'head' }, ['user']));
  await settle();
  assert.equal(sent.length, 3);
  assert.match(sent[2], /Victor – Subject m7/);

  // 'assistant' narrows it back down to the one voice the user asked for.
  config.gateways.telegram.push.mailFrom = 'assistant';
  assistant.emit('mail', mail('m5', { kind: 'agent', id: 'lead' }, ['user']));
  await settle();
  assert.equal(sent.length, 3);

  // The switch is the master: mailFrom never overrides it.
  config.gateways.telegram.push.mail = false;
  config.gateways.telegram.push.mailFrom = 'all';
  assistant.emit('mail', mail('m6', { kind: 'agent', id: 'hand' }, ['user']));
  await settle();
  assert.equal(sent.length, 3);
});

test('a long message is cut so that every piece still fits after HTML escaping', () => {
  // Plain text: the pieces land at Telegram's own limit.
  const plain = 'a'.repeat(10_000);
  const plainPieces = htmlPieces(plain);
  assert.ok(plainPieces.length >= 3);
  for (const piece of plainPieces) assert.ok(piece.length <= 4096);
  assert.equal(plainPieces.join('').replace(/\n/g, ''), plain);

  // Escaping quintuples this one; a naive cut at 4096 would be refused by
  // the API, and the message would never arrive at all.
  const hostile = '&'.repeat(8000);
  const hostilePieces = htmlPieces(hostile);
  for (const piece of hostilePieces) assert.ok(piece.length <= 4096, 'piece of ' + piece.length + ' would be rejected');
  assert.equal(hostilePieces.join('').replace(/\n/g, '').replace(/&amp;/g, '&'), hostile);
});

test('a long mail reaches the phone whole instead of being cut at 600 characters', async (t) => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.gateways.telegram.allowedUserIds = [7];
  Object.assign(config.gateways.telegram.push, { enabled: true, quietFrom: '00:00', quietUntil: '00:00', maxPerHour: 0 });

  const assistant = new EventEmitter();
  assistant.store = { org: { getAgent: () => null, listTeams: () => [], listAgents: () => [] } };
  const sent = [];
  const push = attachGatewayPush({ config, assistant, log: { warn() {} } }, {
    status: () => ({ running: true }),
    send: async (_id, text) => { sent.push(text); },
  });
  t.after(() => push.detach());

  const body = ('Sentence number one. ').repeat(150).trim();
  assert.ok(body.length > 2000);
  assistant.emit('mail', {
    type: 'mail',
    mail: {
      id: 'long',
      orgId: 'org',
      fromKind: 'assistant',
      subject: 'The long one',
      body,
      recipients: [{ recipientKind: 'user', box: 'to' }],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  // Several Telegram messages, and the text survives across the seam.
  const delivered = sent.join('');
  assert.ok(sent.length >= 1);
  assert.ok(delivered.includes(body.slice(-40)), 'the end of the mail never arrived');
  assert.ok(!delivered.includes('inbox.'), 'nothing should have been clipped at this length');
});
