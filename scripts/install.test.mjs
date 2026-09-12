import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { psQuote, startupCommand, autostart } from './rookery.mjs';

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
