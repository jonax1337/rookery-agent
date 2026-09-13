import * as React from 'react';
import { ChevronDownIcon, Columns3Icon, InboxIcon } from 'lucide-react';
import { FlexRender, useTable } from '@tanstack/react-table';
import type {
  ColumnVisibilityState,
  PaginationState,
  RowData,
  RowSelectionState,
  SortingState,
} from '@tanstack/react-table';

import { EmptyState, NoResults } from '@/components/common/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { groupByRecency } from '@/lib/format';
import { formatNumber } from '@/lib/stats';
import { cn } from '@/lib/utils';

import {
  DataTablePagination,
  DEFAULT_PAGE_SIZES,
  DEFAULT_ROW_LABEL,
} from './data-table-pagination';
import type { RowLabel } from './data-table-pagination';
import { DataTableToolbar } from './data-table-toolbar';
import {
  matchesSearch,
  rowSearchText,
  tableFeaturesSet,
  type RookeryColumnDef,
  type RookeryRow,
} from './table-features';

/** One facet tab above the table, with the count the page computed. */
export interface DataTableTab {
  value: string;
  label: string;
  count?: number;
}

export interface DataTableProps<TData extends RowData> {
  /**
   * The rows to show. Facet tabs are pure client filters the page applies to
   * this list before handing it over, so switching tabs keeps sorting, column
   * visibility and page size standing.
   */
  data: TData[];
  columns: RookeryColumnDef<TData>[];
  /**
   * Stable row identity for selection across sorting and paging. Without it the
   * table falls back to `row.id` when the row type happens to carry one, and to
   * the row index otherwise.
   */
  getRowId?: (row: TData, index: number) => string;

  /* ------------------------------- facets -------------------------------- */
  tabs?: readonly DataTableTab[];
  /** Controlled facet. Leave out to let the table hold the state. */
  tab?: string;
  onTabChange?: (value: string) => void;
  defaultTab?: string;
  /** Accessible name of the narrow-screen select that replaces the tab list. */
  tabLabel?: string;

  /* ------------------------------- search -------------------------------- */
  searchable?: boolean;
  /** Controlled search text. Leave out to let the table hold the state. */
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  /** What the search looks at. Defaults to every top-level text field of a row. */
  searchText?: (row: TData) => string;
  /**
   * The rows already came back filtered by the server, so the client must not
   * filter them a second time.
   *
   * The memory list needs this: `GET /api/memories?q=` runs the assistant's own
   * blended recall, which surfaces rows that do not contain the typed words at
   * all. A "contains" pass over that answer would throw away exactly the
   * matches the search was worth running for.
   */
  searchServerSide?: boolean;

  /* ------------------------------ toolbar -------------------------------- */
  filters?: React.ReactNode;
  actions?: React.ReactNode;
  /** German column names for the visibility menu, keyed by column id. */
  columnLabels?: Record<string, string>;
  showColumnMenu?: boolean;

  /* ----------------------------- selection ------------------------------- */
  /** Defaults to true as soon as the column list contains a `select` column. */
  enableRowSelection?: boolean;
  /**
   * Bulk action bar content; `clear` empties the selection after the action ran.
   *
   * Labelling rule, because the bar already prints "N ausgewählt" right next to
   * these buttons: a button that acts on the whole selection carries the bare
   * verb ("Archivieren"), a button that acts on a *subset* of it leads with its
   * own count ("3 abbrechen") - there the number is new information, not an
   * echo, and it explains why the button greys out with rows still selected.
   */
  bulkActions?: (rows: TData[], clear: () => void) => React.ReactNode;
  onSelectionChange?: (rows: TData[]) => void;

  /* ------------------------- sorting / columns --------------------------- */
  initialSorting?: SortingState;
  initialColumnVisibility?: ColumnVisibilityState;

  /* ---------------------------- pagination ------------------------------- */
  /** `false` shows every row at once — for the short "Zuletzt" tables. */
  paginate?: boolean;
  pageSize?: number;
  pageSizeOptions?: readonly number[];
  /**
   * The loaded list hangs exactly at the server limit. The footer then says so,
   * because there is no server-side paging and the rest is unreachable.
   */
  capped?: boolean;
  rowLabel?: RowLabel;

