import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksInterim, expectedArtifacts } from '../dist/util/interim-report.js';

// A report that still waits for something is not the final result.
test('reports that defer the result are interim', () => {
  for (const text of [
    'Die Rookery-Daten sind gesammelt (GitHub öffentlich seit 10.09.2026, 1 Stern, v0.5.1 vom 13.10.2026). Das Dokument schreibe ich, sobald die drei Recherche-Agents zurückgemeldet haben.',
    'Zwei Agents laufen noch (Hermes/OpenClaw und die zusätzlichen Assistenten).',
    'Ich warte noch auf die Rückmeldung der Recherche-Agents.',
    'Ich melde mich, sobald die Tests durch sind.',
    'Den Rest liefere ich später nach.',
    "I'll write the document once the research agents report back.",
    'Waiting for the sub-agents to finish.',
    'Two agents are still running.',
    'I will send the final report when they are done.',
    // Said in live runs while sub-agents were still out.
    'Alpha ist zurück. Beta und Gamma stehen noch aus, deshalb schreibe ich die Datei noch nicht.',
    'Beta ist fertig, das Ergebnis lautet "Beta". Gamma fehlt noch, deshalb schreibe ich die Datei noch nicht.',
    'Gamma ist weiterhin nicht fertig, das ist wieder nur ein Zwischenstand.',
    'Gamma is still missing.',
  ]) assert.equal(looksInterim(text), true, text);
});

test('final reports, suggestions and descriptions are not interim', () => {
  for (const text of [
    'Der Vergleich liegt in docs/vergleich-assistenten.md. Er enthält die Tabelle über zehn Systeme und neun Kriterien.',
    'Fertig. Geänderte Dateien: a.ts, b.ts. Tests: 22 grün.',
    'Sobald Sie die Änderung freigeben, kann sie committet werden.',
    'The scheduler waits for the lock before writing.',
    'Done. All three agents reported back; the file is written.',
    'FINAL: Alpha Beta Gamma',
    'Kein Fehler fehlt, alles ist erledigt.',
  ]) assert.equal(looksInterim(text), false, text);
});

test('paths after a write verb are expected artifacts', () => {
  assert.deepEqual(
    expectedArtifacts('Schreibe das Ergebnis als Markdown-Datei nach E:/DEV/rookery-agent/docs/vergleich-assistenten.md und gib im Bericht die Kernaussagen kurz wieder.'),
    ['E:/DEV/rookery-agent/docs/vergleich-assistenten.md'],
  );
  assert.deepEqual(expectedArtifacts('Lies E:/DEV/x/README.md und fasse zusammen.'), []);
  assert.deepEqual(expectedArtifacts('Write the summary to /tmp/out/report.txt.'), ['/tmp/out/report.txt']);
  assert.deepEqual(expectedArtifacts('Save it as C:\\out\\a.json; then write it to C:\\out\\a.json again.'), ['C:\\out\\a.json']);
});
