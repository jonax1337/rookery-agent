import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '@rookery/core';
import { compareVersions, detectInstall, UpdateService } from '../dist/services/updates.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A package root that looks like a global npm install. */
function npmRoot(t) {
  const root = join(tempDir(t, 'rookery-prefix-'), 'node_modules', 'rookery-agent');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'updater.mjs'), '');
  return root;
}

function service(t, { latest = '0.2.0', busy = {}, root, home, updates, requestShutdown } = {}) {
  home ??= tempDir(t, 'rookery-updates-');
  const config = { ...structuredClone(DEFAULT_CONFIG), home, ...(updates ? { updates } : {}) };
  const requests = [];
  const service = new UpdateService({
    assistant: { config, org: { activeCount: busy.runs ?? 0 }, cron: { runningCount: busy.schedules ?? 0 } },
    turns: { size: busy.turns ?? 0 },
    log: silent,
    version: '0.1.0',
    root: root ?? home,
    fetch: async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({ version: latest }), { status: 200 });
    },
    requestShutdown,
  });
  return { updates: service, requests, config };
}

test('versions order the semver way', () => {
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1);
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0-alpha.1'), 1);
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
});

test('the install kind follows where the package lives', (t) => {
  assert.equal(detectInstall('C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\rookery-agent', 'win32').kind, 'npm');
  assert.equal(detectInstall('/home/a/.local/lib/node_modules/rookery-agent', 'linux').prefix, '/home/a/.local');
  assert.equal(detectInstall('/opt/rookery', 'linux').kind, 'unknown');
  const checkout = tempDir(t, 'rookery-checkout-');
  mkdirSync(join(checkout, 'packages', 'server', 'src'), { recursive: true });
  assert.equal(detectInstall(checkout).kind, 'source');
});

test('a check asks the channel dist-tag and reports a newer version', async (t) => {
  const { updates, requests, config } = service(t);
  config.updates.channel = 'next';
  await updates.check();
  assert.match(requests[0], /\/rookery-agent\/next$/);
  const status = updates.status();
  assert.equal(status.latest, '0.2.0');
  assert.equal(status.available, true);
  assert.equal(status.releaseNotesUrl, 'https://github.com/jonax1337/rookery-agent/releases/tag/v0.2.0');
});

test('an equal registry version is not an update', async (t) => {
  const { updates } = service(t, { latest: '0.1.0' });
  await updates.check();
  assert.equal(updates.status().available, false);
});

test('an installation that is not a global npm package never installs itself', async (t) => {
  const { updates } = service(t, { requestShutdown: () => {} });
  await updates.check();
  assert.equal(updates.status().installable, false);
  assert.throws(() => updates.install({ force: true }), /global npm package/);
});

test('without a way to restart, the app cannot install', async (t) => {
  const { updates } = service(t, { root: npmRoot(t) });
  await updates.check();
  assert.equal(updates.status().installable, false);
  assert.match(updates.status().reason, /cannot restart/);
});

test('running work blocks an install unless forced, and says what is running', async (t) => {
  const { updates } = service(t, { root: npmRoot(t), busy: { turns: 1, runs: 2 }, requestShutdown: () => {} });
  await updates.check();
  const status = updates.status();
  assert.equal(status.installable, true);
  assert.deepEqual(status.busy, ['1 conversation is answering', '2 agent runs are active']);
  assert.throws(
    () => updates.install({ force: false }),
    (error) => error.statusCode === 409 && /Wait for them/.test(error.message),
  );
});

test('auto mode does not retry a version that was already rolled back', async (t) => {
  const home = tempDir(t, 'rookery-updates-');
  mkdirSync(join(home, 'run'));
  writeFileSync(
    join(home, 'run', 'update-status.json'),
    JSON.stringify({ ok: false, rolledBack: true, from: '0.1.0', to: '0.2.0', at: '2026-09-28T00:00:00.000Z', error: 'boom' }),
  );
  let shutdowns = 0;
  const { updates } = service(t, {
    home,
    root: npmRoot(t),
    updates: { mode: 'auto', channel: 'latest' },
    requestShutdown: () => shutdowns++,
  });
  await updates.check();
  assert.equal(updates.status().installing, false);
  assert.equal(updates.status().lastResult.error, 'boom');
  assert.equal(shutdowns, 0);
});
