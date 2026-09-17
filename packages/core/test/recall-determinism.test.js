import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, recall, coreProfile } from '../dist/index.js';
import { byScoreThenId } from '../dist/memory/recall.js';

/**
 * Determinism of the recall path (dream stage 1, AP2).
 *
 * Every test here pins a choice that used to be left to whatever SQLite or
 * the Map iteration happened to produce first: the tie-breakers of R11 and
 * the profile score on the retrieval scale (R13). None of them may change
 * which rows recall finds - only which of two previously interchangeable
 * rows wins. The grouping-stability case (two entities with equal mentions)
 * lives in store-entities.test.js with its `entitiesFor` tie-breaker.
 */

/** A fresh in-memory store per test keeps them independent and fast. */
function makeStore() {
  return new Store(':memory:');
}

/** The shared word bank of the twin rows; every token survives the tokenizer. */
const TWIN_WORDS = ['the', 'aurora', 'node', 'settles', 'the', 'beacon', 'ledger'];
/** Word bank of the filler shelf: same length, no token shared with a query. */
const SHELF_WORDS = ['a', 'quiet', 'harbor', 'stores', 'many', 'coiled', 'ropes'];

/**
 * The shelf only shapes the corpus statistics - its rows never match the
 * query and do not need to tie with anything - so each carries its own
 * trailing ordinal to stay clear of the duplicate guard.
 */
function insertShelfRow(store, index, at) {
  store.db
    .prepare(
      `INSERT INTO memories (id, kind, content, tags, importance, owner, created_at, updated_at)
       VALUES (?, 'fact', ?, '[]', 0.5, 'assistant', ?, ?)`,
    )
    .run('shelf-' + String(index).padStart(2, '0'), SHELF_WORDS.join(' ') + ' ordinal ' + index + '.', at, at);
}

/**
 * Insert rows the duplicate guard would refuse as byte-identical twins: the
 * word order varies (so no two rows share content) while the token multiset
 * stays fixed, and bm25 is bag-of-words - identical tokens, identical score,
 * and therefore a tie that has to be broken by the id, not by chance.
 */
function insertTwinRow(store, id, index, importance, at) {
  const rotation = index % TWIN_WORDS.length;
  let row = [...TWIN_WORDS.slice(rotation), ...TWIN_WORDS.slice(0, rotation)];
  const variant = Math.floor(index / TWIN_WORDS.length);
  if (variant === 1) [row[0], row[1]] = [row[1], row[0]];
  if (variant === 2) [row[5], row[6]] = [row[6], row[5]];
  store.db
    .prepare(
      `INSERT INTO memories (id, kind, content, tags, importance, owner, created_at, updated_at)
       VALUES (?, 'fact', ?, '[]', ?, 'assistant', ?, ?)`,
    )
    .run(id, row.join(' ') + '.', importance, at, at);
}

test('the profile is totally ordered: equal rows always resolve the same way', () => {
  const store = makeStore();
  const a = store.upsertMemory({ kind: 'fact', content: 'Tied profile row about beacons.', importance: 0.8 });
  const b = store.upsertMemory({ kind: 'fact', content: 'Tied profile row about ledgers.', importance: 0.8 });
  // Equal weight and an equal clock leave nothing but the id to decide on.
  store.db.prepare('UPDATE memories SET updated_at = ? WHERE id IN (?, ?)').run(1700000000000, a.id, b.id);

  const runs = Array.from({ length: 100 }, () => coreProfile(store, { limit: 1 }));
  assert.equal(new Set(runs.map((run) => run[0].id)).size, 1);
  store.close();
});

test('the hop-1 frontier edge is fixed: identical bm25 resolves by id', () => {
  const store = makeStore();
  const at = 1700000000000;
  for (let index = 0; index < 20; index += 1) {
    insertTwinRow(store, 'twin-' + String(index).padStart(2, '0'), index, 0.5, at);
  }
  // bm25 only separates terms that not every document carries: when the twins
  // are half the corpus (or all of it) their idf collapses to zero and every
  // twin scores under the threshold. A shelf three times the bank keeps the
  // query terms discriminative while the twins stay tied among themselves.
  for (let index = 0; index < 60; index += 1) {
    insertShelfRow(store, index, at);
  }

  // Twenty token-identical rows share one bm25, so the row at the limit * 4
  // frontier edge is a coin flip without the SQL tie-breaker.
  const runs = Array.from({ length: 10 }, () => recall(store, { text: 'aurora node beacon ledger', limit: 4 }));
  for (const run of runs) assert.equal(run.length, 4);
  assert.deepEqual(runs[0].map((hit) => hit.id), runs[9].map((hit) => hit.id));
  store.close();
});

