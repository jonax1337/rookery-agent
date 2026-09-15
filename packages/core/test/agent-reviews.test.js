import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Assistant, ProviderRegistry, Store } from '../dist/index.js';

/**
 * The agent performance review store (docs/concepts/agent-performance-management.md,
 * phase 1): upsert-per-source, the unique index that backs it, and the
 * automatic `system` review a hard-failure path writes without ever calling
 * a model.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFakeProvider() {
  const provider = {
    id: 'claude',
    displayName: 'Fake Claude',
    models: () => ['fake'],
    async status() {
      return { id: 'claude', available: true, binary: 'fake', authenticated: true };
    },
    async *run(opts) {
      const prompt = opts.prompt ?? '';
      if (prompt.includes('FAIL')) {
        yield { type: 'error', message: 'boom', fatal: true };
        return;
      }
      await sleep(5);
      const text = 'OUTPUT(' + prompt.slice(0, 40) + ')';
      yield { type: 'text', delta: text };
      yield { type: 'done', text };
    },
  };
  return provider;
}

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

function createAssistant() {
  const home = mkdtempSync(join(tmpdir(), 'rookery-review-'));
  mkdirSync(join(home, 'run'), { recursive: true });
  const store = new Store(':memory:');
  const assistant = new Assistant({
    store,
    registry: new ProviderRegistry([createFakeProvider()]),
    // autoReview stays off here: these tests are about the store's own
    // upsert/CHECK/idempotency behaviour and the system review a hard
    // failure writes, not about Jarvis's own judgment call.
    config: { home, logLevel: 'silent', memory: { enabled: false, autoExtract: false }, org: { autoReview: false } },
  });
  openAssistants.push(assistant);
  return { assistant, store };
}

/* --------------------------------- store --------------------------------- */

test('upsertReview replaces the review for the same assignment and source instead of stacking a second row', () => {
  const { assistant, store } = createAssistant();
  const org = assistant.org.activeOrganization();
  const agent = store.org.createAgent({ orgId: org.id, name: 'Mara', title: 'Engineer', instructions: 'Do the work.' });
  const assignment = store.org.createAssignment({ orgId: org.id, agentId: agent.id, task: 'write the parser', requesterKind: 'user' });

  const first = store.org.upsertReview({ orgId: org.id, agentId: agent.id, assignmentId: assignment.id, source: 'user', overall: 2, comment: 'Too slow.' });
  const second = store.org.upsertReview({ orgId: org.id, agentId: agent.id, assignmentId: assignment.id, source: 'user', overall: 4, comment: 'Actually fine on reread.' });

  assert.equal(first.id, second.id, 'the same row is updated, not duplicated');
  const stored = store.org.reviewsForAssignment(assignment.id);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].overall, 4);
  assert.equal(stored[0].comment, 'Actually fine on reread.');
  assistant.close();
});

test('a system review and a user review coexist for the same assignment', () => {
  const { assistant, store } = createAssistant();
  const org = assistant.org.activeOrganization();
  const agent = store.org.createAgent({ orgId: org.id, name: 'Mara', title: 'Engineer', instructions: 'Do the work.' });
  const assignment = store.org.createAssignment({ orgId: org.id, agentId: agent.id, task: 'x', requesterKind: 'user' });

  store.org.upsertReview({ orgId: org.id, agentId: agent.id, assignmentId: assignment.id, source: 'system', overall: 1, failedRun: true });
  store.org.upsertReview({ orgId: org.id, agentId: agent.id, assignmentId: assignment.id, source: 'user', overall: 5 });

  const stored = store.org.reviewsForAssignment(assignment.id);
  assert.equal(stored.length, 2);
  assert.deepEqual(new Set(stored.map((r) => r.source)), new Set(['system', 'user']));
  assistant.close();
});

test('periodic reviews with no assignment never collide on the unique index', () => {
  const { assistant, store } = createAssistant();
  const org = assistant.org.activeOrganization();
  const agent = store.org.createAgent({ orgId: org.id, name: 'Mara', title: 'Engineer', instructions: 'Do the work.' });

  store.org.upsertReview({ orgId: org.id, agentId: agent.id, source: 'assistant', overall: 3 });
  store.org.upsertReview({ orgId: org.id, agentId: agent.id, source: 'assistant', overall: 4 });

  assert.equal(store.org.listReviews(agent.id).length, 2, 'both periodic reviews survive - NULL assignment_id never conflicts');
  assistant.close();
});

test('a reconfig action needs both sides of the instruction diff, on the schema itself', () => {
  const { assistant, store } = createAssistant();
  const org = assistant.org.activeOrganization();
  const agent = store.org.createAgent({ orgId: org.id, name: 'Mara', title: 'Engineer', instructions: 'Do the work.' });

  assert.throws(
    () => store.org.createAction({ orgId: org.id, agentId: agent.id, kind: 'reconfig', stage: 2, reason: 'weak run', decidedBy: 'assistant' }),
    /CHECK constraint failed/,
  );

  const action = store.org.createAction({
    orgId: org.id, agentId: agent.id, kind: 'reconfig', stage: 2, reason: 'weak run',
    beforeText: 'Do the work.', afterText: 'Do the work, and cite evidence.', decidedBy: 'assistant',
  });
  assert.equal(store.org.listActions(agent.id)[0].id, action.id);
  assistant.close();
});

/* ------------------------------- controller ------------------------------- */

test('a run that fails technically writes its own system review - no model call, failed_run set', async () => {
  const { assistant, store } = createAssistant();
  const org = assistant.org.activeOrganization();
  const agent = store.org.createAgent({ orgId: org.id, name: 'Mara', title: 'Engineer', instructions: 'Do the work.' });

  const assignment = await assistant.org.run({
    orgId: org.id,
    agent,
    task: 'FAIL this on purpose',
    requesterKind: 'user',
    depth: 0,
    emit() {},
  });

  assert.equal(assignment.status, 'failed');
  const reviews = store.org.reviewsForAssignment(assignment.id);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].source, 'system');
  assert.equal(reviews[0].overall, 1);
  assert.equal(reviews[0].failedRun, true);
  assistant.close();
});

test('a run that succeeds writes no automatic review at all', async () => {
  const { assistant, store } = createAssistant();
  const org = assistant.org.activeOrganization();
  const agent = store.org.createAgent({ orgId: org.id, name: 'Mara', title: 'Engineer', instructions: 'Do the work.' });

  const assignment = await assistant.org.run({
    orgId: org.id,
    agent,
    task: 'write the parser',
    requesterKind: 'user',
    depth: 0,
    emit() {},
  });

  assert.equal(assignment.status, 'done');
  assert.equal(store.org.reviewsForAssignment(assignment.id).length, 0, 'only a hard failure writes a system review');
  assistant.close();
});
