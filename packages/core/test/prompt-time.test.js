import test from 'node:test';
import assert from 'node:assert/strict';

import { formatAge, formatDay, formatNow, formatWhen, localOffset } from '../dist/index.js';

/**
 * The bug this file exists for: a schedule prompt printed a local "now" while
 * `list_runs` printed UTC start times, so a model judging "has this run too
 * long" subtracted one zone from another. In CEST that is a phantom two
 * hours, and the board watcher restarted healthy runs because of it.
 */

test('a wall clock a model reads is the local one, not UTC', () => {
  // 2026-09-18T02:12:00Z is 04:12 in CEST. The UTC rendering would say 02:12
  // and a model comparing it against a local now would invent two hours.
  const at = Date.UTC(2026, 8, 18, 2, 12);
  const local = new Date(at);
  const shown = formatWhen(at);
  const hour = String(local.getHours()).padStart(2, '0');
  const minute = String(local.getMinutes()).padStart(2, '0');
  assert.ok(shown.includes(hour + ':' + minute), shown + ' should carry the local time ' + hour + ':' + minute);
  if (local.getTimezoneOffset() !== 0) {
    assert.ok(!shown.includes('02:12'), shown + ' must not fall back to the UTC clock');
  }
});

test('a day is the local calendar day, even when UTC has already turned', () => {
  // 23:30 local on the 17th east of Greenwich is the 17th, whatever UTC says.
  const at = Date.UTC(2026, 8, 17, 23, 30);
  const shown = formatDay(at);
  const expected = new Date(at).toLocaleDateString('en-GB', { dateStyle: 'medium' });
  assert.equal(shown, expected);
});

test('the now-anchor names its zone, so the stamps under it can be compared', () => {
  const now = formatNow(Date.UTC(2026, 8, 18, 2, 12));
  assert.match(now, /UTC[+-]/, 'the anchor must carry an offset: ' + now);
  assert.ok(now.length > 'UTC+0'.length, now);
});

test('an offset reads as a person writes it', () => {
  const offset = localOffset(Date.UTC(2026, 8, 18, 2, 12));
  assert.match(offset, /^UTC[+-]\d{1,2}(:\d{2})?$/, offset);
});

test('an age is an age, and no timezone can stretch it', () => {
  const now = Date.UTC(2026, 8, 18, 4, 0);
  assert.equal(formatAge(now - 42_000, now), '42s');
  assert.equal(formatAge(now - 12 * 60_000, now), '12m');
  assert.equal(formatAge(now - 3 * 3_600_000, now), '3h');
  assert.equal(formatAge(now - 2 * 86_400_000, now), '2d');
  // The actual defect, stated as a test: a run started a minute ago is a
  // minute old, not two hours, whatever zone the machine stands in.
  assert.equal(formatAge(now - 60_000, now), '1m');
});

test('a clock that has not moved yet never reads as negative', () => {
  const now = Date.UTC(2026, 8, 18, 4, 0);
  assert.equal(formatAge(now + 5000, now), '0s');
});

test('a board counts in minutes, because "waiting 0s" is noise dressed as precision', () => {
  const now = Date.UTC(2026, 8, 18, 4, 0);
  assert.equal(formatAge(now - 5000, now, 'minute'), '0m');
  assert.equal(formatAge(now - 90_000, now, 'minute'), '1m');
  assert.equal(formatAge(now - 3 * 3_600_000, now, 'minute'), '3h');
});
