// Run: node --test packages/web/src/components/blocks/data-table/data-table.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { outputFiles } = await build({
  stdin: {
    contents: `export { DataTable } from './data-table.tsx';
      export { DataTablePagination } from './data-table-pagination.tsx';`,
    resolveDir: fileURLToPath(new URL('.', import.meta.url)),
  },
  alias: { '@': fileURLToPath(new URL('../../..', import.meta.url)) },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  jsx: 'automatic',
});
const module = { exports: {} };
new Function('require', 'module', 'exports', outputFiles[0].text)(
  createRequire(import.meta.url), module, module.exports,
);
const { DataTable, DataTablePagination } = module.exports;

test('only selection and action columns reserve a narrow width', () => {
  const html = renderToStaticMarkup(createElement(DataTable, {
    data: [{ name: 'Telegram' }],
    columns: [
      { accessorKey: 'name', header: 'Name' },
      { id: 'select', header: 'Auswahl', cell: () => '' },
      { id: 'actions', header: 'Aktionen', cell: () => '' },
    ],
    showColumnMenu: false,
    paginate: false,
  }));
  const heads = [...html.matchAll(/<th\b[^>]*>/g)].map(([tag]) => tag);
  assert.equal(heads.length, 3);
  assert.doesNotMatch(heads[0], /\bw-8\b/);
  assert.match(heads[1], /\bw-8\b/);
  assert.match(heads[2], /\bw-8\b/);
  assert.doesNotMatch(html, /first:w-8/);
});

test('loaded row counts always use the dative plural', () => {
  for (const [rowCount, loadedCount] of [[1, 1], [1, 2], [2, 2]]) {
    const html = renderToStaticMarkup(createElement(DataTablePagination, {
      pageIndex: 0, pageCount: 1, pageSize: 20,
      onPageChange() {}, onPageSizeChange() {},
      rowCount, loadedCount,
      rowLabel: { singular: 'Gateway', plural: 'Gateways' },
    }));
    assert.ok(html.includes(`${rowCount} von ${loadedCount} geladenen Gateways`));
  }
});

test('automatic sorting orders text, numbered names, numbers and dates', () => {
  for (const values of [
    ['Beta', 'alpha'],
    ['Agent 10', 'Agent 2'],
    [10, 2],
    [new Date('2026-09-12'), new Date('2026-09-01')],
  ]) {
    for (const desc of [false, true]) {
      const html = renderToStaticMarkup(createElement(DataTable, {
        data: [{ value: values[0], id: 'later' }, { value: values[1], id: 'earlier' }],
        columns: [{ accessorKey: 'value', cell: ({ row }) => row.original.id }],
        initialSorting: [{ id: 'value', desc }],
        showColumnMenu: false,
        paginate: false,
      }));
      const cells = [...html.matchAll(/<td\b[^>]*>(.*?)<\/td>/g)].map((match) => match[1]);
      assert.deepEqual(cells, desc ? ['later', 'earlier'] : ['earlier', 'later']);
    }
  }
});
