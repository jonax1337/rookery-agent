import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { fileURLToPath } from 'node:url';

async function load(file, bindings) {
  const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../src/' + file, import.meta.url))], bundle: true,
    write: false, platform: 'node', format: 'cjs', packages: 'external' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputFiles[0].text)((name) => bindings[name] ?? require(name), module, module.exports);
  return module.exports;
}

/** The same hand-rolled hook harness the other chat tests use. */
function harness() {
  let slots = [], index = 0;
  const react = {
    useState(value) { const slot = index++; if (!(slot in slots)) slots[slot] = value;
      return [slots[slot], (next) => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next; }]; },
    useRef(value) { const slot = index++; return slots[slot] ??= { current: value }; },
    useCallback(fn) { return fn; }, useMemo(fn) { return fn(); },
  };
  return { react, reset: () => { index = 0; } };
}

const asked = (id, extra = {}) => ({
  type: 'question', id, header: 'Scope', question: 'Which project?',
  options: [{ label: 'Rookery' }, { label: 'Nimbus', description: 'the other one' }],
  multiSelect: false, expiresAt: 1_000, ...extra,
});

test('a question is merged by id, whichever way it arrived', async () => {
  const { mergeQuestion } = await load('hooks/useChat.ts', { react: harness().react });
  const first = [];
  const once = mergeQuestion(first, asked('q1'));
  assert.equal(once.length, 1);
  assert.deepEqual(first, []);
  // The stream and the broadcast carry the same question: one card, and the
  // newer copy wins so a moved deadline moves rather than duplicates.
  const twice = mergeQuestion(once, asked('q1', { expiresAt: 2_000 }));
  assert.equal(twice.length, 1);
  assert.equal(twice[0].expiresAt, 2_000);
  assert.equal(mergeQuestion(twice, asked('q2')).length, 2);
});

test('a question waits inside a running turn and leaves when it is closed', async () => {
  const { react, reset } = harness();
  const { useChat } = await load('hooks/useChat.ts', { react });
  let callbacks;
  const sent = [];
  const socket = {
    send(payload, cb) { callbacks = cb; return 'turn'; },
    abort() {},
    answer(id, body) { sent.push({ id, body }); return true; },
  };
  const render = () => { reset(); return useChat(socket, 'session'); };
  let chat = render();
  chat.send({ text: 'do it', provider: 'claude' });

  callbacks.onEvent({ type: 'question', id: 'q1', ...asked('q1') });
  chat = render();
  assert.equal(chat.questions.length, 1);
  assert.equal(chat.questions[0].question, 'Which project?');
  // The turn is not over - it is standing in front of the question.
  assert.equal(chat.busy, true);
  assert.equal(chat.messages.length, 1);

  // The broadcast for the same question adds no second card.
  chat.openQuestion(asked('q1', { expiresAt: 2_000 }));
  chat = render();
  assert.equal(chat.questions.length, 1);
  assert.equal(chat.questions[0].expiresAt, 2_000);

  // Answering goes over the socket, blank free text is dropped, and the card
  // goes at once rather than waiting for the broadcast.
  await chat.answerQuestion('q1', { selected: [1], text: '   ' });
  chat = render();
  assert.deepEqual(sent, [{ id: 'q1', body: { selected: [1] } }]);
  assert.equal(chat.questions.length, 0);
  assert.equal(chat.busy, true);

  // A close for a question nobody is showing any more changes nothing, and a
  // turn that ends after its question leaves the transcript intact.
  callbacks.onEvent({ type: 'question-closed', id: 'q1', reason: 'answered' });
  chat = render();
  assert.equal(chat.questions.length, 0);
  callbacks.onDone('answered');
  chat = render();
  assert.equal(chat.busy, false);
  assert.equal(chat.messages.at(-1).content, 'answered');

  // A question the assistant asks from somewhere else survives `reset`: the
  // turn waiting on it is not this conversation's to abandon.
  chat.openQuestion(asked('q2'));
  chat.reset();
  chat = render();
  assert.equal(chat.questions.length, 1);
  chat.closeQuestion('q2');
  assert.equal(render().questions.length, 0);
});

test('a closed socket posts the answer instead of losing it, and a failed post keeps the card', async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const { react, reset } = harness();
  const { useChat } = await load('hooks/useChat.ts', { react });
  const socket = { send() { return 'turn'; }, abort() {}, answer() { return false; } };
  const render = () => { reset(); return useChat(socket, 'session'); };
  let chat = render();
  chat.openQuestion(asked('q 1'));

  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({}) }; };
  await chat.answerQuestion('q 1', { selected: [], text: 'in my own words' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/questions/q%201/answer');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { selected: [], text: 'in my own words' });
  assert.equal(render().questions.length, 0);

  chat = render();
  chat.openQuestion(asked('q2'));
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
  await assert.rejects(() => chat.answerQuestion('q2', { selected: [0] }));
  // Nothing got through, so the card stays and the answer can be given again.
  assert.equal(render().questions.length, 1);
});

test('the reload fetch reads either response shape and ignores rows that are not questions', async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const { fetchOpenQuestions } = await load('hooks/useChat.ts', { react: harness().react });

  // A stored request has no `type`; the card needs one, so it is filled in.
  const row = { id: 'q1', header: 'Scope', question: 'Which project?', options: [], multiSelect: false, expiresAt: 5 };
  globalThis.fetch = async () => ({ ok: true, json: async () => [row, { id: 'broken' }, null, 'nonsense'] });
  const bare = await fetchOpenQuestions();
  assert.deepEqual(bare, [{ ...row, type: 'question' }]);

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ questions: [row] }) });
  assert.equal((await fetchOpenQuestions()).length, 1);

  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  assert.deepEqual(await fetchOpenQuestions(), []);

  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
  await assert.rejects(() => fetchOpenQuestions());
});

test('the countdown speaks in minutes and falls silent once the time is up', async () => {
  // The card itself needs a browser; the label it prints does not, so only
  // that function is lifted out of the file, by the same AST route the voice
  // test uses. Every `@/…` import the card makes is stubbed away: nothing but
  // the arithmetic runs here.
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('../src/components/common/question-card.tsx', import.meta.url))],
    bundle: false, write: false, platform: 'node', format: 'cjs', outdir: 'out',
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputFiles[0].text)(
    (name) => (name === 'react' ? require('react') : {}), module, module.exports);
  const { remainingLabel } = module.exports;
  const now = 1_700_000_000_000;
  assert.equal(remainingLabel(now + 9 * 60_000, now), '9 minutes left');
  assert.equal(remainingLabel(now + 60_000, now), '1 minute left');
  assert.equal(remainingLabel(now + 5_000, now), 'less than a minute left');
  assert.equal(remainingLabel(now - 1, now), null);
  assert.equal(remainingLabel(0, now), null);
});
