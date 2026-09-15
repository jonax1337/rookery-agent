import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Assistant, ProviderRegistry, Store } from '../dist/index.js';

/**
 * Phases 2-4 of docs/concepts/agent-performance-management.md: the computed
 * performance view, the escalation stages it drives, and the full
 * note -> reconfig -> replacement-proposal -> replace cycle end to end.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeout = 2000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(interval);
  }
}

/**
 * Routes on the distinctive lead sentence of each prompt in org/review.ts,
 * and pulls the intended score for an assignment's own review out of a
 * "SCORE:<n>" marker embedded in its task text - the rest of the escalation
 * chain (note/reconfig/replacement/handover) always answers the same way,
 * since only the review score needs to vary per assignment in these tests.
 */
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
      if (prompt.includes('You are reviewing one completed assignment')) {
        const match = prompt.match(/SCORE:(\d)/);
        const overall = match ? Number(match[1]) : 4;
        const text = JSON.stringify({ overall, comment: 'auto-judged' });
        yield { type: 'done', text };
        return;
      }
      if (prompt.includes("agent's recent work has been judged weak")) {
        const text = JSON.stringify({
          reason: 'two of the last three runs scored 2 or below',
          agentNote: 'Double check your output before reporting it back.',
        });
        yield { type: 'done', text };
        return;
      }
      if (prompt.includes('keeps producing weak work even after being flagged once')) {
        const text = JSON.stringify({
          reason: 'still weak after the note',
          agentNote: 'Verify every claim before reporting; ask when you are unsure.',
          newInstructions: 'Verify every claim before reporting. Ask when unsure.',
        });
        yield { type: 'done', text };
        return;
      }
      if (prompt.includes('has been reconfigured twice')) {
        const text = JSON.stringify({
          reason: 'two reconfigs did not hold',
          successorName: 'Nora',
          successorSlug: 'nora',
          successorTitle: 'Engineer',
          successorInstructions: 'Be careful and verify every claim.',
        });
        yield { type: 'done', text };
        return;
      }
      if (prompt.includes('is being replaced by a successor')) {
        const text = JSON.stringify({ handover: 'Ongoing work: nothing unusual to hand over.' });
        yield { type: 'done', text };
        return;
      }
      await sleep(2);
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
  const home = mkdtempSync(join(tmpdir(), 'rookery-performance-'));
  mkdirSync(join(home, 'run'), { recursive: true });
  const store = new Store(':memory:');
  const assistant = new Assistant({
    store,
    registry: new ProviderRegistry([createFakeProvider()]),
    config: { home, logLevel: 'silent', memory: { enabled: false, autoExtract: false }, org: { autoReview: true } },
  });
  openAssistants.push(assistant);
  return { assistant, store };
}

function backdate(store, table, id, ms) {
  store.db.prepare('UPDATE ' + table + ' SET created_at = ? WHERE id = ?').run(ms, id);
}

/* ------------------------------- aggregation ------------------------------ */

test('performance() averages, trends and gates on failed runs the way the concept doc specifies', () => {
  const { assistant, store } = createAssistant();
  const org = assistant.org.activeOrganization();
  const agent = store.org.createAgent({ orgId: org.id, name: 'Mara', title: 'Engineer', instructions: 'Do the work.' });

  const now = Date.now();
  // Oldest five score 3, newest five score 5: a clear upward trend, and a
  // failed run mixed in that must not drag the quality average down.
  const scores = [3, 3, 3, 3, 3, 5, 5, 5, 5, 5];
  scores.forEach((overall, index) => {
    const assignment = store.org.createAssignment({ orgId: org.id, agentId: agent.id, task: 'x', requesterKind: 'user' });
    const review = store.org.upsertReview({ orgId: org.id, agentId: agent.id, assignmentId: assignment.id, source: 'user', overall });
    backdate(store, 'agent_reviews', review.id, now - (scores.length - index) * 1000);
  });
  const failedAssignment = store.org.createAssignment({ orgId: org.id, agentId: agent.id, task: 'x', requesterKind: 'user' });
  const failed = store.org.upsertReview({
    orgId: org.id, agentId: agent.id, assignmentId: failedAssignment.id, source: 'system', overall: 1, failedRun: true,
  });
  backdate(store, 'agent_reviews', failed.id, now + 1000);

  const performance = store.org.performance(agent.id);
  assert.equal(performance.count, 10);
  assert.equal(performance.average, 4);
  assert.equal(performance.trend, 2);
  assert.ok(performance.failureRate > 0, 'the failed run counts toward the failure rate');
  assert.equal(performance.stage, 0, 'a strong, improving record stays at stage 0');
  assistant.close();
});

