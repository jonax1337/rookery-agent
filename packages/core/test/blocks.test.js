import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Assistant, ProviderRegistry, Store, TurnBlocks } from '../dist/index.js';

/**
 * The ordered transcript: `TurnBlocks` folding a turn's stream, and the
 * runtime persisting what it folded.
 *
 * The state machine is tested directly - it is pure - and the wiring through
 * `Assistant.chat` with a fake provider, the same shape org.test.js uses.
 * Nothing here talks to a real CLI.
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

function createAssistant(script) {
  const home = mkdtempSync(join(tmpdir(), 'rookery-blocks-'));
  mkdirSync(join(home, 'run'), { recursive: true });
  const store = new Store(':memory:');
  const provider = {
    id: 'claude',
    displayName: 'Fake Claude',
    models: () => ['fake'],
    async status() {
      return { id: 'claude', available: true, binary: 'fake', authenticated: true };
    },
    async *run() {
      yield* script;
    },
  };
  const assistant = new Assistant({
    store,
    registry: new ProviderRegistry([provider]),
    config: {
      home,
      logLevel: 'silent',
      memory: { enabled: false, autoExtract: false },
      org: { autoReview: false },
    },
  });
  openAssistants.push(assistant);
  return { assistant, store };
}

async function chat(assistant, text) {
  const events = [];
  for await (const event of assistant.chat({ text })) events.push(event);
  const sessionId = events.find((event) => event.type === 'session').sessionId;
  return { events, messages: assistant.store.getMessages(sessionId) };
}

/* ---------------------------- the accumulator ---------------------------- */

test('text deltas merge into the trailing text block and never across a tool', () => {
  const blocks = new TurnBlocks();
  blocks.apply({ type: 'text', delta: 'one ' });
  blocks.apply({ type: 'text', delta: 'two' });
  blocks.apply({ type: 'tool', name: 'read', status: 'start', id: 't1' });
  blocks.apply({ type: 'text', delta: 'three' });
  blocks.apply({ type: 'text', delta: ' four' });
  assert.deepEqual(
    blocks.blocks.map((block) => block.type),
    ['text', 'tool', 'text'],
  );
  assert.deepEqual(
    blocks.blocks.filter((block) => block.type === 'text').map((block) => block.text),
    ['one two', 'three four'],
  );
});

test('thinking deltas merge into the trailing thinking block only', () => {
  const blocks = new TurnBlocks();
  blocks.apply({ type: 'text', delta: 'spoken' });
  blocks.apply({ type: 'thinking', delta: 'con' });
  blocks.apply({ type: 'thinking', delta: 'sidering' });
  blocks.apply({ type: 'text', delta: ' more' });
  blocks.apply({ type: 'thinking', delta: 'afresh' });
  assert.deepEqual(
    blocks.blocks.map((block) => block.type),
    ['text', 'thinking', 'text', 'thinking'],
  );
  assert.equal(blocks.blocks[1].text, 'considering');
  assert.equal(blocks.blocks[0].text, 'spoken');
  assert.equal(blocks.blocks[2].text, ' more');
});

test('empty deltas open nothing', () => {
  const blocks = new TurnBlocks();
  blocks.apply({ type: 'text', delta: '' });
  blocks.apply({ type: 'thinking', delta: '' });
  assert.equal(blocks.blocks.length, 0);
});

test('text and thinking are clipped at 16000 characters, across deltas too', () => {
  const blocks = new TurnBlocks();
  blocks.apply({ type: 'text', delta: 'x'.repeat(20000) });
  blocks.apply({ type: 'thinking', delta: 'y'.repeat(9000) });
  blocks.apply({ type: 'thinking', delta: 'y'.repeat(9000) });
  assert.equal(blocks.blocks[0].text, 'x'.repeat(16000) + '\n[...clipped]');
  assert.equal(blocks.blocks[1].text, 'y'.repeat(16000) + '\n[...clipped]');
});

