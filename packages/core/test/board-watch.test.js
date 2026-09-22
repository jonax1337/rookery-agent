import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Assistant, ProviderRegistry, Store, toolsFor } from '../dist/index.js';

/**
 * Phase 3 of the mail/board unification concept: the watcher (section 5, E8).
 *
 * A `board-watch:<orgId>` schedule is seeded once, editable and switchable
 * like any other job; it fires fast off the same task events `#announceTask`
 * already emits, and the clock behind it is only the backstop. Nothing here
 * waits on that clock, a wide every-30-minutes expression - every assertion
 * is about the event path and the schedule row itself.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFakeProvider() {
  const runs = [];
  const provider = {
    id: 'claude',
    displayName: 'Fake Claude',
    models: () => ['fake'],
    async status() {
      return { id: 'claude', available: true, binary: 'fake', authenticated: true };
    },
    async *run(opts) {
      runs.push(opts);
      await sleep(10);
      const text = 'OUTPUT(' + (opts.prompt ?? '').slice(-30) + ')';
      yield { type: 'text', delta: text };
      yield { type: 'done', text };
    },
  };
  return { provider, runs };
}

const openAssistants = [];
after(() => {
  for (const assistant of openAssistants) {
    try {
      assistant.close();
    } catch {
      // already closed
    }
  }
});

function createAssistant(fake) {
  const home = mkdtempSync(join(tmpdir(), 'rookery-board-watch-'));
  mkdirSync(join(home, 'run'), { recursive: true });
  const store = new Store(':memory:');
  const assistant = new Assistant({
    store,
    registry: new ProviderRegistry([fake.provider]),
    config: { home, logLevel: 'silent', memory: { enabled: false, autoExtract: false }, org: { autoReview: false } },
  });
  openAssistants.push(assistant);
  return { assistant, store, home };
}

/** A minimal Task-shaped object: only the fields `#onTaskEvent` reads. */
function fakeTask(orgId, id, status) {
  return {
    id,
    orgId,
    title: 'Task ' + id,
    description: '',
    status,
    priority: 'normal',
    createdBy: 'user',
    dependsOn: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sortOrder: 0,
  };
}

/**
 * A task that is really on the board, in the state given.
 *
 * The event alone no longer starts a watcher turn: every firing checks the
 * board in SQL first and goes back to sleep when nothing on it needs
 * saying, so a test about waking the watcher has to put something there for
 * it to find.
 */
function boardTask(store, orgId, title, status) {
  const task = store.org.createTask({ orgId, title, createdBy: 'user' });
  store.org.updateTask(task.id, {
    status,
    ...(status === 'failed' ? { error: 'boom', finishedAt: Date.now() } : {}),
  });
  return store.org.getTask(task.id);
}

async function waitFor(predicate, what) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.fail('Timed out waiting for ' + what + '.');
}

test('board-watch: seeding is idempotent and keeps a user\'s edit', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const orgId = assistant.org.activeOrganization().id;

  const first = assistant.ensureBoardWatchSchedule();
  assert.ok(first, 'the watcher gets a schedule row');
  assert.equal(first.id, 'board-watch:' + orgId, 'findable by a fixed id, unlike every random-id schedule');
  assert.equal(first.kind, 'assistant');
  assert.equal(first.triggerMode, 'schedule');
  assert.equal(first.schedule, '*/30 * * * *');
  assert.equal(first.eventCooldownMs, 60_000);
  assert.equal(first.enabled, true);
  assert.equal(
    assistant.cron.list(orgId).some((job) => job.id === first.id),
    true,
    'a visible schedule, not hidden system clockwork like the sleep job',
  );

  // A person edits and switches it off - exactly the case a naive reseed
  // would clobber.
  assistant.cron.update(first.id, { enabled: false, prompt: 'Only page me for payments tasks.' });

  const second = assistant.ensureBoardWatchSchedule();
  assert.equal(second.id, first.id, 'the same row, not a second one');
  assert.equal(second.enabled, false, 'a schedule a person switched off stays off');
  assert.equal(second.prompt, 'Only page me for payments tasks.', 'a rewritten prompt is never overwritten');
  assert.equal(
    store.cron.listJobs(orgId).filter((job) => job.id.startsWith('board-watch:')).length,
    1,
    'seeding twice never leaves a second row',
  );
  assistant.close();
});

