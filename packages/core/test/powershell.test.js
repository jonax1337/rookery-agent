import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PowerShellSession } from '../dist/computer/powershell.js';

test('powershell: a timed-out action is killed and its late reply never answers the next call', async t => {
  if (process.platform !== 'win32') return t.skip('The computer-control shell is Windows only.');
  const shell = new PowerShellSession();
  try {
    // The sleeper outlives its own timeout. Before the fix the shell kept
    // running it, and the reply that arrived late resolved the NEXT call -
    // proven cross-talk, not a theoretical race.
    await assert.rejects(shell.run("Start-Sleep -Seconds 6; 'late'", 300), /timed out/);
    const after = await shell.run("'second'", 30_000);
    assert.equal(after, 'second', 'the call after a timeout gets its own answer, never the stale one');
    const queued = await Promise.all([shell.run("'one'"), shell.run("'two'"), shell.run("'three'")]);
    assert.deepEqual(queued, ['one', 'two', 'three']);
  } finally {
    shell.close();
  }
});