test('a tool end replaces its start in place, keeping the start name and clipping the result', () => {
  const blocks = new TurnBlocks();
  blocks.apply({ type: 'text', delta: 'looking' });
  blocks.apply({ type: 'tool', name: 'read', status: 'start', id: 't1', detail: 'notes.md' });
  blocks.apply({ type: 'tool', name: 'other', status: 'start', id: 't2' });
  // Claude Code end events all carry the generic name 'tool'.
  blocks.apply({ type: 'tool', name: 'tool', status: 'end', id: 't1', result: 'r'.repeat(20000), isError: false });
  assert.equal(blocks.blocks.length, 3);
  const merged = blocks.blocks[1];
  assert.equal(merged.type, 'tool');
  assert.equal(merged.call.name, 'read');
  assert.equal(merged.call.status, 'end');
  assert.equal(merged.call.detail, 'notes.md');
  assert.equal(merged.call.result, 'r'.repeat(16000) + '\n[...clipped]');
  assert.equal(merged.call.isError, false);
  // The other call stays open, the text untouched.
  assert.equal(blocks.blocks[2].call.status, 'start');
  assert.equal(blocks.blocks[0].text, 'looking');
});

test('a tool end without an id closes the newest open call without one', () => {
  const blocks = new TurnBlocks();
  blocks.apply({ type: 'tool', name: 'first', status: 'start' });
  blocks.apply({ type: 'tool', name: 'second', status: 'start' });
  blocks.apply({ type: 'tool', name: 'tool', status: 'end', result: 'done' });
  assert.equal(blocks.blocks[0].call.status, 'start');
  assert.equal(blocks.blocks[1].call.status, 'end');
  assert.equal(blocks.blocks[1].call.name, 'second');
  assert.equal(blocks.blocks[1].call.result, 'done');
});

test('a tool end whose start never arrived becomes a synthetic completed call', () => {
  const blocks = new TurnBlocks();
  blocks.apply({ type: 'tool', name: 'tool', status: 'end', id: 'orphan', result: 'late', isError: true });
  assert.equal(blocks.blocks.length, 1);
  const call = blocks.blocks[0].call;
  assert.equal(call.status, 'end');
  assert.equal(call.id, 'orphan');
  assert.equal(call.result, 'late');
  assert.equal(call.isError, true);
});

/* ------------------------------- reconcile ------------------------------- */

test('reconcile replaces the only text block when nothing ran after it', () => {
  const blocks = new TurnBlocks();
  blocks.apply({ type: 'thinking', delta: 'hm' });
  blocks.apply({ type: 'text', delta: 'good' });
  blocks.apply({ type: 'text', delta: 'bye' });
  blocks.reconcile('goodbye (final)');
  assert.deepEqual(blocks.blocks, [
    { type: 'thinking', text: 'hm' },
    { type: 'text', text: 'goodbye (final)' },
  ]);
});

test('reconcile keeps the deltas when a tool ran after the text', () => {
  const blocks = new TurnBlocks();
  blocks.apply({ type: 'text', delta: 'checking' });
  blocks.apply({ type: 'tool', name: 'read', status: 'start', id: 't1' });
  blocks.apply({ type: 'tool', name: 'tool', status: 'end', id: 't1' });
  blocks.reconcile('flattened');
  assert.equal(blocks.blocks[0].text, 'checking');
});

test('reconcile keeps the deltas when the turn has several text blocks, and ignores empty results', () => {
  const blocks = new TurnBlocks();
  blocks.apply({ type: 'text', delta: 'a' });
  blocks.apply({ type: 'tool', name: 'read', status: 'start', id: 't1' });
  blocks.apply({ type: 'tool', name: 'tool', status: 'end', id: 't1' });
  blocks.apply({ type: 'text', delta: 'b' });
  blocks.reconcile('flattened');
  blocks.reconcile('');
  assert.deepEqual(
    blocks.blocks.filter((block) => block.type === 'text').map((block) => block.text),
    ['a', 'b'],
  );
});

test('reconcile ends the pass: the next one opens a new block instead of merging', () => {
  const blocks = new TurnBlocks();
  blocks.apply({ type: 'text', delta: 'first pass' });
  blocks.reconcile('first pass (final)');
  blocks.apply({ type: 'text', delta: 'second pass' });
  assert.deepEqual(
    blocks.blocks.filter((block) => block.type === 'text').map((block) => block.text),
    ['first pass (final)', 'second pass'],
  );
});

test('an empty reconcile ends the attempt all the same - the provider switch seam', () => {
  const blocks = new TurnBlocks();
  blocks.apply({ type: 'text', delta: 'attempt one speaks' });
  blocks.reconcile('');
  blocks.apply({ type: 'text', delta: 'the retry' });
  assert.deepEqual(
    blocks.blocks.filter((block) => block.type === 'text').map((block) => block.text),
    ['attempt one speaks', 'the retry'],
  );
});

