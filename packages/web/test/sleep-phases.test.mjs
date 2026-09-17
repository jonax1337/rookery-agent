import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

/**
 * The running-night row walks `SLEEP_PHASES` in `pages/MemoryLayout.tsx`, while
 * the night itself reports the stages of `SleepStage` from
 * `packages/core/src/types.ts`. `replay` was missing from the list, so the
 * progress bar dropped to zero as soon as the replay phase announced itself -
 * `phaseProgress` maps an unknown phase to 0. These tests keep the two sides
 * from drifting apart again, the same way `config-save.test.mjs` reads its
 * subjects out of the real source files.
 *
 * They run under `npm test -w @rookery/web`; the root `npm test` only collects
 * `packages/core/test/*.test.js` and never sees this file.
 */

/** Mirror of the `SleepStage` union - a type has no runtime presence to read. */
const STAGES = ['replay', 'light', 'deep', 'rem'];

// Pull `SLEEP_PHASES` and `phaseProgress` out of the page itself, so the tests
// follow the shipped list rather than a copy of it that could go stale here.
function fromMemoryLayout() {
  const file = 'pages/MemoryLayout.tsx';
  const source = ts.createSourceFile(
    file,
    readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found = {};
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'SLEEP_PHASES') {
      found.phases = node.initializer.getText(source);
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.name.getText(source) === 'phaseProgress') {
      found.progress = node.getText(source);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(found.phases, 'MemoryLayout.tsx still declares SLEEP_PHASES');
  assert.ok(found.progress, 'MemoryLayout.tsx still declares phaseProgress');
  const js = ts.transpileModule(`const SLEEP_PHASES = ${found.phases};\n${found.progress}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(js + '\nreturn { phases: SLEEP_PHASES, progressFor: phaseProgress };')();
}

const { phases, progressFor } = fromMemoryLayout();

test('every SleepStage occurs in SLEEP_PHASES', () => {
  // The mirror above must track what the core union actually declares, so a
  // new stage fails here until the progress bar learns to walk it.
  const types = readFileSync(new URL('../../core/src/types.ts', import.meta.url), 'utf8');
  const union = /export type SleepStage = ([^;]+);/.exec(types);
  assert.ok(union, 'core types.ts declares the SleepStage union');
  const declared = [...union[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(declared, STAGES);

  assert.ok(STAGES.every((stage) => phases.includes(stage)));
  // And in walking order: replay sits between settling in and the cycles.
  assert.deepEqual(phases, ['started', 'replay', 'light', 'deep', 'rem', 'finished']);
});

test('the replay phase no longer drops the progress bar to zero', () => {
  const value = progressFor('replay');
  assert.ok(value > 0, `progressFor('replay') is ${value}, not zero`);
  assert.ok(value < 100, `progressFor('replay') is ${value}, not the whole night`);
});
