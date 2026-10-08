import type { DataTableTab } from '@/components/blocks/data-table/data-table';
import type { AssignmentStatus } from '@/lib/types';

interface StatusTab {
  value: string;
  label: string;
  /** What goes into the server's `status[]`; unset means "no filter". */
  status?: AssignmentStatus[];
}

/**
 * The status tabs, each one a server parameter rather than a client filter -
 * with no paging in the API, filtering after the fact would only ever search
 * inside the newest 500 rows, so a long-finished failure would be unreachable.
 */
const STATUS_TABS: StatusTab[] = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running', status: ['pending', 'running'] },
  { value: 'done', label: 'Done', status: ['done'] },
  { value: 'failed', label: 'Failed', status: ['failed'] },
  { value: 'cancelled', label: 'Cancelled', status: ['cancelled'] },
];

export const DEFAULT_TAB = 'all';

/**
 * The server-side status filter behind a tab value; `undefined` means "no
 * filter". The arrays are module constants, so the result is a stable
 * reference.
 */
export function statusFilterOf(tabValue: string): AssignmentStatus[] | undefined {
  return STATUS_TABS.find((tab) => tab.value === tabValue)?.status;
}

/**
 * The tabs as the table renders them.
 *
 * Counts on the tabs would be a guess once the window is capped, so they only
 * appear while the loaded list really is everything there is.
 */
export function buildDataTableTabs(
  counts: Record<AssignmentStatus, number>,
  loaded: number,
  capped: boolean,
): DataTableTab[] {
  return STATUS_TABS.map((tab) => {
    if (capped) return { value: tab.value, label: tab.label };
    const count = tab.status
      ? tab.status.reduce((sum, status) => sum + counts[status], 0)
      : loaded;
    return { value: tab.value, label: tab.label, count };
  });
}
