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
        // A scripted answer that goes out as mail: the turn writes to
        // somebody with send_mail and then ends on a line about having done
        // so - the shape that used to deliver the answer twice.
        const mailed = prompt.match(/MAILBACK:([\w-]+)\|([^\n]+)/);
        if (mailed && opts.mcp) {
          await bridgeCall(opts.mcp.env.ROOKERY_BRIDGE_PATH, opts.mcp.env.ROOKERY_BRIDGE_TOKEN, 'call', {
            name: 'send_mail',
            args: { to: mailed[1], subject: 'Answer', body: mailed[2] },
          });
          const text = 'Done - the reply went out.';
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

test('mail follows the chain of command and lands in mailboxes', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const lead = hire(assistant, { name: 'Lead' });
  const junior = hire(assistant, { name: 'Junior', managerId: lead.id });
  const stranger = hire(assistant, { name: 'Stranger' });
  const asJunior = { orgId: org.id, audience: 'agent', agentId: junior.id, depth: 1, emit() {} };

  assert.equal((await assistant.org.handle(asJunior, 'send_mail', { to: stranger.slug, subject: 'hi', body: 'hi' })).isError, true);
  // Cc'ing the lead only delivers - it must not start a real run for them.
  assert.equal((await assistant.org.handle(asJunior, 'send_mail', { to: 'assistant', cc: lead.slug, subject: 'done', body: 'done' })).isError, undefined);
  assert.equal((await assistant.org.handle(asJunior, 'send_mail', { to: 'assistant', subject: 'fyi', body: 'fyi' })).isError, undefined);

  assert.equal(store.org.mailbox(org.id, { kind: 'agent', id: lead.id }, 'inbox', { unreadOnly: true }).length, 1);
  // Not `unreadOnly`: mail to the assistant wakes it, and the turn it runs
  // reads its own mailbox on the way through.
  assert.equal(store.org.mailbox(org.id, { kind: 'assistant' }, 'inbox').length, 2);

  const asLead = { orgId: org.id, audience: 'agent', agentId: lead.id, depth: 0, emit() {} };
  const mail = await assistant.org.handle(asLead, 'read_mail', {});
  assert.match(mail.text, /done/);
  assert.equal(store.org.mailbox(org.id, { kind: 'agent', id: lead.id }, 'inbox', { unreadOnly: true }).length, 0, 'reading marks as read');
  assert.equal(store.org.listAssignments(org.id, { agentId: lead.id }).length, 0, 'a cc never starts a run');
  assistant.close();
});

test('mailing an agent\'s To triggers a real run whose result returns as a reply mail', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });
  const ctx = { orgId: org.id, audience: 'assistant', depth: -1, emit() {} };

  const sent = await assistant.org.handle(ctx, 'send_mail', { to: mara.slug, subject: 'Ping', body: 'Please pong.' });
  assert.equal(sent.isError, undefined);
  await sleep(80);

  const assignments = store.org.listAssignments(org.id, { agentId: mara.id });
  assert.equal(assignments.length, 1, 'the To agent got a real run');
  assert.equal(assignments[0].status, 'done');

  const inbox = store.org.mailbox(org.id, { kind: 'assistant' }, 'inbox');
  const reply = inbox.find((entry) => entry.subject.startsWith('Re:'));
  assert.ok(reply, 'the finished run replied by mail');
  assert.equal(reply.fromKind, 'agent');
  assert.equal(reply.fromAgentId, mara.id);
  assert.match(reply.body, /OUTPUT/);

  const original = store.org.mailbox(org.id, { kind: 'agent', id: mara.id }, 'inbox')[0];
  assert.equal(reply.threadId, original.threadId, 'the reply stays in the original thread');
  assistant.close();
});

