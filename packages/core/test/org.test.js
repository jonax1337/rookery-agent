import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Assistant, BridgeServer, ProviderRegistry, Store, recall, toolsFor } from '../dist/index.js';

/**
 * The organisation, driven by a fake provider.
 *
 * Nothing here talks to a real CLI. The fake provider records the options it
 * was started with (so tests can check the workspace and the MCP spec) and
 * answers scripted text; when a prompt carries `ASSIGN:<slug>|<task>` it
 * calls the assign tool through the bridge pipe, exactly as the real bridge
 * executable would, which is what makes delegation testable end to end.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Talk the bridge protocol over the pipe, one request at a time. */
function bridgeCall(path, token, method, payload) {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index === -1) return;
      const message = JSON.parse(buffer.slice(0, index));
      socket.end();
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method, token, ...payload }) + '\n'));
  });
}

function createFakeProvider(options = {}) {
  const { delay = 20 } = options;
  const runs = [];
  let active = 0;
  let maxActive = 0;
  const provider = {
    id: 'claude',
    displayName: 'Fake Claude',
    models: () => ['fake'],
    async status() {
      return { id: 'claude', available: true, binary: 'fake', authenticated: true };
    },
    async *run(opts) {
      runs.push(opts);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        const prompt = opts.prompt ?? '';
        const call = (name, args) =>
          bridgeCall(opts.mcp.env.ROOKERY_BRIDGE_PATH, opts.mcp.env.ROOKERY_BRIDGE_TOKEN, 'call', { name, args });
        // Work handed off in the background came back (R4). A child that
        // asked a question is answered through answer_task; otherwise the
        // lead just finishes - it must not hand the same work off again.
        if (prompt.includes('has come back') && opts.mcp) {
          const waiting = prompt.match(/answer_task\("([0-9a-f]{8})"/);
          let text = 'FINAL(' + (waiting ? 'answered' : 'collected') + ')';
          if (waiting) {
            const result = await call('answer_task', { id: waiting[1], answer: 'Tab-separated.' });
            text += ' ' + result.text;
          }
          yield { type: 'text', delta: text };
          yield { type: 'done', text };
          return;
        }
        // A scripted background hand-off: assign with wait=false.
        const detached = prompt.match(/DETACH:([\w-]+)\|([^\n]+)/);
        if (detached && opts.mcp) {
          const result = await call('assign', { agent: detached[1], title: 'Background part', task: detached[2], wait: false });
          const text = 'HANDED OFF: ' + result.text;
          yield { type: 'text', delta: text };
          yield { type: 'done', text };
          return;
        }
        // A scripted question to whoever gave the task: ask_requester, then
        // end the run the way the tool says to. Once the answer is in the
        // brief, the run carries on normally instead of asking again.
        const question = prompt.match(/QUESTION:([^\n]+)/);
        if (question && opts.mcp && !prompt.includes(' answered:')) {
          const result = await call('ask_requester', { question: question[1] });
          const text = 'WAITING: ' + result.text;
          yield { type: 'text', delta: text };
          yield { type: 'done', text };
          return;
        }
        // A scripted delegation: call the assign tool through the bridge.
        const calls = [...prompt.matchAll(/ASSIGN:([\w-]+)\|([^\n]+)/g)];
        if (calls.length && opts.mcp) {
          const results = await Promise.all(
            calls.map(([, agent, task]) =>
              bridgeCall(opts.mcp.env.ROOKERY_BRIDGE_PATH, opts.mcp.env.ROOKERY_BRIDGE_TOKEN, 'call', {
                name: 'assign',
                args: { agent, task },
              }),
            ),
          );
          const text = 'DELEGATED: ' + results.map((result) => result.text).join(' || ');
          yield { type: 'text', delta: text };
          yield { type: 'done', text };
          return;
        }
        // A scripted tool switch: the assistant turns a server on mid-turn.
        const wanted = prompt.match(/TOOLS:([a-z0-9-]+)/);
        if (wanted && opts.mcp) {
          const result = await bridgeCall(opts.mcp.env.ROOKERY_BRIDGE_PATH, opts.mcp.env.ROOKERY_BRIDGE_TOKEN, 'call', {
            name: 'set_tool_server',
            args: { id: wanted[1], enabled: true },
          });
          const text = 'SWITCHED: ' + result.text;
          yield { type: 'text', delta: text };
          yield { type: 'done', text };
          return;
        }
        if (prompt.includes('FAIL')) {
          yield { type: 'error', message: 'boom', fatal: true };
          return;
        }
        await sleep(delay);
        const text = 'OUTPUT(' + prompt.slice(0, 40) + ')';
        yield { type: 'text', delta: text };
        yield { type: 'done', text };
      } finally {
        active -= 1;
      }
    },
  };
  return { provider, runs, get maxActive() { return maxActive; } };
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

function createAssistant(fake, overrides = {}, providers = [fake.provider]) {
  const home = mkdtempSync(join(tmpdir(), 'rookery-org-'));
  mkdirSync(join(home, 'run'), { recursive: true });
  const store = new Store(':memory:');
  const assistant = new Assistant({
    store,
    registry: new ProviderRegistry(providers),
    config: {
      home,
      logLevel: 'silent',
      memory: { enabled: false, autoExtract: false },
      // Off by default here: the automatic review adds a second provider.run()
      // call after every successful assignment, which throws off every test
      // that reads fake.runs.at(-1) expecting the assignment's own call. The
      // dedicated review tests turn it back on explicitly.
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

/* ------------------------------ structure ------------------------------ */

test('the store gives every agent a unique slug and finds them by slug or name', () => {
  const { assistant } = createAssistant(createFakeProvider());
  const org = assistant.org.activeOrganization();
  const a = hire(assistant, { name: 'Mara Lind' });
  const b = hire(assistant, { name: 'Mara Lind' });
  assert.equal(a.slug, 'mara-lind');
  assert.equal(b.slug, 'mara-lind-2');
  assert.equal(assistant.store.org.findAgent(org.id, 'MARA-LIND')?.id, a.id);
  assert.equal(assistant.store.org.findAgent(org.id, 'Mara Lind')?.id, a.id);
  assert.equal(assistant.store.org.findAgent(org.id, 'nobody'), null);
  assistant.close();
});

test('a default company exists on first use and is stable', () => {
  const { assistant } = createAssistant(createFakeProvider());
  const first = assistant.org.activeOrganization();
  const second = assistant.org.activeOrganization();
  assert.equal(first.id, second.id);
  assert.match(first.name, /Rookery/);
  assistant.close();
});

test('memories are scoped by owner', () => {
  const { assistant, store } = createAssistant(createFakeProvider());
  store.upsertMemory({ kind: 'project', content: 'The repository uses Fastify for the API server.', owner: 'agent-1' });
  store.upsertMemory({ kind: 'fact', content: 'The user prefers Fastify over Express.' });
  const forAgent = recall(store, { text: 'fastify api', owner: 'agent-1', threshold: 0 });
  const forAssistant = recall(store, { text: 'fastify api', threshold: 0 });
  assert.deepEqual(forAgent.map((m) => m.owner), ['agent-1']);
  assert.deepEqual(forAssistant.map((m) => m.owner), ['assistant']);
  assert.equal(store.memoryStats('agent-1').total, 1);
  assistant.close();
});

/* -------------------------------- turns -------------------------------- */

test('the assistant runs in the workspace with Rookery tools attached', async () => {
  const fake = createFakeProvider();
  const { assistant, home } = createAssistant(fake);
  const events = [];
  for await (const event of assistant.chat({ text: 'hello' })) events.push(event);
  const run = fake.runs[0];
  assert.equal(run.cwd, join(home, 'workspace'), 'never the directory Rookery started in');
  assert.equal(run.mcp.name, 'rookery');
  assert.ok(run.mcp.env.ROOKERY_BRIDGE_TOKEN, 'the turn is registered with the bridge');
  assert.match(run.systemPrompt, /you run a small company of AI agents/);
  assert.equal(events.at(-1).type, 'done');
  assistant.close();
});

test('the bridge answers hello with the audience tools and rejects unknown tokens', async () => {
  const fake = createFakeProvider();
  const { assistant } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const token = assistant.org.register({ orgId: org.id, audience: 'agent', agentId: 'x', depth: 0, emit() {} });
  const path = await assistant.org.bridge.start();
  const hello = await bridgeCall(path, token, 'hello', {});
  assert.deepEqual(hello.tools.map((t) => t.name), toolsFor('agent').map((t) => t.name));
  await assert.rejects(bridgeCall(path, 'nope', 'hello', {}), /Unknown or expired/);
  assistant.org.unregister(token);
  await assert.rejects(bridgeCall(path, token, 'hello', {}), /Unknown or expired/);
  assistant.close();
});

test('an assign tool call from inside a turn runs the agent and streams its assignment', async () => {
  const fake = createFakeProvider({ delay: 30 });
  const { assistant, store } = createAssistant(fake);
  const mara = hire(assistant, { name: 'Mara' });
  hire(assistant, { name: 'Ben' });
  const events = [];
  for await (const event of assistant.chat({ text: 'ASSIGN:mara|write the parser\nASSIGN:ben|write the tests' })) {
    events.push(event);
  }
  const done = events.find((event) => event.type === 'done');
  assert.match(done.text, /DELEGATED: Report from Mara \(mara\)/);
  // No `TASK:` heading here: the card's title was taken from this very
  // brief, so heading the brief with it would say the same thing twice.
  assert.match(done.text, /OUTPUT\(write the parser/);
  assert.match(done.text, /Report from Ben \(ben\)/);
  const views = events.filter((event) => event.type === 'assignment').map((event) => event.assignment);
  assert.ok(views.some((view) => view.agentSlug === 'mara' && view.status === 'done'));
  assert.ok(views.some((view) => view.agentSlug === 'ben' && view.status === 'running'));
  assert.equal(fake.maxActive, 3, 'both agents ran while the assistant turn was still open');
  const stored = store.org.listAssignments(mara.orgId);
  assert.equal(stored.length, 2);
  assert.ok(stored.every((a) => a.status === 'done' && a.requesterKind === 'assistant'));
  const agentRun = fake.runs.find((run) => run.prompt.startsWith('write the parser'));
  assert.match(agentRun.systemPrompt, /You are Mara, Engineer/);
  assert.ok(agentRun.mcp.env.ROOKERY_BRIDGE_TOKEN !== fake.runs[0].mcp.env.ROOKERY_BRIDGE_TOKEN);
  assistant.close();
});

/* -------------------------------- rules -------------------------------- */

test('an agent may only delegate to its direct reports, and never too deep', async () => {
  const fake = createFakeProvider();
  const { assistant } = createAssistant(fake, { org: { maxDelegationDepth: 2 } });
  const org = assistant.org.activeOrganization();
  const lead = hire(assistant, { name: 'Lead' });
  const junior = hire(assistant, { name: 'Junior', managerId: lead.id });
  const stranger = hire(assistant, { name: 'Stranger' });

  const asLead = { orgId: org.id, audience: 'agent', agentId: lead.id, depth: 0, emit() {} };
  const refused = await assistant.org.handle(asLead, 'assign', { agent: stranger.slug, task: 'x' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /direct reports: junior/);

  const self = await assistant.org.handle(asLead, 'assign', { agent: lead.slug, task: 'x' });
  assert.match(self.text, /background/);

  const ok = await assistant.org.handle(asLead, 'assign', { agent: junior.slug, task: 'do it' });
  assert.equal(ok.isError, undefined);
  assert.match(ok.text, /Report from Junior/);

  const asJunior = { orgId: org.id, audience: 'agent', agentId: junior.id, depth: 1, emit() {} };
  const deep = await assistant.org.handle(asJunior, 'assign', { agent: stranger.slug, task: 'x' });
  assert.match(deep.text, /too deep|direct reports/);

  const hiring = await assistant.org.handle(asLead, 'hire_agent', { name: 'X', title: 'Y', instructions: 'Z' });
  assert.equal(hiring.isError, true);
  assistant.close();
});

/* ------------------- notifications, activity, answers ------------------- */

/** The context the board runs a task under: the assistant, nobody waiting. */
function boardContext(org) {
  return { orgId: org.id, audience: 'assistant', depth: -1, emit() {} };
}

/** A card the user put on the board themselves. */
function userCard(store, org, input) {
  return store.org.createTask({ orgId: org.id, createdBy: 'user', ...input });
}

const kinds = (list) => list.map((entry) => entry.kind);

test('answer_task follows the chain of command', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const lead = hire(assistant, { name: 'Lead' });
  const junior = hire(assistant, { name: 'Junior', managerId: lead.id });
  const stranger = hire(assistant, { name: 'Stranger' });

  // What `assign` from inside the lead's task builds: the lead's own errand.
  const hers = store.org.createTask({
    orgId: org.id,
    title: 'Parse the rows',
    description: 'Parse them.',
    assigneeId: junior.id,
    createdBy: 'agent',
    createdByAgentId: lead.id,
  });
  store.org.updateTask(hers.id, { status: 'blocked' });

  const asStranger = { orgId: org.id, audience: 'agent', agentId: stranger.id, depth: 0, emit() {} };
  const refused = await assistant.org.handle(asStranger, 'answer_task', { id: hers.id, answer: 'Commas.' });
  assert.equal(refused.isError, true, 'an agent answers only what it handed out itself');
  assert.match(refused.text, /Only whoever handed this task out/);
  assert.equal(store.org.listTaskEvents(hers.id).some((event) => event.kind === 'answer'), false, 'and nothing was written');

  const asLead = { orgId: org.id, audience: 'agent', agentId: lead.id, depth: 0, emit() {} };
  const answered = await assistant.org.handle(asLead, 'answer_task', { id: hers.id, answer: 'Tabs.' });
  assert.equal(answered.isError, undefined, 'whoever handed it out may answer');
  const answer = store.org.lastTaskEvent(hers.id, 'answer');
  assert.equal(answer.actorKind, 'agent');
  assert.equal(answer.actorAgentId, lead.id);
  assert.equal(answer.text, 'Tabs.');
  await sleep(150);
  const runs = store.org.listAssignments(org.id, { agentId: junior.id });
  assert.equal(runs.length, 1, 'the answer carried the task on');
  assert.match(runs[0].task, /lead answered:\n\nTabs\./);

  // The assistant may answer any card, the user's included.
  const mine = userCard(store, org, { title: 'Fix the gate', description: 'Please fix it.', assigneeId: stranger.id });
  store.org.updateTask(mine.id, { status: 'blocked' });
  const byAssistant = await assistant.org.handle(boardContext(org), 'answer_task', { id: mine.id, answer: 'The north gate.' });
  assert.equal(byAssistant.isError, undefined);
  await sleep(200);
  assert.equal(store.org.listAssignments(org.id, { agentId: stranger.id }).length, 1);
  assistant.close();
});

test('ask_requester blocks the card, the user gets the question once, and their answer carries the same task on', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });
  const announced = [];
  assistant.on('notification', (event) => announced.push(event.notification));

  const task = userCard(store, org, {
    title: 'Fix the gate',
    description: 'QUESTION:Which gate do you mean?',
    assigneeId: mara.id,
  });
  const ended = await assistant.org.runTask(boardContext(org), task);
  assert.equal(ended.status, 'blocked', 'a run that ended with a question is waiting, not finished');

  const question = store.org.lastTaskEvent(task.id, 'question');
  assert.equal(question.text, 'Which gate do you mean?', 'the question is on the card');
  assert.equal(question.actorAgentId, mara.id);
  let notes = store.org.listNotifications({ orgId: org.id });
  assert.deepEqual(kinds(notes), ['question'], 'one question, and no status note repeating it');
  assert.equal(notes[0].taskId, task.id, 'it points at the card an answer continues');
  assert.equal(notes[0].fromAgentId, mara.id, 'in the asking agent\'s name');
  assert.match(notes[0].body, /Which gate do you mean\?/);
  assert.deepEqual(kinds(announced), ['question'], 'announced exactly once');

  // The user answers - the route and a Telegram reply both land here.
  const answered = await assistant.org.answerTask({ taskId: task.id, answer: 'The north gate.' });
  assert.equal(answered.ok, true);
  await sleep(250);

  const runs = store.org.listAssignments(org.id, { agentId: mara.id });
  assert.equal(runs.length, 2, 'the answer started the next run of the task');
  for (const run of runs) assert.equal(store.org.getTaskIdForAssignment(run.id), task.id, 'on the same card');
  assert.ok(runs.some((run) => run.task.includes('The user answered:\n\nThe north gate.')), 'briefed with the answer');
  assert.equal(store.org.getTask(task.id).status, 'done');

  notes = store.org.listNotifications({ orgId: org.id });
  assert.deepEqual(kinds(notes), ['task', 'question'], 'and its ending reaches the user once');
  assert.deepEqual(
    kinds(store.org.listTaskEvents(task.id)),
    ['created', 'run-started', 'question', 'run-ended', 'status', 'answer', 'run-started', 'run-ended', 'status'],
    'the card keeps the whole story',
  );
  assistant.close();
});

test('a card the user put up tells them how it ended exactly once, with the result', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });

  const shipped = userCard(store, org, { title: 'Ship the thing', description: 'Please ship it.', assigneeId: mara.id });
  await assistant.org.runTask(boardContext(org), shipped);
  const broken = userCard(store, org, { title: 'Fix the gate', description: 'FAIL - this run goes nowhere.', assigneeId: mara.id });
  await assistant.org.runTask(boardContext(org), broken);

  const notes = store.org.listNotifications({ orgId: org.id });
  assert.equal(notes.length, 2, 'one per ending, nothing on top');
  const done = notes.find((entry) => entry.taskId === shipped.id);
  assert.equal(done.kind, 'task');
  assert.match(done.title, /"Ship the thing" is done/);
  assert.match(done.body, /OUTPUT\(/, 'it carries the result, not a pointer to it');
  const failed = notes.find((entry) => entry.taskId === broken.id);
  assert.match(failed.title, /failed/, 'a failure the user would otherwise never hear about');
  assert.match(failed.body, /boom/);
  assert.equal(store.org.lastTaskEvent(broken.id, 'status').text.includes('failed'), true, 'and the card says so too');
  assistant.close();
});

test('every writer moves a task the same way: the tool tells the card and the user, and reopening clears the last life', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });

  const task = userCard(store, org, { title: 'Fix the gate', description: 'Please fix it.', assigneeId: mara.id });

  // Closing it through the tool. This is the writer that used to move the
  // card in silence: no event, and nobody told, so whoever was waiting
  // waited for good.
  const closed = await assistant.org.handle(boardContext(org), 'update_task', {
    id: task.id,
    status: 'done',
    result: 'The hinge was loose.',
  });
  assert.equal(closed.isError, undefined);

  const status = store.org.lastTaskEvent(task.id, 'status');
  assert.equal(status.actorKind, 'assistant', 'the card says who moved it');
  assert.match(status.text, /is done/);
  const [note] = store.org.listNotifications({ orgId: org.id });
  assert.equal(note.kind, 'task', 'the user hears it from the tool too');
  assert.match(note.body, /The hinge was loose\./, 'and it carries the result, not a pointer to it');
  assert.equal(store.org.listAssignments(org.id, { agentId: mara.id }).length, 0, 'a status change starts nothing');

  const done = store.org.getTask(task.id);
  assert.equal(done.status, 'done');
  assert.ok(done.finishedAt, 'a finished card is stamped');
  assert.equal(done.result, 'The hinge was loose.');

  // Reopening is a new life. The old stamp and the old result must not
  // survive it: every duration on the page, and the watcher's "running far
  // longer than it should", would otherwise do arithmetic with a timestamp
  // from a run that ended days ago.
  const reopened = await assistant.org.setTaskStatus({ task: done, to: 'open', by: 'user' });
  assert.equal(reopened.ok, true);
  assert.equal(reopened.task.status, 'open');
  assert.equal(reopened.task.finishedAt, undefined, 'the old ending is gone');
  assert.equal(reopened.task.result, undefined, 'and so is the old result');

  // A running card belongs to its run. Everyone but the run loop has to
  // cancel it rather than decide its outcome from outside.
  store.org.updateTask(task.id, { status: 'running' });
  const refused = await assistant.org.setTaskStatus({
    task: store.org.getTask(task.id),
    to: 'done',
    by: 'user',
  });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /running/);
  assistant.close();
});

