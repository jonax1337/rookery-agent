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
    config: { home, logLevel: 'silent', memory: { enabled: false, autoExtract: false } },
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
  const inboxCount = store.org.inbox(orgId, null).length;
  writeFileSync(path, 'console.log(JSON.stringify({wakeAgent:false}))');
  await assistant.cron.runNow(job.id);
  assert.equal(store.org.inbox(orgId, null).length, inboxCount, 'gate suppresses inbox noise');
  writeFileSync(path, '');
  await assistant.cron.runNow(job.id);
  assert.equal(store.org.inbox(orgId, null).length, inboxCount, 'empty script-only output stays quiet');
  assistant.cron.update(job.id, { script: { ...job.script, noAgent: false } });
  writeFileSync(path, 'console.log("sensor data from script")');
  assert.equal((await assistant.cron.runNow(job.id)).status, 'done');
  assert.match(fake.runs.at(-1).prompt, /sensor data from script/);
  const beforeSilentAgent = store.org.inbox(orgId, null).length;
  fake.provider.run = async function* () { yield { type: 'done', text: '[SILENT]' }; };
  await assistant.cron.runNow(job.id);
  assert.equal(store.org.inbox(orgId, null).length, beforeSilentAgent, 'Hermes silent agent responses stay quiet');
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
  assert.equal(after.sessionId, runs[0].sessionId, 'the job keeps its conversation');
  assert.ok(after.nextRunAt > Date.now() - 60_000, 'rescheduled');

  const session = store.getSession(after.sessionId);
  assert.equal(session.title, 'Schedule: Minutentakt');
  assert.equal(store.getMessages(session.id).length, 2, 'prompt and answer are on record');
  assert.match(fake.runs[0].prompt, /Automatic run of schedule “Minutentakt”/);
  assert.match(fake.runs[0].prompt, /Sag hallo\./);
  assert.match(fake.runs[0].systemPrompt, /Your schedules \(cron jobs/);

  const inbox = store.org.inbox(org.id, null, { unreadOnly: true });
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].content, /Schedule “Minutentakt” .* completed/);

  assert.ok(events.some((event) => event.run?.status === 'running'), 'announced the start');
  assert.ok(events.some((event) => event.run?.status === 'done'), 'announced the end');

  // The second run reuses the conversation.
  store.cron.updateJob(job.id, { nextRunAt: Date.now() - 1000 }, false);
  await assistant.cron.tick();
  assert.equal(assistant.cron.runs(job.id).length, 2);
  assert.equal(assistant.cron.get(job.id).sessionId, after.sessionId);
  assert.equal(store.getMessages(session.id).length, 4);
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
  const note = store.org.inbox(org.id, null).find((message) => message.content.includes('Kaputt'));
  assert.match(note.content, /failed/);
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
