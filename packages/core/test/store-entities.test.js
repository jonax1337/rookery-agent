import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSISTANT_MEMORY_OWNER, Store, linkEntities, renderMemoryBlock } from '../dist/index.js';

/**
 * Determinism and bundling on the store's entity read paths.
 *
 * The dream recorder replays the second hop from a recorded frame, so the
 * queries it records must have a total order: which row a LIMIT keeps when
 * two rows tie may never depend on SQLite's internal order. These tests pin
 * the tiebreakers (mentions DESC then id, importance DESC then id), check
 * the bundled per-entity mode against the live one-call-per-entity loop,
 * and hold the owner boundary the link table cannot enforce itself.
 */

/** A fresh in-memory store per test keeps them independent and fast. */
function makeStore() {
  return new Store(':memory:');
}

test('entitiesFor is totally ordered when two entities tie on mentions', () => {
  const store = makeStore();
  const memory = store.upsertMemory({
    kind: 'fact',
    content: 'The user rotates between two editors.',
    importance: 0.6,
  });
  linkEntities(store, ASSISTANT_MEMORY_OWNER, memory.id, ['editor-a', 'editor-b']);

  const firsts = new Set();
  for (let run = 0; run < 100; run += 1) {
    firsts.add(store.entitiesFor(memory.id)[0].id);
  }
  assert.equal(firsts.size, 1, 'the first of two equally mentioned entities is fixed');
  store.close();
});

test('entitiesForMany returns exactly what the per-memory loop returns', () => {
  const store = makeStore();
  const ids = [];
  for (let index = 0; index < 15; index += 1) {
    const memory = store.upsertMemory({
      kind: 'fact',
      content: 'Fact number ' + index + ' about the running project.',
      importance: 0.5,
    });
    ids.push(memory.id);
    // Every third memory joins a shared entity as well, so mentions differ
    // across entities and the per-memory ordering has something to order.
    const tags = index % 3 === 0 ? ['topic-' + index, 'shared'] : ['topic-' + index];
    linkEntities(store, ASSISTANT_MEMORY_OWNER, memory.id, tags);
  }

  const many = store.entitiesForMany(ids);
  assert.deepEqual(
    [...many.entries()].map(([id, entities]) => [id, entities.map((entity) => entity.id)]),
    ids.map((id) => [id, store.entitiesFor(id).map((entity) => entity.id)]),
  );
  store.close();
});

test('entitiesForMany with no input yields an empty map', () => {
  const store = makeStore();
  assert.equal(store.entitiesForMany([]).size, 0);
  store.close();
});

test('perEntity limits per entity while the default mode limits the union', () => {
  const store = makeStore();
  const first = store.upsertEntity({ owner: ASSISTANT_MEMORY_OWNER, name: 'alpha' });
  const second = store.upsertEntity({ owner: ASSISTANT_MEMORY_OWNER, name: 'beta' });
  const firstIds = [];
  const secondIds = [];
  for (let index = 0; index < 12; index += 1) {
    // Equal importance everywhere: the row at the LIMIT edge is chosen by
    // the tiebreaker alone, which is exactly what has to stay fixed.
    const one = store.upsertMemory({
      kind: 'fact',
      content: 'Alpha fact ' + index + ' about the deployment pipeline.',
      importance: 0.5,
    });
    const two = store.upsertMemory({
      kind: 'fact',
      content: 'Beta fact ' + index + ' about the release calendar.',
      importance: 0.5,
    });
    store.linkEntity(one.id, first.id);
    store.linkEntity(two.id, second.id);
    firstIds.push(one.id);
    secondIds.push(two.id);
  }

  const perEntity = store.memoriesForEntities([first.id, second.id], {
    owner: ASSISTANT_MEMORY_OWNER,
    limit: 8,
    perEntity: true,
  });
  assert.equal(perEntity.length, 16, 'eight rows per entity, not eight overall');
  assert.equal(perEntity.filter((row) => firstIds.includes(row.id)).length, 8);
  assert.equal(perEntity.filter((row) => secondIds.includes(row.id)).length, 8);

  const union = store.memoriesForEntities([first.id, second.id], {
    owner: ASSISTANT_MEMORY_OWNER,
    limit: 8,
  });
  assert.equal(union.length, 8, 'the default mode keeps the union-wide top eight');
  store.close();
});