test('an agent reports, the user closes: an agent cannot finish a card the user put up', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });

  const mine = store.org.createTask({
    orgId: org.id,
    title: 'Fix the gate',
    assigneeId: mara.id,
    createdBy: 'user',
  });
  const hers = store.org.createTask({
    orgId: org.id,
    title: 'Her own errand',
    assigneeId: mara.id,
    createdBy: 'agent',
    createdByAgentId: mara.id,
  });

  for (const to of ['done', 'cancelled']) {
    const refused = await assistant.org.setTaskStatus({ task: mine, to, by: 'agent' });
    assert.equal(refused.ok, false, 'an agent may not ' + to + " the user's card");
    assert.match(refused.reason, /belongs to the user/);
  }
  assert.equal(store.org.getTask(mine.id).status, 'open', 'and nothing moved');

  // Reporting a problem is not closing: blocked stays open to them.
  const blocked = await assistant.org.setTaskStatus({ task: mine, to: 'blocked', by: 'agent' });
  assert.equal(blocked.ok, true);

  // Its own errand is its own business.
  const own = await assistant.org.setTaskStatus({ task: hers, to: 'done', by: 'agent' });
  assert.equal(own.ok, true);

  // And the user is never blocked on their own card.
  const mineAgain = await assistant.org.setTaskStatus({
    task: store.org.getTask(mine.id),
    to: 'done',
    by: 'user',
  });
  assert.equal(mineAgain.ok, true);
  assistant.close();
});

