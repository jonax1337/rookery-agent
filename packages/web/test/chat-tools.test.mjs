import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

async function load(file, bindings) {
  const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../src/' + file, import.meta.url))], bundle: true,
    write: false, platform: 'node', format: 'cjs', packages: 'external' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputFiles[0].text)((name) => bindings[name] ?? require(name), module, module.exports);
  return module.exports;
}

test('tools survive streaming, completion, the next turn and transcript reload despite the old opt-out', async (t) => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => '0' } });
  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete globalThis.localStorage;
  });
  let slots = [], index = 0, callbacks;
  const react = {
    useState(value) { const slot = index++; if (!(slot in slots)) slots[slot] = value;
      return [slots[slot], (next) => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next; }]; },
    useRef(value) { const slot = index++; return slots[slot] ??= { current: value }; },
    useCallback(fn) { return fn; }, useMemo(fn) { return fn(); },
  };
  const { useChat } = await load('hooks/useChat.ts', { react });
  const socket = { send(payload, cb) { callbacks = cb; return 'turn'; }, abort() {} };
  const render = () => { index = 0; return useChat(socket, 'session'); };
  let chat = render(); chat.send({ text: 'hello', provider: 'claude' });
  const events = [
    { type: 'tool', name: 'mcp__notes__search', id: 'a', status: 'start', detail: 'query' },
    { type: 'tool', name: 'tool', id: 'a', status: 'end', result: 'found' },
  ];
  for (const event of events) callbacks.onEvent(event);
  assert.deepEqual(render().toolCalls, events);
  callbacks.onDone('answer'); chat = render();
  assert.deepEqual(chat.messages[1].toolCalls, events);
  const saved = JSON.parse(JSON.stringify(chat.messages));
  chat.send({ text: 'again', provider: 'claude' }); chat = render();
  assert.deepEqual(chat.toolCalls, []);
  assert.deepEqual(chat.messages[1].toolCalls, events);
  chat.reset(); render().setMessages(saved); chat = render();
  const { useRookeryRuntime } = await load('runtime/useRookeryRuntime.ts', {
    react, '@assistant-ui/react': { useExternalStoreRuntime: (args) => args,
      WebSpeechDictationAdapter: class {}, WebSpeechSynthesisAdapter: class {} },
  });
  const runtime = useRookeryRuntime({ chat, sessions: { sessions: [], activeId: 'session' } });
  const message = runtime.convertMessage(runtime.messages[1]);
  assert.equal(message.content[0].toolName, 'notes · search');
  assert.equal(message.content[0].result, 'found');
  assert.equal(message.content.filter((part) => part.type === 'tool-call').length, 1);
  chat.send({ text: 'interrupted', provider: 'claude' }); callbacks.onEvent(events[0]);
  render().abort(); chat = render();
  assert.equal(chat.messages.at(-1).toolCalls.length, 1);
  assert.equal(chat.busy, false);
});


test('voice status never exposes tool calls, including while an assignment runs', () => {
  const file = 'VoicePage.tsx';
  const source = ts.createSourceFile(file, readFileSync(new URL('../src/pages/' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'status') expression = node.initializer.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(expression);
  const js = ts.transpileModule(`const result = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const status = new Function('phase', 'voice', 'chat', js + '\nreturn result;');
  const tool = { kind: 'tool', label: 'private_tool_name', done: false };
  assert.equal(status('active', { speaking: false }, { busy: true, activity: [tool] }), 'Thinking …');
  assert.equal(status('active', { speaking: false }, { busy: true, activity: [
    { kind: 'assignment', label: 'Mara', done: false }, tool,
  ] }), 'Mara is working …');
});


test('compact tools preserve readable results, failures, and interactive approval controls', async () => {
  const { CompactToolCall, formatToolValue } = await load('components/assistant-ui/elements/compact-tool-call.tsx', {
    react: { ...require('react'), useState: () => [false, () => {}] },
  });
  assert.equal(formatToolValue(JSON.stringify([{ type: 'text', text: 'First\\nline' }, { type: 'text', text: 'Second' }])), 'First\\nline\n\nSecond');
  assert.equal(formatToolValue('plain result'), 'plain result');
  assert.equal(formatToolValue(undefined), '');
  assert.equal(formatToolValue('{broken'), '{broken');
  const props = { toolName: 'rookery · org_overview', argsText: '{}', result: 'ready', status: { type: 'running' } };
  const running = CompactToolCall(props);
  assert.equal(running.props.running, true);
  assert.equal(running.props.open, false);
  assert.equal(running.props.query, '');
  assert.equal(running.props.label, 'rookery · org overview');
  const failed = CompactToolCall({ ...props, isError: true, status: { type: 'complete' } });
  assert.equal(failed.props.failed, true);
  const approval = CompactToolCall({ ...props, status: { type: 'requires-action' }, approval: { id: 'approval' } });
  assert.notEqual(approval.type, running.type);
  assert.equal(approval.props.approval.id, 'approval');
});


test('greeting prefers a trimmed honorific, falls back to user name, and preserves the generic greeting', async () => {
  const { greeting } = await load('lib/format.ts', {});
  const morning = new Date(2026, 8, 13, 9);
  assert.equal(greeting(morning, { honorific: ' Sir ', userName: 'Jonas' }), 'Good morning, Sir.');
  assert.equal(greeting(morning, { honorific: '  ', userName: ' Jonas ' }), 'Good morning, Jonas.');
  assert.equal(greeting(morning, { userName: 'Jonas' }), 'Good morning, Jonas.');
  assert.equal(greeting(morning, { honorific: ' ', userName: ' ' }), 'Good morning.');
  assert.equal(greeting(morning), 'Good morning.');
  assert.equal(greeting(new Date(2026, 8, 13, 2), { honorific: 'Sir' }), 'Still awake, Sir?');
});
