import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Assistant, ProviderRegistry, Store, toolsFor } from '../dist/index.js';

/**
 * `ask_user`: the one tool call that computes nothing and waits for a person.
 *
 * The tool handler is driven directly here rather than through a provider.
 * What matters is the waiting itself - that an answer releases the call, that
 * a silence releases it too instead of hanging a turn until the provider's own
 * six-hour tool timeout, and that an aborted turn does not leave a question
 * standing with nobody left to receive the answer.
 */

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

function createAssistant(overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'rookery-ask-'));
  mkdirSync(join(home, 'run'), { recursive: true });
  const assistant = new Assistant({
    store: new Store(':memory:'),
    registry: new ProviderRegistry([]),
    config: {
      home,
      logLevel: 'silent',
      memory: { enabled: false, autoExtract: false },
      org: { autoReview: false },
      ...overrides,
    },
  });
  openAssistants.push(assistant);
  return assistant;
}

/** A turn's tool context, with the events it would have streamed collected. */
function turnContext(assistant, extra = {}) {
  const events = [];
  const context = {
    orgId: assistant.org.activeOrganization().id,
    audience: 'assistant',
    depth: -1,
    emit: (event) => events.push(event),
    ...extra,
  };
  return { context, events };
}

const ASK = {
  header: 'Deploy target',
  question: 'Which environment should this go to?',
  options: [
    { label: 'Staging', description: 'safe, throwaway' },
    { label: 'Production', description: 'the real one' },
  ],
};

test('an answer releases the waiting tool call and names what was chosen', async () => {
  const assistant = createAssistant();
  const { context, events } = turnContext(assistant);

  const call = assistant.org.handle(context, 'ask_user', ASK);

  const asked = events.find((event) => event.type === 'question');
  assert.ok(asked, "the card goes out on the asking turn's stream before anything is awaited");
  assert.equal(asked.header, 'Deploy target');
  assert.equal(asked.multiSelect, false);
  assert.ok(asked.expiresAt > Date.now(), 'the card carries its own deadline');
  assert.deepEqual(
    assistant.questions.pending().map((entry) => entry.id),
    [asked.id],
    'the question is open until somebody settles it',
  );

  assert.equal(assistant.questions.answer(asked.id, { selected: [1], source: 'web' }), true);
  const result = await call;

  assert.ok(!result.isError);
  assert.match(result.text, /Production/);
  assert.deepEqual(assistant.questions.pending(), [], 'answering closes it');

  const closed = events.find((event) => event.type === 'question-closed');
  assert.equal(closed.reason, 'answered');
  assert.equal(closed.id, asked.id);
  assert.deepEqual(closed.answer.selected, [1]);
  assert.ok(closed.answer.at, 'the registry stamps when the answer arrived');

  // A second click, from the phone a moment later, finds nothing to settle
  // and says so rather than throwing at whoever delivered it.
  assert.equal(assistant.questions.answer(asked.id, { selected: [0] }), false);
  assistant.close();
});

test('a free-text answer with no option picked still comes back as an answer', async () => {
  const assistant = createAssistant();
  const { context, events } = turnContext(assistant);
  const call = assistant.org.handle(context, 'ask_user', ASK);
  const asked = events.find((event) => event.type === 'question');

  assistant.questions.answer(asked.id, { selected: [], text: 'Neither - hold off until Friday.' });
  const result = await call;

  assert.match(result.text, /hold off until Friday/);
  assistant.close();
});

test('an answer that says nothing usable leaves the question open', async () => {
  const assistant = createAssistant();
  const { context, events } = turnContext(assistant);
  const call = assistant.org.handle(context, 'ask_user', ASK);
  const asked = events.find((event) => event.type === 'question');

  assert.equal(assistant.questions.answer(asked.id, { selected: [] }), false, 'no pick, no words');
  assert.equal(assistant.questions.answer(asked.id, { selected: [7] }), false, 'an index nobody was offered');
  assert.equal(assistant.questions.answer(asked.id, { selected: [1.5] }), false);
  assert.equal(assistant.questions.pending().length, 1, 'still waiting for a real answer');

  // Single select: a client that sends two picks gets the first one taken,
  // not both, because the question said one.
  assert.equal(assistant.questions.answer(asked.id, { selected: [0, 1] }), true);
  const result = await call;
  assert.match(result.text, /Staging/);
  assert.ok(!/Production/.test(result.text));
  assistant.close();
});

