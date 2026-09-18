import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

/**
 * The memories a turn was given, as a label channel (concept 4.2b, S6): the
 * card in the transcript, the highlighted rows on the memory page, and the
 * verdict both of them post.
 *
 * `useChat.ts`, `lib/memory-recall.ts` and `runtime/useRookeryRuntime.ts` have
 * no `@/` imports, so they are bundled and driven like the other chat-hook
 * tests. `rookery-provider.tsx`, `memory-columns.tsx` and `memory-call.tsx`
 * all pull in the component tree, so their pure logic is instead read out of
 * the real source with the TypeScript compiler and run in isolation - the same
 * route `sleep-phases.test.mjs` and the `VoicePage` status test use.
 */

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

/** Read one top-level `function` declaration's own text out of a `.tsx` file. */
function readFunctions(relativePath, names) {
  const source = ts.createSourceFile(
    relativePath,
    readFileSync(new URL('../src/' + relativePath, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found = {};
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.getText(source))) {
      // Strip the `export` keyword these are declared with - the text goes
      // into `new Function`, which runs plain scripts, not ES modules.
      found[node.name.getText(source)] = node.getText(source).replace(/^export\s+/, '');
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const name of names) assert.ok(found[name], relativePath + ' still declares ' + name);
  return found;
}

/* -------------------------- useChat.ts: recalledTurnId -------------------------- */

test('a recall event carries its turnId into chat state, and both clear on the next turn', async () => {
  const { react, reset } = harness();
  const { useChat } = await load('hooks/useChat.ts', { react });
  let callbacks;
  const socket = { send(payload, cb) { callbacks = cb; return 'turn'; }, abort() {} };
  const render = () => { reset(); return useChat(socket, 'session'); };

  let chat = render();
  chat.send({ text: 'hi', provider: 'claude' });
  assert.equal(render().recalledTurnId, null);

  callbacks.onEvent({ type: 'memory', action: 'recalled', count: 1, items: [{ id: 'm1' }], turnId: 'turn-1' });
  chat = render();
  assert.deepEqual(chat.recalled.map((memory) => memory.id), ['m1']);
  assert.equal(chat.recalledTurnId, 'turn-1');

  // A provider that has not caught up to the contract sends no `turnId` -
  // the highlight still renders, just with nothing to post feedback against.
  callbacks.onEvent({ type: 'memory', action: 'recalled', count: 1, items: [{ id: 'm2' }] });
  chat = render();
  assert.equal(chat.recalledTurnId, null);

  callbacks.onEvent({ type: 'memory', action: 'recalled', count: 1, items: [{ id: 'm1' }], turnId: 'turn-1' });
  callbacks.onDone('answer');
  chat = render();
  assert.equal(chat.recalledTurnId, 'turn-1');

  // The next turn starts clean: an old turn's feedback target must not leak
  // onto a fresh recall.
  chat.send({ text: 'again', provider: 'claude' });
  chat = render();
  assert.deepEqual(chat.recalled, []);
  assert.equal(chat.recalledTurnId, null);

  // `reset()` (leaving the conversation) clears it the same way.
  callbacks.onEvent({ type: 'memory', action: 'recalled', count: 1, items: [{ id: 'm3' }], turnId: 'turn-2' });
  chat = render();
  assert.equal(chat.recalledTurnId, 'turn-2');
  chat.reset();
  chat = render();
  assert.equal(chat.recalledTurnId, null);
});

test('a recall becomes a block of the running turn, in the shape the server persists', async () => {
  const { react, reset } = harness();
  const { useChat } = await load('hooks/useChat.ts', { react });
  let callbacks;
  const socket = { send(payload, cb) { callbacks = cb; return 'turn'; }, abort() {} };
  const render = () => { reset(); return useChat(socket, 'session'); };

  let chat = render();
  chat.send({ text: 'how is the migration going', provider: 'claude' });
  callbacks.onEvent({
    type: 'memory', action: 'recalled', count: 2, turnId: 'turn-1',
    items: [
      { id: 'm1', content: 'The user is migrating billing to Fastify.', kind: 'project', importance: 0.8 },
      { id: 'm2', content: 'The user prefers short answers.', kind: 'preference', importance: 0.6 },
    ],
  });
  callbacks.onEvent({ type: 'text', delta: 'Nearly done.' });
  chat = render();

  // Everything a row needs and nothing else - this is stored on every answer.
  assert.deepEqual(chat.parts, [
    {
      type: 'memory',
      turnId: 'turn-1',
      memories: [
        { id: 'm1', content: 'The user is migrating billing to Fastify.' },
        { id: 'm2', content: 'The user prefers short answers.' },
      ],
    },
    { type: 'text', text: 'Nearly done.' },
  ]);

  // And it settles onto the finished message, so the card is there after a
  // reload exactly as it was during the turn.
  callbacks.onDone('Nearly done.');
  chat = render();
  assert.equal(chat.parts.length, 0);
  assert.equal(chat.messages.at(-1).blocks[0].type, 'memory');

  // A turn that recalled nothing writes no block: the transcript says nothing
  // rather than "0 memories".
  chat.send({ text: 'and now', provider: 'claude' });
  callbacks.onEvent({ type: 'memory', action: 'recalled', count: 0, items: [], turnId: 'turn-2' });
  callbacks.onEvent({ type: 'memory', action: 'stored', count: 1, items: [{ id: 'm3', content: 'learned' }] });
  chat = render();
  assert.deepEqual(chat.parts, []);
});

/* ------------------ useRookeryRuntime.ts: the recall as a part ------------------ */

test('a memory block reaches the thread as a standalone part, and an old message as nothing', async () => {
  const { useRookeryRuntime } = await load('runtime/useRookeryRuntime.ts', {
    react: { useMemo: (fn) => fn() },
    '@assistant-ui/react': { useExternalStoreRuntime: (args) => args,
      WebSpeechDictationAdapter: class {}, WebSpeechSynthesisAdapter: class {} },
  });
  const { MEMORY_RECALL_TOOL } = await load('lib/memory-recall.ts', {});
  const blocks = [
    { type: 'memory', turnId: 'turn-1', memories: [{ id: 'm1', content: 'Billing moves to Fastify.' }] },
    { type: 'text', text: 'Nearly done.' },
  ];
  const runtime = useRookeryRuntime({
    chat: { messages: [{ role: 'assistant', content: 'Nearly done.', blocks }], busy: false },
    sessions: { sessions: [], activeId: 'session' },
  });

  const message = runtime.convertMessage(runtime.messages[0]);
  const [card, answer] = message.content;
  assert.equal(card.type, 'tool-call');
  assert.equal(card.toolName, MEMORY_RECALL_TOOL);
  assert.equal(card.args.turnId, 'turn-1');
  assert.deepEqual(card.args.memories, [{ id: 'm1', content: 'Billing moves to Fastify.' }]);
  // A result, so the card reads as the finished thing it is even mid-turn.
  assert.equal(card.result, 1);
  assert.deepEqual(answer, { type: 'text', text: 'Nearly done.' });

  // A turn from before any of this existed has no memory block, and so shows
  // no card at all - not an empty one.
  const old = runtime.convertMessage({ id: 'old', role: 'assistant', content: 'Nearly done.' });
  assert.equal(old.content.filter((part) => part.type === 'tool-call').length, 0);

  // A block without a turn id still renders; there is simply nothing to post
  // a verdict against, which the card reads off the missing `turnId`.
  const anonymous = runtime.convertMessage({
    id: 'anon', role: 'assistant', content: '',
    blocks: [{ type: 'memory', memories: [{ id: 'm1', content: 'no turn' }] }],
  });
  assert.equal(anonymous.content[0].args.turnId, undefined);
});

/* ---------------------- rookery-provider.tsx: highlightFromRecall ---------------------- */

function loadHighlightFromRecall() {
  const { highlightFromRecall } = readFunctions('providers/rookery-provider.tsx', ['highlightFromRecall']);
  const js = ts.transpileModule(highlightFromRecall, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(js + '\nreturn highlightFromRecall;')();
}

test('highlightFromRecall reduces a batch to its ids and carries the turn reference through', () => {
  const highlightFromRecall = loadHighlightFromRecall();
  const result = highlightFromRecall([{ id: 'a' }, { id: 'b' }], 'turn-1');
  assert.deepEqual([...result.ids], ['a', 'b']);
  assert.equal(result.turnId, 'turn-1');

  const empty = highlightFromRecall([], null);
  assert.equal(empty.ids.size, 0);
  assert.equal(empty.turnId, null);
});

/* ------------------------ memory-columns.tsx: the feedback column ------------------------ */

function loadFeedbackColumnBlock() {
  const file = 'components/common/memory-columns.tsx';
  const source = ts.createSourceFile(
    file,
    readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let block;
  function visit(node) {
    if (ts.isIfStatement(node) && node.expression.getText(source) === 'feedback') block = node.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(block, 'memory-columns.tsx still guards the feedback column with `if (feedback)`');
  return block;
}

test('MEMORY_COLUMN_LABELS names the feedback column', () => {
  const source = readFileSync(new URL('../src/components/common/memory-columns.tsx', import.meta.url), 'utf8');
  assert.match(source, /feedback:\s*'Feedback'/);
});

test('the feedback column is added only with a builder, and falls back to the empty cell', () => {
  const block = loadFeedbackColumnBlock();
  const js = ts.transpileModule(block, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;

  const run = (feedback) => {
    const column = { display: (definition) => definition };
    const columns = [];
    const emptyCell = (align) => ({ empty: align });
    const DataTableColumnHeader = () => null;
    const React = { createElement: () => null };
    new Function('column', 'columns', 'feedback', 'emptyCell', 'DataTableColumnHeader', 'React', js)(
      column, columns, feedback, emptyCell, DataTableColumnHeader, React,
    );
    return columns;
  };

  // No builder: no column, and no always-empty "Feedback" header either.
  assert.deepEqual(run(undefined), []);

  const memory = { id: 'm1' };
  const withVote = run((row) => ({ voted: row.id }));
  assert.equal(withVote.length, 1);
  assert.equal(withVote[0].id, 'feedback');
  assert.deepEqual(withVote[0].cell({ row: { original: memory } }), { voted: 'm1' });

  // A row the builder has nothing to say about (not this turn's recall)
  // reads as the column's own empty cell, not a missing vote.
  const withoutVote = run(() => null);
  assert.deepEqual(withoutVote[0].cell({ row: { original: memory } }), { empty: 'start' });
});

/* --------------------- lib/memory-recall.ts: judging a delivered row --------------------- */

async function loadFeedbackHelpers() {
  return load('lib/memory-recall.ts', {});
}

test('feedbackKey composes a turn and a memory into one tracking key', async () => {
  const { feedbackKey } = await loadFeedbackHelpers();
  assert.equal(feedbackKey('turn-1', 'mem-1'), 'turn-1:mem-1');
  assert.notEqual(feedbackKey('turn-1', 'mem-2'), feedbackKey('turn-2', 'mem-1'));
});

test('applyJudgement writes a verdict once; a second click on the same row is a no-op', async () => {
  const { applyJudgement } = await loadFeedbackHelpers();
  const first = applyJudgement({}, 'turn-1', 'mem-1', 'point');
  assert.deepEqual(first, { 'turn-1:mem-1': 'point' });

  // A second click - even the opposite verdict - must not silently write a
  // second label: the map comes back unchanged, same reference included, so
  // the row keeps showing exactly what was already said.
  const second = applyJudgement(first, 'turn-1', 'mem-1', 'ballast');
  assert.equal(second, first);
  assert.deepEqual(second, { 'turn-1:mem-1': 'point' });

  // A different memory, or the same memory in a different turn, is a fresh key.
  const third = applyJudgement(second, 'turn-1', 'mem-2', 'ballast');
  assert.deepEqual(third, { 'turn-1:mem-1': 'point', 'turn-1:mem-2': 'ballast' });
});

test('postMemoryFeedback posts the turn reference and verdict, and throws on a failed response', async (t) => {
  const { postMemoryFeedback } = await loadFeedbackHelpers();
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });

  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true }; };
  await postMemoryFeedback('mem 1', 'turn-1', 'point');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/memories/mem%201/feedback');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { turnId: 'turn-1', verdict: 'point' });

  globalThis.fetch = async () => ({ ok: false });
  await assert.rejects(() => postMemoryFeedback('mem-1', 'turn-1', 'ballast'));
});

/* ------------------------ memory-call.tsx: the card in the thread ------------------------ */

test('the card is the tool-call template, judges through the shared rule, and never says "0 memories"', () => {
  const source = readFileSync(new URL('../src/components/assistant-ui/elements/memory-call.tsx', import.meta.url), 'utf8');

  // The same object a tool call is, down to the trigger: the panel rows are
  // passed as the template's children, never as a second card of its own.
  assert.match(source, /import \{ ToolCall \} from "\.\/tool-call"/);
  assert.match(source, /<ToolCall\b/);

  // One verdict per (turn, memory), through the one implementation of it.
  assert.match(source, /from "@\/lib\/memory-recall"/);
  for (const name of ['feedbackKey', 'applyJudgement', 'postMemoryFeedback']) {
    assert.ok(source.includes(name), 'the card reuses ' + name);
  }

  // Singular, plural, and nothing at all.
  assert.match(source, /'1 memory used'/);
  assert.match(source, /' memories used'/);
  assert.match(source, /if \(!memories\.length\) return null;/);

  // A row already judged reads back what was said instead of voting again.
  assert.match(source, /if \(verdict\) \{/);

  // Icons, not words. The question is put to every delivered row, and a pair
  // of labelled buttons per row shouts louder than the sentence being judged.
  assert.match(source, /ThumbsUpIcon/);
  assert.match(source, /ThumbsDownIcon/);
  assert.match(source, /TooltipIconButton/);
  assert.ok(
    !/Was the point|Was ballast/.test(source),
    'the control carries no shouted label beside every row',
  );
  // Icon-only still has to say what it does out loud.
  assert.match(source, /tooltip=\{/);
  assert.match(source, /sr-only/);
});

test('the card registers itself by name, standalone, so it is not folded into the tool group', async () => {
  const source = readFileSync(new URL('../src/components/assistant-ui/elements/memory-call.tsx', import.meta.url), 'utf8');
  assert.match(source, /makeAssistantToolUI/);
  assert.match(source, /toolName: MEMORY_RECALL_TOOL/);
  assert.match(source, /display: "standalone"/);

  // The name is the one the transcript actually mints the part under.
  const { MEMORY_RECALL_TOOL } = await load('lib/memory-recall.ts', {});
  assert.equal(MEMORY_RECALL_TOOL, 'rookery:memory-recall');

  // And it is mounted where the thread is, or nothing would render it.
  const page = readFileSync(new URL('../src/pages/ChatPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /<MemoryRecallToolUI \/>/);
});
