import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Assistant, ProviderRegistry, Store } from '../dist/index.js';
import { BackgroundWork, runTui, stopVerdict } from '../dist/providers/claude-tui.js';

/**
 * A run is done only once everything it started is done: the sub-agents,
 * workflows and background commands an agent sends off inside its Claude Code
 * session hold the run open, the final report is the one after they are back,
 * and a run that times out while waiting says it is incomplete.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error('Timed out waiting for ' + what);
}

/* ------------------------------ transcript lines ------------------------------ */

const say = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const launchedAgent = (agentId) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Async agent launched successfully.' }] },
  toolUseResult: { isAsync: true, status: 'async_launched', agentId },
});
const launchedCommand = (id) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'Command running in background with ID: ' + id }] },
  toolUseResult: { stdout: '', backgroundTaskId: id },
});
const notification = (id) => ({
  type: 'user',
  message: { role: 'user', content: '<task-notification>\n<task-id>' + id + '</task-id>\n<status>completed</status>\n</task-notification>' },
});
const stopped = (counts = {}) => ({ type: 'system', subtype: 'turn_duration', durationMs: 1, ...counts });

const INTERIM = 'Das Dokument schreibe ich, sobald die drei Recherche-Agents zurückgemeldet haben.';

/* ------------------------------ the gate itself ------------------------------ */

test('a stop while a sub-agent runs is not the end; the stop after its result is', () => {
  const work = new BackgroundWork();
  const gate = { commandNudges: 0, interimNudged: false };
  for (const entry of [launchedAgent('a1'), say(INTERIM), stopped({ pendingBackgroundAgentCount: 1 })]) work.observe(entry);
  const held = stopVerdict(work.pending(), INTERIM, gate);
  assert.equal(held.action, 'wait');
  assert.match(held.detail, /waiting for 1 sub-agent/);
  assert.equal(held.nudge, undefined, 'Claude Code wakes the agent itself when the sub-agent is back');

  for (const entry of [notification('a1'), say('Fertig, Datei geschrieben.'), stopped()]) work.observe(entry);
  assert.deepEqual(work.pending(), { agents: 0, workflows: 0, commands: 0, interim: 0 });
  assert.deepEqual(stopVerdict(work.pending(), 'Fertig, Datei geschrieben.', gate), { action: 'finish' });
});

test('a result that lands right behind the stop is left to Claude Code, nothing typed', () => {
  // As seen in a live run: two notifications written just after the stop.
  const work = new BackgroundWork();
  const gate = { commandNudges: 0, interimNudged: false };
  const waiting = 'Ich warte auf B und C und schreibe die Datei erst, wenn alle Ergebnisse da sind.';
  for (const entry of [launchedAgent('b'), launchedAgent('c'), say(waiting), stopped({ pendingBackgroundAgentCount: 2 }), notification('b'), notification('c')]) work.observe(entry);
  const verdict = stopVerdict(work.pending(), waiting, gate, work.resuming);
  assert.equal(verdict.action, 'wait');
  assert.equal(verdict.nudge, undefined, 'Claude Code wakes the agent with the results itself');
  assert.equal(gate.interimNudged, false);
  // The turn those results started ends with a stop; that one is judged as usual.
  for (const entry of [say('Fertig.'), stopped()]) work.observe(entry);
  assert.equal(work.resuming, false);
  assert.deepEqual(stopVerdict(work.pending(), 'Fertig.', gate, work.resuming), { action: 'finish' });
});

