import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCronScript } from '../dist/cron/script.js';
import {
  Assistant,
  CronSyntaxError,
  ProviderRegistry,
  Store,
  describeCron,
  nextCronRun,
  parseCron,
  upcomingCronRuns,
  resolveBinary,
} from '../dist/index.js';

test('cron: an installed Python runtime handles Unicode output without invoking Windows Store aliases', async t => {
  const candidates = ['python', 'python3'].map(resolveBinary).filter(binary => binary && !binary.isShim && !/[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(binary.path));
  if (!candidates.length) return t.skip('Python is an optional script runtime.');
  const home = mkdtempSync(join(tmpdir(), 'rookery-python-cron-'));
  mkdirSync(join(home, 'imported-scripts'));
  const path = join(home, 'imported-scripts', 'unicode & fixture.py');
  writeFileSync(path, 'print("Grüße 🦉")\n', 'utf8');
  const result = await runCronScript(home, { permission: 'full', script: { path, runtime: 'python', noAgent: true } }, new AbortController().signal);
  assert.equal(result.output, 'Grüße 🦉');
});

/**
 * Schedules: the parser, the clock, and a run end to end against a fake
 * provider. Dates below are local time, so the expectations are built with
 * the same Date constructor the scheduler uses.
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
      const prompt = opts.prompt ?? '';
      if (prompt.includes('FAIL')) {
        yield { type: 'error', message: 'boom', fatal: true };
        return;
      }
      await sleep(10);
      const text = 'OUTPUT(' + prompt.slice(-30) + ')';
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
  const home = mkdtempSync(join(tmpdir(), 'rookery-cron-'));
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

test('cron: imported scripts require review, keep silent gates, and forward pre-check data', async () => {
  const fake = createFakeProvider();
  const { assistant, store, home } = createAssistant(fake);
  const directory = join(home, 'imported-scripts', 'hermes', 'watcher');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'watcher.cjs');
  writeFileSync(path, 'console.log("watcher result")');
  const orgId = assistant.org.activeOrganization().id;
  const job = assistant.cron.create({ orgId, name: 'Imported watcher', schedule: '* * * * *', kind: 'script',
    script: { path, runtime: 'node', noAgent: true }, prompt: 'Summarize the result.', permission: 'chat', enabled: false, createdBy: 'user' });
  assert.deepEqual(assistant.cron.get(job.id).script, job.script);
  assert.throws(() => assistant.cron.update(job.id, { enabled: true }), /grant Full access/);
  await assert.rejects(assistant.cron.runNow(job.id), /grant Full access/);
  assert.equal(assistant.cron.runs(job.id).length, 0);
  assistant.cron.update(job.id, { permission: 'full' });
  const direct = await assistant.cron.runNow(job.id);
  assert.equal(direct.status, 'done');
  assert.equal(direct.result, 'watcher result');
  assert.equal(fake.runs.length, 0, 'script-only jobs never invoke a provider');
  const mailboxCount = store.org.mailbox(orgId, { kind: 'user' }, 'inbox').length;
  writeFileSync(path, 'console.log(JSON.stringify({wakeAgent:false}))');
  await assistant.cron.runNow(job.id);
  assert.equal(store.org.mailbox(orgId, { kind: 'user' }, 'inbox').length, mailboxCount, 'gate suppresses inbox noise');
  writeFileSync(path, '');
  await assistant.cron.runNow(job.id);
  assert.equal(store.org.mailbox(orgId, { kind: 'user' }, 'inbox').length, mailboxCount, 'empty script-only output stays quiet');
  assistant.cron.update(job.id, { script: { ...job.script, noAgent: false } });
  writeFileSync(path, 'console.log("sensor data from script")');
  assert.equal((await assistant.cron.runNow(job.id)).status, 'done');
  assert.match(fake.runs.at(-1).prompt, /sensor data from script/);
  const beforeSilentAgent = store.org.mailbox(orgId, { kind: 'user' }, 'inbox').length;
  fake.provider.run = async function* () { yield { type: 'done', text: '[SILENT]' }; };
  await assistant.cron.runNow(job.id);
  assert.equal(store.org.mailbox(orgId, { kind: 'user' }, 'inbox').length, beforeSilentAgent, 'Hermes silent agent responses stay quiet');
  writeFileSync(path, 'console.error("dependency missing");process.exit(3)');
  const failed = await assistant.cron.runNow(job.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /code 3: dependency missing/);
  assistant.close();
});

test('cron: script execution bounds output, rejects outside paths and supports abort and timeout', async () => {
  const { assistant, home } = createAssistant(createFakeProvider());
  const root = join(home, 'imported-scripts');
  mkdirSync(root);
  const path = join(root, 'safe script & name.cjs');
  const job = { permission: 'full', script: { path, runtime: 'node', noAgent: true } };
  process.env.ROOKERY_CRON_TEST_SECRET = 'fixture-only';
  try {
    writeFileSync(path, 'console.log(process.env.ROOKERY_CRON_TEST_SECRET ?? "not inherited")');
    assert.equal((await runCronScript(home, job, new AbortController().signal)).output, 'not inherited');
  } finally { delete process.env.ROOKERY_CRON_TEST_SECRET; }
  writeFileSync(path, 'process.stdout.write("x".repeat(100000))');
  const clipped = (await runCronScript(home, job, new AbortController().signal)).output;
  assert.match(clipped, /^\[Script output truncated:/);
  assert.equal(clipped.split('\n').at(-1).length, 64000);
  writeFileSync(path, 'console.log("x".repeat(100000));console.log(JSON.stringify({wakeAgent:false}))');
  assert.equal((await runCronScript(home, job, new AbortController().signal)).silent, true, 'truncation preserves the final wake gate');
  const outside = join(home, 'outside.cjs');
  writeFileSync(outside, 'throw new Error("must never execute")');
  await assert.rejects(runCronScript(home, { ...job, script: { ...job.script, path: outside } }, new AbortController().signal), /inside Rookery/);
  writeFileSync(path, 'setInterval(()=>{},1000)');
  await assert.rejects(runCronScript(home, job, new AbortController().signal, 100), /timed out/);
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 100);
  await assert.rejects(runCronScript(home, job, abort.signal), /cancelled/);
  assistant.close();
});

test('cron: finite run limits are reserved before execution and cannot restart after exhaustion', async () => {
  const { assistant } = createAssistant(createFakeProvider());
  const job = assistant.cron.create({ orgId: assistant.org.activeOrganization().id, name: 'Limited', schedule: '* * * * *', prompt: 'FAIL', remainingRuns: 2, createdBy: 'user' });
  assert.equal(assistant.cron.get(job.id).remainingRuns, 2);
  await assistant.cron.runNow(job.id);
  assert.equal(assistant.cron.get(job.id).remainingRuns, 1);
  await assistant.cron.runNow(job.id);
  const exhausted = assistant.cron.get(job.id);
  assert.equal(exhausted.remainingRuns, 0);
  assert.equal(exhausted.enabled, false);
  assert.equal(exhausted.nextRunAt, undefined);
  assert.throws(() => assistant.cron.update(job.id, { enabled: true }), /no remaining runs/);
  await assert.rejects(assistant.cron.runNow(job.id), /no remaining runs/);
  assistant.close();
});

test('cron: schema upgrade preserves existing jobs and new script fields survive reopening', () => {
  const home = mkdtempSync(join(tmpdir(), 'rookery-cron-upgrade-'));
  const path = join(home, 'test.db');
  let store = new Store(path);
  const org = store.org.createOrganization({ name: 'Migration' });
  const old = store.cron.createJob({ orgId: org.id, name: 'Existing', schedule: '* * * * *', kind: 'assistant', prompt: 'unchanged', enabled: false, createdBy: 'user' });
  store.db.exec('ALTER TABLE cron_jobs DROP COLUMN script_json; ALTER TABLE cron_jobs DROP COLUMN remaining_runs');
  store.close();
  store = new Store(path);
  assert.equal(store.cron.getJob(old.id).prompt, 'unchanged');
  assert.equal(store.cron.getJob(old.id).script, undefined);
  const script = { path: join(home, 'imported-scripts', 'test.py'), runtime: 'python', noAgent: true };
  store.cron.updateJob(old.id, { kind: 'script', script, remainingRuns: 3 });
  store.close();
  store = new Store(path);
  assert.deepEqual(store.cron.getJob(old.id).script, script);
  assert.equal(store.cron.getJob(old.id).remainingRuns, 3);
  store.close();
});

/* --------------------------------- parser -------------------------------- */

test('cron: next run walks the calendar in local time', () => {
  // Thursday, 10 September 2026, 09:00.
  const thursday = new Date(2026, 8, 10, 9, 0);
  assert.equal(new Date(2026, 8, 10).getDay(), 4, 'the fixture is a Thursday');

  const weekdays = nextCronRun('0 8 * * 1-5', thursday);
  assert.equal(weekdays.getTime(), new Date(2026, 8, 11, 8, 0).getTime(), 'Friday 08:00');
  const afterFriday = nextCronRun('0 8 * * 1-5', new Date(2026, 8, 11, 9, 0));
  assert.equal(afterFriday.getTime(), new Date(2026, 8, 14, 8, 0).getTime(), 'skips the weekend');

  const quarter = nextCronRun('*/15 * * * *', new Date(2026, 8, 10, 10, 7));
  assert.equal(quarter.getTime(), new Date(2026, 8, 10, 10, 15).getTime());

  const daily = nextCronRun('@daily', new Date(2026, 8, 10, 23, 59));
  assert.equal(daily.getTime(), new Date(2026, 8, 11, 0, 0).getTime());

  const once = nextCronRun('30 15 11 9 *', thursday);
  assert.equal(once.getTime(), new Date(2026, 8, 11, 15, 30).getTime());

  const monday = nextCronRun('0 9 * * mon', thursday);
  assert.equal(monday.getDay(), 1);
  assert.equal(monday.getHours(), 9);

  // Day of month OR day of week, the way cron has always done it.
  const either = upcomingCronRuns('0 9 13 * fri', 2, thursday);
  assert.equal(either[0].getTime(), new Date(2026, 8, 11, 9, 0).getTime(), 'Friday by weekday');
  assert.equal(either[1].getTime(), new Date(2026, 8, 13, 9, 0).getTime(), 'the 13th by date');

  assert.equal(nextCronRun('0 0 31 2 *', thursday), null, 'February 31st never comes');
  assert.equal(nextCronRun('0 8 * * *', new Date(2026, 8, 10, 8, 0)).getDate(), 11, 'strictly after');
});

test('cron: syntax errors name the field, and descriptions read like a person', () => {
  assert.throws(() => parseCron('60 * * * *'), CronSyntaxError);
  assert.throws(() => parseCron('* * * *'), /five fields/);
  assert.throws(() => parseCron('0 8 * * 9'), /day of week/);
  assert.equal(parseCron('@hourly').expression, '0 * * * *');
  assert.equal(parseCron(' 0   8 * * MON-FRI ').expression, '0 8 * * mon-fri');

  assert.equal(describeCron('0 8 * * 1-5'), 'Monday to Friday at 08:00');
  assert.equal(describeCron('*/15 * * * *'), 'every 15 minutes');
  assert.equal(describeCron('0 8 * * *'), 'daily at 08:00');
  assert.equal(describeCron('30 18 1 * *'), 'monthly on day 1 at 18:30');
  assert.equal(describeCron('0 9 * * sat,sun'), 'weekends at 09:00');
  assert.equal(describeCron('0 12 * * 3'), 'Wednesdays at 12:00');
  assert.equal(describeCron('* * * * *'), 'every minute');
  assert.equal(describeCron('5 * * * *'), 'hourly at minute 5');
  assert.equal(describeCron('0 */3 * * *'), 'every 3 hours');
  assert.equal(describeCron('30 9 1 1 *'), 'on 1 January at 09:30');
});

/* ---------------------------------- CRUD --------------------------------- */

test('cron: jobs are created with a next run, paused without one, and found by name', () => {
  const { assistant } = createAssistant(createFakeProvider());
  const org = assistant.org.activeOrganization();
  const before = Date.now();
  const job = assistant.cron.create({
    orgId: org.id,
    name: 'Morgenbriefing',
    schedule: '0 8 * * *',
    prompt: 'Fasse die Lage zusammen.',
    createdBy: 'user',
  });
  assert.equal(job.kind, 'assistant');
  assert.equal(job.enabled, true);
  assert.ok(job.nextRunAt > before, 'scheduled ahead');
  assert.equal(assistant.cron.find(org.id, 'morgenbriefing')?.id, job.id);
  assert.equal(assistant.cron.find(org.id, job.id.slice(0, 8))?.id, job.id);

  const paused = assistant.cron.update(job.id, { enabled: false });
  assert.equal(paused.enabled, false);
  assert.equal(paused.nextRunAt, undefined);
  const resumed = assistant.cron.update(job.id, { enabled: true, schedule: '@hourly' });
  assert.equal(resumed.schedule, '0 * * * *');
  assert.ok(resumed.nextRunAt > before);

  assert.throws(() => assistant.cron.create({ orgId: org.id, name: 'x', schedule: 'nope', prompt: 'y', createdBy: 'user' }), CronSyntaxError);
  assert.throws(() => assistant.cron.create({ orgId: org.id, name: 'x', schedule: '* * * * *', prompt: 'y', kind: 'agent', createdBy: 'user' }), /needs an agent/);

  assert.equal(assistant.cron.remove(job.id), true);
  assert.equal(assistant.cron.list(org.id).length, 0);
  assistant.close();
});

/* ---------------------------------- runs --------------------------------- */

test('cron: a due job runs as the assistant in its own conversation and reports to the inbox', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const events = [];
  assistant.on('cron', (event) => events.push(event));

  const job = assistant.cron.create({
    orgId: org.id,
    name: 'Minutentakt',
    schedule: '* * * * *',
    prompt: 'Sag hallo.',
    createdBy: 'assistant',
  });
  // Nothing is due yet; make it due by hand rather than waiting a minute.
  await assistant.cron.tick();
  assert.equal(assistant.cron.runs(job.id).length, 0);
  store.cron.updateJob(job.id, { nextRunAt: Date.now() - 1000 }, false);

  await assistant.cron.tick();
  const runs = assistant.cron.runs(job.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'done');
  assert.equal(runs[0].trigger, 'schedule');
  assert.match(runs[0].result, /^OUTPUT\(/);
  assert.ok(runs[0].sessionId, 'ran in a conversation');

  const after = assistant.cron.get(job.id);
  assert.equal(after.runCount, 1);
  assert.equal(after.lastStatus, 'done');
  assert.equal(after.sessionId, undefined, 'a recurring job is never pinned to one run\'s conversation');
  assert.ok(after.nextRunAt > Date.now() - 60_000, 'rescheduled');

  const session = store.getSession(runs[0].sessionId);
  assert.equal(session.title, 'Schedule: Minutentakt');
  assert.equal(session.kind, 'schedule', 'hidden from the conversations list like a mail transcript');
  assert.equal(store.getMessages(session.id).length, 2, 'prompt and answer are on record');
  assert.match(fake.runs[0].prompt, /Automatic run of schedule “Minutentakt”/);
  assert.match(fake.runs[0].prompt, /Sag hallo\./);
  assert.match(fake.runs[0].systemPrompt, /Your schedules \(cron jobs/);

  const inbox = store.org.mailbox(org.id, { kind: 'user' }, 'inbox', { unreadOnly: true });
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].subject, /Schedule "Minutentakt" completed/);

  assert.ok(events.some((event) => event.run?.status === 'running'), 'announced the start');
  assert.ok(events.some((event) => event.run?.status === 'done'), 'announced the end');

  // The second run gets a fresh conversation, not the first run's.
  store.cron.updateJob(job.id, { nextRunAt: Date.now() - 1000 }, false);
  await assistant.cron.tick();
  const runsAfterSecond = assistant.cron.runs(job.id);
  assert.equal(runsAfterSecond.length, 2);
  assert.equal(assistant.cron.get(job.id).sessionId, undefined);
  const secondSessionId = runsAfterSecond.find((run) => run.id !== runs[0].id).sessionId;
  assert.notEqual(secondSessionId, runs[0].sessionId, 'a clean rerun, not a diary entry');
  assert.equal(store.getMessages(session.id).length, 2, 'the first run\'s conversation is untouched');
  assert.equal(store.getMessages(secondSessionId).length, 2);
  assistant.close();
});

