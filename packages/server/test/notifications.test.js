import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Assistant, ProviderRegistry, Store } from '@rookery/core';
import { buildServer } from '../dist/server.js';

/**
 * The inbox that replaced mail: `GET/POST /api/notifications*`, the card's
 * activity on `GET /api/org/tasks/:id`, the user's answer to a waiting card,
 * the `notification` and `task-event` broadcasts, and the push settings
 * that took over from the mail switches.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const idleProvider = {
  id: 'claude',
  displayName: 'Fake Claude',
  models: () => ['fake'],
  async status() {
    return { id: 'claude', available: true, binary: 'fake', authenticated: true };
  },
  async *run() {
    // Nothing: no turn is started in this file.
  },
};

async function createFixture() {
  const home = mkdtempSync(join(tmpdir(), 'rookery-notifications-'));
  const assistant = new Assistant({
    store: new Store(':memory:'),
    registry: new ProviderRegistry([idleProvider]),
    config: {
      home,
      logLevel: 'silent',
      memory: { enabled: false, autoExtract: false },
      org: { autoReview: false },
    },
  });
  const app = await buildServer(assistant, { quiet: true });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = 'ws://127.0.0.1:' + app.server.address().port + '/ws';
  return { assistant, app, base, home };
}

async function dispose(fixture) {
  await fixture.app.close();
  fixture.assistant.close();
  rmSync(fixture.home, { recursive: true, force: true });
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
  });
}

function collect(socket) {
  const frames = [];
  socket.on('message', (raw) => frames.push(JSON.parse(String(raw))));
  return {
    frames,
    async until(predicate, what) {
      const deadline = Date.now() + 5000;
      while (!predicate(frames)) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for ' + what);
        await sleep(10);
      }
    },
  };
}

test('notifications are listed, counted, read, archived, and broadcast', async (t) => {
  const fixture = await createFixture();
  t.after(() => dispose(fixture));
  const { assistant, app, base } = fixture;
  const socket = await openSocket(base);
  t.after(() => socket.close());
  const live = collect(socket);

  const first = assistant.org.notifyUser({ kind: 'schedule', title: 'Schedule "Nightly" completed', body: 'All green.' });
  const second = assistant.org.notifyUser({ kind: 'agent', title: 'A word from Pat', body: 'Hello.', fromKind: 'agent' });
  await live.until(
    (frames) => frames.filter((frame) => frame.type === 'notification').length === 2,
    'two notification frames',
  );
  const frame = live.frames.find((entry) => entry.type === 'notification');
  assert.equal(frame.notification.id, first.id, 'the frame carries the notification itself');
  assert.ok(!live.frames.some((entry) => entry.type === 'mail'), 'there is no mail frame any more');

  let response = await app.inject({ url: '/api/notifications' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().map((entry) => entry.id), [second.id, first.id], 'newest first');

  response = await app.inject({ url: '/api/notifications?kind=schedule' });
  assert.deepEqual(response.json().map((entry) => entry.id), [first.id]);
  response = await app.inject({ url: '/api/notifications?kind=nonsense' });
  assert.equal(response.statusCode, 400);
  response = await app.inject({ url: '/api/notifications?limit=1' });
  assert.equal(response.json().length, 1);

  response = await app.inject({ url: '/api/notifications/unread-count' });
  assert.deepEqual(response.json(), { count: 2 });

  // Read by id: the other tabs hear it on `changed`.
  response = await app.inject({ method: 'POST', url: '/api/notifications/read', payload: { ids: [first.id] } });
  assert.deepEqual(response.json(), { ok: true });
  await live.until(
    (frames) => frames.some((entry) => entry.type === 'changed' && entry.change.kind === 'notifications'),
    'a changed frame',
  );
  response = await app.inject({ url: '/api/notifications?unread=1' });
  assert.deepEqual(response.json().map((entry) => entry.id), [second.id]);

  // Back to unread, then everything read at once.
  await app.inject({ method: 'POST', url: '/api/notifications/read', payload: { ids: [first.id], read: false } });
  assert.deepEqual((await app.inject({ url: '/api/notifications/unread-count' })).json(), { count: 2 });
  await app.inject({ method: 'POST', url: '/api/notifications/read', payload: { all: true } });
  assert.deepEqual((await app.inject({ url: '/api/notifications/unread-count' })).json(), { count: 0 });
  response = await app.inject({ method: 'POST', url: '/api/notifications/read', payload: {} });
  assert.equal(response.statusCode, 400, 'neither ids nor all says nothing');

  // Archive moves it to the other shelf; `archived: false` brings it back.
  response = await app.inject({ method: 'POST', url: '/api/notifications/archive', payload: { id: second.id } });
  assert.deepEqual(response.json(), { ok: true });
  assert.deepEqual((await app.inject({ url: '/api/notifications' })).json().map((entry) => entry.id), [first.id]);
  assert.deepEqual(
    (await app.inject({ url: '/api/notifications?archived=1' })).json().map((entry) => entry.id),
    [second.id],
  );
  await app.inject({ method: 'POST', url: '/api/notifications/archive', payload: { id: second.id, archived: false } });
  assert.equal((await app.inject({ url: '/api/notifications' })).json().length, 2);
  response = await app.inject({ method: 'POST', url: '/api/notifications/archive', payload: { id: 'nope' } });
  assert.equal(response.statusCode, 404);

  // The mail routes are gone.
  response = await app.inject({ url: '/api/org/mail' });
  assert.equal(response.statusCode, 404);
});

test('a task carries its activity, and the user answers a waiting card', async (t) => {
  const fixture = await createFixture();
  t.after(() => dispose(fixture));
  const { assistant, app, base } = fixture;
  const socket = await openSocket(base);
  t.after(() => socket.close());
  const live = collect(socket);

  const orgId = assistant.org.activeOrganization().id;
  const task = assistant.store.org.createTask({ orgId, title: 'Ship it', description: 'Ship the release.', createdBy: 'user' });

  let response = await app.inject({ url: '/api/org/tasks/' + task.id });
  assert.equal(response.statusCode, 200);
  const detail = response.json();
  assert.equal(detail.thread, undefined, 'no mail thread any more');
  assert.equal(detail.events[0].kind, 'created');
  assert.equal(detail.events[0].text, 'Ship the release.');

  // Not waiting for anything: nothing to answer.
  response = await app.inject({ method: 'POST', url: '/api/org/tasks/' + task.id + '/answer', payload: { answer: 'Yes' } });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().message, /not waiting/);

  response = await app.inject({ method: 'POST', url: '/api/org/tasks/' + task.id + '/answer', payload: { answer: '  ' } });
  assert.equal(response.statusCode, 400);

  // Waiting, but nobody is assigned to carry it on: the answer still lands on
  // the card, and the reason the task cannot continue comes back as the 400.
  assistant.store.org.updateTask(task.id, { status: 'blocked' });
  response = await app.inject({ method: 'POST', url: '/api/org/tasks/' + task.id + '/answer', payload: { answer: 'Use main.' } });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().message, /nobody is assigned/);
  await live.until(
    (frames) => frames.some((entry) => entry.type === 'task-event' && entry.event.kind === 'answer'),
    'the answer as a task-event frame',
  );
  const answer = live.frames.find((entry) => entry.type === 'task-event' && entry.event.kind === 'answer').event;
  assert.equal(answer.taskId, task.id);
  assert.equal(answer.actorKind, 'user');
  assert.equal(answer.text, 'Use main.');

  response = await app.inject({ url: '/api/org/tasks/' + task.id });
  assert.deepEqual(response.json().events.map((entry) => entry.kind), ['created', 'answer']);

  response = await app.inject({ method: 'POST', url: '/api/org/tasks/nope/answer', payload: { answer: 'x' } });
  assert.equal(response.statusCode, 404);
});

test('push settings speak per kind; the old mail switches are mapped, never stored', async (t) => {
  const fixture = await createFixture();
  t.after(() => dispose(fixture));
  const { app } = fixture;

  let response = await app.inject({ url: '/api/config' });
  let push = response.json().gateways.telegram.push;
  assert.equal(push.schedules, true);
  assert.equal(push.tasks, true);
  assert.equal(push.questions, true);
  assert.equal(push.agents, 'leads');
  assert.equal(push.mail, undefined, 'the mail switch is not shown any more');
  assert.equal(push.mailFrom, undefined);
  assert.equal(response.json().org.roleplay, undefined, 'roleplay went with mail');

  response = await app.inject({
    method: 'PATCH',
    url: '/api/config',
    payload: { gateways: { telegram: { push: { agents: 'all', schedules: false, questions: false } } } },
  });
  assert.equal(response.statusCode, 200);
  push = response.json().gateways.telegram.push;
  assert.equal(push.agents, 'all');
  assert.equal(push.schedules, false);
  assert.equal(push.questions, true, 'a question is never silent');

  // An old client still sending the mail switches.
  response = await app.inject({
    method: 'PATCH',
    url: '/api/config',
    payload: { gateways: { telegram: { push: { mail: true, mailFrom: 'assistant' } } }, org: { roleplay: true } },
  });
  assert.equal(response.statusCode, 200);
  push = response.json().gateways.telegram.push;
  assert.equal(push.schedules, true);
  assert.equal(push.agents, 'off');
  assert.equal(push.mail, undefined);
  assert.equal(response.json().org.roleplay, undefined);

  response = await app.inject({
    method: 'PATCH',
    url: '/api/config',
    payload: { gateways: { telegram: { push: { agents: 'sometimes' } } } },
  });
  assert.equal(response.statusCode, 400);
});