test('a sub-agent still waiting on its own background work is not back yet', () => {
  // The sequence of a live run (Claude Code 2.1.299): Beta's first notification
  // is interim, and Claude Code's own count already leaves Beta out.
  const interim = (id) => ({
    type: 'user',
    message: {
      role: 'user',
      content:
        '<task-notification>\n<task-id>' + id + '</task-id>\n<status>completed</status>\n' +
        '<summary>Agent "Sleep 70, Beta" is waiting on its own background work</summary>\n' +
        '<note>This agent stopped with background work of its own still running. It may resume on its own when that work completes or reports, and the same task-id notifies again if it does; the result below may be interim.</note>\n' +
        '<result>Waiting for the sleep to finish.</result>\n</task-notification>',
    },
  });
  const work = new BackgroundWork();
  for (const entry of [launchedAgent('alpha'), launchedAgent('beta'), say(INTERIM), stopped({ pendingBackgroundAgentCount: 2 })]) work.observe(entry);
  for (const entry of [interim('beta'), say('Beta meldet nur einen Zwischenstand.'), stopped({ pendingBackgroundAgentCount: 1 })]) work.observe(entry);
  assert.equal(work.pending().agents, 2);
  for (const entry of [notification('alpha'), say('Alpha ist zurück, Beta fehlt noch.'), stopped()]) work.observe(entry);
  assert.equal(work.pending().agents, 1, 'Beta is still out although Claude Code counts nothing');
  const gate = { commandNudges: 0, interimNudged: false };
  const held = stopVerdict(work.pending(), 'Alpha ist zurück, Beta fehlt noch.', gate);
  assert.equal(held.action, 'wait');
  assert.equal(held.nudge, undefined);
  work.observe(notification('beta'));
  assert.equal(work.pending().agents, 0);
});

test('a final report while sub-agents only sent interim results stands after a grace period', () => {
  // Also live: Gamma's last notification carried "Gamma" but still the
  // interim label, and no other one followed; the agent wrote its file.
  const label = (id, result) => ({
    type: 'user',
    message: {
      role: 'user',
      content:
        '<task-notification>\n<task-id>' + id + '</task-id>\n<status>completed</status>\n' +
        '<summary>Agent "Sleep 100 Gamma" is waiting on its own background work</summary>\n<result>' + result + '</result>\n</task-notification>',
    },
  });
  const work = new BackgroundWork();
  const gate = { commandNudges: 0, interimNudged: false };
  for (const entry of [launchedAgent('gamma'), say(INTERIM), stopped({ pendingBackgroundAgentCount: 1 }), label('gamma', 'Still sleeping.')]) work.observe(entry);
  for (const entry of [say('Gamma fehlt noch.'), stopped()]) work.observe(entry);
  assert.equal(stopVerdict(work.pending(), 'Gamma fehlt noch.', gate, work.resuming).action, 'wait');
  for (const entry of [label('gamma', 'Gamma'), say('FINAL: Gamma'), stopped()]) work.observe(entry);
  assert.deepEqual(work.pending(), { agents: 1, workflows: 0, commands: 0, interim: 1 });
  // Gamma may still report again; the final report stands unless it does, in time.
  const verdict = stopVerdict(work.pending(), 'FINAL: Gamma', gate, work.resuming);
  assert.equal(verdict.action, 'wait');
  assert.equal(verdict.nudge, undefined);
  assert.equal(verdict.finishAfterMs, 120_000);
});

test('a workflow, known only from Claude Code\'s own count, holds the run as well', () => {
  const work = new BackgroundWork();
  work.observe(say('Workflow gestartet.'));
  work.observe(stopped({ pendingWorkflowCount: 1 }));
  assert.equal(work.pending().workflows, 1);
  // The count is a snapshot of that stop: the conversation going on drops it.
  work.observe(notification('wf_1'));
  assert.equal(work.pending().workflows, 0);
});

test('background commands get the agent asked to settle them, a bounded number of times', () => {
  const work = new BackgroundWork();
  const gate = { commandNudges: 0, interimNudged: false };
  work.observe(launchedCommand('b1'));
  const first = stopVerdict(work.pending(), 'Server läuft.', gate);
  assert.match(first.detail, /1 background command/);
  assert.match(first.nudge, /TaskStop/);
  assert.ok(stopVerdict(work.pending(), 'x', gate).nudge);
  assert.equal(stopVerdict(work.pending(), 'x', gate).nudge, undefined, 'asked twice, then only waited out');
  work.observe(notification('b1'));
  assert.equal(stopVerdict(work.pending(), 'Fertig.', gate).action, 'finish');
});