test('who hears an ending: the user for their own cards and the assistant\'s loose ones, never for an agent\'s errand or their own cancel', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const victor = hire(assistant, { name: 'Victor' });
  const mara = hire(assistant, { name: 'Mara' });
  const count = () => store.org.listNotifications({ orgId: org.id }).length;

  // What `assign` builds when one agent opens a task for another: the user
  // never ordered it and must not be handed a receipt for it. The card still
  // records how it ended.
  const errand = store.org.createTask({
    orgId: org.id,
    title: 'Raise the upload limit',
    description: 'Ten megabytes is not enough.',
    assigneeId: mara.id,
    createdBy: 'agent',
    createdByAgentId: victor.id,
  });
  await assistant.org.setTaskStatus({ task: errand, to: 'failed', by: 'assistant', error: 'boom' });
  assert.equal(count(), 0, 'no receipt for work the user never ordered');
  assert.match(store.org.lastTaskEvent(errand.id, 'status').text, /failed/, 'but the card knows');

  // The assistant's own card with no conversation to report into: nobody
  // else is left to hear it.
  const loose = store.org.createTask({
    orgId: org.id,
    title: 'Rewrite the token cache',
    description: 'Make it expire properly.',
    assigneeId: mara.id,
    createdBy: 'assistant',
  });
  await assistant.org.setTaskStatus({ task: loose, to: 'failed', by: 'assistant', error: 'boom' });
  assert.equal(count(), 1, 'the assistant\'s loose card tells the user when it fails');

  // The user's own cancel is silent - they know, they did it - but the
  // assistant cancelling their card is news.
  const first = userCard(store, org, { title: 'Paint the fence', assigneeId: mara.id });
  await assistant.org.setTaskStatus({ task: first, to: 'cancelled', by: 'user' });
  assert.equal(count(), 1, 'their own cancel says nothing back');
  const second = userCard(store, org, { title: 'Oil the hinge', assigneeId: mara.id });
  await assistant.org.setTaskStatus({ task: second, to: 'cancelled', by: 'assistant' });
  assert.equal(count(), 2);
  assert.match(store.org.listNotifications({ orgId: org.id })[0].title, /was cancelled/);

  // A card handed off from a conversation is that conversation's business:
  // it hears it as a turn (report-back.test.js), never as a notification.
  const session = assistant.createSession({ title: 'Chat' });
  const fromChat = store.org.createTask({
    orgId: org.id,
    title: 'Look it up',
    assigneeId: mara.id,
    createdBy: 'assistant',
    requesterSessionId: session.id,
  });
  await assistant.org.setTaskStatus({ task: fromChat, to: 'done', by: 'assistant', result: 'Found it.' });
  assert.equal(count(), 2, 'no notification on top of the report-back');
  assistant.close();
});