test('a reply keeps whoever was Cc on the mail it answers', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });
  const ctx = { orgId: org.id, audience: 'assistant', depth: -1, emit() {} };

  // The assistant asks Mara something and copies the user in.
  const sent = await assistant.org.handle(ctx, 'send_mail', {
    to: mara.slug,
    cc: 'user',
    subject: 'Ping',
    body: 'Please pong.',
  });
  assert.equal(sent.isError, undefined);
  await sleep(120);

  const reply = store.org.mailbox(org.id, { kind: 'user' }, 'inbox').find((entry) => entry.subject.startsWith('Re:'));
  assert.ok(reply, 'the answer reached the user, who was only on Cc');
  assert.equal(reply.fromAgentId, mara.id);
  const to = reply.recipients.filter((entry) => entry.box === 'to').map((entry) => entry.recipientKind);
  const cc = reply.recipients.filter((entry) => entry.box === 'cc').map((entry) => entry.recipientKind);
  assert.deepEqual(to, ['assistant'], 'the answer is addressed to whoever asked');
  assert.deepEqual(cc, ['user'], 'and everyone else on the mail stays on it');
  assistant.close();
});

test('a turn that answers mail with send_mail does not also deliver its closing text', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();

  await assistant.org.sendUserMail({
    orgId: org.id,
    to: ['assistant'],
    subject: 'A question',
    body: 'MAILBACK:user|Here is the answer you asked for.',
  });
  await sleep(200);

  const inbox = store.org.mailbox(org.id, { kind: 'user' }, 'inbox');
  assert.equal(inbox.length, 1, 'one answer, not an answer plus a note about it');
  assert.match(inbox[0].body, /Here is the answer/);
  assert.ok(
    !inbox.some((entry) => /the reply went out/.test(entry.body)),
    'the turn\'s bookkeeping line never becomes a mail of its own',
  );
  assistant.close();
});

test('a thread keeps the kind it opened with, and replies inherit it', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });

  const chat = store.org.sendMail({ orgId: org.id, from: { kind: 'user' }, to: [{ kind: 'assistant' }], subject: 'hello', body: 'hello' });
  const report = store.org.sendMail({
    orgId: org.id,
    from: { kind: 'agent', id: mara.id },
    to: [{ kind: 'user' }],
    subject: 'status',
    body: 'status',
  });
  assert.equal(store.org.getMailThread(org.id, chat.threadId).kind, 'chat', 'a user mail opens a chat');
  assert.equal(store.org.getMailThread(org.id, report.threadId).kind, 'report', "an agent's mail opens a report");

  store.org.sendMail({
    orgId: org.id,
    from: { kind: 'user' },
    to: [{ kind: 'agent', id: mara.id }],
    subject: 'Re: status',
    body: 'nice',
    inReplyTo: report.id,
    threadId: report.threadId,
  });
  assert.equal(store.org.getMailThread(org.id, report.threadId).kind, 'report', "the reply inherits the thread's kind");
  assert.equal(store.org.getMail(chat.id).threadKind, 'chat');
  assert.equal(store.org.getMail(report.id).threadKind, 'report');
  assistant.close();
});

test('a task mail becomes one task, one run, and one answer in the Aufgaben folder', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });

  const { mail, task } = await assistant.org.sendTaskMail({
    orgId: org.id,
    to: mara.slug,
    subject: 'Ship the thing',
    body: 'Please ship it.',
  });
  assert.equal(task.title, 'Ship the thing');
  assert.equal(task.assigneeId, mara.id);
  assert.equal(task.createdBy, 'user');
  await sleep(150);

  const thread = store.org.getMailThreadForTask(org.id, task.id);
  assert.ok(thread, 'the task is linked to the thread it was born in');
  assert.equal(thread.threadId, mail.threadId);
  assert.equal(thread.kind, 'assignment');

  assert.equal(
    store.org.listAssignments(org.id, { agentId: mara.id }).length,
    1,
    'exactly one run - the To trigger must not fire beside the task run',
  );

  const reply = store.org
    .mailbox(org.id, { kind: 'user' }, 'inbox', { folder: 'tasks' })
    .find((entry) => entry.fromKind === 'agent');
  assert.ok(reply, "the run's answer landed in the thread");
  assert.equal(reply.threadId, mail.threadId);
  assert.equal(store.org.getMail(reply.id).taskId, task.id);
  assert.equal(store.org.getMail(reply.id).taskTitle, task.title);

  assert.ok(
    store.org.mailbox(org.id, { kind: 'agent', id: mara.id }, 'inbox', { folder: 'tasks' }).some((entry) => entry.id === mail.id),
    "the work order lands in the agent's Aufgaben folder",
  );
  // The plain inbox is the superset - everything unarchived - so the work
  // order shows there too; Aufgaben is the slice, not a partition.
  assert.ok(
    store.org.mailbox(org.id, { kind: 'agent', id: mara.id }, 'inbox', { folder: 'inbox' }).some((entry) => entry.id === mail.id),
    'and stays visible in the plain inbox, which is everything unarchived',
  );
  assistant.close();
});