test('sub-agent lines of the session itself are not the main conversation', () => {
  const work = new BackgroundWork();
  work.observe({ ...launchedAgent('nested'), isSidechain: true });
  assert.deepEqual(work.pending(), { agents: 0, workflows: 0, commands: 0, interim: 0 });
});

test('an interim report with nothing left running is asked once for the final report', () => {
  const work = new BackgroundWork();
  const gate = { commandNudges: 0, interimNudged: false };
  const first = stopVerdict(work.pending(), INTERIM, gate);
  assert.equal(first.action, 'wait');
  assert.match(first.nudge, /final report/);
  assert.equal(stopVerdict(work.pending(), INTERIM, gate).action, 'finish', 'asked once, never held for ever');
  assert.equal(stopVerdict(new BackgroundWork().pending(), 'Fertig. Tests: 22 grün.', { commandNudges: 0, interimNudged: false }).action, 'finish');
});

/* --------------------------- the gate in a terminal run --------------------------- */

function fakeTerminal() {
  const exits = [];
  const proc = {
    written: [],
    onData() {},
    onExit(listener) {
      exits.push(listener);
    },
    write(data) {
      proc.written.push(data);
    },
    resize() {},
    kill() {
      for (const listener of exits.splice(0)) listener({ exitCode: 0 });
    },
  };
  return { proc, module: { spawn: () => proc } };
}

function terminalRun(name, signal) {
  const root = mkdtempSync(join(tmpdir(), 'rookery-gate-'));
  const sessionId = 'session-' + name;
  mkdirSync(join(root, 'projects', 'p'), { recursive: true });
  const transcript = join(root, 'projects', 'p', sessionId + '.jsonl');
  writeFileSync(transcript, '');
  const markerFile = join(root, 'stop.json');
  const terminal = fakeTerminal();
  const events = [];
  const finished = (async () => {
    for await (const event of runTui({
      key: 'gate-' + name,
      binary: { path: 'claude', isShim: false },
      args: [],
      prompt: 'go',
      env: { CLAUDE_CONFIG_DIR: root },
      sessionId,
      workDir: root,
      markerFile,
      mapEntry: (entry) =>
        entry.type === 'assistant'
          ? entry.message.content.filter((block) => block.type === 'text').map((block) => ({ type: 'text', delta: block.text }))
          : [],
      cleanup() {},
      lingerMs: 20,
      pty: terminal.module,
      ...(signal ? { signal } : {}),
    })) {
      events.push(event);
    }
  })();
  return {
    events,
    finished,
    written: terminal.proc.written,
    append(lines) {
      for (const line of lines) appendFileSync(transcript, JSON.stringify(line) + '\n');
    },
    /** Lines into the transcript, then - as Claude Code does - the Stop hook's payload. */
    stop(lines, message, counts) {
      for (const line of lines) appendFileSync(transcript, JSON.stringify(line) + '\n');
      writeFileSync(markerFile, JSON.stringify({ last_assistant_message: message }));
      appendFileSync(transcript, JSON.stringify(stopped(counts)) + '\n');
    },
    marker: () => readFileSync(markerFile, 'utf8'),
  };
}

test('a terminal run stays running while its sub-agent works, and ends after the final report', async () => {
  const run = terminalRun('agents');
  run.stop([launchedAgent('a1'), say(INTERIM)], INTERIM, { pendingBackgroundAgentCount: 1 });

  await waitFor(() => run.events.find((event) => event.type === 'status' && event.label === 'waiting'), 'the waiting status');
  await sleep(1500);
  assert.equal(run.events.filter((event) => event.type === 'done').length, 0, 'no done while the sub-agent runs');
  assert.equal(run.marker(), '', 'the stop was taken back, so the next one is judged on its own');
  assert.equal(run.written.length, 0, 'nothing typed: Claude Code picks the result up by itself');

  run.append([notification('a1')]);
  await waitFor(() => run.events.find((event) => event.label === 'resumed'), 'the run to say everything is back');
  run.stop([say('Fertig: docs/vergleich.md geschrieben.')], 'Fertig: docs/vergleich.md geschrieben.');
  await run.finished;
  const done = run.events.filter((event) => event.type === 'done');
  assert.equal(done.length, 1, 'exactly one done');
  assert.equal(done[0].text, 'Fertig: docs/vergleich.md geschrieben.', 'the final report, not the interim one');
});

