import type { ComponentType } from 'react';

import {
  ChevronLeftIcon,
  ChevronLeftIcon as ChevronsLeftIcon,
  ChevronRightIcon,
  ChevronRightIcon as ChevronsRightIcon,
} from "@/components/icons";

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from '@/components/ui/pagination';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatNumber } from '@/lib/stats';
import { cn } from '@/lib/utils';

/** How a table names its rows in the footer sentence. */
export interface RowLabel {
  /** Base form, kept for callers that also use the label outside the footer. */
  singular: string;
  /** English plural: "… of 500 loaded conversations". */
  plural: string;
}

/** What a table calls its rows when it does not say. The status line in
 *  `data-table.tsx` reads the same default, so both sentences agree. */
export const DEFAULT_ROW_LABEL: RowLabel = { singular: 'item', plural: 'items' };

export const DEFAULT_PAGE_SIZES = [10, 20, 30, 50] as const;

export interface DataTablePaginationProps {
  pageIndex: number;
  pageCount: number;
  pageSize: number;
  pageSizeOptions?: readonly number[];
  onPageChange: (pageIndex: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  /** Rows after search, facet and filters. */
  rowCount: number;
  /** Rows the page actually holds — the honest base of every count above. */
  loadedCount: number;
  selectedCount?: number;
  /**
   * The loaded list hangs exactly at the server limit, so there may be more
   * rows nobody can reach. Draws the "capped" badge.
   */
  capped?: boolean;
  rowLabel?: RowLabel;
  /** Unique id suffix so several tables on one page keep distinct labels. */
  idPrefix?: string;
  className?: string;
}

/**
 * The table footer.
 *
 * Two departures from the block. First the wording: there is no server-side
 * paging anywhere in this API, so the sentence says "of N loaded", never
 * "of all" — everything past the list limit is simply unreachable and the
 * footer admits it. Second the controls: the block had four bare chevron
 * buttons, this sits them inside the `Pagination` primitive so the page
 * controls are a real `nav`/`ul`. They stay `Button`s rather than
 * `PaginationLink`, which renders an `<a>` — these pages exist only in memory
 * and have no address to link to.
 */
export function DataTablePagination({
  pageIndex,
  pageCount,
  pageSize,
  pageSizeOptions = DEFAULT_PAGE_SIZES,
  onPageChange,
  onPageSizeChange,
  rowCount,
  loadedCount,
  selectedCount = 0,
  capped = false,
  rowLabel = DEFAULT_ROW_LABEL,
  idPrefix = 'table',
  className,
}: DataTablePaginationProps) {
  const pages = Math.max(1, pageCount);
  const canPrevious = pageIndex > 0;
  const canNext = pageIndex < pages - 1;
  const noun = rowLabel.plural;

  return (
    <div
      className={cn('flex flex-wrap items-center justify-between gap-4', className)}
    >
      <div className="flex flex-1 flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>
          {formatNumber(rowCount)} of {formatNumber(loadedCount)} loaded {noun}
        </span>
        {capped ? <Badge variant="outline">capped</Badge> : null}
        {selectedCount > 0 ? (
          <span className="tabular-nums">· {formatNumber(selectedCount)} selected</span>
        ) : null}
      </div>

      <div className="flex w-full items-center gap-6 lg:w-fit">
        <div className="hidden items-center gap-2 lg:flex">
          <Label htmlFor={`${idPrefix}-rows`} className="text-sm font-medium">
            Rows per page
          </Label>
          <Select
            value={`${pageSize}`}
            onValueChange={(value) => onPageSizeChange(Number(value))}
          >
            <SelectTrigger size="sm" className="w-20" id={`${idPrefix}-rows`}>
              <SelectValue placeholder={`${pageSize}`} />
            </SelectTrigger>
            <SelectContent side="top">
              <SelectGroup>
                {pageSizeOptions.map((option) => (
                  <SelectItem key={option} value={`${option}`}>
                    {option}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        <div className="flex w-fit items-center justify-center text-sm font-medium whitespace-nowrap">
          Page {formatNumber(pageIndex + 1)} of {formatNumber(pages)}
        </div>

        <Pagination className="ml-auto w-fit justify-end lg:ml-0">
          <PaginationContent>
            <PageButton
              label="Go to first page"
              icon={ChevronsLeftIcon}
              disabled={!canPrevious}
              onClick={() => onPageChange(0)}
              desktopOnly
            />
            <PageButton
              label="Go to previous page"
              icon={ChevronLeftIcon}
              disabled={!canPrevious}
              onClick={() => onPageChange(pageIndex - 1)}
            />
            <PageButton
              label="Go to next page"
              icon={ChevronRightIcon}
              disabled={!canNext}
              onClick={() => onPageChange(pageIndex + 1)}
            />
            <PageButton
              label="Go to last page"
              icon={ChevronsRightIcon}
              disabled={!canNext}
              onClick={() => onPageChange(pages - 1)}
              desktopOnly
            />
          </PaginationContent>
        </Pagination>
      </div>
    </div>
  );
}

interface PageButtonProps {
  label: string;
  icon: ComponentType;
  disabled: boolean;
  onClick: () => void;
  /** First/last jumps are hidden below `lg`, where the footer has no room for them. */
  desktopOnly?: boolean;
}

function PageButton({ label, icon: Icon, disabled, onClick, desktopOnly = false }: PageButtonProps) {
  return (
    <PaginationItem>
      <Button
        variant="ghost"
        size="icon"
        className={cn('size-8', desktopOnly && 'hidden lg:flex')}
        disabled={disabled}
        onClick={onClick}
      >
        <span className="sr-only">{label}</span>
        <Icon />
      </Button>
    </PaginationItem>
  );
}
