import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { psQuote, startupCommand, autostart, linuxService, parseMigrationArgs } from './rookery.mjs';

test('migration arguments require an explicit source and opt-in apply', () => {
  assert.deepEqual(parseMigrationArgs(['hermes']), { source: 'hermes', sourcePath: undefined, apply: false });
  assert.deepEqual(parseMigrationArgs(['openclaw', '--apply', '--from', '/a profile']), { source: 'openclaw', sourcePath: '/a profile', apply: true });
  assert.deepEqual(parseMigrationArgs(['hermes', '--file', 'SOUL.md', '--job', 'tea']), { source: 'hermes', sourcePath: undefined, apply: false, selection: { files: ['SOUL.md'], jobs: ['tea'] } });
  assert.throws(() => parseMigrationArgs(['hermes', '--job', 'tea', '--job', 'tea']), /Duplicate selection/);
  for (const args of [[], ['other'], ['hermes', '--from'], ['hermes', '--from', '--apply'], ['hermes', '--apply', '--apply'], ['hermes', '--unknown'], ['hermes', '--from', 'a', '--from', 'b']]) {
    assert.throws(() => parseMigrationArgs(args), /Usage:/);
  }
});

test('migration launcher previews without importing and applies only with --apply', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rookery-migrate-cli-'));
  const home = join(dir, 'rookery');
  const source = join(dir, 'hermes profile');
  const workspace = join(home, 'workspace');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(source, 'memories'), { recursive: true });
  mkdirSync(join(source, 'cron'));
  writeFileSync(join(workspace, 'SOUL.md'), '# Soul\nExisting persona.\n');
  writeFileSync(join(source, 'SOUL.md'), '# Soul\nYou are Ada, a patient companion.\n');
  writeFileSync(join(source, 'memories', 'USER.md'), '# User\nThe user prefers tea.\n');
  writeFileSync(join(source, '.env'), 'TOKEN=never-import-this\n');
  writeFileSync(join(source, 'cron', 'jobs.json'), JSON.stringify({ jobs: [{ id: 'tea', name: 'Tea reminder', prompt: 'Remind the user to make tea.', schedule: { kind: 'cron', expr: '0 15 * * *' }, enabled: true }] }));
  const env = { ...process.env, ROOKERY_HOME: home, ROOKERY_WORKSPACE: workspace };
  const run = (...args) => execFileSync(process.execPath, ['scripts/rookery.mjs', 'migrate', 'hermes', '--from', source, ...args], { env, encoding: 'utf8', stdio: 'pipe' });
  try {
    assert.throws(() => execFileSync(process.execPath, ['scripts/rookery.mjs', 'migrate', 'hermes', '--from', join(dir, 'missing')], { env, stdio: 'pipe' }), (error) => {
      assert.match(error.stderr.toString(), /no applicable plan/);
      return error.status === 1;
    });
    const preview = run();
    assert.match(preview, /Migration preview:/);
    assert.match(preview, /No files imported/);
    assert.match(preview, /Tea reminder/);
    assert.match(preview, /import paused/);
    assert.ok(!existsSync(join(home, 'rookery.db')));
    assert.equal(readFileSync(join(workspace, 'SOUL.md'), 'utf8'), '# Soul\nExisting persona.\n');
    const selected = run('--file', 'USER.md', '--apply');
    assert.match(selected, /Imported 1 files/);
    assert.equal(readFileSync(join(workspace, 'SOUL.md'), 'utf8'), '# Soul\nExisting persona.\n');
    assert.ok(!existsSync(join(home, 'rookery.db')));
    const applied = run('--apply');
    assert.match(applied, /Imported \d+ files/);
    assert.match(applied, /Imported 1 paused schedules/);
    assert.match(applied, /Backup and migration report:/);
    assert.equal(readFileSync(join(workspace, 'SOUL.md'), 'utf8'), readFileSync(join(source, 'SOUL.md'), 'utf8'));
    assert.equal(readFileSync(join(workspace, 'USER.md'), 'utf8'), readFileSync(join(source, 'memories', 'USER.md'), 'utf8'));
    assert.equal(readFileSync(join(source, '.env'), 'utf8'), 'TOKEN=never-import-this\n');
    assert.ok(!existsSync(join(workspace, '.env')));
    assert.ok(!existsSync(join(home, 'server.log')));
    const db = new DatabaseSync(join(home, 'rookery.db'), { readOnly: true });
    try {
      const job = db.prepare('SELECT prompt, enabled, permission, next_run_at, run_count FROM cron_jobs WHERE name = ?').get('Tea reminder');
      assert.equal(job.prompt, 'Remind the user to make tea.');
      assert.equal(job.enabled, 0);
      assert.equal(job.permission, 'chat');
      assert.equal(job.next_run_at, null);
      assert.equal(job.run_count, 0);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Linux unit keeps paths literal and starts the foreground server as the current user', () => {
  const unit = linuxService('/opt/Node App/node', '/home/user/$app%/main.js', '/home/user/"data"', '/usr/bin:/home/user/bin');
  assert.ok(unit.includes('ExecStart="/opt/Node App/node" "/home/user/$$app%%/main.js"'));
  assert.ok(unit.includes('Environment="ROOKERY_HOME=/home/user/\\"data\\""'));
  assert.ok(unit.includes('WantedBy=default.target'));
  assert.ok(!unit.includes('User=root'));
  assert.throws(() => linuxService('/usr/bin/node', '/app/main.js', '/home/user\nExecStart=evil', '/usr/bin'), /control characters/);
});