test('folders route reports, and archiving moves a thread whole', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });
  const who = { kind: 'user' };

  const report = store.org.sendMail({
    orgId: org.id,
    from: { kind: 'agent', id: mara.id },
    to: [{ kind: 'user' }],
    subject: 'Weekly report',
    body: 'numbers',
  });
  store.org.sendMail({
    orgId: org.id,
    from: { kind: 'user' },
    to: [{ kind: 'agent', id: mara.id }],
    subject: 'Re: Weekly report',
    body: 'thanks',
    inReplyTo: report.id,
    threadId: report.threadId,
  });

  assert.ok(
    store.org.mailbox(org.id, who, 'inbox', { folder: 'reports' }).some((entry) => entry.id === report.id),
    'an agent thread lands under Berichte',
  );
  assert.ok(
    !store.org.mailbox(org.id, who, 'inbox', { folder: 'tasks' }).some((entry) => entry.id === report.id),
    'and nowhere else',
  );

  store.org.archiveMailThread(org.id, report.threadId, true);
  assert.ok(
    !store.org.mailbox(org.id, who, 'inbox', { folder: 'reports' }).some((entry) => entry.id === report.id),
    'archiving empties the live folder',
  );
  assert.equal(
    store.org.mailbox(org.id, who, 'inbox', { folder: 'archiv' }).length,
    1,
    'the report moved - the reply, addressed to Mara, was never in this inbox',
  );
  assert.equal(store.org.unreadMailFor(org.id, who).length, 0, 'archived mail never counts as waiting');
  assistant.close();
});

test('every writer moves a task the same way: the tool tells the thread, and reopening clears the last life', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });

  const task = store.org.createTask({
    orgId: org.id,
    title: 'Fix the gate',
    description: 'Please fix it.',
    assigneeId: mara.id,
    createdBy: 'user',
  });
  const order = store.org.sendMail({
    orgId: org.id,
    from: { kind: 'user' },
    to: [{ kind: 'agent', id: mara.id }],
    subject: 'Fix the gate',
    body: 'Please fix it.',
    kind: 'assignment',
  });
  store.org.linkMailThreadTask(org.id, order.threadId, task.id);

  // Closing it through the tool. This is the writer that used to move the
  // card in silence: no event, and nothing said in the thread, so whoever
  // was waiting there waited for good.
  const ctx = { orgId: org.id, audience: 'assistant', depth: -1, emit() {} };
  const closed = await assistant.org.handle(ctx, 'update_task', {
    id: task.id,
    status: 'done',
    result: 'The hinge was loose.',
  });
  assert.equal(closed.isError, undefined);

  const note = store.org.thread(org.id, order.threadId).at(-1);
  // The note carries the work now, not just the fact that something moved.
  assert.match(note.body, /is done/, 'the thread hears it from the tool too');
  assert.match(note.body, /The hinge was loose\./, 'and it carries the result, not a pointer to it');

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

