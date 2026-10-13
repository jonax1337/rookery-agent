import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '@rookery/core';
import { publicConfig } from '../dist/context.js';

/**
 * The settings page reads what GET /api/config hands it. A field missing
 * here shows the page's fallback instead of the stored value - which is how
 * the "Chat in Claude Code's terminal" switch read on while it was off.
 */
test('publicConfig carries turns and the web sign-in fields', () => {
  const config = {
    ...DEFAULT_CONFIG,
    turns: { timeoutMs: 60_000, terminal: false },
    webLoginMode: 'all',
    webLoginBlocklist: ['paypal.com'],
  };
  const view = publicConfig(config);
  assert.deepEqual(view.turns, { timeoutMs: 60_000, terminal: false });
  assert.equal(view.webLoginMode, 'all');
  assert.deepEqual(view.webLoginDomains, []);
  assert.deepEqual(view.webLoginBlocklist, ['paypal.com']);
  assert.equal('token' in view, false);
});
