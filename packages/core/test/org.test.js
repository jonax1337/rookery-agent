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

function createAssistant(fake, overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'rookery-org-'));
  mkdirSync(join(home, 'run'), { recursive: true });
  const store = new Store(':memory:');
  const assistant = new Assistant({
    store,
    registry: new ProviderRegistry([fake.provider]),
    config: { home, logLevel: 'silent', memory: { enabled: false, autoExtract: false }, ...overrides },
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
  assert.match(done.text, /OUTPUT\(write the parser\)/);
  assert.match(done.text, /Report from Ben \(ben\)/);
  const views = events.filter((event) => event.type === 'assignment').map((event) => event.assignment);
  assert.ok(views.some((view) => view.agentSlug === 'mara' && view.status === 'done'));
  assert.ok(views.some((view) => view.agentSlug === 'ben' && view.status === 'running'));
  assert.equal(fake.maxActive, 3, 'both agents ran while the assistant turn was still open');
  const stored = store.org.listAssignments(mara.orgId);
  assert.equal(stored.length, 2);
  assert.ok(stored.every((a) => a.status === 'done' && a.requesterKind === 'assistant'));
  const agentRun = fake.runs.find((run) => run.prompt === 'write the parser');
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

test('the assistant can hire and structure the company through tools', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
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
  const { assistant } = createAssistant(fake, { org: { maxConcurrentAssignments: 1 } });
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
  assert.match(cancelled.text, /Cancelling/);
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
  assert.match(settings.text, /Parallel assignments: 2/);
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
