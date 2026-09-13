import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyUpdate,
  escapeHtml,
  inQuietHours,
  missingGatewaySettings,
  nextGatewayAction,
  pushRecipients,
  splitMessage,
  wantsGatewayRunning,
} from '../dist/index.js';

/**
 * The Telegram gateway guard: who may drive the machine from a phone, how a
 * long answer becomes several messages Telegram will actually accept, and
 * the small pieces of config logic (quiet hours, push recipients) around it.
 *
 * `classifyUpdate` takes foreign JSON, so most of this file builds one
 * update object per scenario rather than trusting a shared fixture - the
 * point is exactly that an unexpected shape must not slip through.
 */

const OWNER_ID = 111;

function makeConfig(overrides = {}) {
  return {
    enabled: true,
    allowedUserIds: [OWNER_ID],
    permission: 'full',
    push: {
      enabled: false,
      assignments: false,
      cron: false,
      sleep: false,
      tasks: false,
      quietFrom: '',
      quietUntil: '',
      maxPerHour: 0,
      recipients: [],
    },
    ...overrides,
  };
}

function makeUpdate(overrides = {}) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1690000000,
      from: { id: OWNER_ID, is_bot: false, first_name: 'Owner' },
      chat: { id: OWNER_ID, type: 'private' },
      text: 'hallo',
      ...overrides,
    },
  };
}

test('an allowed id in its own private chat gets through', () => {
  const verdict = classifyUpdate(makeUpdate(), makeConfig());
  assert.equal(verdict.ok, true);
  assert.equal(verdict.userId, OWNER_ID);
  assert.equal(verdict.chatId, OWNER_ID);
});

test('an id that is not on the allowlist is rejected', () => {
  const update = makeUpdate({
    from: { id: 999, is_bot: false },
    chat: { id: 999, type: 'private' },
  });
  const verdict = classifyUpdate(update, makeConfig());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'not_allowed');
});

test('a group chat is rejected even for an allowed sender', () => {
  const update = makeUpdate({ chat: { id: -100123, type: 'group' } });
  const verdict = classifyUpdate(update, makeConfig());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'not_private');
});

test('a private chat whose id does not match the sender is rejected', () => {
  // Not a shape Telegram sends on its own, but the check exists for exactly
  // this case, so it has to be exercised directly.
  const update = makeUpdate({ chat: { id: 222, type: 'private' } });
  const verdict = classifyUpdate(update, makeConfig());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'not_private');
});

test('a forwarded message is rejected as foreign text', () => {
  const update = makeUpdate({ forward_origin: { type: 'user', sender_user: { id: 555 } } });
  const verdict = classifyUpdate(update, makeConfig());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'forwarded');
});

test('text written by another bot is rejected the same way as a forward', () => {
  const update = makeUpdate({ via_bot: { id: 42, is_bot: true, first_name: 'OtherBot' } });
  const verdict = classifyUpdate(update, makeConfig());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'forwarded');
});

test('a bot sender is rejected before the allowlist is even consulted', () => {
  const update = makeUpdate({ from: { id: OWNER_ID, is_bot: true } });
  const verdict = classifyUpdate(update, makeConfig());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'bot_sender');
});

test('an update carrying no message classifies as not_a_message', () => {
  const verdict = classifyUpdate({ update_id: 1, edited_message: { text: 'x' } }, makeConfig());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'not_a_message');
});

test('a photo with no caption is rejected for lacking text', () => {
  const update = makeUpdate({ text: undefined, photo: [{ file_id: 'abc', file_size: 100 }] });
  const verdict = classifyUpdate(update, makeConfig());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'no_text');
});

test('a message past the length ceiling is rejected as too_long', () => {
  const update = makeUpdate({ text: 'a'.repeat(5000) });
  const verdict = classifyUpdate(update, makeConfig());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'too_long');
});

test('an empty allowlist rejects even the id it would otherwise accept', () => {
  // The most important case in this file: there is no config shape that
  // means "everyone", and an empty list must not accidentally become one.
  const verdict = classifyUpdate(makeUpdate(), makeConfig({ allowedUserIds: [] }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'not_allowed');
});

test('/id from an unknown sender still reports the parsed command', () => {
  const update = makeUpdate({
    from: { id: 999, is_bot: false },
    chat: { id: 999, type: 'private' },
    text: '/id',
  });
  const verdict = classifyUpdate(update, makeConfig());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'not_allowed');
  assert.equal(verdict.command, 'id');
});