test('the board says what a blocked task waits for', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });

  const task = userCard(store, org, { title: 'Fix the gate', description: 'Please fix it.', assigneeId: mara.id });
  store.org.addTaskEvent({
    taskId: task.id,
    kind: 'question',
    actorKind: 'agent',
    actorAgentId: mara.id,
    text: 'Which delimiter do these files use?',
  });
  store.org.updateTask(task.id, { status: 'blocked' });

  const board = await assistant.org.handle(boardContext(org), 'list_tasks', { status: '' });
  assert.match(board.text, /BLOCKED/);
  assert.match(board.text, /waiting \d+[mhd]/, 'how long it has stood there');
  assert.match(board.text, /Which delimiter do these files use\?/, 'and what it is waiting on');

  const activity = await assistant.org.handle(boardContext(org), 'task_activity', { id: task.id.slice(0, 8) });
  assert.match(activity.text, /created by user/);
  assert.match(activity.text, /question by mara:\n\s*Which delimiter/);
  assistant.close();
});

test('a lead\'s background report that asks it something comes back to the lead, who answers it (R4)', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const lead = hire(assistant, { name: 'Lead' });
  const junior = hire(assistant, { name: 'Junior', managerId: lead.id });

  const task = userCard(store, org, {
    title: 'Build the importer',
    description: 'DETACH:junior|QUESTION:Which delimiter do these files use?',
    assigneeId: lead.id,
  });
  const ended = await assistant.org.runTask(boardContext(org), task);
  assert.equal(ended.status, 'done', 'the lead finished once its report was back');
  assert.match(ended.result, /FINAL\(/);

  const [child] = store.org.listTasks(org.id, { parentId: task.id });
  assert.equal(child.assigneeId, junior.id);
  assert.equal(store.org.getTask(child.id).status, 'done', 'the child carried on with the answer and finished');
  const childEvents = store.org.listTaskEvents(child.id);
  const answer = childEvents.find((event) => event.kind === 'answer');
  assert.ok(childEvents.some((event) => event.kind === 'question'), 'the question is on the child\'s card');
  assert.equal(answer.actorAgentId, lead.id, 'answered by the lead that asked for the work');
  assert.equal(answer.text, 'Tab-separated.');

  const notes = store.org.listNotifications({ orgId: org.id });
  assert.deepEqual(kinds(notes), ['task'], 'the user never saw the question - only the card they put up ending');
  assistant.close();
});

test('a question nobody else will carry goes to the user: a split\'s subtask asks, the user hears it', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });
  const noah = hire(assistant, { name: 'Noah' });

  const parent = userCard(store, org, { title: 'Big thing', description: 'Split me.' });
  store.org.createTask({ orgId: org.id, title: 'Part one', description: 'Do part one.', parentId: parent.id, assigneeId: mara.id, createdBy: 'assistant' });
  const asking = store.org.createTask({
    orgId: org.id,
    title: 'Part two',
    description: 'QUESTION:Which region?',
    parentId: parent.id,
    assigneeId: noah.id,
    createdBy: 'assistant',
  });

  await assistant.org.runTask(boardContext(org), store.org.getTask(parent.id));
  assert.equal(store.org.getTask(asking.id).status, 'blocked');
  const notes = store.org.listNotifications({ orgId: org.id });
  const question = notes.find((entry) => entry.kind === 'question');
  assert.ok(question, 'a question is never silent');
  assert.equal(question.taskId, asking.id);
  assert.match(question.body, /Which region\?/);
  const done = notes.filter((entry) => entry.kind === 'task');
  assert.equal(done.length, 1, 'and the split answers once, with the combined result');
  assert.match(done[0].body, /Part one/);
  assert.match(done[0].body, /Part two/);
  assistant.close();
});

test('a person answering is never capped; a machine answering is', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake, { org: { autoReview: false, maxTaskRuns: 1 } });
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });

  const task = userCard(store, org, { title: 'Fix the gate', description: 'QUESTION:Which gate?', assigneeId: mara.id });
  await assistant.org.runTask(boardContext(org), task);
  assert.equal(store.org.getTask(task.id).status, 'blocked');

  const byAssistant = await assistant.org.handle(boardContext(org), 'answer_task', { id: task.id, answer: 'North.' });
  assert.equal(byAssistant.isError, true, 'past the ceiling, a machine cannot set it going again');
  assert.match(byAssistant.text, /already run 1 times/);
  assert.equal(store.org.lastTaskEvent(task.id, 'answer').text, 'North.', 'but its answer is on the card');

  const byUser = await assistant.org.answerTask({ taskId: task.id, answer: 'The north gate.' });
  assert.equal(byUser.ok, true, 'the user always gets their run');
  await sleep(200);
  assert.equal(store.org.listAssignments(org.id, { agentId: mara.id }).length, 2);
  assistant.close();
});

test('ask_requester and report_to_user: only inside a task, and an agent report is an agent notification', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });
  const task = userCard(store, org, { title: 'Fix the gate', assigneeId: mara.id });

  const loose = { orgId: org.id, audience: 'agent', agentId: mara.id, depth: 0, emit() {} };
  const nowhere = await assistant.org.handle(loose, 'ask_requester', { question: 'Which gate?' });
  assert.equal(nowhere.isError, true, 'outside a task there is nobody waiting to be asked');
  const asUser = await assistant.org.handle(loose, 'ask_user', { header: 'x', question: 'y', options: ['a', 'b'] });
  assert.match(asUser.text, /ask_requester/, 'and ask_user points an agent at the right tool');

  const inTask = { ...loose, taskId: task.id, parentAssignmentId: 'run-1' };
  const reported = await assistant.org.handle(inTask, 'report_to_user', {
    title: 'The gate is older than we thought',
    body: 'It predates the fence; replacing it is a bigger job.',
  });
  assert.equal(reported.isError, undefined);
  const [note] = store.org.listNotifications({ orgId: org.id });
  assert.equal(note.kind, 'agent');
  assert.equal(note.fromKind, 'agent');
  assert.equal(note.fromAgentId, mara.id);
  assert.equal(note.taskId, task.id);
  assert.match(store.org.lastTaskEvent(task.id, 'note').text, /Reported to the user/, 'and the card keeps a line of it');
  assistant.close();
});