test('board-watch: only a task landing in failed wakes it, and ten such events in a minute produce exactly one run', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const orgId = assistant.org.activeOrganization().id;
  const job = assistant.ensureBoardWatchSchedule();

  // The healthy transitions a task goes through on its way to `done` must
  // never wake the watcher - and `blocked` is one of them. Blocked means an
  // agent asked a person something and the board is correctly waiting for
  // the answer; waking the watcher on it made the system's reaction to
  // being asked a question be to go and do something else instead.
  for (const status of ['open', 'planned', 'running', 'blocked', 'done', 'cancelled']) {
    assistant.org.emit('task', { type: 'task', task: fakeTask(orgId, 'quiet-' + status, status) });
  }
  await sleep(20);
  assert.equal(assistant.cron.runs(job.id).length, 0, 'an ordinary lifecycle, waiting included, never fires the watcher');

  // Ten different tasks land in failed inside the same instant - ten task
  // events, and E2's coalescing (already proven generically for cron.ts)
  // means one run, not ten.
  const failed = [];
  for (let i = 0; i < 10; i += 1) failed.push(boardTask(store, orgId, 'Burst ' + i, 'failed'));
  for (const task of failed) assistant.org.emit('task', { type: 'task', task });
  await waitFor(() => !assistant.cron.isRunning(job.id) && assistant.cron.runs(job.id).length > 0, 'the coalesced run to finish');
  assert.equal(assistant.cron.runs(job.id).length, 1, 'ten events inside one minute collapse into one run');
  assert.equal(fake.runs.length, 1, 'the provider itself was asked exactly once');
  assert.match(fake.runs[0].prompt, /Burst 0/, 'the turn arrives knowing what it was woken for');

  // The same task re-announced in the same status - an unrelated edit while
  // it sits there, not a fresh transition - must not wake the watcher again.
  assistant.org.emit('task', { type: 'task', task: failed[0] });
  await sleep(20);
  assert.equal(assistant.cron.runs(job.id).length, 1, 'the same task standing still is not a new transition');
  assistant.close();
});

test('board-watch: a firing with nothing new on the board costs no model call at all', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const orgId = assistant.org.activeOrganization().id;
  const job = assistant.ensureBoardWatchSchedule();

  // An empty board, and a board whose tasks are all healthy, are both
  // nothing to say. The clock fires either way; the provider must not.
  let run = await assistant.cron.runNow(job.id);
  assert.equal(run.status, 'done');
  assert.ok(!run.result, 'a quiet board reports nothing');
  assert.equal(fake.runs.length, 0, 'and asks no model to tell it so');

  boardTask(store, orgId, 'Healthy', 'done');
  boardTask(store, orgId, 'Waiting on a person', 'blocked');
  run = await assistant.cron.runNow(job.id);
  assert.equal(fake.runs.length, 0, 'done and blocked are not faults');

  // One real failure, and now it is worth thinking about - once. The second
  // pass has nothing *new* to say, so it falls silent again instead of
  // mailing about the same broken task every half hour.
  boardTask(store, orgId, 'Broken', 'failed');
  run = await assistant.cron.runNow(job.id);
  assert.equal(fake.runs.length, 1, 'a fresh failure is worth a model call');
  assert.ok(run.result, 'and it has something to report');

  await assistant.cron.runNow(job.id);
  assert.equal(fake.runs.length, 1, 'the same failure is not news twice');
  assistant.close();
});

test('board-watch: the watching run is offered nothing that acts', async () => {
  // The watcher reports; it does not act. Its earlier prompt told it to
  // "reassign it, follow up with a fresh run on the same task, or restart
  // it", and it had the whole assistant toolset to do that with - while
  // `ask_user`, the one tool that would have let it check first, was the
  // single thing an unattended run had taken away from it.
  const offered = new Set(toolsFor('assistant', { watching: true, scheduled: true }).map((tool) => tool.name));
  const ordinary = new Set(toolsFor('assistant', { scheduled: true }).map((tool) => tool.name));

  for (const name of ['list_tasks', 'list_assignments', 'org_overview', 'send_mail', 'notify']) {
    assert.ok(offered.has(name), 'the watcher can still see the board and speak up: ' + name);
    assert.ok(ordinary.has(name), 'and an ordinary scheduled run is unchanged: ' + name);
  }
  for (const name of [
    'assign',
    'run_task',
    'plan_task',
    'create_task',
    'update_task',
    'cancel_assignment',
    'hire_agent',
    'update_agent',
    'update_settings',
    'set_tool_server',
    'delete_schedule',
  ]) {
    assert.ok(!offered.has(name), 'nothing that acts is on the watcher\'s list: ' + name);
    assert.ok(ordinary.has(name), 'but it stays available to every other assistant run: ' + name);
  }

  // The narrowing is opt-in, so no existing caller quietly lost anything.
  assert.deepEqual(
    toolsFor('assistant').map((tool) => tool.name),
    toolsFor('assistant', {}).map((tool) => tool.name),
  );
});

