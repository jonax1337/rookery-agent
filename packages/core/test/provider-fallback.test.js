import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Assistant,
  ProviderRegistry,
  Store,
  isUsageLimitError,
  providerBlocked,
  providerLow,
  rememberQuota,
  rememberUsageFailure,
  rememberUsageRecovered,
  remapModel,
} from '../dist/index.js';

/**
 * Provider fallback, from the pieces up: the error classifier, the quota
 * gate, the model remap, the registry's routing, and the two retries
 * (assignment and chat) that keep work alive when a provider runs dry.
 *
 * Nothing here talks to a real CLI. Two constraints shape the ids:
 *
 * - Quota state is module-global per process, so the gate tests use
 *   throwaway ids no other file knows. The ids `claude` and `codex` carry
 *   state between tests, which is why every test that wants them usable
 *   clears them first.
 * - The plain registry tests can use any id, but everything through an
 *   `Assistant` (or a `sync`) cannot: both rebuild the map down to the
 *   built-ins and the configured profiles, so a fake named `p-dead` would
 *   be gone before its first turn. Those tests play the two built-in ids,
 *   with `codex` as the stand-in for a second signed-in provider.
 */

const USAGE_FATAL = 'API Error: 429 You have reached your usage limit, please wait';

/**
 * A scripted provider: answers normally, or dies fatally on every run.
 * `usage-dead` reports the phrasing a CLI sends when its quota is spent,
 * `boom` an ordinary failure the retry must not pick up.
 */
function createFake(id, behaviour = 'ok') {
  const runs = [];
  const provider = {
    id,
    displayName: 'Fake ' + id,
    models: () => ['fake'],
    async status() {
      return { id, available: true, binary: 'fake', authenticated: true };
    },
    async *run(opts) {
      runs.push(opts);
      if (behaviour === 'usage-dead') {
        yield { type: 'error', message: USAGE_FATAL, fatal: true };
        return;
      }
      if (behaviour === 'boom') {
        yield { type: 'error', message: 'boom', fatal: true };
        return;
      }
      const text = 'OUTPUT(' + (opts.prompt ?? '').slice(0, 40) + ')';
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
      // already closed by the test
    }
  }
});

function createAssistant(providers, overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'rookery-fallback-'));
  mkdirSync(join(home, 'run'), { recursive: true });
  const assistant = new Assistant({
    store: new Store(':memory:'),
    registry: new ProviderRegistry(providers),
    config: {
      home,
      logLevel: 'silent',
      memory: { enabled: false, autoExtract: false },
      org: { autoReview: false },
      ...overrides,
    },
  });
  openAssistants.push(assistant);
  return { assistant, store: assistant.store, home };
}

function hire(assistant, input) {
  const org = assistant.org.activeOrganization();
  return assistant.store.org.createAgent({ orgId: org.id, instructions: 'Do the work.', title: 'Engineer', ...input });
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

function window(percent, resetsAt) {
  return { kind: 'session', label: '5 hours', percent, ...(resetsAt ? { resetsAt } : {}) };
}

/* ------------------------------ classifier ------------------------------ */

test('isUsageLimitError matches the phrases the CLIs report and nothing else', () => {
  for (const message of [
    "You've reached your usage limit, it resets at 5pm",
    USAGE_FATAL,
    'rate limit exceeded, retry after 60s',
    'monthly quota exceeded',
    'insufficient credit balance',
    'limit reached for this window',
  ]) {
    assert.ok(isUsageLimitError(message), message);
  }
  for (const message of [
    'boom',
    'The claude CLI is not on PATH.',
    '4290 files changed',
    'tool failed: permission denied',
  ]) {
    assert.equal(isUsageLimitError(message), false, message);
  }
});

/* --------------------------------- gate --------------------------------- */

test('a full window with a future reset blocks; a past one never does', () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  rememberQuota({ provider: 'gate-full', fetchedAt: Date.now(), windows: [window(100, future)] });
  const blocked = providerBlocked('gate-full');
  assert.equal(blocked?.reason, 'limit');
  assert.equal(new Date(blocked.until).getTime(), Date.parse(future));

  const past = new Date(Date.now() - 60 * 1000).toISOString();
  rememberQuota({ provider: 'gate-past', fetchedAt: Date.now(), windows: [window(100, past)] });
  assert.equal(providerBlocked('gate-past'), null, 'a reset time that has passed unblocks');

  rememberQuota({ provider: 'gate-room', fetchedAt: Date.now(), windows: [window(80, future)] });
  assert.equal(providerBlocked('gate-room'), null);
});