test('cron: a one-shot job switches itself off, and a failure is recorded as such', async () => {
  const { assistant, store } = createAssistant(createFakeProvider());
  const org = assistant.org.activeOrganization();

  const once = assistant.cron.create({
    orgId: org.id,
    name: 'Erinnerung',
    schedule: '* * * * *',
    prompt: 'Erinnere an den Termin.',
    once: true,
    createdBy: 'user',
  });
  const run = await assistant.cron.runNow(once.id);
  assert.equal(run.status, 'done');
  assert.equal(run.trigger, 'manual');
  const retired = assistant.cron.get(once.id);
  assert.equal(retired.enabled, false);
  assert.equal(retired.nextRunAt, undefined);

  const failing = assistant.cron.create({
    orgId: org.id,
    name: 'Kaputt',
    schedule: '* * * * *',
    prompt: 'FAIL now',
    createdBy: 'user',
  });
  const failed = await assistant.cron.runNow(failing.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /boom/);
  assert.equal(assistant.cron.get(failing.id).lastStatus, 'failed');
  const note = store.org.mailbox(org.id, { kind: 'user' }, 'inbox').find((mail) => mail.subject.includes('Kaputt'));
  assert.match(note.subject, /failed/);
  assistant.close();
});

test('cron: an agent job runs as an assignment', async () => {
  const { assistant, store } = createAssistant(createFakeProvider());
  const org = assistant.org.activeOrganization();
  const agent = store.org.createAgent({ orgId: org.id, name: 'Mara', title: 'Engineer', instructions: 'Do the work.' });

  const job = assistant.cron.create({
    orgId: org.id,
    name: 'Nachtlauf',
    schedule: '0 3 * * *',
    prompt: 'Prüfe die Builds.',
    agentId: agent.id,
    createdBy: 'assistant',
  });
  assert.equal(job.kind, 'agent');
  const run = await assistant.cron.runNow(job.id);
  assert.equal(run.status, 'done');
  assert.ok(run.assignmentId, 'an assignment ran');
  const assignment = store.org.getAssignment(run.assignmentId);
  assert.equal(assignment.status, 'done');
  assert.equal(assignment.agentId, agent.id);
  assert.equal(assignment.task, 'Prüfe die Builds.');
  assert.equal(run.sessionId, undefined, 'no conversation for an agent run');
  assistant.close();
});

