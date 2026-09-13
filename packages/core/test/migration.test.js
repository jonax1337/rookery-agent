import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { previewMigration, importMigration } from '../dist/migration.js';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'rookery-migration-test-'));
  const source = join(root, 'source');
  const config = { home: join(root, 'rookery'), workspace: join(root, 'rookery', 'workspace') };
  fs.mkdirSync(source);
  fs.mkdirSync(config.workspace, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (base, path, content) => {
    fs.mkdirSync(dirname(join(base, path)), { recursive: true });
    fs.writeFileSync(join(base, path), content);
  };
  return { root, source, config, put };
}

test('Hermes import preserves exact Markdown, backs up conflicts, ignores private configuration, and is idempotent', t => {
  const { source, config, put } = fixture(t);
  const soul = Buffer.from('\uFEFF# My companion\r\nNames: Zoë 🦉\r\n');
  put(source, 'SOUL.md', soul);
  put(source, 'memories/USER.md', '# Me\nJonas');
  put(source, 'memories/MEMORY.md', 'first\n§\nsecond');
  put(source, 'BOOT.md', 'run dangerous startup commands');
  put(source, '.env', 'SECRET=no');
  put(source, 'config.yaml', 'token: secret');
  put(source, 'state.db', 'transcripts');
  put(config.workspace, 'SOUL.md', '# Existing companion');
  const preview = previewMigration(config, 'hermes', source);
  assert.equal(preview.canImport, true);
  assert.equal(preview.files.length, 4);
  assert.equal(preview.files.find(file => file.targetPath === 'SOUL.md').conflict, true);
  assert.equal(fs.readdirSync(config.home).length, 1, 'preview does not write a backup');
  const result = importMigration(config, 'hermes', source, preview.fingerprint);
  assert.deepEqual(fs.readFileSync(join(config.workspace, 'SOUL.md')), soul);
  assert.deepEqual(fs.readFileSync(join(source, 'SOUL.md')), soul, 'source stays unchanged');
  assert.equal(fs.readFileSync(join(config.workspace, 'USER.md'), 'utf8'), '# Me\nJonas');
  assert.equal(fs.readFileSync(join(config.workspace, 'MEMORY.md'), 'utf8'), 'first\n§\nsecond');
  assert.equal(fs.readFileSync(join(result.backupPath, 'SOUL.md'), 'utf8'), '# Existing companion');
  assert.equal(JSON.parse(fs.readFileSync(join(result.backupPath, 'manifest.json'), 'utf8')).status, 'complete');
  assert.ok(fs.existsSync(join(config.workspace, 'migration-archive/hermes/BOOT.md.txt')));
  for (const excluded of ['BOOT.md', '.env', 'config.yaml', 'state.db']) assert.equal(fs.existsSync(join(config.workspace, excluded)), false);
  const repeated = importMigration(config, 'hermes', source);
  assert.deepEqual(repeated.files, []);
  assert.equal(repeated.backupPath, undefined);
  assert.equal(fs.readdirSync(join(config.home, 'migration-backups')).length, 1);
});

test('OpenClaw retains nested notes and active standard files while archiving automation', t => {
  const { source, config, put } = fixture(t);
  for (const name of ['IDENTITY', 'SOUL', 'USER', 'AGENTS', 'TOOLS', 'MEMORY', 'HEARTBEAT', 'BOOTSTRAP']) put(source, `${name}.md`, `# ${name}`);
  put(source, 'memory/2026/meeting.md', 'Remember this meeting');
  put(source, 'memory/index.sqlite', 'not imported');
  const result = importMigration(config, 'openclaw', source);
  assert.equal(result.files.length, 9);
  assert.equal(fs.readFileSync(join(config.workspace, 'memory/2026/meeting.md'), 'utf8'), 'Remember this meeting');
  assert.equal(fs.existsSync(join(config.workspace, 'memory/index.sqlite')), false);
  assert.equal(fs.existsSync(join(config.workspace, 'HEARTBEAT.md')), false);
});