test('notify is kept as a system notification, pushed or not', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();

  // Nobody listening: nothing can push, but the line is not lost.
  const unheard = await assistant.org.handle(boardContext(org), 'notify', { text: 'The backup finished.' });
  assert.equal(unheard.isError, undefined);
  assert.match(unheard.text, /saved in their notifications/);

  const pushed = [];
  assistant.on('notify', (event) => pushed.push(event));
  const heard = await assistant.org.handle(boardContext(org), 'notify', { text: 'The server is down.', urgency: 'high' });
  assert.match(heard.text, /^Sent \(high urgency\)/);
  assert.equal(pushed.length, 1, 'the push still travels on its own event');

  const notes = store.org.listNotifications({ orgId: org.id });
  assert.deepEqual(kinds(notes), ['system', 'system']);
  assert.equal(notes[0].title, 'The server is down.');
  assistant.close();
});

test('a status filter finds a blocked subtask under a finished parent, and lists it once', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });
  const ctx = { orgId: org.id, audience: 'assistant', depth: -1, emit() {} };

  const make = (title, patch, parentId) => {
    const task = store.org.createTask({
      orgId: org.id,
      title,
      description: title + '.',
      assigneeId: mara.id,
      createdBy: 'assistant',
      parentId,
    });
    store.org.updateTask(task.id, patch);
    return task;
  };
  const finished = make('Ship the importer', { status: 'done' });
  make('Write the row parser', { status: 'blocked' }, finished.id);
  const waiting = make('Move the index', { status: 'blocked' });
  make('Rebuild the shards', { status: 'blocked' }, waiting.id);

  const board = await assistant.org.handle(ctx, 'list_tasks', { status: 'blocked' });
  const count = (title) => board.text.split('\n').filter((line) => line.includes(title)).length;
  assert.equal(count('Write the row parser'), 1, 'a blocked subtask under a finished parent is findable');
  assert.equal(count('Rebuild the shards'), 1, 'and a blocked subtask under a blocked parent is listed once, not twice');
  assert.equal(count('Ship the importer'), 0, 'the finished parent is not on a list of blocked work');
  assistant.close();
});

test('the assistant can hire and structure the company through tools', async () => {
  const fake = createFakeProvider();
  // Two providers, as in a real run: an agent can be pinned to any id the
  // registry serves, and `hire_agent` checks it against exactly that.
  const second = { ...fake.provider, id: 'codex', displayName: 'Fake ChatGPT' };
  const { assistant, store } = createAssistant(fake, {}, [fake.provider, second]);
  const org = assistant.org.activeOrganization();
  const ctx = { orgId: org.id, audience: 'assistant', depth: -1, emit() {} };
  const team = await assistant.org.handle(ctx, 'create_team', { name: 'Platform', purpose: 'Infra' });
  assert.match(team.text, /Created team "Platform"/);
  const hired = await assistant.org.handle(ctx, 'hire_agent', {
    name: 'Mara', title: 'SRE', instructions: 'Keep it running.', team: 'Platform', provider: 'codex', permission: 'write',
  });
  assert.match(hired.text, /slug: mara/);
  const mara = store.org.findAgent(org.id, 'mara');
  assert.equal(mara.teamId, store.org.findTeam(org.id, 'Platform').id);
  assert.equal(mara.provider, 'codex');
  assert.equal(mara.permission, 'write');
  // An id nothing serves is not a preference, so it is not stored as one.
  await assistant.org.handle(ctx, 'hire_agent', {
    name: 'Tal', title: 'Dev', instructions: 'Ship it.', provider: 'no-such-backend',
  });
  assert.equal(store.org.findAgent(org.id, 'tal').provider, undefined);
  const missing = await assistant.org.handle(ctx, 'create_project', { name: 'X', path: join(tmpdir(), 'does-not-exist-' + Date.now()) });
  assert.equal(missing.isError, true);
  assert.match(await assistant.org.handle(ctx, 'org_overview', {}).then((r) => r.text), /mara — Mara, SRE · team: Platform/);
  assistant.close();
});

/* ------------------------------ execution ------------------------------ */

test('a direct assignment streams events, records the result, and fails cleanly', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const mara = hire(assistant, { name: 'Mara' });
  const events = [];
  for await (const event of assistant.assign({ agent: 'mara', task: 'summarise the repo' })) events.push(event);
  assert.equal(events.at(-1).type, 'done');
  assert.match(events.at(-1).text, /OUTPUT\(summarise the repo\)/);
  const record = store.org.listAssignments(mara.orgId)[0];
  assert.equal(record.requesterKind, 'user');
  assert.equal(record.status, 'done');
  assert.ok(record.durationMs >= 0);

  // Handing work to an agent directly is still handing out work, so it is
  // on the board. This entrance - the one the web UI, the websocket, the
  // CLI and every agent schedule come through - used to leave a run with no
  // card anywhere, which is why "what is running?" had no honest answer.
  const cardId = store.org.getTaskIdForAssignment(record.id);
  assert.ok(cardId, 'the run hangs on a card');
  const card = store.org.getTask(cardId);
  assert.equal(card.status, 'done');
  assert.equal(card.assigneeId, mara.id);
  assert.equal(card.createdBy, 'user', 'the person who asked is on the card, not the machinery');
  assert.ok(
    store.org.listTasks(mara.orgId, { anyLevel: true }).some((task) => task.id === cardId),
    'and the board can find it',
  );

  const failed = [];
  for await (const event of assistant.assign({ agent: 'mara', task: 'FAIL now' })) failed.push(event);
  assert.equal(failed.at(-1).type, 'error');
  assert.match(failed.at(-1).message, /boom/);
  assert.equal(store.org.listAssignments(mara.orgId)[0].status, 'failed');

  const unknown = [];
  for await (const event of assistant.assign({ agent: 'ghost', task: 'x' })) unknown.push(event);
  assert.match(unknown[0].message, /No agent "ghost"/);
  assistant.close();
});

test('assignments respect the concurrency cap and can be aborted', async () => {
  const fake = createFakeProvider({ delay: 60 });
  const { assistant } = createAssistant(fake, { org: { maxConcurrentAssignments: 1, autoReview: false } });
  hire(assistant, { name: 'A' });
  hire(assistant, { name: 'B' });
  const collect = async (gen) => {
    const out = [];
    for await (const event of gen) out.push(event);
    return out;
  };
  await Promise.all([
    collect(assistant.assign({ agent: 'a', task: 'one' })),
    collect(assistant.assign({ agent: 'b', task: 'two' })),
  ]);
  assert.equal(fake.maxActive, 1);

  const controller = new AbortController();
  const pending = collect(assistant.assign({ agent: 'a', task: 'three', signal: controller.signal }));
  await sleep(10);
  controller.abort();
  const events = await pending;
  assert.match(events.at(-1).message, /cancelled/);
  assistant.close();
});

/* -------------------------------- tasks -------------------------------- */

