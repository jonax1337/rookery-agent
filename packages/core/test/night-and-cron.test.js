import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allocateNightBudget,
  ASSISTANT_MEMORY_OWNER,
  Assistant,
  ProviderRegistry,
  Store,
} from '../dist/index.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A provider that serves three masters: chat turns answer with plain text,
 * the assistant extractor answers with one dark-mode candidate, and the
 * agent extractor answers with one build-pipeline candidate. Which master a
 * call belongs to is read off the prompt, the way the real prompts differ.
 */
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
      const prompt = opts.prompt ?? '';
      if (prompt.includes('EXCHANGE\n')) {
        const text = JSON.stringify([
          {
            kind: 'fact',
            content: 'The user prefers dark mode.',
            tags: ['ui'],
            importance: 0.8,
            evidence: 'I prefer dark mode',
          },
        ]);
        yield { type: 'done', text };
        return;
      }
      if (prompt.includes('ASSIGNMENT:')) {
        const text = JSON.stringify([
          {
            kind: 'project',
            content: 'The repository builds with npm workspaces.',
            tags: ['build'],
            importance: 0.7,
            evidence: 'Check the build pipeline',
          },
        ]);
        yield { type: 'done', text };
        return;
      }
      await sleep(10);
      const text = 'OUTPUT(' + prompt.slice(-40) + ')';
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

function createAssistant(fake, overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'rookery-night-'));
  mkdirSync(join(home, 'run'), { recursive: true });
  const store = new Store(':memory:');
  const assistant = new Assistant({
    store,
    registry: new ProviderRegistry([fake.provider]),
    config: {
      home,
      logLevel: 'silent',
      memory: { enabled: true, autoExtract: true },
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

/* ------------------------- adaptive night budget ------------------------- */

test('night budget: demand that fits is funded in full and respects the ceilings', () => {
  const out = allocateNightBudget(
    { condense: 5, resolve: 2, link: 3, reflect: 2, revise: 1, practise: 1 },
    100,
    { condense: 24, resolve: 8, link: 8, reflect: 2, revise: 2, practise: 1 },
  );
  assert.deepEqual(out, { condense: 5, resolve: 2, link: 3, reflect: 2, revise: 1, practise: 1 });
});

test('night budget: an overflow is cut from the volume phases, judgement keeps its share', () => {
  const demand = { condense: 24, resolve: 20, link: 16, reflect: 2, revise: 2, practise: 1 };
  const ceilings = { condense: 24, resolve: 20, link: 16, reflect: 2, revise: 2, practise: 1 };
  const out = allocateNightBudget(demand, 45, ceilings);
  const sum = Object.values(out).reduce((total, value) => total + value, 0);
  assert.equal(sum, 45, 'an overflowing demand is cut to exactly the wallet');
  assert.deepEqual(
    { reflect: out.reflect, revise: out.revise, practise: out.practise },
    { reflect: 2, revise: 2, practise: 1 },
    'insight, repair and distillation keep their share',
  );
  for (const key of ['condense', 'resolve', 'link']) {
    assert.ok(out[key] < demand[key], key + ' gave something up');
    assert.ok(out[key] > 0, key + ' is not starved outright');
  }

  const roomy = allocateNightBudget(
    { condense: 5, resolve: 2, link: 3, reflect: 2, revise: 2, practise: 1 },
    70,
    ceilings,
  );
  const roomySum = Object.values(roomy).reduce((total, value) => total + value, 0);
  assert.equal(roomySum, 15, 'demand that fits under the wallet is funded in full, not padded up');
});

test('night budget: a starved night funds judgement only, and an empty night costs nothing', () => {
  const starved = allocateNightBudget(
    { condense: 24, resolve: 20, link: 16, reflect: 2, revise: 2, practise: 1 },
    3,
    { condense: 24, resolve: 20, link: 16, reflect: 2, revise: 2, practise: 1 },
  );
  assert.deepEqual(starved, { condense: 0, resolve: 0, link: 0, reflect: 2, revise: 1, practise: 0 });

  const empty = allocateNightBudget(
    { condense: 0, resolve: 0, link: 0, reflect: 0, revise: 0, practise: 0 },
    70,
    { condense: 24, resolve: 8, link: 8, reflect: 2, revise: 2, practise: 1 },
  );
  assert.deepEqual(empty, { condense: 0, resolve: 0, link: 0, reflect: 0, revise: 0, practise: 0 });
});

/* -------------------- cron runs stay out of the memory ------------------- */

test('a scheduled chat run writes no memories and never wakes the extractor', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const orgId = assistant.org.activeOrganization().id;
  const job = assistant.cron.create({
    orgId,
    name: 'Digest',
    schedule: '* * * * *',
    prompt: 'Report on dark mode.',
    kind: 'assistant',
    createdBy: 'user',
  });
  const run = await assistant.cron.runNow(job.id);
  assert.equal(run.status, 'done');
  // Give the fire-and-forget extraction a beat to show up if it were going to.
  await sleep(50);
  assert.equal(fake.runs.filter((call) => call.prompt.includes('EXCHANGE\n')).length, 0, 'no extraction call');
  assert.equal(store.listMemories({ owner: ASSISTANT_MEMORY_OWNER, limit: 100 }).length, 0, 'no memory stored');
});

test('a normal chat turn still learns, proving the schedule skip is exactly that', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  for await (const event of assistant.chat({ text: 'As you know, I prefer dark mode.' })) {
    if (event.type === 'error' && event.fatal) assert.fail(event.message);
  }
  await sleep(50);
  const memories = store.listMemories({ owner: ASSISTANT_MEMORY_OWNER, limit: 100 });
  assert.equal(memories.length, 1);
  assert.match(memories[0].content, /dark mode/);
  assert.ok(memories[0].evidence, 'the memory carries its evidence');
});

test('a scheduled agent assignment does not learn; a direct one does', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const mara = hire(assistant, { name: 'Mara' });

  for await (const event of assistant.assign({ agent: mara.id, task: 'Check the build pipeline.' })) {
    if (event.type === 'error' && event.fatal) assert.fail(event.message);
  }
  await sleep(50);
  assert.equal(store.listMemories({ owner: mara.id, limit: 100 }).length, 1, 'direct assignment learned');

  for await (const event of assistant.assign({ agent: mara.id, task: 'Check the build pipeline.', scheduled: true })) {
    if (event.type === 'error' && event.fatal) assert.fail(event.message);
  }
  await sleep(50);
  assert.equal(store.listMemories({ owner: mara.id, limit: 100 }).length, 1, 'scheduled assignment learned nothing new');
});