test('two weak reviews out of the last three raise the agent to stage 1', () => {
  const { assistant, store } = createAssistant();
  const org = assistant.org.activeOrganization();
  const agent = store.org.createAgent({ orgId: org.id, name: 'Mara', title: 'Engineer', instructions: 'Do the work.' });
  const now = Date.now();
  [4, 2, 2].forEach((overall, index) => {
    const assignment = store.org.createAssignment({ orgId: org.id, agentId: agent.id, task: 'x', requesterKind: 'user' });
    const review = store.org.upsertReview({ orgId: org.id, agentId: agent.id, assignmentId: assignment.id, source: 'user', overall });
    backdate(store, 'agent_reviews', review.id, now + index * 1000);
  });
  assert.equal(store.org.performance(agent.id).stage, 1);
  assistant.close();
});

test('a good user rating resets the stage to 0 even after a weak stretch', () => {
  const { assistant, store } = createAssistant();
  const org = assistant.org.activeOrganization();
  const agent = store.org.createAgent({ orgId: org.id, name: 'Mara', title: 'Engineer', instructions: 'Do the work.' });
  const now = Date.now();
  [2, 2, 1, 5].forEach((overall, index) => {
    const assignment = store.org.createAssignment({ orgId: org.id, agentId: agent.id, task: 'x', requesterKind: 'user' });
    const review = store.org.upsertReview({ orgId: org.id, agentId: agent.id, assignmentId: assignment.id, source: 'user', overall });
    backdate(store, 'agent_reviews', review.id, now + index * 1000);
  });
  assert.equal(store.org.performance(agent.id).stage, 0);
  assistant.close();
});

/* -------------------------------- update_agent ----------------------------- */

test('update_agent needs a reason to change instructions once the agent is flagged, and logs a reconfig', async () => {
  const { assistant, store } = createAssistant();
  const org = assistant.org.activeOrganization();
  const agent = store.org.createAgent({ orgId: org.id, name: 'Mara', title: 'Engineer', instructions: 'Do the work.' });
  const now = Date.now();
  [4, 2, 2].forEach((overall, index) => {
    const assignment = store.org.createAssignment({ orgId: org.id, agentId: agent.id, task: 'x', requesterKind: 'user' });
    const review = store.org.upsertReview({ orgId: org.id, agentId: agent.id, assignmentId: assignment.id, source: 'user', overall });
    backdate(store, 'agent_reviews', review.id, now + index * 1000);
  });
  assert.equal(store.org.performance(agent.id).stage, 1);

  const ctx = { orgId: org.id, audience: 'assistant', depth: -1, emit() {} };
  const blocked = await assistant.org.handle(ctx, 'update_agent', { agent: 'mara', instructions: 'Be careful.' });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /escalation stage 1/);
  assert.equal(store.org.getAgent(agent.id).instructions, 'Do the work.', 'the instructions do not change without a reason');

  const allowed = await assistant.org.handle(ctx, 'update_agent', {
    agent: 'mara',
    instructions: 'Be careful and double-check.',
    reason: 'manual correction after a bad run',
  });
  assert.equal(allowed.isError, undefined);
  assert.equal(store.org.getAgent(agent.id).instructions, 'Be careful and double-check.');
  const actions = store.org.listActions(agent.id);
  assert.equal(actions[0].kind, 'reconfig');
  assert.equal(actions[0].beforeText, 'Do the work.');
  assert.equal(actions[0].afterText, 'Be careful and double-check.');
  assistant.close();
});

/* ----------------------------- end to end cycle ----------------------------- */