test('a bot-addressed command strips the @botname and keeps the rest as args', () => {
  const update = makeUpdate({ text: '/neu@meinbot Rest' });
  const verdict = classifyUpdate(update, makeConfig());
  assert.equal(verdict.ok, true);
  assert.equal(verdict.command, 'neu');
  assert.equal(verdict.args, 'Rest');
});

test('malformed input is never classified as ok', () => {
  const config = makeConfig();
  for (const bad of [null, '', {}, 42, []]) {
    const verdict = classifyUpdate(bad, config);
    assert.equal(verdict.ok, false, `${JSON.stringify(bad)} must not pass`);
  }
});

test('a short text is returned as a single piece', () => {
  const parts = splitMessage('hallo welt');
  assert.deepEqual(parts, ['hallo welt']);
});

test('a long text is split so that no piece exceeds the limit', () => {
  const paragraphs = Array.from(
    { length: 20 },
    (_, i) => `paragraph number ${i} with some filler words here`,
  );
  const parts = splitMessage(paragraphs.join('\n\n'), 60);
  assert.ok(parts.length > 1, 'the text is long enough that it must have been split');
  for (const part of parts) {
    assert.ok(part.length <= 60, `piece exceeds the limit: ${JSON.stringify(part)}`);
  }
});

test('the cut prefers a paragraph break over a mid-line hard cut', () => {
  const text = `${'A'.repeat(20)}\n\n${'B'.repeat(20)}`;
  const parts = splitMessage(text, 25);
  assert.deepEqual(parts, ['A'.repeat(20), 'B'.repeat(20)]);
});

test('a code block cut across the limit is closed and reopened with its language', () => {
  const text = '```js\nlineone\nlinetwo\nlinethree\nlinefour\n```\nafter';
  const parts = splitMessage(text, 25);

  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.length <= 25, `piece exceeds the limit: ${JSON.stringify(part)}`);
    // Every fence line opened in a piece must be closed again inside the
    // same piece - that is the whole point of the reopen logic.
    const fenceLines = part.split('\n').filter((line) => line.trimStart().startsWith('```'));
    assert.equal(fenceLines.length % 2, 0, `unbalanced fence in piece: ${JSON.stringify(part)}`);
  }
  // Every piece after the first still opens with the same language tag.
  for (const part of parts.slice(1)) {
    assert.ok(part.startsWith('```js\n'), `piece did not reopen the block: ${JSON.stringify(part)}`);
  }
});

test('empty text produces an empty array, not a blank message', () => {
  assert.deepEqual(splitMessage(''), []);
  assert.deepEqual(splitMessage('   \n  '), []);
});

test('23:00 falls inside a 22:00-08:00 quiet window', () => {
  assert.equal(inQuietHours(23 * 60, '22:00', '08:00'), true);
});

test('noon falls outside a 22:00-08:00 quiet window', () => {
  assert.equal(inQuietHours(12 * 60, '22:00', '08:00'), false);
});

test('07:00 is still inside a window that wraps midnight', () => {
  assert.equal(inQuietHours(7 * 60, '22:00', '08:00'), true);
});

test('a window that does not wrap midnight works the same way', () => {
  assert.equal(inQuietHours(3 * 60, '01:00', '05:00'), true);
  assert.equal(inQuietHours(6 * 60, '01:00', '05:00'), false);
});

test('empty bounds mean no quiet hours at all', () => {
  assert.equal(inQuietHours(23 * 60, '', ''), false);
  assert.equal(inQuietHours(23 * 60, '22:00', ''), false);
  assert.equal(inQuietHours(23 * 60, '', '08:00'), false);
});

test('an empty recipient list falls back to the first allowed id', () => {
  const config = makeConfig({ allowedUserIds: [111, 222], push: { recipients: [] } });
  assert.deepEqual(pushRecipients(config), [111]);
});

test('a configured recipient outside the allowlist is filtered out', () => {
  const config = makeConfig({ allowedUserIds: [111, 222], push: { recipients: [333, 222] } });
  assert.deepEqual(pushRecipients(config), [222]);
});

test('an empty allowlist leaves nobody to push to', () => {
  const config = makeConfig({ allowedUserIds: [], push: { recipients: [111] } });
  assert.deepEqual(pushRecipients(config), []);
});

