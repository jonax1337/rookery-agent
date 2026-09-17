import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_VERSION, Store } from '../dist/index.js';

/**
 * Schema 22 -> 23: an agent gets a voice - two to four sentences on HOW it
 * writes, colouring mail without ever steering the work (that stays
 * `instructions`).
 *
 * The column is nullable on purpose. An agent hired before this migration
 * keeps reading with a null voice and stays silently neutral (decision E11,
 * F5) - nothing is backfilled, guessed, or nagged about.
 *
 * The reopen case needs a real file: an old file is the whole point, and it
 * cannot be observed on `:memory:`.
 */

/** A throwaway file path, removed when the test ends. */
function tempPath(t) {
  const root = mkdtempSync(join(tmpdir(), 'rookery-agent-voice-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'state.db');
}

test('an agent hired before schema 23 reads back with a null voice', (t) => {
  const path = tempPath(t);

  const before = new Store(path);
  const org = before.org.createOrganization({ name: 'Rookery & Co.' });
  const agent = before.org.createAgent({
    orgId: org.id,
    name: 'Mara',
    title: 'Engineer',
    instructions: 'Do the work.',
  });
  // Roll the file back to what schema 22 left behind: the column is gone
  // and the stamp says 22, which is exactly the file this migration opens.
  before.db.exec('ALTER TABLE agents DROP COLUMN voice');
  before.db.prepare("UPDATE meta SET value = '22' WHERE key = 'schema_version'").run();
  before.close();

  const after = new Store(path);
  const stamp = after.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  assert.equal(stamp.value, String(SCHEMA_VERSION), 'the file is stamped with this build');
  assert.equal(SCHEMA_VERSION, 23);

  const read = after.org.getAgent(agent.id);
  assert.equal(read.voice, undefined, 'an old agent reads back with no voice at all');
  assert.equal(read.name, 'Mara', 'the rest of the row is unharmed');
  after.close();
});

test('a voice can be set at hire, edited, and cleared back to neutral', () => {
  const store = new Store(':memory:');
  const org = store.org.createOrganization({ name: 'Rookery & Co.' });

  const withVoice = store.org.createAgent({
    orgId: org.id,
    name: 'Priya',
    title: 'Support Lead',
    instructions: 'Answer support mail.',
    voice: 'Warm and direct; short sentences, no corporate hedging.',
  });
  assert.equal(withVoice.voice, 'Warm and direct; short sentences, no corporate hedging.');

  const silent = store.org.createAgent({
    orgId: org.id,
    name: 'Tom',
    title: 'Backend Engineer',
    instructions: 'Do the work.',
  });
  assert.equal(silent.voice, undefined, 'no voice given at hire stays silently neutral (F5)');

  store.org.updateAgent(silent.id, { voice: 'Terse and technical, one line per point.' });
  assert.equal(store.org.getAgent(silent.id).voice, 'Terse and technical, one line per point.');

  store.org.updateAgent(silent.id, { voice: null });
  assert.equal(store.org.getAgent(silent.id).voice, undefined, 'clearing the field returns it to neutral');
});
