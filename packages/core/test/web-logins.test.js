import test from 'node:test';
import assert from 'node:assert/strict';
import { computerPromptBlock, webLoginDomains } from '../dist/computer/tools.js';
import { TOOL_CATALOG } from '../dist/tools/catalog.js';
import { DEFAULT_CONFIG } from '../dist/config.js';

const OFF_RULE =
  "UAC prompts, Windows Hello, PINs, sign-ins and CAPTCHAs are the user's: call hand_over " +
  'with a short reason, never try to answer them.';
const hint = (id, config) => TOOL_CATALOG.find((entry) => entry.id === id).hint({}, config);

test('web sign-ins off: the prompts keep the old hand-over rule and say nothing new', () => {
  for (const config of [DEFAULT_CONFIG, { ...DEFAULT_CONFIG, allowWebLogins: true, webLoginDomains: [] }, { ...DEFAULT_CONFIG, webLoginDomains: ['example.com'] }]) {
    assert.deepEqual(webLoginDomains(config), []);
    assert.equal(hint('computer', config), computerPromptBlock('builtin'));
    assert.ok(computerPromptBlock('builtin').includes(OFF_RULE));
    assert.doesNotMatch(hint('computer', config) + hint('playwright', config), /allowed you to complete web sign-ins/);
  }
});

test('web sign-ins on: the domains are named and the exclusions stay', () => {
  const config = { ...DEFAULT_CONFIG, allowWebLogins: true, webLoginDomains: ['https://Login.Microsoft.com/x', '*.github.com', 'not a host'] };
  assert.deepEqual(webLoginDomains(config), ['login.microsoft.com', 'github.com']);
  for (const text of [hint('computer', config), hint('playwright', config), computerPromptBlock('zavora', webLoginDomains(config))]) {
    assert.match(text, /subdomains: login\.microsoft\.com, github\.com\./);
    for (const kept of ['any other domain', 'CAPTCHA', 'payment confirmation', 'UAC', 'Windows Hello', 'a PIN', 'lock screen', 'hand_over']) {
      assert.ok(text.includes(kept), kept);
    }
    assert.doesNotMatch(text, /not a host/);
  }
  assert.ok(!hint('computer', config).includes(OFF_RULE));
});