test('clear resets the transcript for a fresh attempt', () => {
  const blocks = new TurnBlocks();
  blocks.apply({ type: 'text', delta: 'doomed' });
  blocks.clear();
  assert.equal(blocks.blocks.length, 0);
  blocks.apply({ type: 'text', delta: 'retry' });
  assert.deepEqual(blocks.blocks, [{ type: 'text', text: 'retry' }]);
});

/* ------------------------- the runtime wiring ------------------------- */

test('chat persists the interleaved transcript beside the flat views', async () => {
  const { assistant, store } = createAssistant([
    { type: 'text', delta: 'Let me check ' },
    { type: 'thinking', delta: 'which file' },
    { type: 'tool', name: 'read', status: 'start', id: 't1', detail: 'notes.md' },
    { type: 'tool', name: 'tool', status: 'end', id: 't1', result: 'contents', isError: false },
    { type: 'text', delta: ' found it' },
    { type: 'done', text: 'Let me check  found it', usage: { inputTokens: 1 } },
  ]);
  const { events, messages } = await chat(assistant, 'read my notes');
  assert.equal(messages.length, 2);
  const answer = messages[1];
  assert.deepEqual(answer.blocks, [
    { type: 'text', text: 'Let me check ' },
    { type: 'thinking', text: 'which file' },
    {
      type: 'tool',
      call: { type: 'tool', name: 'read', status: 'end', id: 't1', detail: 'notes.md', result: 'contents', isError: false },
    },
    { type: 'text', text: ' found it' },
  ]);
  // Two text blocks: reconcile stands aside, and the flat views stay as they were.
  assert.equal(answer.content, 'Let me check  found it');
  assert.equal(answer.toolCalls.length, 2);
  // Thinking now travels on the wire the same way it always did.
  assert.ok(events.some((event) => event.type === 'thinking' && event.delta === 'which file'));
  store.close();
});

test('chat reconciles a pure text turn to the final result text', async () => {
  const { assistant, store } = createAssistant([
    { type: 'text', delta: 'good' },
    { type: 'text', delta: 'bye' },
    { type: 'done', text: 'goodbye (edited)' },
  ]);
  const { messages } = await chat(assistant, 'say goodbye');
  assert.deepEqual(messages[1].blocks, [{ type: 'text', text: 'goodbye (edited)' }]);
  store.close();
});

test('an interrupted turn keeps its open tool block in the transcript', async () => {
  const { assistant, store } = createAssistant([
    { type: 'text', delta: 'on it' },
    { type: 'tool', name: 'read', status: 'start', id: 't1', detail: 'notes.md' },
    { type: 'error', message: 'interrupted', fatal: true },
  ]);
  const { messages } = await chat(assistant, 'inspect notes');
  assert.deepEqual(messages[1].blocks, [
    { type: 'text', text: 'on it' },
    { type: 'tool', call: { type: 'tool', name: 'read', status: 'start', id: 't1', detail: 'notes.md' } },
  ]);
  store.close();
});

/* ------------------------------ migration ------------------------------ */

test('a fresh database carries the blocks column and old rows read as undefined', () => {
  const store = new Store(':memory:');
  const columns = store.db.prepare('PRAGMA table_info(messages)').all().map((row) => row.name);
  assert.ok(columns.includes('blocks'), 'fresh schema has the blocks column');

  const session = store.createSession({ provider: 'claude', cwd: '.' });
  // The pre-blocks write: no blocks field at all.
  store.addMessage({ sessionId: session.id, role: 'user', content: 'old row' });
  const plain = store.addMessage({ sessionId: session.id, role: 'assistant', content: 'flat answer' });
  assert.equal(plain.blocks, undefined);
  assert.equal(store.getMessages(session.id)[1].blocks, undefined);

  // And the new one round-trips through JSON.
  const blocks = [
    { type: 'text', text: 'before' },
    { type: 'tool', call: { type: 'tool', name: 'read', status: 'end', id: 't1', result: 'r' } },
  ];
  store.addMessage({ sessionId: session.id, role: 'assistant', content: 'before r', blocks });
  const messages = store.getMessages(session.id);
  assert.deepEqual(messages[2].blocks, blocks);
  store.close();
});