test('cron: start() skips runs missed long ago and fails runs left behind', async () => {
  const { assistant, store } = createAssistant(createFakeProvider());
  const org = assistant.org.activeOrganization();
  const job = assistant.cron.create({
    orgId: org.id,
    name: 'Alt',
    schedule: '0 8 * * *',
    prompt: 'x',
    createdBy: 'user',
  });
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  store.cron.updateJob(job.id, { nextRunAt: twoHoursAgo }, false);
  const orphan = store.cron.createRun({ jobId: job.id, orgId: org.id, trigger: 'schedule' });

  assistant.cron.start();
  assert.equal(assistant.cron.started, true);
  assert.ok(assistant.cron.get(job.id).nextRunAt > Date.now(), 'moved on to the next slot');
  assert.equal(store.cron.getRun(orphan.id).status, 'failed');
  await assistant.cron.tick();
  assert.equal(assistant.cron.runs(job.id).length, 1, 'nothing new ran');
  assistant.cron.stop();
  assert.equal(assistant.cron.started, false);
  assistant.close();
});

test('cron: a self-run schedule answering [SILENT] stays out of the inbox', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const orgId = assistant.org.activeOrganization().id;
  const before = store.org.mailbox(orgId, { kind: 'user' }, 'inbox').length;
  const job = assistant.cron.create({ orgId, name: 'Morgen-Bote', schedule: '* * * * *', kind: 'assistant',
    prompt: 'Send the briefing by mail yourself, then answer [SILENT].', enabled: false, createdBy: 'user' });
  const loud = await assistant.cron.runNow(job.id);
  assert.equal(loud.status, 'done');
  assert.match(loud.result, /^OUTPUT\(/, 'an ordinary self-run reports its text');
  const afterLoud = store.org.mailbox(orgId, { kind: 'user' }, 'inbox').length;
  assert.equal(afterLoud, before + 1, 'an ordinary self-run still lands in the inbox');
  // The sentinel is whitespace-tolerant: the model ends its turn, not a protocol.
  fake.provider.run = async function* () { yield { type: 'done', text: '  [SILENT]\n' }; };
  const silent = await assistant.cron.runNow(job.id);
  assert.equal(silent.status, 'done');
  assert.ok(!silent.result, 'the sentinel is consumed, never reported as a result');
  assert.equal(store.org.mailbox(orgId, { kind: 'user' }, 'inbox').length, afterLoud, 'a silent self-run posts no completion mail');

  // The model also reasons out loud before the sentinel sometimes - an exact
  // match on the whole reply would miss this and let the reasoning (sentinel
  // and all) straight into a "completed" mail, which is exactly what shipped
  // once before this was caught.
  fake.provider.run = async function* () {
    yield { type: 'done', text: 'Identical to the update already delivered earlier - no new send.\n\n[SILENT]' };
  };
  const silentWithReasoning = await assistant.cron.runNow(job.id);
  assert.equal(silentWithReasoning.status, 'done');
  assert.ok(!silentWithReasoning.result, 'reasoning before the trailing sentinel is still recognised as silent');
  assert.equal(
    store.org.mailbox(orgId, { kind: 'user' }, 'inbox').length,
    afterLoud,
    'a silent self-run with reasoning still posts no completion mail',
  );

  // But the token only counts as the sentinel when it is the reply's last
  // word - a report that merely quotes or discusses the convention midway
  // through must still be delivered in full.
  fake.provider.run = async function* () {
    yield { type: 'done', text: 'Sent already. Per the [SILENT] convention this would stay quiet, but this run was not silent.' };
  };
  const mentionsSentinel = await assistant.cron.runNow(job.id);
  assert.equal(mentionsSentinel.status, 'done');
  assert.match(mentionsSentinel.result, /was not silent\.$/, 'a mid-text mention of the token is not the sentinel');
  assert.equal(
    store.org.mailbox(orgId, { kind: 'user' }, 'inbox').length,
    afterLoud + 1,
    'a report that only mentions the token still reaches the inbox',
  );
  assistant.close();
});

