import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { EventEmitter } from 'node:events';
import { DEFAULT_CONFIG } from '@rookery/core';
import { registerGatewayRoutes } from '../dist/routes/gateways.js';
import { attachGatewayPush } from '../dist/gateways/push.js';
import { COMMANDS, htmlPieces } from '../dist/gateways/telegram.js';
import { findOrigin, noteMessages, openThread, originContext, rememberOrigin, takeMessages } from '../dist/gateways/threads.js';

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

/* ------------------------------------------------------------------ *
 * Replying to a notification
 *
 * The point of the registry is that a mail push, a schedule and last
 * night's sleep report are three different subjects in one Telegram
 * column, and a reply has to reach the right one. These tests use a fake
 * store - the registry is a `meta` row and nothing more - so what is being
 * checked is the routing, not SQLite.
 * ------------------------------------------------------------------ */

function fakeContext(overrides = {}) {
  const meta = new Map();
  const sessions = new Map();
  let next = 0;
  const context = {
    config: structuredClone(DEFAULT_CONFIG),
    log: { warn() {}, info() {} },
    assistant: {
      store: {
        getMeta: (key) => meta.get(key) ?? null,
        setMeta: (key, value) => { meta.set(key, value); },
        getSleepRun: () => null,
        org: { getMail: () => null, getAgent: () => null, getAssignment: () => null, getTask: () => null },
        ...overrides.store,
      },
      cron: { get: () => null, runs: () => [], ...overrides.cron },
      getSession: (id) => sessions.get(id) ?? null,
      createSession: ({ title, kind }) => {
        next += 1;
        const session = { id: 'session-' + next, title, kind, messageCount: 0 };
        sessions.set(session.id, session);
        return session;
      },
    },
  };
  return { context, meta, sessions };
}

test('a reply finds what it answers, and each subject gets a thread of its own', () => {
  const { context } = fakeContext();

  rememberOrigin(context, 7, [100, 101], { kind: 'mail', ref: 'mail-1', title: 'Quarterly numbers' });
  rememberOrigin(context, 7, [200], { kind: 'sleep', ref: 'sleep-9', title: '12/09/2026' });

  // Any piece of a long notification leads back to the same subject.
  assert.equal(findOrigin(context, 7, 101)?.ref, 'mail-1');
  assert.equal(findOrigin(context, 7, 200)?.kind, 'sleep');
  assert.equal(findOrigin(context, 7, 999), undefined);
  // A different chat knows nothing about this one's messages.
  assert.equal(findOrigin(context, 8, 100), undefined);

  const fallback = () => { throw new Error('the plain chat must not be used for a record'); };
  const mailThread = openThread(context, findOrigin(context, 7, 100), fallback);
  assert.equal(mailThread.fresh, true);
  assert.match(mailThread.session.title, /Mail: Quarterly numbers/);

  const sleepThread = openThread(context, findOrigin(context, 7, 200), fallback);
  assert.notEqual(sleepThread.session.id, mailThread.session.id, 'two subjects must not share a conversation');

  // The second reply to the same mail continues the conversation the first
  // one opened, rather than opening another.
  mailThread.session.messageCount = 2;
  const again = openThread(context, findOrigin(context, 7, 100), fallback);
  assert.equal(again.session.id, mailThread.session.id);
  assert.equal(again.fresh, false, 'a continued thread must not be handed the notification twice');
});

test('a schedule is answered in the conversation the schedule itself runs in', () => {
  const { context, sessions } = fakeContext();
  sessions.set('job-session', { id: 'job-session', title: 'Daily', kind: 'chat', messageCount: 6 });

  rememberOrigin(context, 7, [300], { kind: 'cron', ref: 'run-3', parent: 'job-7', sessionId: 'job-session' });
  const thread = openThread(context, findOrigin(context, 7, 300), () => {
    throw new Error('the plain chat must not be used when the job owns a session');
  });
  assert.equal(thread.session.id, 'job-session');
  assert.equal(thread.fresh, false);
});

