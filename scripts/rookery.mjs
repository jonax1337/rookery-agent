#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const entry = fileURLToPath(new URL('../packages/server/dist/main.js', import.meta.url));
const launcher = fileURLToPath(import.meta.url);
export const psQuote = (value) => "'" + value.replaceAll("'", "''") + "'";
const encode = (text) => Buffer.from(text, 'utf16le').toString('base64');

export function startupCommand(node, script, home) {
  return `$env:ROOKERY_HOME=${psQuote(home)}; & ${psQuote(node)} ${psQuote(script)} start`;
}

export function autostart(enabled, home, startupFolder) {
  if (process.platform !== 'win32') throw new Error('Automatic login startup currently supports Windows only. Use rookery serve on this platform.');
  const folder = startupFolder ?? execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); [Environment]::GetFolderPath('Startup')"], { encoding: 'utf8', windowsHide: true }).trim();
  if (!folder) throw new Error('Windows Startup folder is unavailable.');
  const shortcut = join(folder, 'Rookery.lnk');
  if (!enabled) {
    if (existsSync(shortcut)) unlinkSync(shortcut);
    console.log('Autostart disabled. Your data is unchanged.');
    return;
  }
  // A shortcut starts in the signed-in user session, retaining provider OAuth access.
  const args = '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + encode(startupCommand(process.execPath, launcher, home));
  const script = `$ProgressPreference='SilentlyContinue'; $s=(New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(shortcut)}); $s.TargetPath=(Get-Command powershell.exe).Source; $s.Arguments=${psQuote(args)}; $s.WorkingDirectory=${psQuote(home)}; $s.WindowStyle=7; $s.Save()`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encode(script)], { windowsHide: true });
  console.log('Autostart enabled: Rookery starts after Windows sign-in. Run rookery autostart off to disable.');
}

async function start(config) {
  if (!existsSync(entry)) throw new Error('Server is not built. Run npm run build first.');
  const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
  const url = `http://${host.includes(':') ? '[' + host + ']' : host}:${config.port}`;
  const ready = async () => {
    try {
      const response = await fetch(url + '/api/config', { headers: config.token ? { Authorization: `Bearer ${config.token}` } : {}, signal: AbortSignal.timeout(1500) });
      const body = await response.json();
      return response.ok && typeof body.assistantName === 'string' && typeof body.defaultProvider === 'string';
    } catch { return false; }
  };
  if (await ready()) return url;
  mkdirSync(config.home, { recursive: true });
  const log = openSync(join(config.home, 'server.log'), 'a');
  const child = spawn(process.execPath, [entry], { cwd: config.home, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
  closeSync(log);
  let failure;
  child.on('error', (error) => { failure = error; });
  child.on('exit', (code) => { failure = new Error(`Server exited (${code}). See ${join(config.home, 'server.log')}`); });
  child.unref();
  for (let attempt = 0; attempt < 40; attempt++) {
    if (failure) throw failure;
    if (await ready()) {
      console.log(`Started server (PID ${child.pid}).`);
      return url;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  child.kill();
  throw new Error(`Server did not become ready. See ${join(config.home, 'server.log')}`);
}

async function main() {
  const [command, option, ...extra] = process.argv.slice(2);
  if (!['setup', 'start', 'autostart'].includes(command)) {
    if (command === '--help' || command === '-h') console.log('Installation: rookery setup [--no-autostart] | start | autostart on|off\n');
    await import('../packages/cli/dist/index.js');
    return;
  }
  if (extra.length || (command !== 'autostart' && option && !(command === 'setup' && option === '--no-autostart'))) throw new Error('Usage: rookery setup [--no-autostart] | start | autostart on|off');
  const { loadConfig } = await import('../packages/core/dist/config.js');
  const { loadDotEnv } = await import('../packages/server/dist/env.js');
  loadDotEnv();
  const config = loadConfig();
  mkdirSync(config.home, { recursive: true });
  if (command === 'autostart') {
    if (!['on', 'off'].includes(option)) throw new Error('Usage: rookery autostart on|off');
    autostart(option === 'on', config.home);
    return;
  }
  if (command === 'setup' && process.platform !== 'win32' && option !== '--no-autostart') throw new Error('Use rookery setup --no-autostart on macOS/Linux. Automatic startup currently supports Windows.');
  const url = await start(config);
  console.log(`Rookery is running: ${url}`);
  if (command === 'setup') {
    if (option !== '--no-autostart') autostart(true, config.home);
    console.log('Configure your assistant in Settings and Telegram in Gateways. No .env is needed.\nInstall and sign in to Claude Code or Codex, then select that provider in Settings.\nRun rookery doctor to check provider readiness.');
    const browser = process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process ${psQuote(url + '/settings')}`], { windowsHide: true, stdio: 'ignore' })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url + '/settings'], { stdio: 'ignore' });
    browser.on('error', () => console.log(`Open ${url}/settings in your browser.`));
    browser.unref();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