  /* ------------------------------- rows ---------------------------------- */
  onRowClick?: (row: TData) => void;
  /** Columns whose clicks must not reach the row (buttons, checkboxes, menus). */
  rowClickIgnoreColumns?: readonly string[];
  rowClassName?: (row: TData) => string | undefined;
  /**
   * Draws "Heute / Gestern / Diese Woche / Früher" separator rows — but only
   * while the table is sorted descending by `groupSortId`, because any other
   * order would put the runs in the wrong place.
   */
  groupTime?: (row: TData) => number | null | undefined;
  groupSortId?: string;

  /* ------------------------------ states --------------------------------- */
  loading?: boolean;
  skeletonRows?: number;
  /** Nothing loaded at all. */
  empty?: React.ReactNode;
  /** Loaded, but search, facet or filters left nothing. */
  filteredEmpty?: React.ReactNode;
  /** Request failed — pass `<ServerOffline onRetry/>` here. */
  error?: React.ReactNode;

  /** Drop the block's `px-4 lg:px-6`, for tables nested inside a card or tab. */
  flush?: boolean;
  className?: string;
  /** Distinguishes the labels of several tables on one page. */
  idPrefix?: string;
}

const DEFAULT_IGNORED_COLUMNS = ['select', 'actions'] as const;

/**
 * The generic table behind every list in Rookery, adapted from dashboard-01.
 *
 * Gone from the original: the zod demo schema, the fixed
 * `getRowId: row.id.toString()`, the `toast.promise(setTimeout)` saves that
 * pretended to write, the three empty dashed tab panels, "No results." — and
 * the whole drag-and-drop apparatus. Nothing in this API has an order column,
 * so a drag handle could only ever reshuffle the current render.
 *
 * What it does instead: sorting, column visibility, row selection with a bulk
 * bar, one toolbar search, optional facet tabs with counts, client-side paging
 * whose footer names its own base, a skeleton that keeps the geometry while
 * loading, an empty state with something to do, and a row click for the detail
 * drawer.
 */