test('& is escaped first, so an already-escaped-looking input is not double-escaped', () => {
  assert.equal(escapeHtml('&<'), '&amp;&lt;');
});

/* ---------------------------- lifecycle ---------------------------- */

const RUNNING = { running: true, activeToken: 'tok-a' };
const STOPPED = { running: false, activeToken: '' };

test('wants to run with a token, an allowed sender and nothing silencing it', () => {
  assert.equal(wantsGatewayRunning(makeConfig(), 'tok-a', false), true);
});

test('does not want to run without a token', () => {
  assert.equal(wantsGatewayRunning(makeConfig(), '', false), false);
});

test('does not want to run switched off, silenced, or with an empty allowlist', () => {
  assert.equal(wantsGatewayRunning(makeConfig({ enabled: false }), 'tok-a', false), false);
  assert.equal(wantsGatewayRunning(makeConfig(), 'tok-a', true), false);
  assert.equal(wantsGatewayRunning(makeConfig({ allowedUserIds: [] }), 'tok-a', false), false);
});

test('pairing mode wants to run with an empty allowlist', () => {
  assert.equal(wantsGatewayRunning(makeConfig({ allowedUserIds: [], pairing: true }), 'tok-a', false), true);
});

test('missing settings names every gap, not just the first one', () => {
  const missing = missingGatewaySettings(
    makeConfig({ enabled: false, allowedUserIds: [] }),
    '',
    true,
  );
  assert.deepEqual(missing.sort(), [
    '/off until restart',
    'gateways.telegram.allowedUserIds',
    'gateways.telegram.enabled',
    'gateways.telegram.token',
  ]);
});

test('missing settings never names the token itself', () => {
  const missing = missingGatewaySettings(makeConfig(), '', false);
  assert.ok(!missing.some((entry) => entry.includes('tok-')));
});

test('missing settings is empty for pairing mode with nothing else wrong', () => {
  assert.deepEqual(
    missingGatewaySettings(makeConfig({ allowedUserIds: [], pairing: true }), 'tok-a', false),
    [],
  );
});

test('stopped and everything in place: start', () => {
  const decision = nextGatewayAction(STOPPED, makeConfig(), 'tok-a', false);
  assert.deepEqual(decision, { action: 'start', clearBlock: true });
});

test('running and nothing changed: none', () => {
  const decision = nextGatewayAction(RUNNING, makeConfig(), 'tok-a', false);
  assert.deepEqual(decision, { action: 'none', clearBlock: true });
});

test('running and switched off: stop, and the block clears', () => {
  const state = { ...RUNNING, blockedToken: 'tok-a' };
  const decision = nextGatewayAction(state, makeConfig({ enabled: false }), 'tok-a', false);
  assert.deepEqual(decision, { action: 'stop', clearBlock: true });
});

test('stopped and switched off: none, but the block still clears', () => {
  const state = { ...STOPPED, blockedToken: 'tok-a' };
  const decision = nextGatewayAction(state, makeConfig({ enabled: false }), 'tok-a', false);
  assert.deepEqual(decision, { action: 'none', clearBlock: true });
});

test('a new token while running is a restart, not a wait for the next boot', () => {
  const decision = nextGatewayAction(RUNNING, makeConfig(), 'tok-b', false);
  assert.deepEqual(decision, { action: 'restart', clearBlock: true });
});

test('blocked on the exact token that is still configured: none, block stays', () => {
  const state = { ...STOPPED, blockedToken: 'tok-a' };
  const decision = nextGatewayAction(state, makeConfig(), 'tok-a', false);
  assert.deepEqual(decision, { action: 'none', clearBlock: false });
});

test('blocked on an old token that was since replaced: start, block clears', () => {
  const state = { ...STOPPED, blockedToken: 'tok-old' };
  const decision = nextGatewayAction(state, makeConfig(), 'tok-a', false);
  assert.deepEqual(decision, { action: 'start', clearBlock: true });
});

test('turning the channel off lifts a block even on the same token', () => {
  const state = { ...STOPPED, blockedToken: 'tok-a' };
  const decision = nextGatewayAction(state, makeConfig({ enabled: false }), 'tok-a', false);
  assert.deepEqual(decision, { action: 'none', clearBlock: true });
});