test('a turn that died on quota parks its provider until a healthy read clears it', () => {
  rememberUsageFailure('gate-fail');
  const blocked = providerBlocked('gate-fail');
  assert.equal(blocked?.reason, 'failure');
  assert.ok(new Date(blocked.until).getTime() > Date.now());

  // A live window with headroom proves the provider takes turns again.
  rememberQuota({ provider: 'gate-fail', fetchedAt: Date.now(), windows: [window(40)] });
  assert.equal(providerBlocked('gate-fail'), null);
});

test('rememberUsageRecovered forgets a failure by hand', () => {
  rememberUsageFailure('gate-recover');
  rememberUsageRecovered('gate-recover');
  assert.equal(providerBlocked('gate-recover'), null);
});

/* ------------------------------- threshold ------------------------------- */

test('a window at or above the threshold counts as low; unknown quota never does', () => {
  rememberQuota({ provider: 'gate-low', fetchedAt: Date.now(), windows: [window(96)] });
  assert.equal(providerLow('gate-low', 95), true);
  assert.equal(providerLow('gate-low', 100), false);
  assert.equal(providerLow('gate-nothing', 95), false, 'unknown is not nearly-empty');
});

/* --------------------------------- remap --------------------------------- */

test('remapModel translates a model the target does not serve', () => {
  assert.equal(remapModel('claude', 'glm-5.3'), undefined, 'a GLM name on the claude login becomes the CLI default');
  assert.equal(remapModel('glm', 'glm-5.3'), 'glm-5.3');
  assert.equal(remapModel('glm', 'sonnet'), 'glm-5.3', "somebody else's model becomes the target default");
  assert.equal(remapModel('claude', undefined), undefined);
  assert.equal(remapModel('claude', 'mystery-model'), 'mystery-model', 'a name nobody knows passes through');
});

/* -------------------------------- routing -------------------------------- */

function registryOf(...fakes) {
  const registry = new ProviderRegistry(fakes.map((fake) => fake.provider));
  return registry;
}

test('resolveUsable routes around a failed provider and back when it recovers', async () => {
  const registry = registryOf(createFake('p-a'), createFake('p-b'));
  assert.equal(await registry.resolveUsable('p-a'), 'p-a');
  rememberUsageFailure('p-a');
  assert.equal(await registry.resolveUsable('p-a'), 'p-b');
  assert.equal(await registry.resolveUsable('p-a', { exclude: ['p-a', 'p-b'] }), null, 'excluded is out of the race entirely');
  rememberUsageRecovered('p-a');
  assert.equal(await registry.resolveUsable('p-a'), 'p-a');
});

test('a nearly-full provider is passed over while a roomier one is signed in', async () => {
  const registry = registryOf(createFake('p-low'), createFake('p-roomy'));
  rememberQuota({ provider: 'p-low', fetchedAt: Date.now(), windows: [window(97)] });
  assert.equal(await registry.resolveUsable('p-low'), 'p-roomy');
  // All low is not out: with nothing roomier, the preferred one stays usable.
  rememberQuota({ provider: 'p-roomy', fetchedAt: Date.now(), windows: [window(99)] });
  assert.equal(await registry.resolveUsable('p-low'), 'p-low');
});

/*
  `sync` rebuilds the map down to the built-ins plus the configured
  profiles, so only `claude` and `codex` survive it - which caps these
  tests at two providers. That is enough to prove the settings a sync
  stashes are the ones routing uses (the thing the config PATCH route
  depends on); the candidate order itself is exercised above through the
  map order, which is the same walk.
*/
test('the fallback settings a sync stashes are the ones routing uses', async () => {
  const registry = registryOf(createFake('claude'), createFake('codex'));
  registry.sync({
    providerProfiles: [],
    providerFallback: { enabled: true, thresholdPercent: 95, order: ['codex'] },
  });
  rememberUsageFailure('claude');
  assert.equal(await registry.resolveUsable('claude'), 'codex');
  rememberUsageRecovered('claude');
});

test('with fallback switched off, a blocked provider is chosen anyway', async () => {
  const registry = registryOf(createFake('claude'), createFake('codex'));
  registry.sync({
    providerProfiles: [],
    providerFallback: { enabled: false, thresholdPercent: 95, order: [] },
  });
  rememberUsageFailure('claude');
  assert.equal(await registry.resolveUsable('claude'), 'claude');
  rememberUsageRecovered('claude');
});