test('marking a task done by hand tells a thread that heard nothing, and wakes nobody', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });

  // A work order that was never run: the thread has the order and nothing
  // else, so the hand change is the only news it will ever get.
  const task = store.org.createTask({
    orgId: org.id,
    title: 'Fix the gate',
    description: 'Please fix it.',
    assigneeId: mara.id,
    createdBy: 'user',
  });
  const order = store.org.sendMail({
    orgId: org.id,
    from: { kind: 'user' },
    to: [{ kind: 'agent', id: mara.id }],
    subject: 'Fix the gate',
    body: 'Please fix it.',
    kind: 'assignment',
  });
  store.org.linkMailThreadTask(org.id, order.threadId, task.id);

  await assistant.org.notifyTaskStatus(store.org.getTask(task.id), 'done');

  const note = store.org.thread(org.id, order.threadId).at(-1);
  assert.equal(note.fromKind, 'assistant', 'the status note is a system mail');
  assert.match(note.body, /is done/);
  assert.equal(
    store.org.listAssignments(org.id, { agentId: mara.id }).length,
    0,
    'a status note starts nothing',
  );
  assistant.close();
});

test('a reply in a task thread continues the same task instead of running beside it', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });

  const { mail, task } = await assistant.org.sendTaskMail({
    orgId: org.id,
    to: mara.slug,
    subject: 'Ship the thing',
    body: 'Please ship it.',
  });
  await sleep(200);
  assert.equal(store.org.listAssignments(org.id, { agentId: mara.id }).length, 1, 'the work order ran once');

  await assistant.org.sendUserMail({
    orgId: org.id,
    to: [mara.slug],
    subject: 'Re: Ship the thing',
    body: 'One more thing before you do.',
    inReplyTo: mail.id,
  });
  await sleep(300);

  const runs = store.org.listAssignments(org.id, { agentId: mara.id });
  assert.equal(runs.length, 2, 'the reply started exactly one more run');
  for (const run of runs) {
    assert.equal(
      store.org.getTaskIdForAssignment(run.id),
      task.id,
      'every run in the thread hangs on the same task - no board-less run beside it',
    );
  }
  assert.ok(
    runs.some((run) => (run.task ?? '').includes('One more thing before you do.')),
    'the continued run was briefed with the mail that continued it',
  );
  assistant.close();
});

test('a task that ends failed leaves a status note in its thread', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });

  const { task } = await assistant.org.sendTaskMail({
    orgId: org.id,
    to: mara.slug,
    subject: 'Fix the gate',
    body: 'FAIL - this run goes nowhere.',
  });
  await sleep(250);

  assert.equal(store.org.getTask(task.id).status, 'failed');
  const thread = store.org.getMailThreadForTask(org.id, task.id);
  const note = store.org.thread(org.id, thread.threadId).at(-1);
  assert.equal(note.fromKind, 'assistant', 'a failure the thread would otherwise never hear about');
  assert.match(note.body, /failed/);
  assistant.close();
});

test('an agent that asks its assigner on To leaves the task blocked, not done', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });

  const { task } = await assistant.org.sendTaskMail({
    orgId: org.id,
    to: mara.slug,
    subject: 'Fix the gate',
    body: 'MAILBACK:user|Which gate do you mean?',
  });
  await sleep(250);

  const current = store.org.getTask(task.id);
  assert.equal(current.status, 'blocked', 'a run that ended with a question is waiting, not finished');
  const thread = store.org.getMailThreadForTask(org.id, task.id);
  const mails = store.org.thread(org.id, thread.threadId);
  assert.equal(mails.at(-1).fromKind, 'agent', 'the question itself is the last word in the thread');
  assert.ok(
    !mails.some((entry) => entry.fromKind === 'assistant'),
    'and it is the message - no status note repeats it',
  );

  // And the answer puts the very same task back to work instead of opening
  // a second one beside it.
  await assistant.org.sendUserMail({
    orgId: org.id,
    to: [mara.slug],
    subject: 'Re: Fix the gate',
    body: 'The north gate.',
    inReplyTo: mails.at(-1).id,
  });
  await sleep(300);
  const runs = store.org.listAssignments(org.id, { agentId: mara.id });
  assert.equal(runs.length, 2, 'the answer started the next run of the task');
  for (const run of runs) assert.equal(store.org.getTaskIdForAssignment(run.id), task.id);
  assistant.close();
});

