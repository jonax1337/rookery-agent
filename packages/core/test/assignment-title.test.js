import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_VERSION, Store, titleFromBrief } from '../dist/index.js';

/**
 * Schema 21 -> 22: a run gets a name of its own.
 *
 * The column is nullable on purpose. A row written before the name existed
 * must keep reading, and the name it reads back is derived from its own first
 * line rather than backfilled - a guess written into the place a real name
 * belongs would be indistinguishable from one somebody meant (decision E15).
 *
 * The reopen case needs a real file: an old file is the whole point, and it
 * cannot be observed on `:memory:`.
 */

/** A throwaway file path, removed when the test ends. */
function tempPath(t) {
  const root = mkdtempSync(join(tmpdir(), 'rookery-run-title-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'state.db');
}

/** An organisation and an agent, the two rows an assignment needs. */
function seed(store) {
  const org = store.org.createOrganization({ name: 'Rookery & Co.' });
  const agent = store.org.createAgent({
    orgId: org.id,
    name: 'Mara',
    title: 'Engineer',
    instructions: 'Do the work.',
  });
  return { org, agent };
}

test('a run written before schema 22 reads back with a name derived from its brief', (t) => {
  const path = tempPath(t);

  const before = new Store(path);
  const { org, agent } = seed(before);
  const run = before.org.createAssignment({
    orgId: org.id,
    agentId: agent.id,
    title: 'Ship the parser',
    task: '# Ship the parser\n\nAll the detail that belongs in the brief and in no list.',
    requesterKind: 'assistant',
  });
  // Roll the file back to what schema 21 left behind: the column is gone and
  // the stamp says 21, which is exactly the file this migration has to open.
  before.db.exec('ALTER TABLE assignments DROP COLUMN title');
  before.db.prepare("UPDATE meta SET value = '21' WHERE key = 'schema_version'").run();
  before.close();

  const after = new Store(path);
  const stamp = after.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  assert.equal(stamp.value, String(SCHEMA_VERSION), 'the file is stamped with this build');
  assert.equal(SCHEMA_VERSION, 25);

  const read = after.org.getAssignment(run.id);
  assert.equal(read.title, 'Ship the parser', 'the old row is named from its first line');
  assert.ok(!read.title.includes('\n'), 'and that name is one line');
  assert.notEqual(read.title, read.task, 'never the brief itself');

  const stored = after.db.prepare('SELECT title FROM assignments WHERE id = ?').get(run.id);
  assert.equal(stored.title, null, 'and the derivation is never written back over it');
  after.close();
});

test('the fallback name is the first line, stripped of markup and clamped', () => {
  assert.equal(titleFromBrief('# Fix the flaky upload test\n\nDetail.'), 'Fix the flaky upload test');
  assert.equal(titleFromBrief('- ship it\nand more'), 'ship it');
  assert.equal(titleFromBrief('> quoted request\n'), 'quoted request');
  assert.equal(titleFromBrief('**Bold ask**\n\nbody'), 'Bold ask');
  assert.equal(titleFromBrief('\n\n   \nlate first line'), 'late first line');
  assert.equal(titleFromBrief(''), 'Untitled');
  const long = titleFromBrief('x'.repeat(200));
  assert.ok(long.length <= 60, 'clamped to one short line');
});
