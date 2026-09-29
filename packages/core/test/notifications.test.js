import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG,
  Store,
  notificationPushAllowed,
  openDatabase,
  upgradePushConfig,
} from '../dist/index.js';

/**
 * The two carriers that replaced internal mail
 * (docs/concepts/mail-removal-notifications-and-task-activity.md):
 * notifications for the user, activity on a card - their store methods, the
 * one-time copy out of the mail tables, and the push switches that took over
 * from `push.mail`.
 */

function freshStore() {
  const store = new Store(':memory:');
  const org = store.org.createOrganization({ name: 'Test & Co.' });
  return { store, org };
}

/* ------------------------------- notifications ------------------------------ */

test('notifications are stored newest first, filtered by kind, unread and shelf', () => {
  const { store, org } = freshStore();
  const schedule = store.org.createNotification({
    orgId: org.id,
    kind: 'schedule',
    title: 'Schedule "Briefing" completed',
    body: 'Completed at 08:00.',
    fromKind: 'assistant',
    cronJobId: 'job-1',
    cronRunId: 'run-1',
    sessionId: 'session-1',
  });
  const question = store.org.createNotification({
    orgId: org.id,
    kind: 'question',
    title: 'Mara has a question',
    body: 'Which gate?',
    fromKind: 'agent',
    fromAgentId: 'agent-1',
    taskId: 'task-1',
  });

  assert.equal(schedule.fromAgentId, undefined, 'only an agent carries an agent id');
  const all = store.org.listNotifications({ orgId: org.id });
  assert.deepEqual(all.map((entry) => entry.id), [question.id, schedule.id], 'newest first');
  const stored = store.org.getNotification(schedule.id);
  assert.equal(stored.cronJobId, 'job-1');
  assert.equal(stored.cronRunId, 'run-1');
  assert.equal(stored.sessionId, 'session-1');
  assert.equal(stored.readAt, undefined);
  assert.deepEqual(
    store.org.listNotifications({ orgId: org.id, kind: 'question' }).map((entry) => entry.id),
    [question.id],
  );
  assert.equal(store.org.listNotifications({ kind: ['question', 'schedule'] }).length, 2, 'several kinds at once');
  assert.equal(store.org.unreadNotificationCount(org.id), 2);

  assert.equal(store.org.markNotificationsRead([question.id]), 1);
  assert.equal(store.org.markNotificationsRead([question.id]), 0, 'marking twice changes nothing');
  assert.ok(store.org.getNotification(question.id).readAt, 'stamped');
  assert.deepEqual(
    store.org.listNotifications({ orgId: org.id, unread: true }).map((entry) => entry.id),
    [schedule.id],
  );
  assert.equal(store.org.markNotificationsRead([question.id], { read: false }), 1, 'and back to unread');
  assert.equal(store.org.markNotificationsRead('all', { orgId: org.id }), 2);
  assert.equal(store.org.unreadNotificationCount(org.id), 0);
});

test('archiving takes a notification off the live list, marks it read, and can be undone', () => {
  const { store, org } = freshStore();
  const note = store.org.createNotification({ orgId: org.id, kind: 'agent', title: 'FYI', fromKind: 'agent', fromAgentId: 'a' });
  assert.equal(store.org.unreadNotificationCount(org.id), 1);

  const archived = store.org.archiveNotification(note.id);
  assert.ok(archived.archivedAt);
  assert.ok(archived.readAt, 'something put away on purpose is not waiting for anybody');
  assert.equal(store.org.listNotifications({ orgId: org.id }).length, 0);
  assert.equal(store.org.listNotifications({ orgId: org.id, archived: true }).length, 1);
  assert.equal(store.org.unreadNotificationCount(org.id), 0);

  const restored = store.org.archiveNotification(note.id, false);
  assert.equal(restored.archivedAt, undefined);
  assert.equal(store.org.listNotifications({ orgId: org.id }).length, 1);
});

/* ------------------------------- task activity ------------------------------ */