test('a task that ends done with a result reply gets no status note on top', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });

  const { task } = await assistant.org.sendTaskMail({
    orgId: org.id,
    to: mara.slug,
    subject: 'Ship the thing',
    body: 'Please ship it.',
  });
  await sleep(250);

  assert.equal(store.org.getTask(task.id).status, 'done');
  const thread = store.org.getMailThreadForTask(org.id, task.id);
  const mails = store.org.thread(org.id, thread.threadId);
  assert.equal(mails.length, 2, 'the work order and the answer, nothing else');
  assert.equal(mails.at(-1).fromKind, 'agent', 'the result is the message');
  assistant.close();
});

test('a mailed task that splits answers once, with the combined result', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });
  const noah = hire(assistant, { name: 'Noah' });

  const parent = store.org.createTask({ orgId: org.id, title: 'Big thing', description: 'Split me.', createdBy: 'user' });
  store.org.createTask({ orgId: org.id, title: 'Part one', parentId: parent.id, assigneeId: mara.id, createdBy: 'user' });
  store.org.createTask({ orgId: org.id, title: 'Part two', parentId: parent.id, assigneeId: noah.id, createdBy: 'user' });
  const mail = store.org.sendMail({
    orgId: org.id,
    from: { kind: 'user' },
    to: [{ kind: 'agent', id: mara.id }],
    subject: 'Big thing',
    body: 'Split me.',
    kind: 'assignment',
  });
  store.org.linkMailThreadTask(org.id, mail.threadId, parent.id);

  await assistant.org.runTask(
    {
      orgId: org.id,
      audience: 'assistant',
      depth: -1,
      emit() {},
      sourceMail: { id: mail.id, threadId: mail.threadId, depth: 0, fromKind: 'user', subject: mail.subject },
    },
    store.org.getTask(parent.id),
  );
  await sleep(250);

  const answers = store.org
    .mailbox(org.id, { kind: 'user' }, 'inbox', { folder: 'tasks' })
    .filter((entry) => entry.fromKind === 'assistant');
  assert.equal(answers.length, 1, 'one combined answer, not one per subtask');
  assert.match(answers[0].body, /Part one/);
  assert.match(answers[0].body, /Part two/);
  assistant.close();
});

test('a colleague on To inside a task thread still gets a run of their own', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });
  const noah = hire(assistant, { name: 'Noah', managerId: mara.id });

  // Mara writes to Noah while working the task. The mail answers nothing, so
  // it inherits the task's own thread - and the task must not swallow it:
  // whoever is on To and is neither doing this task nor asked for it is
  // being asked for something new.
  const { task } = await assistant.org.sendTaskMail({
    orgId: org.id,
    to: mara.slug,
    subject: 'Build the importer',
    body: 'MAILBACK:noah|Can you check the index?',
  });
  await sleep(500);

  const asked = store.org.listAssignments(org.id, { agentId: noah.id });
  assert.equal(asked.length, 1, 'the colleague on To was woken');
  assert.match(asked[0].task, /Can you check the index\?/, 'and briefed with what was asked');
  assert.equal(
    store.org.listAssignments(org.id, { agentId: mara.id }).length,
    1,
    'while the task itself ran exactly once',
  );
  assert.equal(store.org.getTask(task.id).status, 'done');
  assistant.close();
});