test('a task is planned by role and executed as parallel subtasks in dependency order', async () => {
  const fake = createFakeProvider({ delay: 30 });
  // The planner answer rides on the fake: a prompt carrying the planner marker gets this JSON.
  fake.provider.run = (function (original) {
    return async function* (opts) {
      if ((opts.prompt ?? '').includes('ROOKERY TASK PLANNER')) {
        const text = JSON.stringify({
          mode: 'split',
          reason: 'Two independent parts and one that needs both.',
          subtasks: [
            { title: 'Parser', description: 'Write the parser.', agent: 'mara', dependsOn: [] },
            { title: 'Tests', description: 'Write the tests.', agent: 'ben', dependsOn: [] },
            { title: 'Docs', description: 'Document both.', agent: 'ghost-writer', dependsOn: [0, 1] },
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
  hire(assistant, { name: 'Mara', title: 'Engineer' });
  hire(assistant, { name: 'Ben', title: 'Tester' });
  const ctx = { orgId: org.id, audience: 'assistant', depth: -1, emit() {} };

  const created = await assistant.org.handle(ctx, 'create_task', { title: 'Build the thing', description: 'All of it.' });
  assert.match(created.text, /is on the board/);
  const task = store.org.listTasks(org.id)[0];
  assert.equal(task.status, 'open');

  const planned = await assistant.org.handle(ctx, 'plan_task', { id: task.id.slice(0, 8) });
  assert.match(planned.text, /Plan: split/);
  const children = store.org.listTasks(org.id, { parentId: task.id });
  assert.equal(children.length, 3);
  assert.equal(store.org.getTask(task.id).status, 'planned');
  const docs = children.find((c) => c.title === 'Docs');
  assert.equal(docs.dependsOn.length, 2, 'dependencies point at sibling ids');
  assert.ok(docs.assigneeId, 'an unknown slug falls back to a real agent');

  const events = [];
  const ran = await assistant.org.handle({ ...ctx, emit: (e) => events.push(e) }, 'run_task', { id: task.id });
  assert.match(ran.text, /is done/);
  assert.match(ran.text, /### Parser \(mara, done\)/);
  assert.match(ran.text, /### Docs/);
  const finished = store.org.getTask(task.id);
  assert.equal(finished.status, 'done');
  assert.equal(fake.maxActive, 2, 'the two independent subtasks ran together, the dependent one after');
  const docsRun = fake.runs.find((run) => (run.prompt ?? '').includes('TASK: Docs'));
  assert.match(docsRun.prompt, /Results of the subtasks this one depends on/);
  assert.ok(events.some((e) => e.type === 'task' && e.task.status === 'running'));
  assert.ok(store.org.listTasks(org.id, { parentId: task.id }).every((c) => c.status === 'done' && c.assignmentId));
  assistant.close();
});

test('an unplanned task with an assignee runs as one assignment; run_task plans when needed', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  hire(assistant, { name: 'Solo' });
  const ctx = { orgId: org.id, audience: 'assistant', depth: -1, emit() {} };
  await assistant.org.handle(ctx, 'create_task', { title: 'Quick one', description: 'Do it.', assignee: 'solo', priority: 'high' });
  const task = store.org.listTasks(org.id)[0];
  assert.equal(task.priority, 'high');
  const ran = await assistant.org.handle(ctx, 'run_task', { id: task.id });
  assert.match(ran.text, /OUTPUT\(TASK: Quick one/);
  assert.equal(store.org.getTask(task.id).status, 'done');
  // The board renders both the parent and its state.
  const board = await assistant.org.handle(ctx, 'list_tasks', {});
  assert.match(board.text, /DONE high — Quick one \(solo\)/);
  const closed = await assistant.org.handle(ctx, 'update_task', { id: task.id, status: 'open' });
  assert.match(closed.text, /status/);
  assistant.close();
});

test('the assistant can restructure staff and teams through tools', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const lead = hire(assistant, { name: 'Lead' });
  const junior = hire(assistant, { name: 'Junior' });
  const ctx = { orgId: org.id, audience: 'assistant', depth: -1, emit() {} };
  await assistant.org.handle(ctx, 'create_team', { name: 'Core' });
  const moved = await assistant.org.handle(ctx, 'update_agent', { agent: 'junior', team: 'Core', manager: 'lead', title: 'Engineer II' });
  assert.match(moved.text, /Updated Junior/);
  const updated = store.org.getAgent(junior.id);
  assert.equal(updated.managerId, lead.id);
  assert.equal(updated.title, 'Engineer II');
  assert.equal(updated.teamId, store.org.findTeam(org.id, 'Core').id);
  const renamed = await assistant.org.handle(ctx, 'update_team', { team: 'Core', name: 'Platform', lead: 'lead' });
  assert.match(renamed.text, /Platform/);
  assert.equal(store.org.findTeam(org.id, 'Platform').leadId, lead.id);
  const loop = await assistant.org.handle(ctx, 'update_agent', { agent: 'lead', manager: 'lead' });
  assert.equal(loop.isError, true);
  assistant.close();
});

test('the assistant can cancel, browse history, edit projects, keep memory and change settings', async () => {
  const fake = createFakeProvider({ delay: 300 });
  const { assistant, store, home } = createAssistant(fake, { memory: { enabled: true, autoExtract: false } });
  const org = assistant.org.activeOrganization();
  hire(assistant, { name: 'Mara' });
  const ctx = { orgId: org.id, audience: 'assistant', depth: -1, emit() {} };

  // Cancel by id prefix while the fake provider is still "working".
  const events = [];
  const pending = (async () => {
    for await (const event of assistant.assign({ agent: 'mara', task: 'slow one' })) events.push(event);
  })();
  await sleep(30);
  const running = store.org.listAssignments(org.id, { status: ['running', 'pending'] })[0];
  assert.ok(running, 'the assignment is in flight');
  const cancelled = await assistant.org.handle(ctx, 'cancel_assignment', { id: running.id.slice(0, 8) });
  assert.match(cancelled.text, /Calling off/);
  await pending;
  assert.equal(store.org.getAssignment(running.id).status, 'cancelled');
  const again = await assistant.org.handle(ctx, 'cancel_assignment', { id: running.id });
  assert.equal(again.isError, true, 'a finished assignment cannot be cancelled twice');

  const history = await assistant.org.handle(ctx, 'list_assignments', { agent: 'mara', status: 'cancelled' });
  assert.match(history.text, /cancelled .*mara: slow one/);
  const nobody = await assistant.org.handle(ctx, 'list_assignments', { agent: 'ghost' });
  assert.equal(nobody.isError, true);

  await assistant.org.handle(ctx, 'create_project', { name: 'Nimbus' });
  const renamed = await assistant.org.handle(ctx, 'update_project', { project: 'Nimbus', name: 'Nimbus 2', archived: true });
  assert.match(renamed.text, /Nimbus 2/);
  const project = store.org.listProjects(org.id, true).find((entry) => entry.name === 'Nimbus 2');
  assert.equal(project.archived, true);
  const missingDir = await assistant.org.handle(ctx, 'update_project', { project: 'Nimbus 2', path: join(home, 'nope') });
  assert.equal(missingDir.isError, true);

  const kept = await assistant.org.handle(ctx, 'remember', { content: 'The user drinks espresso.', kind: 'preference', tags: 'coffee' });
  assert.match(kept.text, /espresso/);
  const found = await assistant.org.handle(ctx, 'search_memory', { query: 'espresso' });
  assert.match(found.text, /preference.*espresso/);
  const id = found.text.match(/^- (\w+)/m)[1];
  const gone = await assistant.org.handle(ctx, 'forget', { id });
  assert.match(gone.text, /Forgotten/);
  assert.equal(store.listMemories().length, 0);

  const settings = await assistant.org.handle(ctx, 'update_settings', { maxConcurrentAssignments: 2, defaultEffort: 'high', assignmentTimeoutMinutes: 5 });
  assert.match(settings.text, /Parallel runs: 2/);
  assert.equal(assistant.config.org.maxConcurrentAssignments, 2);
  assert.equal(assistant.config.defaultEffort, 'high');
  assert.equal(assistant.config.org.assignmentTimeoutMs, 5 * 60 * 1000);
  const saved = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  assert.equal(saved.org.maxConcurrentAssignments, 2);
  const cleared = await assistant.org.handle(ctx, 'update_settings', { defaultEffort: 'default' });
  assert.match(cleared.text, /Default effort: provider default/);
  assert.equal(assistant.config.defaultEffort, undefined);
  const bad = await assistant.org.handle(ctx, 'update_settings', { defaultEffort: 'ludicrous' });
  assert.equal(bad.isError, true);
  assistant.close();
});

test('chat() is assistant-only; a stale agentId on a session no longer changes its behaviour', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake, { memory: { enabled: true, autoExtract: false } });
  const mara = hire(assistant, { name: 'Mara', title: 'Designer', instructions: 'Love whitespace.' });
  store.upsertMemory({ kind: 'fact', content: 'The user likes serif fonts for headings.', owner: mara.id, importance: 0.9 });
  // An old session from the removed agent-chat feature still carries an agentId in the DB.
  const stale = assistant.createSession({ agentId: mara.id });
  const events = [];
  for await (const event of assistant.chat({ text: 'hi there', sessionId: stale.id })) events.push(event);
  const run = fake.runs.at(-1);
  assert.doesNotMatch(run.systemPrompt, /You are Mara, Designer/);
  assert.doesNotMatch(run.systemPrompt, /serif fonts/, 'a stale agentId no longer brings that agent into the turn');
  assert.match(run.systemPrompt, /you run a small company of AI agents/);
  assert.equal(run.systemPromptMode, 'replace');
  assert.equal(run.cwd, assistant.config.workspace);
  assert.ok(events.find((e) => e.type === 'session'), 'the turn still runs to completion, never throws');
  assistant.close();
});

test('a tool switched on mid-turn is attached at once instead of next time', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake, {
    tools: {
      servers: [
        {
          id: 'custom-notes',
          enabled: false,
          audience: 'assistant',
          options: {},
          env: {},
          custom: { name: 'Notes', command: 'node', args: ['notes.js'], hint: 'The notes live here.' },
        },
      ],
    },
  });

  const session = assistant.createSession();
  let done = null;
  const attached = [];
  for await (const event of assistant.chat({ text: 'TOOLS:custom-notes', sessionId: session.id })) {
    if (event.type === 'done') done = event;
    if (event.type === 'status' && event.label === 'tools') attached.push(event.detail);
  }

  const passes = fake.runs.filter((run) => run.mcp);
  assert.equal(passes.length, 2, 'the turn ran the provider again with the new server');
  assert.equal(passes[0].mcpExtra, undefined, 'the first pass had nothing attached');
  assert.deepEqual(passes[1].mcpExtra.map((spec) => spec.name), ['custom-notes']);
  assert.ok(passes[1].prompt.startsWith('[Rookery]'), 'the second pass is nudged by the system, not the user');
  assert.ok(passes[1].systemPrompt.includes('The notes live here.'), 'and it is told what the new server is for');
  assert.deepEqual(attached, ['custom-notes attached, carrying on']);

  assert.ok(done.text.includes('SWITCHED'));
  assert.ok(done.text.includes('OUTPUT([Rookery]'), 'both passes are one answer');
  const messages = store.getMessages(session.id, 10);
  assert.equal(messages.filter((message) => message.role === 'assistant').length, 1, 'one turn, one stored answer');

  // A second turn changes nothing more: the server is attached from the start.
  fake.runs.length = 0;
  for await (const event of assistant.chat({ text: 'hello', sessionId: session.id })) void event;
  const second = fake.runs.filter((run) => run.mcp);
  assert.equal(second.length, 1, 'no continuation when no switch was flipped');
  assert.deepEqual(second[0].mcpExtra.map((spec) => spec.name), ['custom-notes']);
  assistant.close();
});

/* --------------------------- project scoping ---------------------------- */

test("an agent's own project skills override the home ones with the same name", async () => {
  const fake = createFakeProvider();
  const { assistant, store, home } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });

  const homeSkill = join(home, 'skills', 'brief');
  mkdirSync(homeSkill, { recursive: true });
  writeFileSync(
    join(homeSkill, 'SKILL.md'),
    '---\nname: brief\ndescription: Home brief\naudience: agents\n---\n\nHOME\n',
  );

  const projectDir = mkdtempSync(join(tmpdir(), 'rookery-project-'));
  const projectSkills = join(projectDir, '.claude', 'skills');
  mkdirSync(join(projectSkills, 'brief'), { recursive: true });
  writeFileSync(
    join(projectSkills, 'brief', 'SKILL.md'),
    '---\nname: brief\ndescription: Project brief\naudience: agents\n---\n\nPROJECT\n',
  );
  mkdirSync(join(projectSkills, 'deploy'), { recursive: true });
  writeFileSync(
    join(projectSkills, 'deploy', 'SKILL.md'),
    '---\nname: deploy\ndescription: Project deploy\naudience: agents\n---\n\nDEPLOY\n',
  );

  const project = store.org.createProject({ orgId: org.id, name: 'Rook', path: projectDir });

  for await (const _ of assistant.assign({ agent: 'mara', task: 'go', projectId: project.id })) void _;
  const run = fake.runs.at(-1);
  assert.match(run.systemPrompt, /brief: Project brief/, 'the project skill wins the name clash in the index');
  assert.match(run.systemPrompt, /deploy: Project deploy/, 'a project-only skill is listed too');
  assert.doesNotMatch(run.systemPrompt, /Home brief/);

  const asMara = { orgId: org.id, audience: 'agent', agentId: mara.id, projectId: project.id, depth: 0, emit() {} };
  const opened = await assistant.org.handle(asMara, 'use_skill', { name: 'brief' });
  assert.match(opened.text, /PROJECT/);
  assert.doesNotMatch(opened.text, /HOME/);
  assistant.close();
});

test("a project's MCP servers only start once trust_project_mcp approves them, and a later edit needs approving again", async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  hire(assistant, { name: 'Mara' });
  const ctx = { orgId: org.id, audience: 'assistant', depth: -1, emit() {} };

  const projectDir = mkdtempSync(join(tmpdir(), 'rookery-project-'));
  const mcpFile = join(projectDir, '.mcp.json');
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { docs: { command: 'node', args: ['server.js'] } } }));
  const project = store.org.createProject({ orgId: org.id, name: 'Rook', path: projectDir });

  for await (const _ of assistant.assign({ agent: 'mara', task: 'go', projectId: project.id })) void _;
  assert.equal(fake.runs.at(-1).mcpExtra, undefined, 'untrusted: nothing attached');
  assert.match(fake.runs.at(-1).systemPrompt, /not yet trusted/);

  const pending = await assistant.org.handle(ctx, 'project_mcp_servers', { project: 'Rook' });
  assert.match(pending.text, /Status: pending/);
  assert.match(pending.text, /docs: node server\.js/);

  const approved = await assistant.org.handle(ctx, 'trust_project_mcp', { project: 'Rook', decision: 'approve' });
  assert.match(approved.text, /Trusted "Rook": 1 MCP server/);

  fake.runs.length = 0;
  for await (const _ of assistant.assign({ agent: 'mara', task: 'go', projectId: project.id })) void _;
  assert.deepEqual(fake.runs.at(-1).mcpExtra.map((spec) => spec.name), ['docs'], 'trusted: attached this time');

  // The file changes after approval: the fingerprint no longer matches.
  writeFileSync(
    mcpFile,
    JSON.stringify({ mcpServers: { docs: { command: 'node', args: ['server.js'] }, extra: { command: 'sh' } } }),
  );
  fake.runs.length = 0;
  for await (const _ of assistant.assign({ agent: 'mara', task: 'go', projectId: project.id })) void _;
  assert.equal(fake.runs.at(-1).mcpExtra, undefined, 'changed: back to untrusted');
  assert.match(fake.runs.at(-1).systemPrompt, /changed since it was approved/);

  const revoked = await assistant.org.handle(ctx, 'trust_project_mcp', { project: 'Rook', decision: 'revoke' });
  assert.match(revoked.text, /Revoked trust/);
  assert.equal(store.org.getProject(project.id).mcpTrust, undefined);
  assistant.close();
});