test('a terminal run with only a background command left asks the agent to settle it', async () => {
  const run = terminalRun('commands');
  run.stop([launchedCommand('b1'), say('Server läuft im Hintergrund.')], 'Server läuft im Hintergrund.');
  await waitFor(() => run.written.join('').includes('TaskStop'), 'the nudge');
  await waitFor(() => run.written.includes('\r'), 'the nudge being sent');
  assert.equal(run.events.filter((event) => event.type === 'done').length, 0);

  run.stop([notification('b1'), say('Server gestoppt, alles erledigt.')], 'Server gestoppt, alles erledigt.');
  await run.finished;
  assert.equal(run.events.filter((event) => event.type === 'done').length, 1);
});

test('a terminal run cancelled while it waits ends without a done', async () => {
  const abort = new AbortController();
  const run = terminalRun('abort', abort.signal);
  run.stop([launchedAgent('a1'), say(INTERIM)], INTERIM, { pendingBackgroundAgentCount: 1 });
  await waitFor(() => run.events.find((event) => event.label === 'waiting'), 'the waiting status');
  abort.abort();
  await run.finished;
  assert.equal(run.events.filter((event) => event.type === 'done').length, 0);
});

/* ------------------------------ through the company ------------------------------ */

function gatedProvider() {
  return {
    id: 'claude',
    displayName: 'Fake Claude',
    models: () => ['fake'],
    async status() {
      return { id: 'claude', available: true, binary: 'fake', authenticated: true };
    },
    async *run(opts) {
      const prompt = opts.prompt ?? '';
      if (prompt.includes('ASSIGNBG:')) {
        // The assistant's turn: hand the work off and answer at once.
        const [, agent, task] = prompt.match(/ASSIGNBG:([\w-]+)\|([^\n]+)/);
        const { connect } = await import('node:net');
        await new Promise((resolve, reject) => {
          const socket = connect(opts.mcp.env.ROOKERY_BRIDGE_PATH);
          socket.on('error', reject);
          socket.on('data', () => {
            socket.end();
            resolve();
          });
          socket.on('connect', () =>
            socket.write(
              JSON.stringify({
                id: 1,
                method: 'call',
                token: opts.mcp.env.ROOKERY_BRIDGE_TOKEN,
                name: 'assign',
                args: { agent, task, wait: false },
              }) + '\n',
            ),
          );
        });
        yield { type: 'done', text: 'Handed off.' };
        return;
      }
      if (prompt.includes('[Rookery] Background task')) {
        yield { type: 'done', text: 'Noted.' };
        return;
      }
      // The agent: stops once while its sub-agent is out, as the gate reports it.
      yield { type: 'text', delta: INTERIM };
      yield { type: 'status', label: 'waiting', detail: 'waiting for 1 sub-agent before the final report' };
      if (prompt.includes('HANGLATE')) {
        // Everything is back; the agent is writing its report when time runs out.
        yield { type: 'status', label: 'resumed', detail: 'all background work is back; the final report is being written' };
      }
      if (prompt.includes('HANG')) {
        await new Promise((resolve) => opts.signal.addEventListener('abort', resolve, { once: true }));
        return;
      }
      await sleep(150);
      const text = prompt.includes('INTERIM') ? INTERIM : 'FINAL REPORT';
      yield { type: 'text', delta: text };
      yield { type: 'done', text };
    },
  };
}

const assistants = [];
after(() => {
  for (const assistant of assistants) assistant.close();
});