/* -------------------------------- events --------------------------------- */

/**
 * A schedule can also be fired by something that happened: a webhook call, or
 * a listener that saw a mail arrive. Nothing below waits on the wall clock -
 * the cooldowns are tens of milliseconds and the long runs are gated by hand,
 * so the whole section costs well under a second.
 */

async function waitFor(predicate, what) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.fail('Timed out waiting for ' + what + '.');
}

test('cron: an event fires a run that records the trigger and what caused it', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const orgId = assistant.org.activeOrganization().id;
  const job = assistant.cron.create({
    orgId,
    name: 'Mail watcher',
    schedule: '',
    triggerMode: 'event',
    prompt: 'Read the new mail.',
    createdBy: 'user',
  });

  const outcome = await assistant.cron.runEvent(job.id, 'imap:work');
  assert.equal(outcome.status, 'started');
  // The answer names the run as booked, not as finished. Whoever offered the
  // event is told "this is happening" and let go; making a webhook sender wait
  // out a model run is how one event turns into several retries.
  assert.equal(outcome.run.status, 'running');
  assert.equal(outcome.run.trigger, 'event');
  assert.equal(outcome.run.source, 'imap:work');

  await waitFor(() => assistant.cron.runs(job.id)[0]?.status === 'done', 'the event run finishing');
  assert.equal(fake.runs.length, 1);

  const recorded = assistant.cron.runs(job.id);
  assert.equal(recorded.length, 1);
  assert.match(recorded[0].result, /^OUTPUT\(/);
  assert.equal(recorded[0].trigger, 'event');
  assert.equal(recorded[0].source, 'imap:work', 'the source is on the run row, not only in the caller\'s reply');

  const after = assistant.cron.get(job.id);
  assert.equal(after.runCount, 1);
  assert.equal(after.lastStatus, 'done');
  assert.equal(after.nextRunAt, undefined, 'an event run does not put an event job on the clock');

  const inbox = store.org.mailbox(orgId, { kind: 'user' }, 'inbox', { unreadOnly: true });
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].subject, /Schedule "Mail watcher" completed/);
  assert.match(inbox[0].body, /fired by imap:work/, 'the note says why it ran, not which expression it does not have');
  assistant.close();
});