test('perEntity equals one call per entity, and a shared row comes back once per entity', () => {
  const store = makeStore();
  const first = store.upsertEntity({ owner: ASSISTANT_MEMORY_OWNER, name: 'alpha' });
  const second = store.upsertEntity({ owner: ASSISTANT_MEMORY_OWNER, name: 'beta' });
  // One memory hangs off both entities. In the perEntity form it must come
  // back twice, once per partition: the recorder buckets neighbour rows by
  // entity, so collapsing the pair would silently drop one bucket.
  const shared = store.upsertMemory({
    kind: 'fact',
    content: 'The user works on both fronts at once.',
    importance: 0.95,
  });
  store.linkEntity(shared.id, first.id);
  store.linkEntity(shared.id, second.id);
  for (let index = 0; index < 12; index += 1) {
    const one = store.upsertMemory({
      kind: 'fact',
      content: 'Alpha note ' + index + ' with enough substance to count.',
      importance: 0.5,
    });
    const two = store.upsertMemory({
      kind: 'fact',
      content: 'Beta note ' + index + ' with enough substance to count.',
      importance: 0.4,
    });
    store.linkEntity(one.id, first.id);
    store.linkEntity(two.id, second.id);
  }

  const windowed = store.memoriesForEntities([first.id, second.id], {
    owner: ASSISTANT_MEMORY_OWNER,
    limit: 8,
    perEntity: true,
  });
  const sharedRows = windowed.filter((row) => row.id === shared.id);
  assert.equal(sharedRows.length, 2, 'the shared memory rides along with both entities');
  assert.equal(new Set(sharedRows.map((row) => row.hopEntityId)).size, 2);

  for (const entity of [first, second]) {
    const looped = store.memoriesForEntities([entity.id], { owner: ASSISTANT_MEMORY_OWNER, limit: 8 });
    const fromWindow = windowed.filter((row) => row.hopEntityId === entity.id).map((row) => row.id);
    assert.deepEqual(fromWindow, looped.map((row) => row.id));
  }
  store.close();
});

test('the owner boundary holds in both modes, even across a shared entity link', () => {
  const store = makeStore();
  const assistantNote = store.upsertMemory({
    kind: 'fact',
    content: 'The user files his expenses at the end of every month.',
    importance: 0.9,
    tags: ['expenses'],
  });
  linkEntities(store, ASSISTANT_MEMORY_OWNER, assistantNote.id, ['expenses']);
  const agentNote = store.upsertMemory({
    kind: 'fact',
    content: 'The agent keeps its own expense ledger separately.',
    importance: 0.95,
    owner: 'agent-releng',
  });
  // However a cross-owner link came about, the shared node must not leak the
  // agent row into an assistant query: the link table has no owner column,
  // so the query has to enforce the bank on the memory side.
  const shared = store.findEntity(ASSISTANT_MEMORY_OWNER, 'expenses');
  store.linkEntity(agentNote.id, shared.id);

  const plain = store.memoriesForEntities([shared.id], { owner: ASSISTANT_MEMORY_OWNER, limit: 40 });
  const windowed = store.memoriesForEntities([shared.id], {
    owner: ASSISTANT_MEMORY_OWNER,
    limit: 40,
    perEntity: true,
  });
  for (const rows of [plain, windowed]) {
    assert.ok(rows.length > 0, 'the assistant row itself is still found');
    assert.ok(rows.every((row) => row.owner === ASSISTANT_MEMORY_OWNER));
    assert.ok(!rows.some((row) => row.id === agentNote.id));
  }
  store.close();
});

test('grouping is stable when two entities tie on mentions', () => {
  const store = makeStore();
  const first = store.upsertEntity({ owner: ASSISTANT_MEMORY_OWNER, name: 'alpha' });
  const second = store.upsertEntity({ owner: ASSISTANT_MEMORY_OWNER, name: 'beta' });
  const memories = [];
  for (const index of [0, 1]) {
    const record = store.upsertMemory({
      kind: 'fact',
      content: 'Tied fact number ' + index + ' about both topics at once.',
      importance: 0.6,
    });
    store.linkEntity(record.id, first.id);
    store.linkEntity(record.id, second.id);
    memories.push({ ...record, score: 1, reason: 'test' });
  }

  // Both entities mention exactly two memories, so groupByEntity's "first of
  // the equal minima" picks the bucket - with the tiebreaker that choice is
  // the same on every render, and the rendered block is byte-stable.
  let block = null;
  for (let run = 0; run < 10; run += 1) {
    const rendered = renderMemoryBlock(memories, 2000, 'this user', store);
    if (block === null) block = rendered;
    else assert.equal(rendered, block);
  }
  assert.ok(block.length > 0, 'a grouped block was actually rendered');
  store.close();
});
