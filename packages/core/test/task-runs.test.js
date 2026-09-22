import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Assistant, ProviderRegistry, Store } from '../dist/index.js';

/**
 * Task runs from the board: the claim that keeps a first run from being
 * planned twice, and the dependency failure that must not be swallowed.
 * Nothing here talks to a real CLI; the fake provider answers scripted
 * text, the same setup org.test.js uses.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFakeProvider(options = {}) {
  const { delay = 20 } = options;
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
      const prompt = opts.prompt ?? '';
      if (prompt.includes('FAIL')) {
        yield { type: 'error', message: 'boom', fatal: true };
        return;
      }
      await sleep(delay);
      const text = 'OUTPUT(' + prompt.slice(0, 40) + ')';
      yield { type: 'text', delta: text };
      yield { type: 'done', text };
    },
  };
  return { provider, runs };
}

/** Every assistant built by a test; closed at the end so a failed assertion cannot hang the run. */
const openAssistants = [];
after(() => {
  for (const assistant of openAssistants) {
    try {
      assistant.close();
    } catch {
      // already closed by the test
    }
  }
});

function createAssistant(fake, overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'rookery-tasks-'));
  mkdirSync(join(home, 'run'), { recursive: true });
  const store = new Store(':memory:');
  const assistant = new Assistant({
    store,
    registry: new ProviderRegistry([fake.provider]),
    config: {
      home,
      logLevel: 'silent',
      memory: { enabled: false, autoExtract: false },
      // See org.test.js: keeps fake.runs counting the assignments themselves.
      org: { autoReview: false },
      ...overrides,
    },
  });
  openAssistants.push(assistant);
  return { assistant, store, home };
}

function hire(assistant, input) {
  const org = assistant.org.activeOrganization();
  return assistant.store.org.createAgent({ orgId: org.id, instructions: 'Do the work.', title: 'Engineer', ...input });
}

test('two first runs of the same unplanned task plan it once, not twice', async () => {
  const fake = createFakeProvider();
  // The planner answer rides on the fake, with a delay that holds the first
  // run inside planning - exactly the window a second click falls into.
  fake.provider.run = (function (original) {
    return async function* (opts) {
      if ((opts.prompt ?? '').includes('ROOKERY TASK PLANNER')) {
        // The original generator only records its own runs, so the planner
        // branch has to book this invocation itself or the count below sees
        // nothing - the early return never reaches `original`.
        fake.runs.push(opts);
        await sleep(30);
        const text = JSON.stringify({
          mode: 'split',
          reason: 'Two parts, one after the other.',
          subtasks: [
            { title: 'Parser', description: 'Write the parser.', agent: 'mara', dependsOn: [] },
            { title: 'Docs', description: 'Document it.', agent: 'ben', dependsOn: [0] },
          ],
        });
        yield { type: 'done', text };
        return;
      }
      yield* original(opts);
    };
  })(fake.provider.run);
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  hire(assistant, { name: 'Mara' });
  hire(assistant, { name: 'Ben' });
  const ctx = { orgId: org.id, audience: 'assistant', depth: -1, emit() {} };

  await assistant.org.handle(ctx, 'create_task', { title: 'Build the thing', description: 'All of it.' });
  const task = store.org.listTasks(org.id)[0];

  const [first, second] = await Promise.all([
    assistant.org.runTask(ctx, task),
    assistant.org.runTask(ctx, task),
  ]);

  assert.equal(first.status, 'done', 'the invocation that got the claim runs the task to the end');
  assert.notEqual(second.status, 'done', 'the duplicate steps aside instead of reporting a run it never made');
  assert.equal(
    fake.runs.filter((run) => (run.prompt ?? '').includes('ROOKERY TASK PLANNER')).length,
    1,
    'the planner ran once, not once per click',
  );
  const children = store.org.listTasks(org.id, { parentId: task.id }).filter((c) => c.status !== 'cancelled');
  assert.equal(children.length, 2, 'one set of subtasks, not two plannings\' worth');
  assert.ok(children.every((c) => c.status === 'done'));
  assert.equal(
    fake.runs.filter((run) => /TASK: (Parser|Docs)/.test(run.prompt ?? '')).length,
    2,
    'every subtask ran exactly once',
  );
  assistant.close();
});