test('cron: a switched-off schedule ignores events, whoever still holds its webhook', async () => {
  const fake = createFakeProvider();
  const { assistant } = createAssistant(fake);
  const orgId = assistant.org.activeOrganization().id;
  const job = assistant.cron.create({
    orgId,
    name: 'Retired hook',
    schedule: '',
    triggerMode: 'event',
    prompt: 'Do the thing.',
    enabled: false,
    createdBy: 'user',
  });
  const token = assistant.cron.enableWebhook(job.id).webhookToken;
  assert.equal(assistant.cron.findByWebhookToken(token)?.id, job.id, 'the secret still resolves - the switch is what stops the job');

  const ignored = await assistant.cron.runEvent(job.id, 'webhook');
  assert.equal(ignored.status, 'ignored');
  assert.match(ignored.reason, /switched off/);
  assert.equal(assistant.cron.runs(job.id).length, 0, 'a URL handed out weeks ago cannot wake a job the user switched off');
  assert.equal(fake.runs.length, 0);

  const unknown = await assistant.cron.runEvent('no-such-schedule', 'webhook');
  assert.equal(unknown.status, 'ignored');
  assert.equal(fake.runs.length, 0);

  // Switched back on, the very same event is answered.
  assistant.cron.update(job.id, { enabled: true });
  assert.equal((await assistant.cron.runEvent(job.id, 'webhook')).status, 'started');
  assert.equal(assistant.cron.runs(job.id).length, 1);
  assistant.close();
});