test('chat retains completed and interrupted tool events on the persisted answer', async () => {
  const fake = createFakeProvider();
  const calls = [
    { type: 'tool', name: 'lookup', id: 'one', status: 'start', detail: 'a question' },
    { type: 'tool', name: 'tool', id: 'one', status: 'end', result: 'found', isError: false },
    { type: 'tool', name: 'read', id: 'two', status: 'start', detail: 'notes' },
  ];
  fake.provider.run = async function* () {
    yield* calls;
    yield { type: 'error', message: 'interrupted', fatal: true };
  };
  const { assistant, store } = createAssistant(fake);
  const events = [];
  for await (const event of assistant.chat({ text: 'inspect notes' })) events.push(event);
  const sessionId = events.find((event) => event.type === 'session').sessionId;
  const messages = store.getMessages(sessionId);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1].toolCalls, calls);
  assert.equal(messages[1].content, '');
  assistant.close();
});

/* --------------------------- one entrance, one shape --------------------------- */

/**
 * Every way into the company leaves the same rows behind: a task that opens
 * its own activity with its brief, a run, and the link between task and run
 * (concept 1.1). What differs is who started it, never what is left over.
 */
async function assertOneShape(store, orgId, taskId, label) {
  const task = store.org.getTask(taskId);
  assert.ok(task, label + ': a task exists');
  const events = store.org.listTaskEvents(taskId);
  assert.equal(events[0]?.kind, 'created', label + ': its activity opens with the brief');
  assert.equal(events[0].text, task.description, label + ': which is the description itself');
  assert.ok(events.some((event) => event.kind === 'run-started'), label + ': the run is on the card');
  assert.ok(task.assignmentId, label + ': the task points at its current run');
  const run = store.org.getAssignment(task.assignmentId);
  assert.ok(run, label + ': the run exists');
  assert.equal(store.org.getTaskIdForAssignment(run.id), taskId, label + ': the run is linked to the task');
  assert.equal(store.org.taskRunNumber(run.id), 1, label + ': and it is the first run of it');
  return { task, run };
}

