import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unconfirmedMessage } from '../dist/providers/claude-tui.js';

// A message typed into the Claude Code terminal that the transcript has not
// confirmed yet is typed again only when the screen shows it never arrived.
const notice = '[Rookery] Background task 7432c125 "X" is done.\n\nReport:\n' + 'line\n'.repeat(80) + 'Keep it as short as the report allows.';

test('a message Claude Code is working on is never typed again', () => {
  // The start scrolled off the screen; the spinner says it is being answered.
  assert.equal(unconfirmedMessage('line\nline\n✻ Thinking… (4s · esc to interrupt)\n', notice), 'wait');
});

test('a sent message still on screen gets Enter, not a second copy', () => {
  assert.equal(unconfirmedMessage('> line\nline Keep it as short as the report allows.\n', notice), 'enter');
  assert.equal(unconfirmedMessage('> [Pasted text #1 +84 lines]\n', notice), 'enter');
  assert.equal(unconfirmedMessage(null, notice), 'enter');
});

test('keys that never arrived are typed again', () => {
  assert.equal(unconfirmedMessage('>\n? for shortcuts\n', notice), 'retype');
});