test('cron: events arriving during a run collapse into exactly one further run', async (t) => {
  const fake = createFakeProvider();
  const { assistant } = createAssistant(fake);
  const orgId = assistant.org.activeOrganization().id;
  const job = assistant.cron.create({
    orgId,
    name: 'Busy mailbox',
    schedule: '',
    triggerMode: 'event',
    eventCooldownMs: 0,
    prompt: 'Look at the mailbox.',
    createdBy: 'user',
  });

  // Hold every run open until this test lets it go, so the overlap is ours to
  // choose instead of the machine's.
  const gates = [];
  fake.provider.run = async function* () {
    await new Promise((resolve) => gates.push(resolve));
    yield { type: 'done', text: 'released' };
  };
  t.after(() => {
    for (const release of gates) release();
  });

  const first = assistant.cron.runEvent(job.id, 'imap:work');
  await waitFor(() => gates.length === 1, 'the first event run starting');
  for (const source of ['webhook', 'imap:work', 'imap:private']) {
    assert.deepEqual(await assistant.cron.runEvent(job.id, source), { status: 'coalesced' });
  }
  assert.equal(assistant.cron.runs(job.id).length, 1, 'nothing starts beside a run already in flight');

  gates[0]();
  const started = await first;
  assert.equal(started.status, 'started');
  assert.equal(started.run.trigger, 'event');
  assert.equal(started.run.source, 'imap:work');

  await waitFor(() => gates.length === 2, 'the run the coalesced events earned');
  gates[1]();
  await waitFor(
    () => assistant.cron.runs(job.id).length === 2 && assistant.cron.runs(job.id).every((run) => run.status !== 'running'),
    'the second run finishing',
  );
  // A regression that queued each event separately would show up late, so give
  // it room to before counting.
  await sleep(50);

  const runs = assistant.cron.runs(job.id);
  assert.equal(runs.length, 2, 'three events during one run are one more run, not three');
  assert.equal(gates.length, 2, 'the provider was asked exactly twice');
  const drained = runs.find((run) => run.id !== started.run.id);
  assert.equal(drained.trigger, 'event');
  assert.equal(drained.source, 'imap:private', 'the newest reason is the one the run carries');
  assert.equal(drained.status, 'done');
  assistant.close();
});