test('a task cancelled by hand after it ran still tells its thread', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });

  const { task } = await assistant.org.sendTaskMail({
    orgId: org.id,
    to: mara.slug,
    subject: 'Ship the thing',
    body: 'Please ship it.',
  });
  await sleep(250);
  assert.equal(store.org.getTask(task.id).status, 'done', 'the run answered the thread');

  // Hours later, by hand. The old answer belongs to the run that is over; it
  // says nothing about this ending, so this ending gets its own note.
  store.org.updateTask(task.id, { status: 'cancelled' });
  await assistant.org.notifyTaskStatus(store.org.getTask(task.id), 'cancelled');

  const thread = store.org.getMailThreadForTask(org.id, task.id);
  const mails = store.org.thread(org.id, thread.threadId);
  assert.equal(mails.length, 3, 'the work order, the answer, and the note about the cancellation');
  assert.equal(mails.at(-1).fromKind, 'assistant');
  assert.match(mails.at(-1).body, /was cancelled/);
  assistant.close();
});

test('a task the assistant handed out tells its thread when it fails', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });

  // Nobody mailed this one in: the work order is written by the assistant,
  // and a run starts a handful of statements later - the same millisecond as
  // often as not. The window this ending is judged against therefore opens
  // on the work order itself, which is exactly what must not count as the
  // thread having heard how the work ended.
  const task = store.org.createTask({
    orgId: org.id,
    title: 'Rewrite the token cache',
    description: 'Make it expire properly.',
    assigneeId: mara.id,
    createdBy: 'assistant',
  });
  const order = store.org.sendMail({
    orgId: org.id,
    from: { kind: 'assistant' },
    to: [{ kind: 'agent', id: mara.id }],
    subject: task.title,
    body: task.description,
    kind: 'assignment',
  });
  store.org.linkMailThreadTask(org.id, order.threadId, task.id);
  store.org.updateTask(task.id, { status: 'failed', error: 'boom' });

  await assistant.org.notifyTaskStatus(store.org.getTask(task.id), 'failed', order.createdAt);

  const mails = store.org.thread(org.id, order.threadId);
  assert.equal(mails.length, 2, 'the work order and the note about the failure');
  assert.equal(mails.at(-1).fromKind, 'assistant');
  assert.match(mails.at(-1).body, /failed/);
  assistant.close();
});

test('a delegated task reports back to the agent who ordered it, not to the user', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const victor = hire(assistant, { name: 'Victor' });
  const mara = hire(assistant, { name: 'Mara' });

  // What `assign` builds: one agent opens a task for another. The user never
  // ordered this and must not be handed a receipt for it.
  const task = store.org.createTask({
    orgId: org.id,
    title: 'Raise the upload limit',
    description: 'Ten megabytes is not enough.',
    assigneeId: mara.id,
    createdBy: 'agent',
    createdByAgentId: victor.id,
  });
  const order = store.org.sendMail({
    orgId: org.id,
    from: { kind: 'agent', id: victor.id },
    to: [{ kind: 'agent', id: mara.id }],
    subject: task.title,
    body: task.description,
    kind: 'assignment',
  });
  store.org.linkMailThreadTask(org.id, order.threadId, task.id);
  store.org.updateTask(task.id, { status: 'failed', error: 'boom' });

  await assistant.org.notifyTaskStatus(store.org.getTask(task.id), 'failed', order.createdAt);

  const note = store.org.thread(org.id, order.threadId).at(-1);
  assert.match(note.body, /failed/, 'the thread still hears how it ended');
  const to = note.recipients.filter((entry) => entry.box === 'to');
  assert.equal(to.length, 1);
  assert.equal(to[0].recipientKind, 'agent');
  assert.equal(to[0].recipientId, victor.id, 'the note goes to whoever asked for the work');
  assert.ok(
    !note.recipients.some((entry) => entry.recipientKind === 'user' && entry.box === 'to'),
    'the user is not on To for a task they never ordered',
  );
  assistant.close();
});