test('a subtask whose dependency failed is failed with the reason, not run blind', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });
  const ben = hire(assistant, { name: 'Ben' });
  const parent = store.org.createTask({ orgId: org.id, title: 'Ship it', description: 'All of it.', createdBy: 'user' });
  const parser = store.org.createTask({
    orgId: org.id,
    parentId: parent.id,
    title: 'Parser',
    description: 'FAIL hard',
    assigneeId: mara.id,
    createdBy: 'assistant',
    status: 'planned',
  });
  const docs = store.org.createTask({
    orgId: org.id,
    parentId: parent.id,
    title: 'Docs',
    description: 'Document the parser.',
    assigneeId: ben.id,
    createdBy: 'assistant',
    status: 'planned',
    dependsOn: [parser.id],
  });

  const ctx = { orgId: org.id, audience: 'assistant', depth: -1, emit() {} };
  const finished = await assistant.org.runTask(ctx, parent);

  assert.equal(store.org.getTask(parser.id).status, 'failed');
  const dependent = store.org.getTask(docs.id);
  assert.equal(dependent.status, 'failed');
  assert.match(dependent.error ?? '', /Dependency did not finish: Parser/);
  assert.ok(
    !fake.runs.some((run) => (run.prompt ?? '').includes('TASK: Docs')),
    'the dependent subtask never started an assignment',
  );
  assert.equal(finished.status, 'failed', 'the failure reaches the parent');
  assert.match(finished.error ?? '', /Every subtask failed/);
  assert.match(finished.result ?? '', /FAILED: Dependency did not finish: Parser/, 'and its report says why');
  assistant.close();
});

test('a stuck subtask can be cancelled on its own, and a throw never leaves a card running', async () => {
  // Two subtasks, one of which hangs. Cancelling the hanging child used to
  // be impossible: only the parent was registered as cancellable, so
  // `cancelTask(childId)` returned false, every writer refused to edit a
  // running card, and the card sat there until the server was restarted.
  const fake = createFakeProvider({ delay: 20 });
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara', slug: 'mara' });

  let release = () => {};
  const hanging = new Promise((resolve) => {
    release = resolve;
  });
  fake.provider.run = async function* (opts) {
    if ((opts.prompt ?? '').includes('Slow')) {
      await hanging;
      yield { type: 'done', text: 'never mind' };
      return;
    }
    yield { type: 'done', text: 'OUTPUT' };
  };

  const parent = store.org.createTask({ orgId: org.id, title: 'Split', createdBy: 'user' });
  const slow = store.org.createTask({
    orgId: org.id,
    parentId: parent.id,
    title: 'Slow child',
    description: 'Slow',
    assigneeId: mara.id,
    createdBy: 'user',
  });

  const run = assistant.org.runTask(
    { orgId: org.id, audience: 'assistant', depth: -1, emit() {} },
    parent,
  );

  // Wait until the child is really going, then stop that child alone.
  const deadline = Date.now() + 3000;
  while (store.org.getTask(slow.id).status !== 'running' && Date.now() < deadline) await sleep(5);
  assert.equal(store.org.getTask(slow.id).status, 'running');

  assert.equal(assistant.org.cancelTask(slow.id), true, 'the child is cancellable in its own right');
  release();
  await run;

  assert.notEqual(
    store.org.getTask(slow.id).status,
    'running',
    'no card is left claiming to run once nothing is',
  );
  assert.notEqual(store.org.getTask(parent.id).status, 'running');
  assistant.close();
});

test('a task whose run throws ends failed with the reason, not stuck on running', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara', slug: 'mara' });

  const task = store.org.createTask({
    orgId: org.id,
    title: 'Explodes',
    description: 'Explodes',
    assigneeId: mara.id,
    createdBy: 'user',
  });

  // A failure inside the machinery rather than inside the model: the kind
  // that used to escape `#runTask` entirely and leave the card frozen.
  fake.provider.run = function () {
    throw new Error('the bridge fell over');
  };

  const finished = await assistant.org.runTask(
    { orgId: org.id, audience: 'assistant', depth: -1, emit() {} },
    task,
  );
  assert.notEqual(finished.status, 'running', 'the card does not stay frozen');
  assert.equal(store.org.getTask(task.id).status, finished.status);
  assistant.close();
});