function company(org = {}) {
  const home = mkdtempSync(join(tmpdir(), 'rookery-gate-org-'));
  mkdirSync(join(home, 'run'), { recursive: true });
  const assistant = new Assistant({
    store: new Store(':memory:'),
    registry: new ProviderRegistry([gatedProvider()]),
    config: {
      home,
      logLevel: 'silent',
      memory: { enabled: false, autoExtract: false },
      org: { autoReview: false, interactiveRuns: false, ...org },
    },
  });
  assistants.push(assistant);
  const orgRow = assistant.org.activeOrganization();
  assistant.store.org.createAgent({ orgId: orgRow.id, name: 'Iris', title: 'Research', instructions: 'Research.' });
  const followUps = [];
  assistant.on('follow-up', (event) => followUps.push(event));
  return { assistant, followUps, home, orgId: orgRow.id };
}

async function handOff(assistant, task) {
  for await (const event of assistant.chat({ text: 'ASSIGNBG:iris|' + task })) void event;
}

const onlyTask = (assistant, orgId) => assistant.store.org.listTasks(orgId, { anyLevel: true })[0];

test('the task ends once, with the final report, after the run stopped to wait', async () => {
  const { assistant, followUps, orgId } = company();
  await handOff(assistant, 'compare the assistants');
  const task = await waitFor(() => {
    const row = onlyTask(assistant, orgId);
    return row && row.status === 'done' ? row : null;
  }, 'the task to finish');
  assert.equal(task.result, 'FINAL REPORT');
  const notes = assistant.store.org.listTaskEvents(task.id).map((event) => event.text);
  assert.ok(notes.some((text) => /stays open: waiting for 1 sub-agent/.test(text)), 'the card said it was waiting');
  await waitFor(() => followUps.length >= 1, 'the report-back');
  await sleep(300);
  assert.equal(followUps.length, 1, 'exactly one ending reported');
});

test('a run that times out while waiting is incomplete, not done', async () => {
  const { assistant, followUps, orgId } = company({ assignmentTimeoutMs: 400 });
  await handOff(assistant, 'HANG compare the assistants');
  const task = await waitFor(() => {
    const row = onlyTask(assistant, orgId);
    return row && row.status === 'failed' ? row : null;
  }, 'the task to fail');
  assert.match(task.error, /^Incomplete: the run timed out after \d+ min \(waiting for 1 sub-agent before the final report\)\./);
  assert.match(task.error, /Last interim report: Das Dokument/);
  await waitFor(() => followUps.length >= 1, 'the report-back');
  await sleep(300);
  assert.equal(followUps.length, 1);
});

test('a run that times out after its sub-agents came back does not say it was waiting for them', async () => {
  const { assistant, orgId } = company({ assignmentTimeoutMs: 400 });
  await handOff(assistant, 'HANGLATE compare the assistants');
  const task = await waitFor(() => {
    const row = onlyTask(assistant, orgId);
    return row && row.status === 'failed' ? row : null;
  }, 'the task to fail');
  assert.match(task.error, /^Incomplete: .*\(all background work is back; the final report is being written\)\./);
  assert.doesNotMatch(task.error, /waiting for 1 sub-agent/);
});

test('a done report that reads as interim, or misses its file, is flagged on the card', async () => {
  const { assistant, orgId, home } = company();
  const target = join(home, 'out', 'vergleich.md').replace(/\\/g, '/');
  await handOff(assistant, 'INTERIM Schreibe das Ergebnis nach ' + target + ' und berichte.');
  const task = await waitFor(() => {
    const row = onlyTask(assistant, orgId);
    return row && row.status === 'done' ? row : null;
  }, 'the task to finish');
  const notes = assistant.store.org.listTaskEvents(task.id).map((event) => event.text);
  assert.ok(notes.some((text) => /Warning: the report reads like an interim note/.test(text)));
  assert.ok(notes.some((text) => text.includes(target) && /does not exist/.test(text)));
});