test('write_skill refuses in a scheduled context and works in a normal one', async () => {
  const fake = createFakeProvider();
  const { assistant } = createAssistant(fake);
  const orgId = assistant.org.activeOrganization().id;
  const context = (scheduled) => ({ orgId, audience: 'assistant', depth: -1, emit: () => {}, scheduled });
  const body = '## Steps\n1. ' + 'x'.repeat(140);

  const blocked = await assistant.org.handle(context(true), 'write_skill', {
    name: 'nightly-checklist',
    description: 'A procedure a schedule tried to write.',
    body,
  });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /schedule/i);

  const allowed = await assistant.org.handle(context(false), 'write_skill', {
    name: 'daily-checklist',
    description: 'A procedure written in conversation.',
    body,
  });
  assert.notEqual(allowed.isError, true);

  // Memories are writes too: a schedule pins nothing and forgets nothing.
  const rememberBlocked = await assistant.org.handle(context(true), 'remember', {
    content: 'Something a schedule wanted to pin.',
  });
  assert.equal(rememberBlocked.isError, true);
  assert.match(rememberBlocked.text, /schedule/i);

  const rememberAllowed = await assistant.org.handle(context(false), 'remember', {
    content: 'Something said in conversation.',
  });
  assert.notEqual(rememberAllowed.isError, true);

  const forgetBlocked = await assistant.org.handle(context(true), 'forget', { id: 'whatever' });
  assert.equal(forgetBlocked.isError, true);
  assert.match(forgetBlocked.text, /schedule/i);
});

test('agents remember and search inside their own bank, never across the boundary', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const mara = hire(assistant, { name: 'Mara' });
  const orgId = assistant.org.activeOrganization().id;
  const agentContext = { orgId, audience: 'agent', agentId: mara.id, depth: 0, emit: () => {} };
  const assistantContext = { orgId, audience: 'assistant', depth: -1, emit: () => {} };

  const remembered = await assistant.org.handle(agentContext, 'remember', {
    content: 'The deploy script lives in scripts/deploy.ps1.',
    kind: 'project',
    tags: 'deploy',
    importance: 0.7,
  });
  assert.match(remembered.text, /Remembered/);
  assert.equal(store.listMemories({ owner: mara.id, limit: 100 }).length, 1, 'in the agent bank');
  assert.equal(store.listMemories({ owner: ASSISTANT_MEMORY_OWNER, limit: 100 }).length, 0, 'not in the assistant bank');

  const found = await assistant.org.handle(agentContext, 'search_memory', { query: 'deploy script' });
  assert.match(found.text, /deploy script lives/);

  const emptyAcross = await assistant.org.handle(assistantContext, 'search_memory', { query: 'deploy script' });
  assert.match(emptyAcross.text, /Nothing in memory matches/);
});

test('the sleep job is hidden from schedule lists, visible to the memory page, and untouchable', async () => {
  const fake = createFakeProvider();
  const { assistant } = createAssistant(fake);
  const orgId = assistant.org.activeOrganization().id;

  const job = assistant.ensureSleepSchedule();
  assert.ok(job, 'the nightly run has a schedule row');
  assert.equal(assistant.cron.list(orgId).some((entry) => entry.kind === 'sleep'), false, 'hidden from the list');
  assert.equal(
    assistant.cron.list(orgId, { includeSystem: true }).some((entry) => entry.kind === 'sleep'),
    true,
    'the memory page can ask for it by name',
  );

  const result = await assistant.org.handle(
    { orgId, audience: 'assistant', depth: -1, emit: () => {} },
    'run_schedule',
    { id: 'Memory sleep' },
  );
  assert.equal(result.isError, true);
  assert.match(result.text, /memory page/);
});