test('stale previews reject changed source and destination before writing', t => {
  const { source, config, put } = fixture(t);
  put(source, 'SOUL.md', 'first');
  const first = previewMigration(config, 'hermes', source);
  put(source, 'SOUL.md', 'second');
  assert.throws(() => importMigration(config, 'hermes', source, first.fingerprint), /changed since the preview/);
  const second = previewMigration(config, 'hermes', source);
  put(config.workspace, 'SOUL.md', 'new local identity');
  assert.throws(() => importMigration(config, 'hermes', source, second.fingerprint), /changed since the preview/);
  assert.equal(fs.readFileSync(join(config.workspace, 'SOUL.md'), 'utf8'), 'new local identity');
  assert.equal(fs.existsSync(join(config.home, 'migration-backups')), false);
});

test('invalid UTF-8, binary files and oversized input reject the entire plan', t => {
  const { source, config, put } = fixture(t);
  put(source, 'IDENTITY.md', '# valid');
  for (const [content, message] of [[Buffer.from([0xff]), /UTF-8/], [Buffer.from([65, 0, 66]), /binary/], [Buffer.alloc(1024 * 1024 + 1, 65), /1 MiB/]]) {
    put(source, 'SOUL.md', content);
    const preview = previewMigration(config, 'hermes', source);
    assert.equal(preview.canImport, false);
    assert.deepEqual(preview.files, []);
    assert.match(preview.warnings[0], message);
    assert.throws(() => importMigration(config, 'hermes', source), message);
    assert.deepEqual(fs.readdirSync(config.workspace), []);
  }
});

test('overlapping folders, unsupported source names and empty sources do not import', t => {
  const { source, config, put } = fixture(t);
  put(config.workspace, 'SOUL.md', 'keep');
  assert.match(previewMigration(config, 'hermes', config.workspace).warnings[0], /overlap/);
  assert.match(previewMigration(config, 'hermes', config.home).warnings[0], /overlap/);
  assert.equal(previewMigration(config, 'unknown', source).canImport, false);
  assert.equal(previewMigration(config, 'hermes', source).canImport, false);
  assert.throws(() => importMigration(config, 'hermes', source), /No supported/);
});

test('source and destination symlink ancestors are rejected', t => {
  const { root, source, config, put } = fixture(t);
  const outside = join(root, 'outside');
  fs.mkdirSync(outside);
  put(outside, 'note.md', 'private');
  put(source, 'SOUL.md', 'identity');
  try { fs.symlinkSync(outside, join(source, 'memory'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Creating symbolic links is not permitted'); throw error; }
  assert.match(previewMigration(config, 'openclaw', source).warnings[0], /Symbolic links/);
  fs.rmSync(join(source, 'memory'));
  put(source, 'memory/note.md', 'new');
  fs.symlinkSync(outside, join(config.workspace, 'memory'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(previewMigration(config, 'openclaw', source).warnings[0], /Symbolic links/);
  assert.equal(fs.readFileSync(join(outside, 'note.md'), 'utf8'), 'private');
});

test('write failure restores overwritten files and removes newly written files', t => {
  const { source, config, put } = fixture(t);
  put(source, 'AGENTS.md', 'new instructions');
  put(source, 'IDENTITY.md', 'new identity');
  put(source, 'SOUL.md', 'new soul');
  put(config.workspace, 'AGENTS.md', 'existing instructions');
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === join(config.workspace, 'SOUL.md')) throw new Error('simulated disk write failure');
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => importMigration(config, 'hermes', source), /files were restored.*simulated disk write failure/);
  } finally { fs.renameSync = originalRename; syncBuiltinESMExports(); }
  assert.equal(fs.readFileSync(join(config.workspace, 'AGENTS.md'), 'utf8'), 'existing instructions');
  assert.equal(fs.existsSync(join(config.workspace, 'IDENTITY.md')), false);
  assert.equal(fs.existsSync(join(config.workspace, 'SOUL.md')), false);
  assert.equal(fs.readFileSync(join(source, 'SOUL.md'), 'utf8'), 'new soul');
});

test('bounded note collection refuses an oversized total instead of truncating', t => {
  const { source, config, put } = fixture(t);
  for (let index = 0; index < 17; index++) put(source, `memory/${index}.md`, Buffer.alloc(1024 * 1024, 65));
  const preview = previewMigration(config, 'openclaw', source);
  assert.equal(preview.canImport, false);
  assert.match(preview.warnings[0], /16 MiB total/);
  assert.deepEqual(preview.files, []);
  assert.deepEqual(fs.readdirSync(config.workspace), []);
});
