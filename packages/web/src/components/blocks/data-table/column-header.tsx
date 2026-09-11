import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronsUpDownIcon,
  EyeOffIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * Only the slice of a TanStack column this header touches.
 *
 * Structural instead of `Column<TFeatures, TData, TValue>` on purpose: the
 * TanStack column type is invariant in its row type, so a generic header
 * component would force every page to spell out its own type argument for a
 * component that never reads a single row.
 */
export interface SortableColumn {
  getCanSort: () => boolean;
  getIsSorted: () => false | 'asc' | 'desc';
  toggleSorting: (desc?: boolean, isMulti?: boolean) => void;
  clearSorting: () => void;
  getCanHide: () => boolean;
  toggleVisibility: (value?: boolean) => void;
}

export interface DataTableColumnHeaderProps {
  column: SortableColumn;
  title: string;
  /** `end` right-aligns the label, for the numeric columns. */
  align?: 'start' | 'end';
  className?: string;
}

/**
 * Sortable column head from the block, but with the sort direction spelled out
 * in a menu instead of hidden in a click sequence.
 *
 * A column that can neither be sorted nor hidden renders as plain text — no
 * button that does nothing.
 */
export function DataTableColumnHeader({
  column,
  title,
  align = 'start',
  className,
}: DataTableColumnHeaderProps) {
  const sorted = column.getIsSorted();
  const canSort = column.getCanSort();
  const canHide = column.getCanHide();

  if (!canSort && !canHide) {
    return (
      <div
        className={cn(
          'text-sm font-medium',
          align === 'end' && 'w-full text-right',
          className,
        )}
      >
        {title}
      </div>
    );
  }

  return (
    <div
      className={cn('flex items-center', align === 'end' && 'justify-end', className)}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 h-8 data-[state=open]:bg-accent"
          >
            <span>{title}</span>
            {sorted === 'desc' ? (
              <ArrowDownIcon data-icon="inline-end" />
            ) : sorted === 'asc' ? (
              <ArrowUpIcon data-icon="inline-end" />
            ) : (
              <ChevronsUpDownIcon
                data-icon="inline-end"
                className="text-muted-foreground"
              />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align === 'end' ? 'end' : 'start'} className="w-40">
          {canSort ? (
            <>
              <DropdownMenuItem onSelect={() => column.toggleSorting(false)}>
                <ArrowUpIcon data-icon="inline-start" />
                Aufsteigend
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => column.toggleSorting(true)}>
                <ArrowDownIcon data-icon="inline-start" />
                Absteigend
              </DropdownMenuItem>
              {sorted === false ? null : (
                <DropdownMenuItem onSelect={() => column.clearSorting()}>
                  <ChevronsUpDownIcon data-icon="inline-start" />
                  Sortierung aufheben
                </DropdownMenuItem>
              )}
            </>
          ) : null}
          {canSort && canHide ? <DropdownMenuSeparator /> : null}
          {canHide ? (
            <DropdownMenuItem onSelect={() => column.toggleVisibility(false)}>
              <EyeOffIcon data-icon="inline-start" />
              Ausblenden
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