test('cron: an event inside the cooldown waits out the rest instead of being dropped', async () => {
  const fake = createFakeProvider();
  const { assistant } = createAssistant(fake);
  const orgId = assistant.org.activeOrganization().id;
  const job = assistant.cron.create({
    orgId,
    name: 'Chatty mailbox',
    schedule: '',
    triggerMode: 'event',
    eventCooldownMs: 300,
    prompt: 'Look once.',
    createdBy: 'user',
  });

  const immediate = await assistant.cron.runEvent(job.id, 'imap:work');
  assert.equal(immediate.status, 'started', 'a rested job runs at once');
  // Let that run finish first, so what answers the next event is the rest it
  // earned and not the plain guard against two runs at once.
  await waitFor(() => assistant.cron.runs(job.id)[0]?.status === 'done', 'the first event run finishing');

  const queued = await assistant.cron.runEvent(job.id, 'webhook');
  assert.equal(queued.status, 'queued');
  assert.ok(queued.waitMs > 0 && queued.waitMs <= 300, 'the wait is what is left of the rest, not a fresh cooldown');
  const alsoQueued = await assistant.cron.runEvent(job.id, 'imap:private');
  assert.equal(alsoQueued.status, 'queued');
  assert.equal(assistant.cron.runs(job.id).length, 1, 'nothing runs while the job rests');

  await waitFor(() => assistant.cron.runs(job.id).length === 2, 'the run the waiting events earned');
  await waitFor(() => assistant.cron.runs(job.id).every((run) => run.status !== 'running'), 'that run finishing');
  await sleep(60);

  const runs = assistant.cron.runs(job.id);
  assert.equal(runs.length, 2, 'two events inside one rest become one run');
  assert.equal(runs[0].trigger, 'event');
  assert.equal(runs[0].source, 'imap:private');
  assert.equal(runs[0].status, 'done');
  assert.ok(runs[0].startedAt - runs[1].startedAt >= 200, 'the run waited for the rest rather than following straight on');
  assistant.close();
});

test('cron: an event-only schedule needs no expression and is never fired by the clock', async () => {
  const fake = createFakeProvider();
  const { assistant } = createAssistant(fake);
  const orgId = assistant.org.activeOrganization().id;
  const watcher = assistant.cron.create({
    orgId,
    name: 'Clockless watcher',
    schedule: '',
    triggerMode: 'event',
    prompt: 'Read the new mail.',
    createdBy: 'user',
  });
  assert.equal(watcher.schedule, '');
  assert.equal(watcher.triggerMode, 'event');
  assert.equal(watcher.enabled, true, 'waiting for events is not the same as switched off');
  assert.equal(watcher.nextRunAt, undefined, 'no clock, no next run');
  assert.equal(assistant.cron.get(watcher.id).nextRunAt, undefined);

  await assistant.cron.tick(Date.now() + 365 * 24 * 60 * 60 * 1000);
  assert.equal(assistant.cron.runs(watcher.id).length, 0, 'a year of clock still fires nothing');
  assert.equal(fake.runs.length, 0);

  // Only an event job may go without one; putting a job on the clock without
  // an expression is still the mistake it always was.
  assert.throws(
    () => assistant.cron.create({ orgId, name: 'No expression', schedule: '', prompt: 'x', createdBy: 'user' }),
    CronSyntaxError,
  );
  assert.throws(() => assistant.cron.update(watcher.id, { triggerMode: 'schedule' }), CronSyntaxError);
  assert.equal(assistant.cron.get(watcher.id).triggerMode, 'event', 'the rejected change left the job alone');

  const onTheClock = assistant.cron.update(watcher.id, { triggerMode: 'schedule', schedule: '0 8 * * *' });
  assert.ok(onTheClock.nextRunAt > Date.now(), 'going on the clock books a next run');
  const backToEvents = assistant.cron.update(watcher.id, { triggerMode: 'event' });
  assert.equal(backToEvents.nextRunAt, undefined, 'going back off the clock clears it rather than leaving it ticking');
  assert.equal(backToEvents.schedule, '0 8 * * *', 'the expression is kept for the day it goes back on the clock');
  assistant.close();
});