test('a task the user ordered still reports to the user', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });

  const task = store.org.createTask({
    orgId: org.id,
    title: 'Raise the upload limit',
    description: 'Ten megabytes is not enough.',
    assigneeId: mara.id,
    createdBy: 'user',
  });
  const order = store.org.sendMail({
    orgId: org.id,
    from: { kind: 'user' },
    to: [{ kind: 'agent', id: mara.id }],
    subject: task.title,
    body: task.description,
    kind: 'assignment',
  });
  store.org.linkMailThreadTask(org.id, order.threadId, task.id);
  store.org.updateTask(task.id, { status: 'failed', error: 'boom' });

  await assistant.org.notifyTaskStatus(store.org.getTask(task.id), 'failed', order.createdAt);

  const note = store.org.thread(org.id, order.threadId).at(-1);
  const to = note.recipients.filter((entry) => entry.box === 'to');
  assert.equal(to.length, 1);
  assert.equal(to[0].recipientKind, 'user');
  assistant.close();
});

test('the board says what a blocked task waits for', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });
  const ctx = { orgId: org.id, audience: 'assistant', depth: -1, emit() {} };

  const task = store.org.createTask({
    orgId: org.id,
    title: 'Fix the gate',
    description: 'Please fix it.',
    assigneeId: mara.id,
    createdBy: 'user',
  });
  const question = store.org.sendMail({
    orgId: org.id,
    from: { kind: 'agent', id: mara.id },
    to: [{ kind: 'user' }],
    subject: 'Which delimiter do these files use?',
    body: 'Tab or semicolon?',
    kind: 'assignment',
  });
  store.org.linkMailThreadTask(org.id, question.threadId, task.id);
  store.org.updateTask(task.id, { status: 'blocked' });

  const board = await assistant.org.handle(ctx, 'list_tasks', { status: '' });
  assert.match(board.text, /BLOCKED/);
  assert.match(board.text, /waiting \d+[mhd]/, 'how long it has stood there');
  assert.match(board.text, /Which delimiter do these files use\?/, 'and what it is waiting on');
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
 * Every way into the company leaves the same rows behind: a task, the mail
 * thread it is negotiated in, a run, and the link between task and run
 * (concept 1.1). What differs is who started it, never what is left over.
 */
async function assertOneShape(store, orgId, taskId, label) {
  const task = store.org.getTask(taskId);
  assert.ok(task, label + ': a task exists');
  const thread = store.org.getMailThreadForTask(orgId, taskId);
  assert.ok(thread, label + ': the task has a mail thread');
  assert.equal(thread.kind, 'assignment', label + ': and that thread is a task thread');
  assert.ok(task.assignmentId, label + ': the task points at its current run');
  const run = store.org.getAssignment(task.assignmentId);
  assert.ok(run, label + ': the run exists');
  assert.equal(store.org.getTaskIdForAssignment(run.id), taskId, label + ': the run is linked to the task');
  assert.equal(store.org.taskRunNumber(run.id), 1, label + ': and it is the first run of it');
  return { task, run };
}

test('all four ways in leave the same rows: a task, its thread, a run and the link', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, { name: 'Mara' });
  const ctx = { orgId: org.id, audience: 'assistant', depth: -1, emit() {} };

  // 1. Compose with exactly one agent on To - no mode, no switch.
  const composed = await assistant.org.sendUserMail({
    orgId: org.id,
    to: [mara.slug],
    subject: 'Ship the parser',
    body: 'Please ship the parser.',
  });
  assert.ok(composed.task, 'one agent on To opens a task');
  await sleep(200);
  const mailBorn = await assertOneShape(store, org.id, composed.task.id, 'mail');
  assert.equal(mailBorn.task.title, 'Ship the parser', 'the subject is the name');
  assert.equal(mailBorn.run.title, 'Ship the parser', 'and the run inherits it');

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
  const fromBoard = await assertOneShape(store, org.id, boardTask.id, 'board');
  assert.equal(fromBoard.run.title, 'Document the cache');

  // 4. A conversation is the exception that proves the rule: several people
  //    on To wake the agents among them and leave no card at all (E3).
  const before = store.org.listAllTasks(org.id).length;
  const conversation = await assistant.org.sendUserMail({
    orgId: org.id,
    to: [mara.slug, 'assistant'],
    subject: 'What do you two think',
    body: 'Two of you, one question.',
  });
  await sleep(200);
  assert.equal(conversation.task, undefined, 'two on To is a conversation');
  assert.equal(store.org.getMailThread(org.id, conversation.mail.threadId).kind, 'chat');
  assert.equal(store.org.listAllTasks(org.id).length, before, 'and it creates no card');
  assistant.close();
});