test('every way in leaves the same rows: a task, its activity, a run and the link', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });
  const ctx = { orgId: org.id, audience: 'assistant', depth: -1, emit() {} };

  // 1. The user puts a card up and the board runs it.
  const card = userCard(store, org, { title: 'Ship the parser', description: 'Please ship the parser.', assigneeId: mara.id });
  await assistant.org.runTask(boardContext(org), card);
  const fromBoard = await assertOneShape(store, org.id, card.id, 'board');
  assert.equal(fromBoard.run.title, 'Ship the parser', 'the run inherits the card\'s name');

  // 2. The assistant hands work over with assign.
  const assigned = await assistant.org.handle(ctx, 'assign', {
    agent: mara.slug,
    title: 'Rewrite the token cache',
    task: 'Rewrite the token cache and keep the public API.',
  });
  assert.equal(assigned.isError, undefined);
  const assignTask = store.org
    .listAllTasks(org.id)
    .find((entry) => entry.title === 'Rewrite the token cache');
  const fromAssign = await assertOneShape(store, org.id, assignTask.id, 'assign');
  assert.equal(fromAssign.run.title, 'Rewrite the token cache');

  // 3. create_task followed by run_task.
  const created = await assistant.org.handle(ctx, 'create_task', {
    title: 'Document the cache',
    description: 'Write down how the token cache behaves.',
    assignee: mara.slug,
  });
  assert.equal(created.isError, undefined);
  const boardTask = store.org.listAllTasks(org.id).find((entry) => entry.title === 'Document the cache');
  await assistant.org.handle(ctx, 'run_task', { id: boardTask.id });
  const fromTool = await assertOneShape(store, org.id, boardTask.id, 'create_task');
  assert.equal(fromTool.run.title, 'Document the cache');
  assistant.close();
});

test('assign inside a task hangs the new task under it instead of beside it', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const lead = hire(assistant, { name: 'Lead' });
  hire(assistant, { name: 'Junior', managerId: lead.id });

  const task = userCard(store, org, {
    title: 'Build the importer',
    description: 'ASSIGN:junior|write the row parser',
    assigneeId: lead.id,
  });
  await assistant.org.runTask(boardContext(org), task);

  const children = store.org.listTasks(org.id, { parentId: task.id });
  assert.equal(children.length, 1, 'what the lead handed on is a child of its own task');
  assert.equal(children[0].title, 'write the row parser');
  assert.ok(children[0].assigneeId, 'and it has the junior on it');
  assert.equal(store.org.listTaskEvents(children[0].id)[0].actorAgentId, lead.id, 'opened by the lead that handed it on');
  assistant.close();
});

test('a name is one short line and never the brief itself', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });
  const ctx = { orgId: org.id, audience: 'assistant', depth: -1, emit() {} };

  const brief =
    '# Fix the flaky upload test\n\nThe upload test fails about one run in three. Find out why, ' +
    'fix it, and say what was actually wrong rather than retrying it until it passes. ' +
    'Everything below the first line is detail nobody wants in a list.';
  // No title from the caller: the fallback is the first line, stripped of its
  // heading marker and clamped - never the whole brief.
  await assistant.org.handle(ctx, 'assign', { agent: mara.slug, task: brief, title: '' });
  await sleep(200);

  const run = store.org.listAssignments(org.id, { agentId: mara.id })[0];
  assert.equal(run.title, 'Fix the flaky upload test');
  assert.ok(!run.title.includes('\n'), 'a name is one line');
  assert.ok(run.title.length <= 60, 'and a short one');
  assert.notEqual(run.title, run.task, 'a name is not the brief');

  const overview = await assistant.org.handle(ctx, 'list_assignments', { agent: mara.slug });
  for (const line of overview.text.split('\n')) {
    assert.ok(line.length <= 160, 'no line of the history carries a whole brief');
    assert.ok(!line.includes('nobody wants in a list'), 'the brief stays out of the list');
  }
  assistant.close();
});


test('a promoted retrieval policy reaches the user as a sleep notification', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const announced = [];
  assistant.on('notification', (event) => announced.push(event.notification));

  // What the night hands the hook when it promotes a policy. It used to be a
  // mail from the user to the user, which no push filter ever let through.
  await assistant.announcePromotion({
    owner: 'assistant',
    slot: 'recall',
    version: { id: 'policy-2', version: 2 },
    evaluation: { delta: 0.0312, ciLow: 0.0101, closed: 40, traces: 55 },
    rationale: 'Entity hops found the right memory more often.',
    cooldownUntil: Date.now() + 86_400_000,
    prevActiveId: 'policy-1',
    runId: 'night-7',
  });

  const [note] = store.org.listNotifications({ orgId: org.id });
  assert.equal(note.kind, 'sleep');
  assert.equal(note.fromKind, 'system');
  assert.equal(note.title, 'Retrieval policy recall v2 is in force');
  assert.match(note.body, /Entity hops found the right memory more often\./);
  assert.match(note.body, /undo sleep run night-7/);
  assert.deepEqual(announced.map((entry) => entry.id), [note.id], 'announced, so a push channel can carry it');
  assistant.close();
});