test('every card opens its activity with its brief, and lines come back in order', () => {
  const { store, org } = freshStore();
  const task = store.org.createTask({
    orgId: org.id,
    title: 'Fix the gate',
    description: 'The north gate sticks.',
    createdBy: 'agent',
    createdByAgentId: 'lead-1',
  });
  const [created] = store.org.listTaskEvents(task.id);
  assert.equal(created.kind, 'created');
  assert.equal(created.text, 'The north gate sticks.');
  assert.equal(created.actorKind, 'agent');
  assert.equal(created.actorAgentId, 'lead-1');

  const at = created.at;
  store.org.addTaskEvent({ taskId: task.id, kind: 'question', actorKind: 'agent', actorAgentId: 'mara', text: 'Which one?', at });
  store.org.addTaskEvent({ taskId: task.id, kind: 'answer', actorKind: 'user', text: 'North.', at, assignmentId: 'run-1' });
  store.org.addTaskEvent({ taskId: task.id, kind: 'question', actorKind: 'agent', text: 'Paint too?', at });

  assert.deepEqual(
    store.org.listTaskEvents(task.id).map((event) => event.kind),
    ['created', 'question', 'answer', 'question'],
    'insertion order breaks a tie on the clock',
  );
  assert.equal(store.org.lastTaskEvent(task.id).text, 'Paint too?');
  assert.equal(store.org.lastTaskEvent(task.id, 'question').text, 'Paint too?');
  assert.equal(store.org.lastTaskEvent(task.id, 'answer').assignmentId, 'run-1');
  assert.equal(store.org.lastTaskEvent(task.id, 'status'), null);
  assert.equal(store.org.lastTaskEvent(task.id, 'answer').actorAgentId, undefined, 'only an agent carries an agent id');

  // A card without a description still says what it is.
  const bare = store.org.createTask({ orgId: org.id, title: 'Just a title', createdBy: 'user' });
  assert.equal(store.org.listTaskEvents(bare.id)[0].text, 'Just a title');
});

/* --------------------------------- migration -------------------------------- */

test('schema 27 copies mail to the user into notifications and task threads into activity, once', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'rookery-mail-migration-')), 'rookery.db');
  let db = openDatabase(path);
  let store = new Store(db);
  const org = store.org.createOrganization({ name: 'Test & Co.' });
  const mara = store.org.createAgent({ orgId: org.id, name: 'Mara', title: 'Engineer', instructions: 'x' });

  // What a database written before schema 27 holds: a schedule report, a
  // task thread with an answer in it, the night's promotion notice (a mail
  // from the user to themselves), and mail the user never saw.
  const report = store.org.sendMail({
    orgId: org.id,
    from: { kind: 'agent', id: mara.id },
    to: [{ kind: 'user' }],
    subject: 'Schedule "Nightly" completed',
    body: 'All green.',
    kind: 'report',
  });
  store.org.markMailReadFor([report], { kind: 'user' });
  const task = store.org.createTask({ orgId: org.id, title: 'Fix the gate', description: 'Please fix it.', createdBy: 'user' });
  const order = store.org.sendMail({
    orgId: org.id,
    from: { kind: 'user' },
    to: [{ kind: 'agent', id: mara.id }],
    subject: 'Fix the gate',
    body: 'Please fix it.',
    kind: 'assignment',
  });
  store.org.linkMailThreadTask(org.id, order.threadId, task.id);
  const answer = store.org.sendMail({
    orgId: org.id,
    from: { kind: 'agent', id: mara.id },
    to: [{ kind: 'user' }],
    subject: 'Re: Fix the gate',
    body: 'Done, the hinge was loose.',
    threadId: order.threadId,
    inReplyTo: order.id,
  });
  const promotion = store.org.sendMail({
    orgId: org.id,
    from: { kind: 'user' },
    to: [{ kind: 'user' }],
    subject: 'Retrieval policy recall v2 is in force',
    body: 'A new recall policy.',
  });
  store.org.archiveMailThread(org.id, promotion.threadId, true);
  store.org.sendMail({
    orgId: org.id,
    from: { kind: 'assistant' },
    to: [{ kind: 'agent', id: mara.id }],
    subject: 'Between colleagues',
    body: 'Not for the user.',
  });

  // Pretend none of it has been migrated yet: no flag, no copies, and the
  // card without the `created` line only schema 27 writes.
  db.exec("DELETE FROM meta WHERE key = 'mail_to_notifications_v1'");
  db.exec('DELETE FROM notifications');
  db.exec('DELETE FROM task_events');
  db.close();

  db = openDatabase(path);
  store = new Store(db);
  const notes = store.org.listNotifications({ orgId: org.id, archived: false });
  const archived = store.org.listNotifications({ orgId: org.id, archived: true });
  assert.equal(notes.length + archived.length, 3, 'every mail the user was on, and nothing else');

  const byId = new Map([...notes, ...archived].map((entry) => [entry.id, entry]));
  const fromReport = byId.get(report.id);
  assert.equal(fromReport.kind, 'schedule', 'a report thread was what a schedule posted');
  assert.equal(fromReport.fromKind, 'agent');
  assert.equal(fromReport.fromAgentId, mara.id);
  assert.equal(fromReport.title, 'Schedule "Nightly" completed');
  assert.ok(fromReport.readAt, 'read stays read');

  const fromAnswer = byId.get(answer.id);
  assert.equal(fromAnswer.kind, 'task', 'an assignment thread was a card');
  assert.equal(fromAnswer.taskId, task.id);
  assert.equal(fromAnswer.readAt, undefined, 'unread stays unread');

  const fromPromotion = byId.get(promotion.id);
  assert.equal(fromPromotion.kind, 'sleep');
  assert.equal(fromPromotion.fromKind, 'system');
  assert.ok(fromPromotion.archivedAt, 'an archived thread stays archived');

  const events = store.org.listTaskEvents(task.id);
  assert.deepEqual(events.map((event) => event.kind), ['created', 'note'], 'the work order opens it, the rest are notes');
  assert.equal(events[0].id, order.id);
  assert.equal(events[0].actorKind, 'user');
  assert.equal(events[1].actorAgentId, mara.id);
  assert.equal(events[1].text, 'Done, the hinge was loose.');

  // Nothing was deleted, and a second open copies nothing twice.
  assert.ok(store.org.getMail(order.id), 'the mail itself is still there');
  db.close();
  db = openDatabase(path);
  store = new Store(db);
  assert.equal(
    store.org.listNotifications({ orgId: org.id }).length + store.org.listNotifications({ orgId: org.id, archived: true }).length,
    3,
  );
  assert.equal(store.org.listTaskEvents(task.id).length, 2);
  db.close();
});