test('a weak streak escalates note -> reconfig -> replacement proposal, and hire_agent(replaces) completes it', async () => {
  const { assistant, store } = createAssistant();
  const org = assistant.org.activeOrganization();
  const mara = store.org.createAgent({ orgId: org.id, name: 'Mara', title: 'Engineer', instructions: 'Do the work.' });
  const lead = store.org.createAgent({ orgId: org.id, name: 'Lead', title: 'Head of Eng', instructions: 'Lead the team.' });
  store.org.updateAgent(mara.id, { managerId: lead.id });

  const runWeak = async (score) => {
    const assignment = await assistant.org.run({
      orgId: org.id,
      agent: store.org.getAgent(mara.id),
      task: 'do it, SCORE:' + score,
      requesterKind: 'user',
      depth: 0,
      emit() {},
    });
    assert.equal(assignment.status, 'done');
    return assignment;
  };

  // Three weak runs: stage 1, a `note` gets written automatically.
  await runWeak(2);
  await runWeak(2);
  await runWeak(2);
  await waitFor(() => store.org.listActions(mara.id).some((a) => a.kind === 'note'));
  assert.equal(store.org.performance(mara.id).stage, 1);
  const note = store.org.listActions(mara.id)[0];
  assert.equal(note.kind, 'note');
  assert.ok(note.agentNote, 'the agent gets a qualitative note, not a number');

  // Three more weak runs since the note: stage 2, a `reconfig` executes on
  // its own (decision E1) - instructions actually change, with a full
  // before/after pair on record.
  await runWeak(2);
  await runWeak(2);
  await runWeak(2);
  await waitFor(() => store.org.listActions(mara.id).some((a) => a.kind === 'reconfig'));
  const afterFirstReconfig = store.org.getAgent(mara.id).instructions;
  assert.notEqual(afterFirstReconfig, 'Do the work.');
  const reconfig = store.org.listActions(mara.id).find((a) => a.kind === 'reconfig');
  assert.equal(reconfig.beforeText, 'Do the work.');
  assert.equal(reconfig.afterText, afterFirstReconfig);
  assert.equal(reconfig.decidedBy, 'assistant');

  // Ten more weak runs after the reconfig (minData >= 10, probation window
  // filled and still weak): stage 3, a replacement is proposed but nothing
  // about the agent changes yet.
  for (let i = 0; i < 10; i += 1) await runWeak(2);
  await waitFor(() => store.org.listActions(mara.id).some((a) => a.kind === 'probation'));
  assert.equal(store.org.performance(mara.id).stage, 3);
  assert.ok(store.org.getAgent(mara.id) && !store.org.getAgent(mara.id).archived, 'still employed until the user approves');

  // The user approves: hire_agent(replaces=...) archives Mara and her
  // memory, hires Nora in her place, and Nora inherits the manager.
  store.upsertMemory({ kind: 'project', content: 'The API lives in packages/server.', owner: mara.id });
  const ctx = { orgId: org.id, audience: 'assistant', depth: -1, emit() {} };
  const hired = await assistant.org.handle(ctx, 'hire_agent', {
    name: 'Nora',
    title: 'Engineer',
    instructions: 'Verify every claim before reporting.',
    replaces: 'mara',
  });
  assert.equal(hired.isError, undefined);
  assert.match(hired.text, /Archived Mara/);

  const archivedMara = store.org.getAgent(mara.id);
  assert.equal(archivedMara.archived, true);
  const nora = store.org.findAgent(org.id, 'nora');
  assert.ok(nora);
  assert.notEqual(nora.id, mara.id);
  assert.equal(nora.managerId, lead.id, "the successor inherits the predecessor's manager");
  assert.equal(store.org.predecessorFor(nora.id)?.id, mara.id);
  const replaceAction = store.org.replacementFor(mara.id);
  assert.equal(replaceAction.successorAgentId, nora.id);
  assert.ok(replaceAction.handoverText, 'a handover was drafted');
  assert.doesNotMatch(replaceAction.handoverText, /\breview|rating|score\b/i, 'the handover is working knowledge, not a performance record');

  const maraMemories = store.listMemories({ owner: mara.id, limit: 10, includeDormant: true });
  assert.ok(maraMemories.every((m) => m.archivedAt), "the predecessor's memory is archived");
  assistant.close();
});
