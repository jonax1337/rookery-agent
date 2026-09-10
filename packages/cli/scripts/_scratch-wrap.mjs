import { createElement as h } from 'react';
import { Box, renderToString } from 'ink';
import { Scrollback } from '../dist/tui/components/Scrollback.js';

const long = 'Die Rookery TUI soll richtig sauber aussehen und dieser Absatz ist absichtlich sehr lang damit man sieht ob der Zeilenumbruch im Terminal tatsaechlich greift oder ob alles in eine einzige Zeile geklatscht wird was ziemlich haesslich waere.';

const entries = [
  { kind: 'user', id: 'u1', text: 'mach die tui huebsch' },
  { kind: 'activity', id: 'c1', icon: '⏺', text: 'Read src/repl.ts' },
  { kind: 'activity', id: 'c2', icon: '⏺', text: 'Bash npm run build' },
  { kind: 'assistant', id: 'a1', speaker: 'jarvis', provider: 'claude', durationMs: 1234,
    text: long + '\n\n- ein listenpunkt der auch sehr lang ist und umbrechen muss damit man sieht wie sich das verhaelt im schmalen terminal\n\n' + long },
];

for (const w of [60, 100]) {
  const out = renderToString(h(Box, { width: w, flexDirection: 'column' }, h(Scrollback, { entries, inline: true })));
  console.log('+' + '-'.repeat(w - 2) + '+ width=' + w);
  console.log(out.replace(/\x1b\[[0-9;]*m/g, ''));
  console.log('+' + '-'.repeat(w - 2) + '+');
}