test('cron: a webhook secret opens one schedule, and rotating it closes the old URL', () => {
  const { assistant } = createAssistant(createFakeProvider());
  const orgId = assistant.org.activeOrganization().id;
  const make = (name) =>
    assistant.cron.create({ orgId, name, schedule: '', triggerMode: 'event', prompt: 'Report.', createdBy: 'user' });
  const job = make('Deploy hook');
  const other = make('Build hook');
  assert.equal(job.webhookToken, undefined, 'a schedule has no secret until one is asked for');
  assert.equal(assistant.cron.findByWebhookToken(''), null, 'a blank secret opens nothing');
  assert.equal(assistant.cron.findByWebhookToken('   '), null);
  assert.equal(assistant.cron.findByWebhookToken('not-a-token'), null);

  const first = assistant.cron.enableWebhook(job.id);
  assert.ok(first.webhookToken);
  assert.equal(assistant.cron.get(job.id).webhookToken, first.webhookToken, 'the secret is stored, not only returned');
  assert.equal(assistant.cron.findByWebhookToken(first.webhookToken)?.id, job.id);

  const neighbour = assistant.cron.enableWebhook(other.id);
  assert.notEqual(neighbour.webhookToken, first.webhookToken, 'every schedule gets a secret of its own');
  assert.equal(assistant.cron.findByWebhookToken(neighbour.webhookToken)?.id, other.id);

  const rotated = assistant.cron.enableWebhook(job.id);
  assert.notEqual(rotated.webhookToken, first.webhookToken);
  assert.equal(assistant.cron.findByWebhookToken(first.webhookToken), null, 'the old URL is dead the moment it is rotated');
  assert.equal(assistant.cron.findByWebhookToken(rotated.webhookToken)?.id, job.id);

  const cleared = assistant.cron.disableWebhook(job.id);
  assert.equal(cleared.webhookToken, undefined);
  assert.equal(assistant.cron.get(job.id).webhookToken, undefined);
  assert.equal(assistant.cron.findByWebhookToken(rotated.webhookToken), null, 'a taken-away hook answers nothing');
  assert.equal(assistant.cron.findByWebhookToken(neighbour.webhookToken)?.id, other.id, 'taking one hook away leaves the others alone');
  assistant.close();
});

test('cron: an event fires a clock-backed schedule without costing it its next run', async () => {
  const { assistant, store } = createAssistant(createFakeProvider());
  const orgId = assistant.org.activeOrganization().id;
  const job = assistant.cron.create({
    orgId,
    name: 'Nightly with a shortcut',
    schedule: '0 3 * * *',
    prompt: 'Check the builds.',
    createdBy: 'user',
  });
  assert.equal(job.triggerMode, 'schedule');
  assert.ok(job.nextRunAt > Date.now());

  const outcome = await assistant.cron.runEvent(job.id, 'webhook');
  assert.equal(outcome.status, 'started');
  assert.equal(outcome.run.trigger, 'event');
  assert.equal(outcome.run.source, 'webhook');
  // The clock may not fire while that run is still in flight - one run per job
  // holds for events too - so let it finish before asking the clock for one.
  await waitFor(() => assistant.cron.runs(job.id)[0]?.status === 'done', 'the event run finishing');

  const after = assistant.cron.get(job.id);
  assert.equal(after.triggerMode, 'schedule', 'an event does not take a job off the clock');
  assert.equal(after.schedule, '0 3 * * *');
  assert.ok(after.nextRunAt > Date.now(), 'the clock backstop survives an event run');

  // And the backstop still works: the clock catches the events that never come.
  store.cron.updateJob(job.id, { nextRunAt: Date.now() - 1000 }, false);
  await assistant.cron.tick();
  const runs = assistant.cron.runs(job.id);
  assert.equal(runs.length, 2);
  const byClock = runs.find((run) => run.trigger === 'schedule');
  assert.equal(byClock.status, 'done');
  assert.equal(byClock.source, undefined, 'a clock run has no source to name');
  assert.ok(assistant.cron.get(job.id).nextRunAt > Date.now(), 'and it books the one after that');
  assistant.close();
});

test('cron: a schedule without an expression does not stop the clock from starting', async () => {
  const { assistant } = createAssistant(createFakeProvider());
  const orgId = assistant.org.activeOrganization().id;
  assistant.cron.create({
    orgId,
    name: 'Clockless watcher',
    schedule: '',
    triggerMode: 'event',
    prompt: 'Read the new mail.',
    createdBy: 'user',
  });

  // start() works out a next run for every enabled job it finds, and a job off
  // the clock has no expression to work one out from. Getting this wrong did
  // not fail the one job - it threw out of start() and took the whole server
  // down on the next boot, which is why it is worth a test of its own.
  assert.doesNotThrow(() => assistant.cron.start());
  assert.equal(assistant.cron.started, true);
  assert.equal(assistant.cron.get(assistant.cron.list(orgId)[0].id).nextRunAt, undefined);
  assistant.cron.stop();
  assistant.close();
});
