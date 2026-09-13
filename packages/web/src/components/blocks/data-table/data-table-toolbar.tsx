import type { ReactNode } from 'react';
import { SearchIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import { Separator } from '@/components/ui/separator';
import { formatNumber } from '@/lib/stats';
import { cn } from '@/lib/utils';

export interface DataTableSearch {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export interface DataTableSelection {
  count: number;
  onClear: () => void;
  actions?: ReactNode;
}

export interface DataTableToolbarProps {
  /** Facet tabs plus their narrow-screen select, rendered by `DataTable`. */
  tabs?: ReactNode;
  search?: DataTableSearch;
  /** Page-supplied filters (comboboxes, switches) — they sit left of the column menu. */
  filters?: ReactNode;
  /** The column visibility menu, built by `DataTable` from the table instance. */
  columnMenu?: ReactNode;
  /** Primary actions ("Neues Gespräch", "Agent einstellen"). */
  actions?: ReactNode;
  /** Bulk action bar; only drawn while rows are selected. */
  selection?: DataTableSelection;
  className?: string;
}

/**
 * The toolbar row of the block, opened up so every page can hang its own
 * filters into it.
 *
 * The block had a fixed "Columns" dropdown plus one "Add Section" button; the
 * order here is the same left to right (tabs, search, filters, columns,
 * actions) so all tables read alike, but each slot is a prop.
 *
 * The selection bar is a second row instead of a popup: it has to stay visible
 * while the reader scrolls the rows they just ticked.
 */
export function DataTableToolbar({
  tabs,
  search,
  filters,
  columnMenu,
  actions,
  selection,
  className,
}: DataTableToolbarProps) {
  const hasSelection = selection !== undefined && selection.count > 0;
  const hasRight = search !== undefined || filters || columnMenu || actions;

  if (!tabs && !hasRight && !hasSelection) return null;

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {tabs ?? <div />}
        {hasRight ? (
          <div className={cn('flex flex-1 flex-wrap items-center justify-end gap-2', tabs && 'basis-full @5xl/main:basis-auto')}>
            {search ? (
              <InputGroup className="h-8 w-full sm:w-56">
                <InputGroupAddon align="inline-start">
                  <SearchIcon />
                </InputGroupAddon>
                <InputGroupInput
                  className="h-8"
                  value={search.value}
                  placeholder={search.placeholder ?? 'Search'}
                  aria-label={search.placeholder ?? 'Search'}
                  onChange={(event) => search.onChange(event.target.value)}
                />
                {search.value ? (
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      size="icon-xs"
                      aria-label="Clear search"
                      onClick={() => search.onChange('')}
                    >
                      <XIcon />
                    </InputGroupButton>
                  </InputGroupAddon>
                ) : null}
              </InputGroup>
            ) : null}
            {filters}
            {columnMenu}
            {actions}
          </div>
        ) : null}
      </div>

      {hasSelection ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
          <span className="text-sm font-medium tabular-nums">
            {formatNumber(selection.count)} selected
          </span>
          <Separator orientation="vertical" className="h-4" />
          {selection.actions}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={selection.onClear}
          >
            <XIcon data-icon="inline-start" />
            Clear selection
          </Button>
        </div>
      ) : null}
    </div>
  );
}
