import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, recall, coreProfile, toMatchQuery, tokenize, parseCandidates, renderMemoryBlock } from '../dist/index.js';

/** A fresh in-memory store per test keeps them independent and fast. */
function makeStore() {
  return new Store(':memory:');
}

test('tokenize drops stop words and short tokens in both languages', () => {
  assert.deepEqual(tokenize('What is the deployment for my project'), ['deployment', 'project']);
  assert.deepEqual(tokenize('Wie ist der Zeitplan für mein Projekt'), ['zeitplan', 'projekt']);
});

test('toMatchQuery quotes every token so punctuation cannot inject FTS syntax', () => {
  assert.equal(toMatchQuery('deploy pipeline'), '"deploy"* OR "pipeline"*');
  // A query that is only punctuation and stop words has nothing to search for.
  assert.equal(toMatchQuery('the a of'), '');
  // FTS operators arrive as ordinary quoted tokens, so they cannot change the query.
  assert.equal(toMatchQuery('NOT (evil) OR *'), '"not"* OR "evil"*');
});

test('recall finds a memory by content and reports why', () => {
  const store = makeStore();
  store.upsertMemory({ kind: 'project', content: 'The user is migrating the billing service to Fastify.', importance: 0.8 });
  store.upsertMemory({ kind: 'fact', content: 'The user keeps chickens.', importance: 0.5 });

  const hits = recall(store, { text: 'How is the billing migration going?' });
  assert.equal(hits.length, 1);
  assert.match(hits[0].content, /billing service/);
  assert.ok(hits[0].score > 0);
  assert.ok(hits[0].reason.length > 0);
  store.close();
});

test('recall returns nothing for an unsearchable query instead of dumping everything', () => {
  const store = makeStore();
  store.upsertMemory({ kind: 'fact', content: 'The user lives in Berlin.', importance: 0.9 });
  assert.deepEqual(recall(store, { text: 'the a of is' }), []);
  store.close();
});

test('importance outranks a weaker but equally matching memory', () => {
  const store = makeStore();
  store.upsertMemory({ kind: 'fact', content: 'The user prefers Postgres for storage.', importance: 0.2 });
  store.upsertMemory({ kind: 'preference', content: 'The user prefers Postgres over MySQL always.', importance: 0.95 });

  const hits = recall(store, { text: 'postgres preference' });
  assert.equal(hits.length, 2);
  assert.ok(hits[0].importance > hits[1].importance, 'the important memory should rank first');
  store.close();
});

test('storing the same sentence twice reinforces instead of duplicating', () => {
  const store = makeStore();
  const first = store.upsertMemory({ kind: 'fact', content: 'The user runs Windows.', importance: 0.5 });
  const second = store.upsertMemory({ kind: 'fact', content: 'The user runs Windows.', importance: 0.5, tags: ['os'] });

  assert.equal(first.id, second.id, 'the same fact keeps its id');
  assert.ok(second.importance > first.importance, 'repetition raises importance');
  assert.deepEqual(second.tags, ['os']);
  assert.equal(store.memoryStats().total, 1);
  store.close();
});

test('forgetting is a soft delete that removes a memory from recall', () => {
  const store = makeStore();
  const memory = store.upsertMemory({ kind: 'fact', content: 'The user drives a red bicycle.', importance: 0.7 });
  assert.equal(recall(store, { text: 'bicycle' }).length, 1);

  store.forgetMemory(memory.id);
  assert.equal(recall(store, { text: 'bicycle' }).length, 0, 'forgotten memories stop surfacing');
  assert.equal(store.getMemory(memory.id).forgotten, true, 'but the record is still auditable');
  store.close();
});

test('recall marks used memories so proven-useful ones climb', () => {
  const store = makeStore();
  const memory = store.upsertMemory({ kind: 'fact', content: 'The user works on the Rookery assistant.', importance: 0.6 });
  recall(store, { text: 'rookery assistant' });
  assert.equal(store.getMemory(memory.id).accessCount, 1);
  store.close();
});

