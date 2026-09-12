import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyConfig, loadConfig, saveConfig, withToolServer } from '../dist/index.js';

/**
 * Settings that change while Rookery runs.
 *
 * Everything holds one config object - the runtime, the company controller,
 * the server routes - so the interesting part is not what lands in the file
 * but what the live object looks like afterwards.
 */

function home() {
  return mkdtempSync(join(tmpdir(), 'rookery-config-'));
}

test('voice defaults to British English and preserves a saved language and voice', () => {
  const root = home();
  const config = loadConfig({ home: root });
  assert.equal(config.voice.lang, 'en-GB');
  assert.equal(config.voice.edgeVoice, 'en-GB-RyanNeural');

  saveConfig({ voice: { lang: 'de-DE', edgeVoice: 'de-DE-FlorianMultilingualNeural' } }, root);
  const saved = loadConfig({ home: root });
  assert.equal(saved.voice.lang, 'de-DE');
  assert.equal(saved.voice.edgeVoice, 'de-DE-FlorianMultilingualNeural');
});

test('a runtime change reaches the file and the live object without replacing it', () => {
  const root = home();
  const config = loadConfig({ home: root });
  const same = applyConfig(config, { assistantName: 'Jarvis' });

  assert.equal(same, config, 'the object is mutated, not swapped, so every holder sees the change');
  assert.equal(config.assistantName, 'Jarvis');
  const onDisk = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
  assert.equal(onDisk.assistantName, 'Jarvis');
});

test('what the host started with survives a save it did not touch', () => {
  const root = home();
  // What `rookery-server --port 4318` does: a setting that is never written.
  const config = loadConfig({ home: root, port: 4318, logLevel: 'silent' });
  assert.equal(config.port, 4318);

  applyConfig(config, { tools: withToolServer(config, 'playwright', { enabled: true }) });

  assert.equal(config.port, 4318, 'the flag still holds after an unrelated change');
  assert.equal(config.logLevel, 'silent');
  assert.equal(config.tools.servers.find((server) => server.id === 'playwright').enabled, true);
  assert.equal(
    JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).port,
    undefined,
    'and it stays out of the file, where it never belonged',
  );
});

test('an explicit change outranks what the host started with, and keeps outranking it', () => {
  const root = home();
  const config = loadConfig({ home: root, defaultPermission: 'read' });

  applyConfig(config, { defaultPermission: 'full' });
  assert.equal(config.defaultPermission, 'full', 'the patch wins over the startup override');

  applyConfig(config, { assistantName: 'Jarvis' });
  assert.equal(config.defaultPermission, 'full', 'and the override does not creep back later');
});

test('clearing a setting removes it instead of leaving the old value behind', () => {
  const root = home();
  saveConfig({ defaultModel: 'opus' }, root);
  const config = loadConfig({ home: root });
  assert.equal(config.defaultModel, 'opus');

  // The empty string is what the UI and the settings tool send for "default".
  applyConfig(config, { defaultModel: '' });
  assert.equal('defaultModel' in config, false, 'unset means the key is gone, not an empty string');
});