test('npm-style symlink invokes the launcher', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rookery-bin-'));
  try {
    const bin = join(dir, 'rookery');
    symlinkSync(resolve('scripts/rookery.mjs'), bin);
    assert.throws(() => execFileSync(process.execPath, [bin, 'setup', '--bogus'], { stdio: 'pipe' }), (error) => {
      assert.match(error.stderr.toString(), /Usage:/);
      return error.status === 1;
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Windows startup preserves literal paths and home, including spaces and shell syntax', { skip: process.platform !== 'win32' }, () => {
  const value = "C:\\Users\\O'Brien $HOME `test` & (data)";
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', `[Console]::Write(${psQuote(value)})`], { encoding: 'utf8', windowsHide: true });
  assert.equal(output, value);
  const script = startupCommand('node.exe', 'C:\\Rookery App\\rookery.mjs', value);
  assert.ok(script.includes("& 'node.exe' 'C:\\Rookery App\\rookery.mjs' start"));
  assert.ok(script.startsWith('$env:ROOKERY_HOME=' + psQuote(value)));
});

test('unknown setup flags fail before starting or registering anything', () => {
  assert.throws(() => execFileSync(process.execPath, ['scripts/rookery.mjs', 'setup', '--bogus'], { stdio: 'pipe' }), (error) => {
    assert.match(error.stderr.toString(), /Usage:/);
    return error.status === 1;
  });
});

test('autostart shortcut can be installed, updated, and removed without touching real Startup', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rookery-shortcut-'));
  const home = join(dir, "Jörg O'Brien $HOME");
  mkdirSync(home);
  try {
    autostart(true, home, dir);
    autostart(true, home, dir);
    const path = join(dir, 'Rookery.lnk');
    assert.ok(existsSync(path));
    const result = execFileSync('powershell.exe', ['-NoProfile', '-Command', `[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $s=(New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(path)}); @{target=$s.TargetPath;args=$s.Arguments;cwd=$s.WorkingDirectory}|ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true });
    const shortcut = JSON.parse(result);
    assert.match(shortcut.target, /powershell.exe$/i);
    assert.equal(shortcut.cwd, home);
    const script = Buffer.from(shortcut.args.split(' ').at(-1), 'base64').toString('utf16le');
    assert.ok(script.startsWith('$env:ROOKERY_HOME=' + psQuote(home)));
    autostart(false, home, dir);
    autostart(false, home, dir);
    assert.ok(!existsSync(path));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
