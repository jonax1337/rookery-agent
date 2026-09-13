#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, unlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const entry = fileURLToPath(new URL('../packages/server/dist/main.js', import.meta.url));
const launcher = fileURLToPath(import.meta.url);
export const psQuote = (value) => "'" + value.replaceAll("'", "''") + "'";
const encode = (text) => Buffer.from(text, 'utf16le').toString('base64');

export function parseMigrationArgs(args) {
  const [source, ...options] = args;
  const usage = 'Usage: rookery migrate <hermes|openclaw> [--from <path>] [--file <target-path>] [--job <source-id>] [--apply]';
  if (!['hermes', 'openclaw'].includes(source)) throw new Error(usage);
  let sourcePath;
  let apply = false;
  let selection;
  for (let i = 0; i < options.length; i++) {
    if (options[i] === '--apply' && !apply) apply = true;
    else if (options[i] === '--from' && sourcePath === undefined && options[i + 1] && !options[i + 1].startsWith('--')) sourcePath = options[++i];
    else if (['--file', '--job'].includes(options[i]) && options[i + 1] && !options[i + 1].startsWith('--')) {
      selection ??= { files: [], jobs: [] };
      const group = options[i] === '--file' ? selection.files : selection.jobs;
      const value = options[++i];
      if (group.includes(value)) throw new Error('Duplicate selection. ' + usage);
      group.push(value);
    }
    else throw new Error(usage);
  }
  return { source, sourcePath, apply, ...(selection ? { selection } : {}) };
}

export function startupCommand(node, script, home) {
  return `$env:ROOKERY_HOME=${psQuote(home)}; & ${psQuote(node)} ${psQuote(script)} start`;
}

export function linuxService(node, server, home, path) {
  const quote = (value) => {
    if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Autostart paths cannot contain control characters.');
    return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
  };
  return `[Unit]\nDescription=Rookery personal assistant\n\n[Service]\nType=simple\nEnvironment=${quote('ROOKERY_HOME=' + home)}\nEnvironment=${quote('PATH=' + path)}\nExecStart=${quote(node).replaceAll('$', () => '$$')} ${quote(server).replaceAll('$', () => '$$')}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
}

function linuxAutostart(enabled, home) {
  const folder = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd/user');
  const file = join(folder, 'rookery.service');
  const systemctl = (...args) => execFileSync('systemctl', ['--user', ...args], { stdio: 'pipe' });
  try { systemctl('show-environment'); }
  catch { throw new Error('No systemd user session available. Use rookery setup --no-autostart, or run setup from a normal user login.'); }
  if (enabled) {
    mkdirSync(folder, { recursive: true });
    writeFileSync(file, linuxService(process.execPath, entry, home, process.env.PATH || '/usr/local/bin:/usr/bin:/bin'), { mode: 0o600 });
    systemctl('daemon-reload');
    systemctl('enable', 'rookery.service');
    console.log('Autostart enabled for your next Linux login. Logs: journalctl --user -u rookery.service');
  } else {
    if (existsSync(file)) {
      systemctl('disable', 'rookery.service');
      unlinkSync(file);
      systemctl('daemon-reload');
    }
    console.log('Autostart disabled. Your data and current server are unchanged.');
  }
}

export function autostart(enabled, home, startupFolder) {
  if (process.platform === 'linux') return linuxAutostart(enabled, home);
  if (process.platform !== 'win32') throw new Error('Automatic startup supports Windows and Linux with systemd. Use rookery setup --no-autostart on this platform.');
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
  if (command === 'migrate') {
    const { source, sourcePath, apply, selection } = parseMigrationArgs(process.argv.slice(3));
    const { loadConfig } = await import('../packages/core/dist/config.js');
    const { previewMigration, importMigration } = await import('../packages/core/dist/migration.js');
    const { loadDotEnv } = await import('../packages/server/dist/env.js');
    loadDotEnv();
    const config = loadConfig();
    const preview = previewMigration(config, source, sourcePath);
    if (selection && (selection.files.some(path => !preview.files.some(file => file.targetPath === path)) || selection.jobs.some(id => !preview.jobs.some(job => job.sourceId === id)))) throw new Error('Unknown selected file or job. Run a preview without selection flags to see available entries.');
    console.log(`Migration preview: ${source} from ${preview.sourcePath}`);
    for (const file of preview.files.filter(file => !selection || selection.files.includes(file.targetPath))) console.log(`  ${file.sourcePath} -> ${file.targetPath} (${file.bytes} bytes${file.conflict ? ', replaces existing file with backup' : ''})`);
    for (const job of preview.jobs.filter(job => !selection || selection.jobs.includes(job.sourceId))) {
      console.log(`  Schedule [${job.sourceId}] ${JSON.stringify(job.name)}: ${job.schedule} (import paused${job.remainingRuns === undefined ? '' : ', ' + job.remainingRuns + ' runs remaining'})\n    Prompt: ${JSON.stringify(job.prompt)}`);
      if (job.script) console.log(`    Script: ${job.script.runtime}, ${job.script.noAgent ? 'script only' : 'script followed by assistant'}`);
      for (const file of job.assets ?? []) console.log(`    ${file.sourcePath} -> ${file.targetPath} (${file.bytes} bytes)`);
    }
    for (const warning of preview.warnings) console.log(`Warning: ${warning}`);
    if (!preview.canImport) throw new Error('Migration has no applicable plan. Resolve the preview warnings first.');
    if (!apply) {
      console.log('No files imported or schedules created. Review this preview, then repeat with --apply to import.');
      return;
    }
    const result = importMigration(config, source, sourcePath, preview.fingerprint, selection);
    console.log(`Imported ${result.files.length} files. Source files are unchanged.`);
    if (result.jobs.length) console.log(`Imported ${result.jobs.length} paused schedules. Review timing, tools, permissions and delivery in Schedules before enabling.`);
    if (result.backupPath) console.log(`Backup and migration report: ${result.backupPath}`);
    for (const warning of result.warnings) console.log(`Warning: ${warning}`);
    console.log('Open Settings → Identity to review your agent. Start a new conversation for the cleanest transition.');
    return;
  }
  if (!['setup', 'start', 'autostart'].includes(command)) {
    if (command === '--help' || command === '-h') console.log('Installation: rookery setup [--no-autostart] | start | autostart on|off\nMigration: rookery migrate <hermes|openclaw> [--from <path>] [--file <target-path>] [--job <source-id>] [--apply]\n');
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
  if (command === 'setup' && !['win32', 'linux'].includes(process.platform) && option !== '--no-autostart') throw new Error('Use rookery setup --no-autostart on this platform. Automatic startup supports Windows and Linux with systemd.');
  const url = await start(config);
  console.log(`Rookery is running: ${url}`);
  if (command === 'setup') {
    if (option !== '--no-autostart') autostart(true, config.home);
    console.log('Choose to migrate from Hermes or OpenClaw, or start fresh, at Settings → Migration.\nReview your assistant in Settings → Identity and configure Telegram in Gateways. No .env is needed.\nInstall and sign in to Claude Code or Codex, then select that provider in Settings.\nRun rookery doctor to check provider readiness.');
    const browser = process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process ${psQuote(url + '/settings/migration')}`], { windowsHide: true, stdio: 'ignore' })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url + '/settings/migration'], { stdio: 'ignore' });
    browser.on('error', () => console.log(`Open ${url}/settings/migration in your browser.`));
    browser.unref();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
