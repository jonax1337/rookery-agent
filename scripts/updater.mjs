#!/usr/bin/env node
// Replaces an installed Rookery with another npm release, outside the server.
//
// The server cannot update itself in place: on Windows its loaded native
// modules (node-pty) are locked while it runs, and on every platform npm would
// be swapping files under a live process. So the server writes a plan, starts
// this script detached - from a copy under ~/.rookery/run, never from the
// package it is about to replace - and exits. This script then waits for the
// old server to be gone, backs up the database, installs, starts the new
// server and checks that it answers with the new version. Anything failing
// after the install rolls back: the previous release is installed again and
// the database backup restored, because a migration only ever runs forward.
//
// It imports nothing from Rookery on purpose; it must keep working while the
// package directory is half replaced.
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PACKAGE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const DB_SUFFIXES = ['', '-wal', '-shm'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read and check the plan the server wrote; nothing in it reaches a shell unchecked. */
export function readPlan(path) {
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  if (!PACKAGE.test(plan.packageName ?? '')) throw new Error('Invalid package name in update plan.');
  if (!VERSION.test(plan.from ?? '') || !VERSION.test(plan.to ?? '')) throw new Error('Invalid version in update plan.');
  for (const key of ['home', 'prefix', 'root', 'database']) {
    if (typeof plan[key] !== 'string' || !plan[key]) throw new Error(`Missing ${key} in update plan.`);
  }
  if (!['launcher', 'systemd', 'none'].includes(plan.restart)) throw new Error('Invalid restart mode in update plan.');
  return plan;
}

/** npm's own entry point next to this Node, so no shell and no .cmd shim is involved. */
export function findNpmCli(execPath = process.execPath) {
  const candidates = [
    join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

function createLog(home) {
  mkdirSync(join(home, 'logs'), { recursive: true });
  const file = join(home, 'logs', 'update.log');
  return (message) => {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    appendFileSync(file, line);
    process.stdout.write(line);
  };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitForExit(pid, log) {
  if (!pid) return;
  for (let waited = 0; waited < 90_000; waited += 500) {
    if (!alive(pid)) return;
    await sleep(500);
  }
  log(`Server ${pid} did not stop within 90 s; terminating it.`);
  try { process.kill(pid); } catch { /* already gone */ }
  await sleep(3000);
}

function run(command, args, log) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', (error) => resolve({ ok: false, output: error.message }));
    child.on('exit', (code) => {
      if (output.trim()) log(output.trim().split('\n').slice(-15).join('\n'));
      resolve({ ok: code === 0, output });
    });
  });
}

async function npmInstall(plan, version, log) {
  const npmCli = findNpmCli();
  if (!npmCli) {
    log('npm was not found next to this Node installation.');
    return false;
  }
  const args = ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', plan.prefix, `${plan.packageName}@${version}`];
  if (plan.registry) args.push('--registry', plan.registry);
  // A file still held by a process that has not quite let go (Windows) is
  // the usual reason for a failed swap, and it clears within seconds.
  for (let attempt = 1; attempt <= 3; attempt++) {
    log(`npm install ${plan.packageName}@${version} (attempt ${attempt})`);
    if ((await run(process.execPath, [npmCli, ...args], log)).ok) return true;
    await sleep(3000 * attempt);
  }
  return false;
}

function installedVersion(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

function backupDatabase(plan, log) {
  const folder = join(plan.home, 'backups', `update-${plan.from}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(folder, { recursive: true });
  const saved = [];
  for (const suffix of DB_SUFFIXES) {
    const source = plan.database + suffix;
    if (!existsSync(source)) continue;
    copyFileSync(source, join(folder, 'rookery.db' + suffix));
    saved.push(suffix);
  }
  log(`Database backed up to ${folder}`);
  return { folder, saved };
}

function restoreDatabase(plan, backup, log) {
  for (const suffix of DB_SUFFIXES) {
    const target = plan.database + suffix;
    if (backup.saved.includes(suffix)) copyFileSync(join(backup.folder, 'rookery.db' + suffix), target);
    else rmSync(target, { force: true });
  }
  log('Database restored from backup.');
}

async function healthy(plan, version) {
  if (!plan.healthUrl) return true;
  for (let waited = 0; waited < 60_000; waited += 1000) {
    try {
      const response = await fetch(plan.healthUrl, {
        headers: plan.token ? { Authorization: `Bearer ${plan.token}` } : {},
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok && (await response.json()).version === version) return true;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  return false;
}

async function start(plan, version, log) {
  if (plan.restart === 'none') return true;
  if (plan.restart === 'systemd') {
    try {
      execFileSync('systemctl', ['--user', 'start', 'rookery.service'], { stdio: 'pipe' });
    } catch (error) {
      log(`systemctl start failed: ${error.message}`);
      return false;
    }
  } else if (!(await run(process.execPath, [join(plan.root, 'scripts', 'rookery.mjs'), 'start'], log)).ok) {
    return false;
  }
  return healthy(plan, version);
}

/** Stop a server that came up but is not the right one, before its data is put back. */
async function stopStarted(plan) {
  if (plan.restart === 'systemd') {
    try { execFileSync('systemctl', ['--user', 'stop', 'rookery.service'], { stdio: 'pipe' }); } catch { /* not running */ }
    return;
  }
  // Whatever answered or hung on the port wrote its PID on start; a hung one
  // would not answer a polite request, and npm cannot swap files under it.
  let pid;
  try { pid = Number(readFileSync(join(plan.home, 'run', 'server.pid'), 'utf8').trim()); } catch { return; }
  if (!Number.isInteger(pid) || pid <= 0 || pid === plan.waitPid || !alive(pid)) return;
  try { process.kill(pid); } catch { /* already gone */ }
  await sleep(3000);
}

async function main() {
  const planPath = process.argv[2];
  if (!planPath) throw new Error('Usage: updater.mjs <plan.json>');
  const plan = readPlan(planPath);
  const log = createLog(plan.home);
  const statusFile = join(plan.home, 'run', 'update-status.json');
  const finish = (result) => {
    writeFileSync(statusFile, JSON.stringify({ ...result, from: plan.from, to: plan.to, at: new Date().toISOString() }, null, 2));
    log(result.ok ? `Updated ${plan.from} -> ${plan.to}.` : `Update failed: ${result.error}`);
  };
  process.env.ROOKERY_HOME = plan.home;

  log(`Updating Rookery ${plan.from} -> ${plan.to}`);
  await waitForExit(plan.waitPid, log);
  const backup = backupDatabase(plan, log);

  if ((await npmInstall(plan, plan.to, log)) && installedVersion(plan.root) === plan.to) {
    if (await start(plan, plan.to, log)) return finish({ ok: true });
    log('The new version did not come up; rolling back.');
    await stopStarted(plan);
  } else {
    log('Install failed; rolling back.');
  }

  restoreDatabase(plan, backup, log);
  const reinstalled = await npmInstall(plan, plan.from, log);
  const restarted = reinstalled && (await start(plan, plan.from, log));
  finish({
    ok: false,
    rolledBack: reinstalled,
    error: reinstalled
      ? `Version ${plan.to} could not be installed or did not start; ${plan.from} was restored${restarted ? '' : ' but did not start - run rookery start'}.`
      : `Version ${plan.to} failed and ${plan.from} could not be reinstalled. Run: npm install -g --ignore-scripts ${plan.packageName}@${plan.from}`,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
