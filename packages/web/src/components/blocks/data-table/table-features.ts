import {
  columnFilteringFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
} from '@tanstack/react-table';
import type { Cell, Column, ColumnDef, Row, RowData, Table } from '@tanstack/react-table';

/**
 * The one feature set every Rookery table shares.
 *
 * TanStack v9 tree-shakes anything that is not registered here, so this list is
 * deliberately the smallest set that carries all pages: sorting, column
 * visibility, row selection, client-side pagination, column filters (for the
 * facet tabs) and one global filter for the toolbar search.
 *
 * What is NOT in here is as important as what is: no row expanding, no column
 * ordering, no grouping — and above all nothing that would reorder rows by
 * hand. The server has no sort_order column anywhere, so a drag handle could
 * never persist what it moved.
 */
export const tableFeaturesSet = tableFeatures({
  columnFilteringFeature,
  columnVisibilityFeature,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortedRowModel: createSortedRowModel(),
});

export type RookeryFeatures = typeof tableFeaturesSet;

export type RookeryRow<TData extends RowData> = Row<RookeryFeatures, TData>;
export type RookeryTable<TData extends RowData> = Table<RookeryFeatures, TData>;
export type RookeryCell<TData extends RowData> = Cell<RookeryFeatures, TData, unknown>;
export type RookeryColumn<TData extends RowData> = Column<RookeryFeatures, TData, unknown>;

/**
 * A column definition for a Rookery table.
 *
 * The value type stays `any` on purpose: `columnHelper.columns()` returns
 * exactly this shape, and narrowing it here would force every page to spell out
 * a tuple type for its column list.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RookeryColumnDef<TData extends RowData> = ColumnDef<RookeryFeatures, TData, any>;

/**
 * The typed column helper for a row type.
 *
 * Pages call this once next to their column list instead of repeating
 * `createColumnHelper<typeof tableFeaturesSet, Session>()`:
 *
 * ```ts
 * const column = createRookeryColumnHelper<Session>();
 * const columns = column.columns([column.accessor('title', { header: 'Titel' })]);
 * ```
 */
export function createRookeryColumnHelper<TData extends RowData>() {
  return createColumnHelper<RookeryFeatures, TData>();
}

/**
 * What the toolbar search looks at when a page does not say otherwise.
 *
 * Only the row's own top-level fields, flattened to text — deep objects would
 * make the search match on ids and timestamps nobody typed. Pages that want
 * something else pass `searchText` to `DataTable`.
 */
export function rowSearchText(row: unknown): string {
  if (row === null || typeof row !== 'object') return String(row ?? '');
  const parts: string[] = [];
  for (const value of Object.values(row as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    const kind = typeof value;
    if (kind === 'string' || kind === 'number' || kind === 'boolean') parts.push(String(value));
  }
  return parts.join(' ');
}

/** Case-insensitive "contains", the only match the toolbar search needs. */
export function matchesSearch(haystack: string, needle: string): boolean {
  if (!needle) return true;
  return haystack.toLocaleLowerCase('de-DE').includes(needle.toLocaleLowerCase('de-DE'));
}