test('the recall output order is total: (score desc, id asc)', () => {
  const store = makeStore();
  const at = 1700000000000;
  for (let index = 0; index < 20; index += 1) {
    insertTwinRow(
      store,
      'mix-' + String(index).padStart(2, '0'),
      index,
      index % 2 === 0 ? 0.9 : 0.4,
      at,
    );
  }

  // Identical tokens keep relevance tied while the alternating importance
  // splits the bank into two score classes with ties inside each.
  const hits = recall(store, { text: 'aurora node beacon ledger', limit: 8, touch: false });
  assert.ok(hits.length > 1);
  assert.deepEqual(hits.map((hit) => hit.id), [...hits].sort(byScoreThenId).map((hit) => hit.id));
  store.close();
});

test('profile order follows the SQL order: pinned, insight, plain weight', () => {
  const store = makeStore();
  store.upsertMemory({ kind: 'fact', content: 'Pinned line the user fixed in place.', importance: 0.1, pinned: true });
  store.upsertMemory({ kind: 'insight', content: 'Insight the nights concluded.', importance: 0.9 });
  store.upsertMemory({ kind: 'fact', content: 'Plain heavy row of ordinary weight.', importance: 1.0 });

  const profile = coreProfile(store, { limit: 3 });
  assert.deepEqual(
    profile.map((row) => (row.kind === 'insight' ? 'i' : row.pinned ? 'p' : 'n')),
    ['p', 'i', 'n'],
  );
  // The score bonuses are sized so the numeric order cannot drift from the
  // SQL order: pinned (1.0) beats any insight-plus-weights rest (at most
  // 0.5 + 0.2 + 0.15).
  assert.ok(profile[0].score > profile[1].score, 'pinned outranks the insight');
  assert.ok(profile[1].score > profile[2].score, 'the insight outranks plain weight');
  store.close();
});

test('profile precedence: a near-ceiling direct hit cannot displace a profile row', () => {
  const store = makeStore();
  const pinned = store.upsertMemory({
    kind: 'preference',
    content: 'Pinned preference of the user.',
    importance: 0.8,
    pinned: true,
  });
  const hit = store.upsertMemory({
    kind: 'fact',
    content: 'The aurora beacon guards the colony ledger.',
    importance: 1.0,
    tags: ['aurora'],
  });
  // bm25 is corpus-relative: in a two-row bank every matching term sits in
  // half the documents and its idf collapses to zero, so the hit would score
  // on importance alone and the premise could not bite. A shelf of unrelated
  // rows keeps the query terms discriminative and the relevance real.
  for (let index = 0; index < 20; index += 1) {
    store.upsertMemory({ kind: 'fact', content: 'Unrelated shelf row number ' + index + ' about harbor ropes.', importance: 0.3 });
  }
  // Age the pinned row so only the direct hit could plausibly win on
  // recency, and feed the hit every signal at once: full importance, a
  // logged access history, a fresh update and a tag hit.
  store.db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(1700000000000, pinned.id);
  store.db.prepare('UPDATE memories SET access_count = 31, updated_at = ? WHERE id = ?').run(Date.now(), hit.id);

  const hits = recall(store, { text: 'aurora beacon colony ledger', touch: false });
  assert.equal(hits.length, 1);
  assert.ok(hits[0].score >= 1.0, 'the direct hit must sit near the ceiling for this test to bite');

  const profile = coreProfile(store);
  assert.ok(profile.length >= 1);
  assert.equal(profile[0].id, pinned.id);

  // The merge of runtime.ts: profile rows enter the map first, direct hits
  // overwrite them on collision, then one sort over the union. No
  // contradicting edges exist here, so dropContradicted would be a no-op.
  const byId = new Map();
  for (const memory of profile) byId.set(memory.id, memory);
  for (const memory of hits) byId.set(memory.id, memory);
  const merged = [...byId.values()].sort(byScoreThenId);
  assert.equal(merged[0].id, profile[0].id);
  store.close();
});
