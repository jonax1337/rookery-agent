import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startConversationTerminal, unconfirmedMessage } from '../dist/providers/claude-tui.js';

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

/* ------------- a report-back typed into a real conversation terminal ------------- */

// Claude Code 2.1.296 writes a pasted message to its transcript wrapped in
// <pasted_content id="..."> tags and draws no "esc to interrupt" while it
// thinks. The acceptance check read neither, so it typed the 0.5.1 report-back
// of task fb6ab447 again every 3 s and Claude Code answered three copies.
test('a pasted message Claude Code wraps in <pasted_content> is typed once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rookery-accept-'));
  const sessionId = 'session-accept';
  mkdirSync(join(root, 'projects', 'p'), { recursive: true });
  const transcript = join(root, 'projects', 'p', sessionId + '.jsonl');
  writeFileSync(transcript, '');
  const markerFile = join(root, 'stop.json');
  const line = (entry) => appendFileSync(transcript, JSON.stringify({ uuid: randomUUID(), ...entry }) + '\n');

  let sends = 0;
  let typed = '';
  const dataListeners = [];
  const exits = [];
  const proc = {
    onData(listener) {
      dataListeners.push(listener);
    },
    onExit(listener) {
      exits.push(listener);
    },
    write(data) {
      if (data !== '\r') {
        typed += data;
        return;
      }
      if (!typed.includes('[Rookery] Background task')) return;
      sends += 1;
      const body = typed.replace(/\x1b\[20[01]~/g, '');
      typed = '';
      // Claude Code takes the message at once, then thinks for a while.
      line({ type: 'user', message: { role: 'user', content: '\n\n<pasted_content id="e4bc">\n' + body + '\n</pasted_content id="e4bc">\n' } });
      if (sends > 1) return;
      setTimeout(() => {
        line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Summarised.' }] } });
        writeFileSync(markerFile, JSON.stringify({ last_assistant_message: 'Summarised.' }));
        line({ type: 'system', subtype: 'turn_duration', durationMs: 1 });
      }, 7000);
    },
    resize() {},
    kill() {
      for (const listener of exits.splice(0)) listener({ exitCode: 0 });
    },
  };
  // The idle input box, with bracketed paste on, as Claude Code draws it.
  setTimeout(() => {
    for (const listener of dataListeners) listener('\x1b[?2004h> \r\n? for shortcuts\r\n');
  }, 50);

  const terminal = await startConversationTerminal(
    {
      key: 'chat:accept',
      binary: { path: 'claude', isShim: false },
      args: [],
      env: { CLAUDE_CONFIG_DIR: root },
      sessionId,
      workDir: root,
      markerFile,
      mapEntry: (entry) =>
        entry.type === 'assistant'
          ? entry.message.content.map((block) => ({ type: 'text', delta: block.text }))
          : [],
      cleanup() {},
      pty: { spawn: () => proc },
    },
    false,
    { onTurn() {}, onExit() {} },
  );
  try {
    const turn = await terminal.submit({ prompt: notice, onEvent() {} });
    assert.equal(turn.answer, 'Summarised.');
    assert.equal(sends, 1, 'the report-back went into the terminal exactly once');
  } finally {
    terminal.close();
  }
});