/* ----------------------------- assignment retry ----------------------------- */

test('an assignment whose provider dies on quota continues on the next one', async () => {
  rememberUsageRecovered('claude');
  const dead = createFake('claude', 'usage-dead');
  const live = createFake('codex');
  const { assistant } = createAssistant([dead.provider, live.provider], { defaultProvider: 'claude' });
  const mara = hire(assistant, { name: 'Mara', provider: 'claude' });

  const events = await collect(assistant.assign({ agent: mara.id, task: 'write the parser' }));
  const view = events.filter((event) => event.type === 'assignment').map((event) => event.assignment).at(-1);
  assert.equal(view.status, 'done');
  assert.equal(view.provider, 'codex', 'the record shows who actually ran it');
  assert.equal(dead.runs.length, 1, 'the dead provider was started exactly once');
  assert.equal(live.runs.length, 1);
  assert.ok(
    events.some(
      (event) =>
        event.type === 'status' && event.label === 'provider' && /claude hit its usage limit, continuing on codex/.test(event.detail ?? ''),
    ),
    'the switch says so in the event stream',
  );

  // The dead provider is parked now: the next assignment goes straight through.
  const second = await collect(assistant.assign({ agent: mara.id, task: 'write the tests' }));
  const secondView = second.filter((event) => event.type === 'assignment').map((event) => event.assignment).at(-1);
  assert.equal(secondView.status, 'done');
  assert.equal(secondView.provider, 'codex');
  assert.equal(dead.runs.length, 1, 'still exactly one run on the dead provider');
});

test('a fatal error that is not a usage limit fails the assignment without a retry', async () => {
  rememberUsageRecovered('claude');
  const dead = createFake('claude', 'boom');
  const live = createFake('codex');
  const { assistant } = createAssistant([dead.provider, live.provider], { defaultProvider: 'claude' });
  const mara = hire(assistant, { name: 'Mara', provider: 'claude' });

  const events = await collect(assistant.assign({ agent: mara.id, task: 'write the parser' }));
  const view = events.filter((event) => event.type === 'assignment').map((event) => event.assignment).at(-1);
  assert.equal(view.status, 'failed');
  assert.match(view.error, /boom/);
  assert.equal(live.runs.length, 0, 'an ordinary failure never reaches the second provider');
});

test('when every provider is out of quota the assignment fails once, with one system review', async () => {
  rememberUsageRecovered('claude');
  const deadA = createFake('claude', 'usage-dead');
  const deadB = createFake('codex', 'usage-dead');
  const { assistant, store } = createAssistant([deadA.provider, deadB.provider], { defaultProvider: 'claude' });
  const mara = hire(assistant, { name: 'Mara', provider: 'claude' });

  const events = await collect(assistant.assign({ agent: mara.id, task: 'write the parser' }));
  const view = events.filter((event) => event.type === 'assignment').map((event) => event.assignment).at(-1);
  assert.equal(view.status, 'failed');
  assert.match(view.error, /usage limit/);
  assert.equal(deadA.runs.length, 1);
  assert.equal(deadB.runs.length, 1, 'the second provider got its one attempt');
  const reviews = store.org.reviewsForAssignment(view.id);
  assert.equal(reviews.filter((review) => review.failedRun).length, 1, 'exactly one failedRun review, not one per attempt');
});

/* -------------------------------- chat retry -------------------------------- */

test('a chat turn whose provider dies on quota finishes on the next one and stays there', async () => {
  // Both ids carry parked state from the assignment tests above.
  rememberUsageRecovered('claude');
  rememberUsageRecovered('codex');
  const dead = createFake('claude', 'usage-dead');
  const live = createFake('codex');
  const { assistant, store } = createAssistant([dead.provider, live.provider], { defaultProvider: 'claude' });

  const events = await collect(assistant.chat({ text: 'hello there' }));
  const session = events.find((event) => event.type === 'session');
  const done = events.find((event) => event.type === 'done');
  assert.ok(done, 'the turn finished');
  assert.match(done.text, /OUTPUT/);
  assert.ok(
    events.some(
      (event) => event.type === 'status' && event.label === 'provider' && /claude hit its usage limit, continuing on codex/.test(event.detail ?? ''),
    ),
    'the switch says so in the event stream',
  );
  assert.equal(store.getSession(session.sessionId).provider, 'codex', 'the session sticks to the fallback');
  const messages = store.getMessages(session.sessionId);
  assert.equal(messages.filter((message) => message.role === 'user').length, 1, 'the user message was stored exactly once');
});