export function DataTable<TData extends RowData>({
  data,
  columns,
  getRowId,
  tabs,
  tab,
  onTabChange,
  defaultTab,
  tabLabel = 'Selection',
  searchable = false,
  search,
  onSearchChange,
  searchPlaceholder = 'Search',
  searchText,
  searchServerSide = false,
  filters,
  actions,
  columnLabels,
  showColumnMenu = true,
  enableRowSelection,
  bulkActions,
  onSelectionChange,
  initialSorting,
  initialColumnVisibility,
  paginate = true,
  pageSize = 20,
  pageSizeOptions = DEFAULT_PAGE_SIZES,
  capped = false,
  rowLabel,
  onRowClick,
  rowClickIgnoreColumns = DEFAULT_IGNORED_COLUMNS,
  rowClassName,
  groupTime,
  groupSortId,
  loading = false,
  skeletonRows = 8,
  empty,
  filteredEmpty,
  error,
  flush = false,
  className,
  idPrefix = 'tabelle',
}: DataTableProps<TData>) {
  const [sorting, setSorting] = React.useState<SortingState>(initialSorting ?? []);
  const [columnVisibility, setColumnVisibility] = React.useState<ColumnVisibilityState>(
    initialColumnVisibility ?? {},
  );
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const [pagination, setPagination] = React.useState<PaginationState>({
    pageIndex: 0,
    pageSize,
  });

  const [internalSearch, setInternalSearch] = React.useState('');
  const searchValue = search ?? internalSearch;
  const setSearch = React.useCallback(
    (value: string) => {
      if (onSearchChange) onSearchChange(value);
      if (search === undefined) setInternalSearch(value);
    },
    [onSearchChange, search],
  );

  const firstTab = tabs?.[0]?.value ?? '';
  const [internalTab, setInternalTab] = React.useState(defaultTab ?? firstTab);
  const activeTab = tab ?? internalTab;
  const setTab = React.useCallback(
    (value: string) => {
      if (onTabChange) onTabChange(value);
      if (tab === undefined) setInternalTab(value);
    },
    [onTabChange, tab],
  );

  // A facet or a search term changes what the reader is looking at; staying on
  // page 7 of the old result would show an empty table for no reason.
  React.useEffect(() => {
    setPagination((state) => (state.pageIndex === 0 ? state : { ...state, pageIndex: 0 }));
  }, [activeTab, searchValue]);

  const selectable =
    enableRowSelection ?? columns.some((column) => column.id === 'select');

  const resolveRowId = React.useMemo(
    () =>
      getRowId ??
      ((row: TData, index: number) => {
        const candidate = (row as { id?: unknown }).id;
        return typeof candidate === 'string' || typeof candidate === 'number'
          ? String(candidate)
          : String(index);
      }),
    [getRowId],
  );

  const table = useTable({
    features: tableFeaturesSet,
    data,
    columns,
    state: {
      sorting,
      columnVisibility,
      rowSelection,
      globalFilter: searchValue,
      // Without paging every row belongs on the single page there is.
      pagination: paginate
        ? pagination
        : { pageIndex: 0, pageSize: Math.max(1, data.length) },
    },
    getRowId: resolveRowId,
    enableRowSelection: selectable,
    // Our global filter reads the row, not one cell, so every column is a
    // candidate — otherwise TanStack skips the non-string ones and the search
    // silently matches nothing.
    getColumnCanGlobalFilter: () => true,
    globalFilterFn: (row, _columnId, filterValue) => {
      if (searchServerSide) return true;
      const needle = String(filterValue ?? '').trim();
      if (!needle) return true;
      const original = row.original as TData;
      return matchesSearch(
        searchText ? searchText(original) : rowSearchText(original),
        needle,
      );
    },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    onPaginationChange: setPagination,
  });

  const selectedRows = React.useMemo(
    () =>
      selectable
        ? table.getFilteredSelectedRowModel().rows.map((row) => row.original as TData)
        : [],
    // The selection model is derived from rowSelection; recompute when it moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectable, rowSelection, table, data],
  );

  const selectionCallback = React.useRef(onSelectionChange);
  selectionCallback.current = onSelectionChange;
  React.useEffect(() => {
    selectionCallback.current?.(selectedRows);
  }, [selectedRows]);

  const clearSelection = React.useCallback(() => {
    table.resetRowSelection();
  }, [table]);

  const rows = table.getRowModel().rows;
  const visibleColumns = table.getVisibleLeafColumns();
  const colSpan = Math.max(1, visibleColumns.length);
  // The footer needs this number anyway; the status line below needs the same
  // one, and computing it twice from two expressions is how they drift apart.
  const filteredCount = table.getFilteredRowModel().rows.length;

  // Group runs only hold while the table is sorted the way the grouping reads:
  // newest first, by the column the timestamps come from.
  const groups = React.useMemo(() => {
    if (!groupTime || !groupSortId) return null;
    const primary = sorting[0];
    if (sorting.length !== 1 || primary?.id !== groupSortId || primary.desc !== true) {
      return null;
    }
    return groupByRecency(rows, (row) => groupTime(row.original as TData));
  }, [groupTime, groupSortId, sorting, rows]);

  const pad = flush ? undefined : 'px-4 lg:px-6';
  const hasRows = rows.length > 0;
  const isFiltered = searchValue.trim().length > 0;

  /*
   * What the table looks like is a skeleton turning into rows; what it sounds
   * like was nothing at all. Every list in the app runs through here, so the
   * announcement belongs here once rather than in thirty pages.
   *
   * The sentence is the footer's, word for word, because the two are read one
   * after the other - but always in the plural: "1 von 58 geladenen
   * Gesprächen" is the sentence the dative asks for, whatever the count.
   */
  const noun = rowLabel?.plural ?? DEFAULT_ROW_LABEL.plural;
  const statusMessage = error
    ? 'The list could not be loaded.'
    : loading
      ? 'Loading list…'
      : hasRows
        ? formatNumber(filteredCount) +
          ' of ' +
          formatNumber(data.length) +
          ' loaded ' +
          noun
        : data.length === 0
          ? 'Nothing here'
          : 'No results';

  // One sentence for every clickable row, referenced rather than repeated: a
  // focusable `<tr>` announces its cells and otherwise keeps quiet about the
  // fact that Enter opens something.
  const rowHintId = React.useId();

  const columnMenu =
    showColumnMenu && visibleColumns.length > 0 ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" aria-label="Choose columns">
            <Columns3Icon data-icon="inline-start" />
            <span className="hidden lg:inline">Columns</span>
            <ChevronDownIcon data-icon="inline-end" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {table
            .getAllColumns()
            .filter((column) => column.getCanHide())
            .map((column) => (
              <DropdownMenuCheckboxItem
                key={column.id}
                checked={column.getIsVisible()}
                onCheckedChange={(value) => column.toggleVisibility(!!value)}
              >
                {columnLabels?.[column.id] ?? column.id}
              </DropdownMenuCheckboxItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  const tabsNode = tabs?.length ? (
    <>
      <Label htmlFor={`${idPrefix}-auswahl`} className="sr-only">
        {tabLabel}
      </Label>
      <Select value={activeTab} onValueChange={setTab}>
        <SelectTrigger
          className="flex w-fit @4xl/main:hidden"
          size="sm"
          id={`${idPrefix}-auswahl`}
        >
          <SelectValue placeholder={tabLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {tabs.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
                {item.count === undefined ? '' : ` (${formatNumber(item.count)})`}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <TabsList className="hidden **:data-[slot=badge]:size-5 **:data-[slot=badge]:rounded-full **:data-[slot=badge]:bg-muted-foreground/30 **:data-[slot=badge]:px-1 @4xl/main:flex">
        {tabs.map((item) => (
          <TabsTrigger key={item.value} value={item.value}>
            {item.label}
            {item.count === undefined ? null : (
              <Badge variant="secondary">{formatNumber(item.count)}</Badge>
            )}
          </TabsTrigger>
        ))}
      </TabsList>
    </>
  ) : null;

  const toolbar = (
    <DataTableToolbar
      className={pad}
      tabs={tabsNode ? <div className="flex items-center gap-2">{tabsNode}</div> : undefined}
      search={
        searchable
          ? { value: searchValue, onChange: setSearch, placeholder: searchPlaceholder }
          : undefined
      }
      filters={filters}
      columnMenu={columnMenu}
      actions={actions}
      selection={
        selectable && bulkActions
          ? {
              count: selectedRows.length,
              onClear: clearSelection,
              actions: bulkActions(selectedRows, clearSelection),
            }
          : undefined
      }
    />
  );

  function renderRow(row: RookeryRow<TData>) {
    const original = row.original as TData;
    const clickable = onRowClick !== undefined;
    return (
      <TableRow
        key={row.id}
        data-state={row.getIsSelected() ? 'selected' : undefined}
        className={cn(clickable && 'cursor-pointer', rowClassName?.(original))}
        tabIndex={clickable ? 0 : undefined}
        aria-describedby={clickable ? rowHintId : undefined}
        onClick={clickable ? () => onRowClick(original) : undefined}
        onKeyDown={
          clickable
            ? (event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onRowClick(original);
              }
            : undefined
        }
      >
        {row.getVisibleCells().map((cell) => {
          const shield =
            clickable && rowClickIgnoreColumns.includes(cell.column.id);
          return (
            <TableCell key={cell.id}>
              {shield ? (
                <div
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <FlexRender cell={cell} />
                </div>
              ) : (
                <FlexRender cell={cell} />
              )}
            </TableCell>
          );
        })}
      </TableRow>
    );
  }

  function renderBody() {
    if (error) {
      return (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={colSpan} className="p-0">
            {error}
          </TableCell>
        </TableRow>
      );
    }

    if (loading) {
      return Array.from({ length: skeletonRows }).map((_, rowIndex) => (
        <TableRow key={`skeleton-${rowIndex}`} className="hover:bg-transparent">
          {visibleColumns.map((column) => (
            <TableCell key={column.id}>
              <Skeleton className="h-5 w-full" />
            </TableCell>
          ))}
        </TableRow>
      ));
    }

    if (!hasRows) {
      const nothingLoaded = data.length === 0;
      const fallback = nothingLoaded ? empty : (filteredEmpty ?? empty);
      return (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={colSpan} className="p-0">
            {fallback ?? (
              <DefaultEmpty
                filtered={!nothingLoaded || isFiltered}
                query={searchValue.trim()}
              />
            )}
          </TableCell>
        </TableRow>
      );
    }

    if (groups) {
      return groups.map((group) => (
        <React.Fragment key={group.label}>
          <TableRow className="hover:bg-transparent">
            <TableCell
              colSpan={colSpan}
              className="bg-muted/40 text-xs font-medium text-muted-foreground"
            >
              {group.label}
            </TableCell>
          </TableRow>
          {group.items.map((row) => renderRow(row))}
        </React.Fragment>
      ));
    }

    return rows.map((row) => renderRow(row));
  }

  const grid = (
    <>
      <div className="sr-only" role="status" aria-live="polite">
        {statusMessage}
      </div>
      {onRowClick ? (
        <span id={rowHintId} className="sr-only">
          Press Enter to open details.
        </span>
      ) : null}

      <div
        className={cn('overflow-hidden rounded-lg border', pad && 'mx-4 lg:mx-6')}
        aria-busy={loading || undefined}
      >
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-muted">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  // `scope` is free here and stops being free the moment a
                  // group row spans the whole width below.
                  <TableHead
                    key={header.id}
                    colSpan={header.colSpan}
                    scope="col"
                    className={cn(
                      (header.column.id === 'select' || header.column.id === 'actions') && 'w-8',
                    )}
                  >
                    {header.isPlaceholder ? null : <FlexRender header={header} />}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>{renderBody()}</TableBody>
        </Table>
      </div>

      {paginate && !loading && !error && hasRows ? (
        <DataTablePagination
          className={pad}
          idPrefix={idPrefix}
          pageIndex={table.state.pagination.pageIndex}
          pageCount={table.getPageCount()}
          pageSize={table.state.pagination.pageSize}
          pageSizeOptions={pageSizeOptions}
          onPageChange={(index) => table.setPageIndex(index)}
          onPageSizeChange={(size) => table.setPageSize(size)}
          rowCount={filteredCount}
          loadedCount={data.length}
          selectedCount={selectedRows.length}
          capped={capped}
          {...(rowLabel ? { rowLabel } : {})}
        />
      ) : null}
    </>
  );

  if (tabs?.length) {
    return (
      <Tabs
        value={activeTab}
        onValueChange={setTab}
        className={cn('w-full flex-col justify-start gap-4', className)}
      >
        {toolbar}
        {/*
          One panel that always carries the active value: the facets filter the
          same loaded list, so unmounting and remounting a panel per tab would
          throw away sorting, column visibility and page size on every switch.
        */}
        <TabsContent
          value={activeTab}
          forceMount
          className="relative flex flex-col gap-4 overflow-auto"
        >
          {grid}
        </TabsContent>
      </Tabs>
    );
  }

  return (
    <div className={cn('flex w-full flex-col justify-start gap-4', className)}>
      {toolbar}
      {grid}
    </div>
  );
}

/**
 * Last-resort empty state.
 *
 * Pages are expected to pass their own `empty` with a call to action; this only
 * keeps the table from showing a bare "No results." when one is missing. A miss
 * after filtering is a different statement from having nothing at all, so it
 * gets the other component.
 */
function DefaultEmpty({ filtered, query }: { filtered: boolean; query: string }) {
  if (filtered) {
    return <NoResults {...(query ? { query } : {})} size="sm" />;
  }
  return (
    <EmptyState
      icon={InboxIcon}
      title="Nothing here yet"
      description="Items will appear in this table once they are created."
      variant="plain"
      size="sm"
    />
  );
}
