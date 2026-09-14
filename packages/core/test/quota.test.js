import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexWindows, parseGlmWindows } from '../dist/providers/quota.js';

const RESET_MS = 1788351145586;

test('z.ai reports the Coding Plan as a five-hour and a weekly window', () => {
  const windows = parseGlmWindows({
    code: 200,
    msg: 'Operation successful',
    success: true,
    data: {
      level: 'lite',
      limits: [
        {
          type: 'CREDIT_LIMIT',
          unit: 3,
          number: 5,
          usage: 2000,
          currentValue: 402,
          remaining: 1598,
          percentage: 20,
          nextResetTime: RESET_MS,
        },
        // No `percentage`: the spent-out-of-allowance pair has to carry it.
        {
          type: 'CREDIT_LIMIT',
          unit: 6,
          number: 1,
          usage: 10000,
          currentValue: 2500,
          remaining: 7500,
          nextResetTime: RESET_MS,
        },
      ],
    },
  });
  assert.deepEqual(windows, [
    { kind: 'session', label: '5 hours', percent: 20, resetsAt: new Date(RESET_MS).toISOString() },
    { kind: 'weekly', label: 'Week', percent: 25, resetsAt: new Date(RESET_MS).toISOString() },
  ]);
});

test('z.ai windows survive a renamed limit type and drop what cannot be named', () => {
  const windows = parseGlmWindows({
    data: {
      limits: [
        // The window is identified by its length, never by the type z.ai
        // happens to meter it as.
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 7 },
        // The same window a second way: one bar, not two.
        { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 9 },
        // A unit nothing here can name, and an entry without any figure.
        { type: 'CREDIT_LIMIT', unit: 99, number: 1, percentage: 50 },
        { type: 'CREDIT_LIMIT', unit: 6, number: 1 },
      ],
    },
  });
  assert.deepEqual(windows, [{ kind: 'session', label: '5 hours', percent: 7 }]);
});

test('a payload without limits is no windows rather than a throw', () => {
  assert.deepEqual(parseGlmWindows({ success: false, msg: 'unauthorized' }), []);
  assert.deepEqual(parseGlmWindows({ data: { limits: [null, 'nope', {}] } }), []);
  assert.deepEqual(parseGlmWindows(undefined), []);
});

test('Codex still labels its windows by length', () => {
  assert.deepEqual(
    parseCodexWindows({
      rate_limit: {
        primary_window: { used_percent: 12.4, limit_window_seconds: 5 * 3600, reset_at: 1788351145 },
        secondary_window: { used_percent: 61, limit_window_seconds: 7 * 24 * 3600 },
      },
    }),
    [
      { kind: 'session', label: '5 hours', percent: 12, resetsAt: new Date(1788351145 * 1000).toISOString() },
      { kind: 'weekly', label: 'Week', percent: 61 },
    ],
  );
  // No length reported: the position in the payload is all that is left.
  assert.deepEqual(parseCodexWindows({ rate_limit: { primary_window: { used_percent: 3 } } }), [
    { kind: 'session', label: 'Session', percent: 3 },
  ]);
});