test('board-watch: a healthy pass that ends in [SILENT] posts no completion mail', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const orgId = assistant.org.activeOrganization().id;
  const job = assistant.ensureBoardWatchSchedule();
  const before = store.org.mailbox(orgId, { kind: 'user' }, 'inbox').length;

  fake.provider.run = async function* () {
    yield { type: 'done', text: 'Checked the board, nothing needs a person right now.\n\n[SILENT]' };
  };
  const run = await assistant.cron.runNow(job.id);
  assert.equal(run.status, 'done');
  assert.ok(!run.result, 'the sentinel is consumed, never reported as a result');
  assert.equal(
    store.org.mailbox(orgId, { kind: 'user' }, 'inbox').length,
    before,
    'a healthy board posts no completion mail',
  );
  assistant.close();
});

test('board-watch: the mark survives a long quiet stretch and a [SILENT] verdict', async () => {
  // The mark used to be reconstructed from "the newest run that produced a
  // result", read out of a fixed window of recent runs. Three ways that
  // went wrong, all of them ending in the same place: the same old failure
  // reported over and over.
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const orgId = assistant.org.activeOrganization().id;
  const job = assistant.ensureBoardWatchSchedule();

  boardTask(store, orgId, 'Broken', 'failed');
  await assistant.cron.runNow(job.id);
  assert.equal(fake.runs.length, 1, 'the failure is worth one look');

  // Thirty quiet passes. The speaking run is long out of any fixed window;
  // the stored mark does not care.
  for (let i = 0; i < 30; i += 1) await assistant.cron.runNow(job.id);
  assert.equal(fake.runs.length, 1, 'a quiet stretch never makes an old failure new again');

  // A finding the model looked at and judged not worth reporting is still a
  // finding it was shown. It must not come back every half hour.
  fake.provider.run = async function* () {
    yield { type: 'done', text: '[SILENT]' };
  };
  boardTask(store, orgId, 'Also broken', 'failed');
  const silent = await assistant.cron.runNow(job.id);
  assert.ok(!silent.result, 'the model said nothing');
  const after = fake.runs.length;
  await assistant.cron.runNow(job.id);
  assert.equal(fake.runs.length, after, 'and is not asked about the same thing again');
  assistant.close();
});

test('board-watch: a schedule-born task neither opens a thread nor mails a status note', async () => {
  // The card is the point of `Runtime.assign` going through `runTask`. The
  // mail that came with it was not: a nightly agent job would have written
  // a work order to the agent and a "was marked as done" note to the user,
  // every night, for work nobody was following.
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const orgId = assistant.org.activeOrganization().id;
  const agent = store.org.createAgent({
    orgId,
    name: 'Mara',
    title: 'Engineer',
    instructions: 'Do the work.',
  });
  const before = store.org.mailbox(orgId, { kind: 'user' }, 'inbox').length;

  const job = assistant.cron.create({
    orgId,
    name: 'Nightly build check',
    schedule: '0 3 * * *',
    prompt: 'Check the builds.',
    agentId: agent.id,
    createdBy: 'user',
  });
  const run = await assistant.cron.runNow(job.id);
  assert.equal(run.status, 'done');

  const taskId = store.org.getTaskIdForAssignment(run.assignmentId);
  const card = store.org.getTask(taskId);
  assert.equal(card.scheduleId, job.id, 'the card knows which schedule made it');
  assert.equal(
    store.org.getMailThreadForTask(orgId, card.id),
    null,
    'a schedule has no counterpart to negotiate with',
  );
  assert.equal(
    store.org.mailbox(orgId, { kind: 'user' }, 'inbox').length,
    before + 1,
    "only the schedule's own outcome mail, never a status note on top of it",
  );
  assistant.close();
});