test('a notice with no record behind it falls back to the plain chat, carrying its own words', () => {
  const { context } = fakeContext();
  rememberOrigin(context, 7, [400], { kind: 'notify', snippet: 'The deploy is still red.' });
  const origin = findOrigin(context, 7, 400);
  assert.equal(originContext(context, origin), 'The deploy is still red.');

  const plain = { id: 'telegram-chat', title: 'Telegram', kind: 'chat', messageCount: 12 };
  const thread = openThread(context, origin, () => plain);
  assert.equal(thread.session.id, 'telegram-chat');
});

test('the mail itself is read back from the store, not from what was pushed', () => {
  const { context } = fakeContext({
    store: {
      org: {
        getMail: (id) => (id === 'mail-1'
          ? { id, fromKind: 'assistant', subject: 'Quarterly numbers', body: 'The whole body, all of it.', createdAt: 0 }
          : null),
        getAgent: () => null,
        getAssignment: () => null,
        getTask: () => null,
      },
    },
  });
  rememberOrigin(context, 7, [100], { kind: 'mail', ref: 'mail-1', snippet: 'a shortened push line' });
  const quoted = originContext(context, findOrigin(context, 7, 100));
  assert.match(quoted, /Quarterly numbers/);
  assert.match(quoted, /The whole body, all of it\./);
  assert.ok(!quoted.includes('shortened'), 'the push line is a fallback, not the source');
});

test('the registry stays bounded, keeping the newest messages', () => {
  const { context, meta } = fakeContext();
  for (let id = 1; id <= 450; id += 1) {
    rememberOrigin(context, 7, [id], { kind: 'notify', snippet: 'note ' + id });
  }
  assert.equal(findOrigin(context, 7, 450)?.snippet, 'note 450');
  assert.equal(findOrigin(context, 7, 1), undefined, 'the oldest entries have to fall out');
  const stored = JSON.parse(meta.get('telegram:origins:7'));
  assert.equal(stored.items.length, 400);
});

test('the command table is one Telegram will actually accept', () => {
  // setMyCommands refuses the whole list over a single bad entry, and a
  // refused list is a menu that never appears without anything failing
  // visibly - so the rules are checked here rather than discovered on a
  // phone: lowercase letters, digits and underscores, 1-32 characters, and
  // a description between 3 and 256.
  assert.ok(COMMANDS.length > 0);
  const seen = new Set();
  for (const entry of COMMANDS) {
    assert.match(entry.command, /^[a-z0-9_]{1,32}$/, entry.command + ' is not a usable command name');
    assert.ok(!seen.has(entry.command), entry.command + ' is listed twice');
    seen.add(entry.command);
    assert.ok(
      entry.description.length >= 3 && entry.description.length <= 256,
      entry.command + ' has a description Telegram would refuse',
    );
  }
  // The four that carry this release, so a rename has to be deliberate.
  for (const name of ['help', 'clear', 'tasks', 'schedules']) {
    assert.ok(seen.has(name), '/' + name + ' is missing from the menu');
  }
});

test('the chat ledger remembers what is standing in the chat, once each and bounded', () => {
  const { context, meta } = fakeContext();

  noteMessages(context, 7, [10, 11, undefined, 11]);
  noteMessages(context, 7, [12]);
  assert.deepEqual(JSON.parse(meta.get('telegram:messages:7')), [10, 11, 12]);

  // /clear takes them all and leaves nothing behind, or a second /clear
  // would try to delete the same ids again.
  assert.deepEqual(takeMessages(context, 7), [10, 11, 12]);
  assert.deepEqual(takeMessages(context, 7), []);

  // Another chat is untouched by either.
  noteMessages(context, 8, [99]);
  assert.deepEqual(takeMessages(context, 7), []);
  assert.deepEqual(takeMessages(context, 8), [99]);

  const many = Array.from({ length: 1200 }, (_value, index) => index + 1);
  noteMessages(context, 9, many);
  const kept = takeMessages(context, 9);
  assert.equal(kept.length, 1000);
  assert.equal(kept.at(-1), 1200, 'the newest message has to survive the ring');
});
