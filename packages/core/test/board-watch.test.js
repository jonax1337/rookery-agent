import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Assistant, ProviderRegistry, Store } from '../dist/index.js';

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

test('board-watch: only a task landing in failed or blocked wakes it, and ten such events in a minute produce exactly one run', async () => {
  const fake = createFakeProvider();
  const { assistant } = createAssistant(fake);
  const orgId = assistant.org.activeOrganization().id;
  const job = assistant.ensureBoardWatchSchedule();

  // The healthy transitions a task goes through on its way to `done` must
  // never wake the watcher - only the two transitions E8 names do.
  for (const status of ['open', 'planned', 'running', 'done', 'cancelled']) {
    assistant.org.emit('task', { type: 'task', task: fakeTask(orgId, 'quiet-' + status, status) });
  }
  await sleep(20);
  assert.equal(assistant.cron.runs(job.id).length, 0, 'an ordinary lifecycle never fires the watcher');

  // Ten different tasks land in failed or blocked inside the same instant -
  // ten task events, and E2's coalescing (already proven generically for
  // cron.ts) means one run, not ten.
  for (let i = 0; i < 10; i += 1) {
    const status = i % 2 === 0 ? 'failed' : 'blocked';
    assistant.org.emit('task', { type: 'task', task: fakeTask(orgId, 'burst-' + i, status) });
  }
  await waitFor(() => !assistant.cron.isRunning(job.id) && assistant.cron.runs(job.id).length > 0, 'the coalesced run to finish');
  assert.equal(assistant.cron.runs(job.id).length, 1, 'ten events inside one minute collapse into one run');
  assert.equal(fake.runs.length, 1, 'the provider itself was asked exactly once');

  // The same task re-announced in the same status - an unrelated edit while
  // it sits there, not a fresh transition - must not wake the watcher again.
  assistant.org.emit('task', { type: 'task', task: fakeTask(orgId, 'burst-0', 'failed') });
  await sleep(20);
  assert.equal(assistant.cron.runs(job.id).length, 1, 'the same task standing still is not a new transition');
  assistant.close();
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