test('nobody answers: the call comes back saying so instead of hanging', async () => {
  const assistant = createAssistant({ questions: { timeoutMs: 40 } });
  const { context, events } = turnContext(assistant);

  const result = await assistant.org.handle(context, 'ask_user', ASK);

  assert.ok(!result.isError, 'a silence is not an error - the turn carries on');
  assert.match(result.text, /No answer within/);
  assert.deepEqual(assistant.questions.pending(), []);
  assert.equal(events.find((event) => event.type === 'question-closed').reason, 'expired');
  assistant.close();
});

test('an aborted turn takes its question with it', async () => {
  const assistant = createAssistant();
  const abort = new AbortController();
  const { context, events } = turnContext(assistant, { signal: abort.signal });

  const call = assistant.org.handle(context, 'ask_user', ASK);
  const asked = events.find((event) => event.type === 'question');
  assert.equal(assistant.questions.pending().length, 1);

  abort.abort();
  const result = await call;

  assert.match(result.text, /cancelled/i);
  assert.deepEqual(assistant.questions.pending(), [], 'no orphan left behind for the timeout to find');
  assert.equal(events.find((event) => event.type === 'question-closed').reason, 'cancelled');
  assert.equal(assistant.questions.answer(asked.id, { selected: [0] }), false);
  assistant.close();
});

test('a turn that was already aborted never opens a question at all', async () => {
  const assistant = createAssistant();
  const abort = new AbortController();
  abort.abort();
  const { context, events } = turnContext(assistant, { signal: abort.signal });

  const result = await assistant.org.handle(context, 'ask_user', ASK);

  assert.match(result.text, /cancelled/i);
  assert.equal(events.filter((event) => event.type === 'question').length, 0);
  assert.deepEqual(assistant.questions.pending(), []);
  assistant.close();
});

test('the question is rejected before it is opened when it is malformed', async () => {
  const assistant = createAssistant();
  const { context, events } = turnContext(assistant);

  const one = await assistant.org.handle(context, 'ask_user', { ...ASK, options: [{ label: 'Only this' }] });
  assert.equal(one.isError, true);

  const five = await assistant.org.handle(context, 'ask_user', {
    ...ASK,
    options: ['a', 'b', 'c', 'd', 'e'],
  });
  assert.equal(five.isError, true);

  assert.equal(events.length, 0, 'nothing reaches a screen that nobody could answer');
  assert.deepEqual(assistant.questions.pending(), []);
  assistant.close();
});

test('an agent cannot ask, and a scheduled run is not even offered the tool', async () => {
  const assistant = createAssistant();
  const { context } = turnContext(assistant, { audience: 'agent', agentId: 'x', depth: 0 });
  const refused = await assistant.org.handle(context, 'ask_user', ASK);
  assert.equal(refused.isError, true);

  const scheduled = turnContext(assistant, { scheduled: true });
  const stalled = await assistant.org.handle(scheduled.context, 'ask_user', ASK);
  assert.equal(stalled.isError, true);
  assert.deepEqual(assistant.questions.pending(), []);

  assert.ok(toolsFor('assistant').some((tool) => tool.name === 'ask_user'));
  assert.ok(!toolsFor('agent').some((tool) => tool.name === 'ask_user'));
  assert.ok(
    !toolsFor('assistant', { scheduled: true }).some((tool) => tool.name === 'ask_user'),
    'at four in the morning there is nobody to ask',
  );
  // Nothing else is lost to a scheduled run.
  assert.deepEqual(
    toolsFor('assistant', { scheduled: true }).map((tool) => tool.name),
    toolsFor('assistant').map((tool) => tool.name).filter((name) => name !== 'ask_user'),
  );
  assistant.close();
});

test('closing the runtime settles whatever was still waiting on a person', async () => {
  const assistant = createAssistant();
  const { context, events } = turnContext(assistant);
  const call = assistant.org.handle(context, 'ask_user', ASK);
  assert.equal(assistant.questions.pending().length, 1);

  assistant.close();
  const result = await call;

  assert.match(result.text, /No answer|cancelled/i);
  assert.equal(events.find((event) => event.type === 'question-closed').reason, 'cancelled');
  assert.deepEqual(assistant.questions.pending(), []);
});
