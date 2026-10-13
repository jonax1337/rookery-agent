import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computerPromptBlock, computerServerSpec, computerTools, webLoginScope } from '../dist/computer/tools.js';
import { TOOL_CATALOG } from '../dist/tools/catalog.js';
import { DEFAULT_CONFIG, loadConfig } from '../dist/config.js';

const OFF_RULE =
  "UAC prompts, Windows Hello, PINs, sign-ins and CAPTCHAs are the user's: call hand_over " +
  'with a short reason, never try to answer them.';
// hand_over as it reads on main, before web sign-ins existed.
const HAND_OVER_MAIN =
  'Let the user do what software must not: approve a UAC prompt, confirm Windows Hello or a PIN, solve ' +
  'a CAPTCHA, sign in. The cursor shows "Your turn" with the reason and a sound plays; the call returns ' +
  'when a secure prompt closes, or when the user has acted and then been idle for 4 s, with a fresh ' +
  'screenshot. Never try to answer such prompts yourself.';
const EXCLUSIONS = ['CAPTCHA', 'payment confirmation', 'UAC', 'Windows Hello', 'a PIN', 'lock screen', 'hand_over'];
const hint = (id, config) => TOOL_CATALOG.find((entry) => entry.id === id).hint({ engine: 'builtin' }, config);
const handOver = (on) => computerTools(on).find((tool) => tool.name === 'hand_over').description;
const env = (config) => computerServerSpec({ ...config, home: tmpdir() }, undefined, 'ax', 'builtin').env;

test('web sign-ins off: prompts, hand_over and the server env read as on main', () => {
  for (const config of [
    DEFAULT_CONFIG,
    { ...DEFAULT_CONFIG, webLoginMode: 'allowlist', webLoginDomains: [] },
    { ...DEFAULT_CONFIG, webLoginDomains: ['example.com'] },
    // Everything allowed is also blocked: nothing left.
    { ...DEFAULT_CONFIG, webLoginMode: 'allowlist', webLoginDomains: ['paypal.com'] },
  ]) {
    assert.equal(webLoginScope(config), null);
    assert.equal(hint('computer', config), computerPromptBlock('builtin'));
    assert.ok(computerPromptBlock('builtin').includes(OFF_RULE));
    assert.doesNotMatch(hint('computer', config) + hint('playwright', config), /allowed you to complete web sign-ins/);
    assert.equal(env(config).ROOKERY_COMPUTER_WEB_LOGINS, undefined);
  }
  assert.equal(handOver(false), HAND_OVER_MAIN);
  assert.match(handOver(true), /sign in \(unless your instructions allow that web sign-in\)\./);
  assert.equal(env({ ...DEFAULT_CONFIG, webLoginMode: 'all' }).ROOKERY_COMPUTER_WEB_LOGINS, '1');
});

test('allowlist: the domains are named and the exclusions stay', () => {
  const config = {
    ...DEFAULT_CONFIG,
    webLoginMode: 'allowlist',
    webLoginDomains: ['https://Login.Microsoft.com/x', '*.github.com', 'not a host'],
    webLoginBlocklist: [],
  };
  assert.deepEqual(webLoginScope(config).domains, ['login.microsoft.com', 'github.com']);
  for (const text of [hint('computer', config), hint('playwright', config), computerPromptBlock('zavora', webLoginScope(config))]) {
    assert.match(text, /subdomains: login\.microsoft\.com, github\.com\. There/);
    for (const kept of ['any other domain', ...EXCLUSIONS]) assert.ok(text.includes(kept), kept);
    assert.doesNotMatch(text, /not a host|banking/);
  }
  assert.ok(!hint('computer', config).includes(OFF_RULE));
});

test('the blocklist beats the allowlist, subdomains included', () => {
  const config = {
    ...DEFAULT_CONFIG,
    webLoginMode: 'allowlist',
    webLoginDomains: ['github.com', 'login.paypal.com', 'google.com'],
    webLoginBlocklist: ['paypal.com', 'pay.google.com'],
  };
  assert.deepEqual(webLoginScope(config), { mode: 'allowlist', domains: ['github.com', 'google.com'], blocked: ['pay.google.com'] });
  assert.match(hint('playwright', config), /subdomains: github\.com, google\.com\. Never on these or their subdomains: pay\.google\.com\./);
});

test('all websites: blocked domains are listed and the hard exclusions stay', () => {
  const config = { ...DEFAULT_CONFIG, webLoginMode: 'all', webLoginDomains: ['github.com'] };
  const scope = webLoginScope(config);
  assert.equal(scope.mode, 'all');
  assert.ok(scope.blocked.includes('sparkasse.de') && scope.blocked.includes('paypal.com'));
  for (const text of [hint('computer', config), hint('playwright', config)]) {
    assert.match(text, /on any website except these domains and their subdomains: sparkasse\.de, /);
    assert.match(text, /Never sign in to a banking, brokerage, payment or government identity site, listed or not\./);
    for (const kept of EXCLUSIONS) assert.ok(text.includes(kept), kept);
    assert.doesNotMatch(text, /github\.com/);
  }
  const empty = hint('computer', { ...config, webLoginBlocklist: [] });
  assert.match(empty, /on any website\. Never sign in to a banking/);
});

test('the old allowWebLogins switch becomes a mode', () => {
  const load = (file) => {
    const home = mkdtempSync(join(tmpdir(), 'rookery-weblogin-'));
    writeFileSync(join(home, 'config.json'), JSON.stringify(file));
    return loadConfig({ home });
  };
  const on = load({ allowWebLogins: true, webLoginDomains: ['github.com'] });
  assert.equal(on.webLoginMode, 'allowlist');
  assert.deepEqual(on.webLoginDomains, ['github.com']);
  assert.equal('allowWebLogins' in on, false);
  assert.equal(load({ allowWebLogins: false, webLoginDomains: ['github.com'] }).webLoginMode, 'off');
  assert.equal(load({ allowWebLogins: true, webLoginMode: 'all' }).webLoginMode, 'all');
  const fresh = load({});
  assert.equal(fresh.webLoginMode, 'off');
  assert.ok(fresh.webLoginBlocklist.includes('sparkasse.de'));
});
