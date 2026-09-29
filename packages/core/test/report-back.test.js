import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Assistant, ProviderRegistry, Store, reportBackNotice } from '../dist/index.js';

/**
 * Whoever hands work off in the background hears how it ended
 * (docs/concepts/delegation-report-back-and-chat-terminal.md, R1-R4).
 *
 * The fake provider scripts delegation the way the real bridge executable
 * would: `ASSIGN:<slug>|<task>` calls `assign` and waits, `ASSIGNBG:` calls it
 * with `wait: false`. A prompt carrying the report-back continuation note
 * answers with what came back, so a nested chain can be followed end to end.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(20);
  }
  throw new Error('Timed out waiting for ' + what);
}

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

function createFakeProvider({ delay = 20 } = {}) {
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
        // A task picked back up with what its handed-off work returned.
        if (prompt.includes('has come back')) {
          const back = prompt.match(/OUTPUT\([^)]*\)/g) ?? [];
          const text = 'FINAL with ' + back.join(', ');
          yield { type: 'text', delta: text };
          yield { type: 'done', text };
          return;
        }
        const calls = [...prompt.matchAll(/ASSIGN(BG)?:([\w-]+)\|([^\n]+)/g)];
        if (calls.length && opts.mcp) {
          const results = [];
          for (const [, background, agent, task] of calls) {
            results.push(
              await bridgeCall(opts.mcp.env.ROOKERY_BRIDGE_PATH, opts.mcp.env.ROOKERY_BRIDGE_TOKEN, 'call', {
                name: 'assign',
                args: { agent, task, ...(background ? { wait: false } : {}) },
              }),
            );
          }
          const text = 'DELEGATED: ' + results.map((result) => result.text).join(' || ');
          yield { type: 'text', delta: text };
          yield { type: 'done', text };
          return;
        }
        if (prompt.includes('FAIL')) {
          yield { type: 'error', message: 'boom', fatal: true };
          return;
        }
        await sleep(prompt.includes('SLOW') ? delay * 5 : delay);
        const text = 'OUTPUT(' + prompt.slice(0, 40).replace(/[()]/g, '') + ')';
        yield { type: 'text', delta: text };
        yield { type: 'done', text };
      } finally {
        active -= 1;
      }
    },
  };
  return { provider, runs, get maxActive() { return maxActive; } };
}

const open = [];
after(() => {
  for (const assistant of open) {
    try {
      assistant.close();
    } catch {
      // closed already
    }
  }
});

function createAssistant(fake) {
  const home = mkdtempSync(join(tmpdir(), 'rookery-report-back-'));
  mkdirSync(join(home, 'run'), { recursive: true });
  const assistant = new Assistant({
    store: new Store(':memory:'),
    registry: new ProviderRegistry([fake.provider]),
    config: { home, logLevel: 'silent', memory: { enabled: false, autoExtract: false }, org: { autoReview: false } },
  });
  open.push(assistant);
  return assistant;
}

function hire(assistant, input) {
  const org = assistant.org.activeOrganization();
  return assistant.store.org.createAgent({ orgId: org.id, instructions: 'Do the work.', title: 'Engineer', ...input });
}

async function drain(events) {
  const out = [];
  for await (const event of events) out.push(event);
  return out;
}

test('work handed off in the background comes back as a turn in the same conversation', async () => {
  const fake = createFakeProvider();
  const assistant = createAssistant(fake);
  hire(assistant, { name: 'Dev' });
  const followUps = [];
  assistant.on('follow-up', (event) => followUps.push(event));

  const first = await drain(assistant.chat({ text: 'ASSIGNBG:dev|write the report' }));
  const done = first.find((event) => event.type === 'done');
  assert.match(done.text, /a message arrives in this conversation/, 'the tool promises what the code does');
  const sessionId = first.find((event) => event.type === 'session').sessionId;

  const messages = await waitFor(() => {
    const rows = assistant.store.getMessages(sessionId);
    return rows.length >= 4 ? rows : null;
  }, 'the report-back turn');
  assert.deepEqual(messages.map((row) => row.role), ['user', 'assistant', 'system', 'assistant']);
  const notice = messages[2].content;
  assert.match(notice, /^\[Rookery\] Background task [0-9a-f]{8} ".*", handed to Dev \(dev\), is done/);
  assert.match(notice, /OUTPUT\(write the report/, 'the report travels with it');
  assert.match(notice, /comes from the system, not from your user/);
  // The follow-up is a turn of the assistant's own, fed the notice.
  assert.match(fake.runs.at(-1).prompt, /\[Rookery\] Background task/);
  assert.equal(followUps.length, 1, 'exactly one report-back');
  assert.equal(followUps[0].sessionId, sessionId);
  assert.ok(followUps[0].text.length > 0);

  // Nothing further arrives: the ending was reported once.
  await sleep(200);
  assert.equal(assistant.store.getMessages(sessionId).length, 4);
  const session = assistant.store.getSession(sessionId);
  assert.doesNotMatch(session.title, /Rookery\] Background/, 'a system line never titles the conversation');
});

test('a caller that waited for the result gets no report-back on top', async () => {
  const fake = createFakeProvider();
  const assistant = createAssistant(fake);
  hire(assistant, { name: 'Dev' });
  const followUps = [];
  assistant.on('follow-up', (event) => followUps.push(event));

  const events = await drain(assistant.chat({ text: 'ASSIGN:dev|write the report' }));
  const sessionId = events.find((event) => event.type === 'session').sessionId;
  assert.match(events.find((event) => event.type === 'done').text, /Report from Dev/);
  await sleep(250);
  assert.equal(followUps.length, 0);
  assert.deepEqual(
    assistant.store.getMessages(sessionId).map((row) => row.role),
    ['user', 'assistant'],
  );
  const task = assistant.store.org.listTasks(assistant.org.activeOrganization().id, { anyLevel: true })[0];
  assert.equal(task.requesterSessionId, sessionId, 'the card still knows where it came from');
});

test('a failed background task is reported as a failure, with the reason', async () => {
  const fake = createFakeProvider();
  const assistant = createAssistant(fake);
  hire(assistant, { name: 'Dev' });
  const first = await drain(assistant.chat({ text: 'ASSIGNBG:dev|FAIL on purpose' }));
  const sessionId = first.find((event) => event.type === 'session').sessionId;
  const system = await waitFor(
    () => assistant.store.getMessages(sessionId).find((row) => row.role === 'system'),
    'the failure notice',
  );
  assert.match(system.content, /failed after .*: boom/);
  assert.match(system.content, /what went wrong and what you suggest/);
});

test('an agent that hands work off in the background finishes only once it is back', async () => {
  const fake = createFakeProvider();
  const assistant = createAssistant(fake);
  const lead = hire(assistant, { name: 'Lead' });
  hire(assistant, { name: 'Dev', managerId: lead.id });

  // The assistant waits for the lead; the lead hands on without waiting.
  const events = await drain(assistant.chat({ text: 'ASSIGN:lead|ASSIGNBG:dev|SLOW build the parser' }));
  const done = events.find((event) => event.type === 'done');
  assert.match(done.text, /Report from Lead/);
  assert.match(done.text, /FINAL with OUTPUT\(/, "the lead's final report is built on what came back");

  const orgId = assistant.org.activeOrganization().id;
  const tasks = assistant.store.org.listTasks(orgId, { anyLevel: true });
  const parent = tasks.find((task) => !task.parentId);
  const child = tasks.find((task) => task.parentId === parent.id);
  assert.ok(child, 'the handed-on work is a subtask of the lead task');
  assert.equal(child.status, 'done');
  assert.equal(child.requesterSessionId, undefined, 'a subtask reports to its parent, not past it');
  assert.equal(parent.status, 'done');
  assert.ok(parent.finishedAt >= child.finishedAt, 'the parent did not end before its child');
  assert.equal(assistant.store.org.taskRunCount(parent.id), 2, 'one run, then one pick-up with the result');
});

test('one conversation answers one message at a time', async () => {
  const fake = createFakeProvider({ delay: 60 });
  const assistant = createAssistant(fake);
  const session = assistant.createSession({ title: 'Serial' });
  await Promise.all([
    drain(assistant.chat({ text: 'first', sessionId: session.id })),
    drain(assistant.chat({ text: 'second', sessionId: session.id })),
  ]);
  assert.equal(fake.maxActive, 1, 'the second waited for the first');
  assert.deepEqual(
    assistant.store.getMessages(session.id).map((row) => row.content.slice(0, 13)),
    ['first', 'OUTPUT(first)', 'second', 'OUTPUT(second'],
  );
});

test('the notice says what the assistant is to do for each ending', () => {
  const base = {
    id: 'abcdef0123456789', orgId: 'o', title: 'Parser', description: '', priority: 'normal',
    createdBy: 'assistant', dependsOn: [], createdAt: 1, updatedAt: 2, sortOrder: 1, startedAt: 1_000, finishedAt: 61_000,
  };
  const agent = { name: 'Dev', slug: 'dev' };
  assert.match(reportBackNotice({ ...base, status: 'done', result: 'All good.' }, agent), /is done after 1m\.[\s\S]*Report:\nAll good\./);
  assert.match(reportBackNotice({ ...base, status: 'blocked', result: 'Which format?' }, agent), /waiting for an answer[\s\S]*Put the question to the user/);
  assert.match(reportBackNotice({ ...base, status: 'cancelled' }, agent), /was cancelled/);
  assert.match(reportBackNotice({ ...base, status: 'failed', error: 'boom' }, agent), /failed after 1m: boom\./);
});
