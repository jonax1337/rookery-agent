// Run: node --test packages/web/test/command-palette.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

// Execute the production list callbacks, without mounting the dialog or router.
const file = 'command-palette.tsx';
const source = ts.createSourceFile(file, readFileSync(new URL('../src/components/common/' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map();
let limit;
function visit(node) {
  if (ts.isVariableDeclaration(node)) {
    const name = node.name.getText(source);
    if (name === 'PER_GROUP') limit = Number(node.initializer.getText(source));
    if (['recentSessions', 'recentTasks', 'liveAssignments'].includes(name)) {
      callbacks.set(name, node.initializer.arguments[0].getText(source));
    }
  }
  ts.forEachChild(node, visit);
}
visit(source);

test('search includes older loaded records in every previously capped group', () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({ id: index, updatedAt: 12 - index }));
  for (const name of ['recentSessions', 'recentTasks', 'liveAssignments']) {
    assert.ok(callbacks.has(name));
    const js = ts.transpileModule(`const run = ${callbacks.get(name)};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const run = new Function('sessions', 'tasks', 'assignments', 'PER_GROUP', 'query', js + '\nreturn run();');
    for (const query of ['', '   ', 'older record']) {
      const actual = run(rows, rows, rows, limit, query);
      assert.deepEqual(actual, query.trim() ? rows : rows.slice(0, 8), `${name}: ${JSON.stringify(query)}`);
    }
    assert.equal(rows[0].id, 0, 'input order is unchanged');
  }
});
