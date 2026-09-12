import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
} from 'lucide-react';

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
  /** Dative plural: "… von 500 geladenen **Gesprächen**". */
  plural: string;
}

/** What a table calls its rows when it does not say. The status line in
 *  `data-table.tsx` reads the same default, so both sentences agree. */
export const DEFAULT_ROW_LABEL: RowLabel = { singular: 'Eintrag', plural: 'Einträgen' };

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
   * rows nobody can reach. Draws the "gedeckelt" badge.
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
 * paging anywhere in this API, so the sentence says "von N geladenen", never
 * "von allen" — everything past the list limit is simply unreachable and the
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
  idPrefix = 'tabelle',
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
          {formatNumber(rowCount)} von {formatNumber(loadedCount)} geladenen {noun}
        </span>
        {capped ? <Badge variant="outline">gedeckelt</Badge> : null}
        {selectedCount > 0 ? (
          <span className="tabular-nums">· {formatNumber(selectedCount)} ausgewählt</span>
        ) : null}
      </div>

      <div className="flex w-full items-center gap-6 lg:w-fit">
        <div className="hidden items-center gap-2 lg:flex">
          <Label htmlFor={`${idPrefix}-zeilen`} className="text-sm font-medium">
            Zeilen pro Seite
          </Label>
          <Select
            value={`${pageSize}`}
            onValueChange={(value) => onPageSizeChange(Number(value))}
          >
            <SelectTrigger size="sm" className="w-20" id={`${idPrefix}-zeilen`}>
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
          Seite {formatNumber(pageIndex + 1)} von {formatNumber(pages)}
        </div>

        <Pagination className="ml-auto w-fit justify-end lg:ml-0">
          <PaginationContent>
            <PaginationItem>
              <Button
                variant="ghost"
                size="icon"
                className="hidden size-8 lg:flex"
                disabled={!canPrevious}
                onClick={() => onPageChange(0)}
              >
                <span className="sr-only">Zur ersten Seite</span>
                <ChevronsLeftIcon />
              </Button>
            </PaginationItem>
            <PaginationItem>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                disabled={!canPrevious}
                onClick={() => onPageChange(pageIndex - 1)}
              >
                <span className="sr-only">Vorherige Seite</span>
                <ChevronLeftIcon />
              </Button>
            </PaginationItem>
            <PaginationItem>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                disabled={!canNext}
                onClick={() => onPageChange(pageIndex + 1)}
              >
                <span className="sr-only">Nächste Seite</span>
                <ChevronRightIcon />
              </Button>
            </PaginationItem>
            <PaginationItem>
              <Button
                variant="ghost"
                size="icon"
                className="hidden size-8 lg:flex"
                disabled={!canNext}
                onClick={() => onPageChange(pages - 1)}
              >
                <span className="sr-only">Zur letzten Seite</span>
                <ChevronsRightIcon />
              </Button>
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    </div>
  );
}