/* ------------------------------ push switches ------------------------------- */

test('an old config file maps its mail push settings onto the per-kind switches', () => {
  const base = () => ({ ...DEFAULT_CONFIG.gateways.telegram.push });

  // Mail on, from leads - the old default.
  let push = base();
  push.mail = true;
  push.mailFrom = 'leads';
  push.tasks = false;
  upgradePushConfig(push, { gateways: { telegram: { push: { mail: true, mailFrom: 'leads', tasks: false } } } });
  assert.equal(push.schedules, true, 'schedule outcomes were mail to the user');
  assert.equal(push.agents, 'leads');
  assert.equal(push.tasks, true, 'and so was a card\'s status note');
  assert.equal(push.questions, true);

  // Mail off: nothing that used to be mail buzzes now either.
  push = base();
  push.mail = false;
  push.tasks = false;
  upgradePushConfig(push, { gateways: { telegram: { push: { mail: false, tasks: false } } } });
  assert.equal(push.schedules, false);
  assert.equal(push.agents, 'off');
  assert.equal(push.tasks, false);

  // Only the assistant's mail: no agent at all.
  push = base();
  push.mailFrom = 'assistant';
  upgradePushConfig(push, { gateways: { telegram: { push: { mailFrom: 'assistant' } } } });
  assert.equal(push.agents, 'off');

  // A file that already has the new switches keeps them.
  push = base();
  push.mail = false;
  push.schedules = true;
  push.agents = 'all';
  upgradePushConfig(push, { gateways: { telegram: { push: { mail: false, schedules: true, agents: 'all' } } } });
  assert.equal(push.schedules, true);
  assert.equal(push.agents, 'all');

  // No file at all: the defaults stand, questions always on.
  push = base();
  push.questions = false;
  upgradePushConfig(push, {});
  assert.equal(push.schedules, true);
  assert.equal(push.questions, true, 'a question is never silent');
});

test('the push filter follows the kind of notification, and no kind switch holds back a question', () => {
  const push = { ...DEFAULT_CONFIG.gateways.telegram.push, schedules: true, tasks: false, sleep: true, agents: 'leads' };
  const lead = (id) => id === 'lead';
  const allowed = (kind, fromAgentId, config = push) => notificationPushAllowed(config, { kind, fromAgentId }, lead);

  assert.equal(allowed('schedule'), true);
  assert.equal(allowed('watch'), true, 'the watcher rides on the schedule switch');
  assert.equal(allowed('task'), false);
  assert.equal(allowed('sleep'), true);
  assert.equal(allowed('agent', 'lead'), true, 'a lead reaches the phone');
  assert.equal(allowed('agent', 'junior'), false, 'a junior does not');
  assert.equal(allowed('agent', 'junior', { ...push, agents: 'all' }), true);
  assert.equal(allowed('agent', 'lead', { ...push, agents: 'off' }), false);
  assert.equal(allowed('system'), false, 'notify pushes on its own event, never twice');
  assert.equal(allowed('question'), true);
  assert.equal(allowed('question', undefined, { ...push, questions: false }), true, 'no switch silences a question');
  assert.equal(allowed('question', undefined, { ...push, enabled: false }), false, 'only push being off altogether');
  assert.equal(allowed('schedule', undefined, { ...push, enabled: false }), false);
});
