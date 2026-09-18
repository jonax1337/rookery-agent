import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

/**
 * The chat highlight as a label channel (concept 4.2b, S6).
 *
 * `useChat.ts` has no `@/` imports, so it is bundled and driven like the
 * other chat-hook tests. `rookery-provider.tsx`, `memory-columns.tsx` and
 * `MemoryListPage.tsx` all pull in the component tree, so their pure logic
 * is instead read out of the real source with the TypeScript compiler and
 * run in isolation - the same route `sleep-phases.test.mjs` and the
 * `VoicePage` status test use.
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

/* --------------------- MemoryListPage.tsx: judging a highlighted row --------------------- */

function loadFeedbackHelpers() {
  const names = ['feedbackKey', 'applyJudgement', 'postMemoryFeedback'];
  const found = readFunctions('pages/MemoryListPage.tsx', names);
  const js = ts.transpileModule(names.map((name) => found[name]).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(js + '\nreturn { feedbackKey, applyJudgement, postMemoryFeedback };')();
}

test('feedbackKey composes a turn and a memory into one tracking key', () => {
  const { feedbackKey } = loadFeedbackHelpers();
  assert.equal(feedbackKey('turn-1', 'mem-1'), 'turn-1:mem-1');
  assert.notEqual(feedbackKey('turn-1', 'mem-2'), feedbackKey('turn-2', 'mem-1'));
});

test('applyJudgement writes a verdict once; a second click on the same row is a no-op', () => {
  const { applyJudgement } = loadFeedbackHelpers();
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
  const { postMemoryFeedback } = loadFeedbackHelpers();
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