test('renderMemoryBlock respects its character budget', () => {
  const memories = Array.from({ length: 20 }, (unused, index) => ({
    kind: 'fact',
    content: 'Memory number ' + index + ' with some padding text to take up room.',
    score: 1,
    reason: 'test',
  }));
  const block = renderMemoryBlock(memories, 200);
  assert.ok(block.length < 400, 'the block stays near the budget');
  assert.match(block, /What you already know/);
  assert.equal(renderMemoryBlock([], 200), '');
});

test('parseCandidates survives prose, fences and malformed entries', () => {
  const fenced =
    '```json\n[{"kind":"preference","content":"The user prefers German.","tags":["lang"],' +
    '"importance":0.8,"evidence":"answer me in German"}]\n```';
  assert.equal(parseCandidates(fenced).length, 1);

  const withProse =
    'Here is what I found:\n[{"kind":"fact","content":"The user has two cats.",' +
    '"evidence":"I have two cats"}]\nHope that helps.';
  const parsed = parseCandidates(withProse);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].importance, 0.5, 'a missing importance falls back to the middle');
  assert.equal(parsed[0].evidence, 'I have two cats');

  assert.deepEqual(parseCandidates('no json at all'), []);
  assert.deepEqual(parseCandidates('[{"content":"tiny","evidence":"tiny"}]'), [], 'too-short content is rejected');
  assert.deepEqual(parseCandidates(''), []);
});

test('parseCandidates refuses a memory that quotes nothing', () => {
  // The point of the evidence rule: a sentence the model simply asserted,
  // with no claim about where it came from, does not travel any further.
  assert.deepEqual(parseCandidates('[{"kind":"fact","content":"The user dislikes meetings."}]'), []);
  assert.deepEqual(
    parseCandidates('[{"kind":"fact","content":"The user dislikes meetings.","evidence":"  "}]'),
    [],
  );
});

test('parseCandidates drops duplicates and caps the batch', () => {
  const entries = Array.from({ length: 15 }, (unused, index) => ({
    kind: 'fact',
    content: 'The user owns gadget number ' + index + '.',
    evidence: 'I own gadget number ' + index,
  }));
  entries.push({ kind: 'fact', content: 'The user owns gadget number 0.', evidence: 'I own gadget number 0' });
  const parsed = parseCandidates(JSON.stringify(entries));
  assert.ok(parsed.length <= 8, 'at most eight memories per turn');
  const contents = new Set(parsed.map((item) => item.content));
  assert.equal(contents.size, parsed.length, 'no duplicates');
});

test('the core profile carries high-importance memories regardless of the question', () => {
  const store = makeStore();
  store.upsertMemory({ kind: 'preference', content: 'Der Nutzer arbeitet hauptsaechlich mit TypeScript.', importance: 0.9 });
  store.upsertMemory({ kind: 'fact', content: 'Der Nutzer hat einmal eine Katze gesehen.', importance: 0.3 });

  // Lexical recall cannot bridge category to instance: the question says
  // "programming language", the memory says "TypeScript".
  assert.equal(recall(store, { text: 'Welche Programmiersprache bevorzuge ich?' }).length, 0);

  const profile = coreProfile(store);
  assert.equal(profile.length, 1, 'only the important memory is pinned');
  assert.match(profile[0].content, /TypeScript/);
  assert.equal(profile[0].reason, 'core profile');
  store.close();
});

test('the core profile respects its limit and importance floor', () => {
  const store = makeStore();
  for (let index = 0; index < 10; index += 1) {
    store.upsertMemory({ kind: 'fact', content: 'Wichtiger Fakt Nummer ' + index + ' ueber den Nutzer.', importance: 0.8 });
  }
  store.upsertMemory({ kind: 'fact', content: 'Eine belanglose Randnotiz ohne Bedeutung.', importance: 0.4 });

  const profile = coreProfile(store, { limit: 3 });
  assert.equal(profile.length, 3);
  assert.ok(profile.every((memory) => memory.importance >= 0.7), 'nothing unimportant is pinned');
  store.close();
});