test('assign inside a task hangs the new task under it instead of beside it', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const lead = hire(assistant, { name: 'Lead' });
  hire(assistant, { name: 'Junior', managerId: lead.id });

  const { task } = await assistant.org.sendTaskMail({
    orgId: org.id,
    to: lead.slug,
    subject: 'Build the importer',
    body: 'ASSIGN:junior|write the row parser',
  });
  await sleep(400);

  const children = store.org.listTasks(org.id, { parentId: task.id });
  assert.equal(children.length, 1, 'what the lead handed on is a child of its own task');
  assert.equal(children[0].title, 'write the row parser');
  assert.ok(children[0].assigneeId, 'and it has the junior on it');
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

/* ------------------------------- roleplay ------------------------------- */

test('a mail-born run is told to answer as a letter, result first, in its own voice', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, {
    name: 'Mara',
    voice: 'Warm and precise; short sentences, never hedges.',
  });

  await assistant.org.sendTaskMail({
    orgId: org.id,
    to: mara.slug,
    subject: 'Ship the thing',
    body: 'Please ship it.',
  });
  await sleep(150);

  const run = fake.runs.find((entry) => entry.prompt.startsWith('TASK: Ship the thing'));
  assert.ok(run, 'the mail-born run happened');
  assert.match(run.systemPrompt, /a short salutation, one sentence of context/);
  assert.match(run.systemPrompt, /The result stands in the first paragraph/);
  assert.match(run.systemPrompt, /in your own voice: Warm and precise; short sentences, never hedges\./);
  assert.doesNotMatch(
    run.systemPrompt,
    /lead with the result, then what you changed or found/,
    'the report register is replaced, not doubled up alongside the letter one',
  );
  assert.equal(store.org.getAssignment(store.org.listAssignments(org.id, { agentId: mara.id })[0].id).status, 'done');
  assistant.close();
});

test('an assign-born run keeps the plain report register, no letter', async () => {
  const fake = createFakeProvider();
  const { assistant } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, {
    name: 'Mara',
    voice: 'Warm and precise; short sentences, never hedges.',
  });
  const ctx = { orgId: org.id, audience: 'assistant', depth: -1, emit() {} };

  await assistant.org.handle(ctx, 'assign', { agent: mara.slug, task: 'Write the parser', title: 'Write the parser' });
  await sleep(200);

  const run = fake.runs.find((entry) => entry.prompt.startsWith('Write the parser'));
  assert.ok(run, 'the assign-born run happened');
  assert.match(run.systemPrompt, /lead with the result, then what you changed or found/);
  assert.doesNotMatch(run.systemPrompt, /a short salutation, one sentence of context/);
  assistant.close();
});

test('org.roleplay off restores the plain report register even for a mail-born run', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake, { org: { autoReview: false, roleplay: false } });
  const org = assistant.org.activeOrganization();
  const mara = hire(assistant, {
    name: 'Mara',
    voice: 'Warm and precise; short sentences, never hedges.',
  });

  await assistant.org.sendTaskMail({
    orgId: org.id,
    to: mara.slug,
    subject: 'Ship the thing',
    body: 'Please ship it.',
  });
  await sleep(150);

  const run = fake.runs.find((entry) => entry.prompt.startsWith('TASK: Ship the thing'));
  assert.ok(run, 'the mail-born run happened');
  assert.match(run.systemPrompt, /lead with the result, then what you changed or found/);
  assert.doesNotMatch(run.systemPrompt, /a short salutation, one sentence of context/);
  assistant.close();
});
