import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/lib/api';
import type { Assignment, AssignmentStatus, AssignmentView } from '@/lib/types';

/** The server's ceiling for one list request; the honest base of every count. */
export const ASSIGNMENT_LIMIT = 500;

/** How long a burst of socket news is collected before one silent refetch. */
const REFRESH_DEBOUNCE_MS = 600;

type LoadState = 'loading' | 'ready' | 'error';

interface AssignmentFilter {
  status?: AssignmentStatus[] | undefined;
  agentId?: string | null | undefined;
}

interface AssignmentWindow {
  list: Assignment[];
  state: LoadState;
  /** Visible reload: the table shows its skeleton or error while it runs. */
  reload: () => Promise<void>;
  /** Silent reload: a failure never replaces what is already on screen. */
  refresh: () => Promise<void>;
}

/**
 * One request's worth of assignments (the newest `ASSIGNMENT_LIMIT`).
 *
 * Sequence guard: silent socket reloads, the retry and the drawer's "assigned"
 * nudge can overlap, and switching the filter starts a new request; only the
 * newest run may write state, so a slow answer for an old one never lands in
 * the current list. A disabled window cancels whatever is still in flight.
 */
function useAssignmentWindow(
  filter: AssignmentFilter,
  enabled: boolean,
  initialState: LoadState,
): AssignmentWindow {
  const { status, agentId } = filter;
  const [list, setList] = useState<Assignment[]>([]);
  const [state, setState] = useState<LoadState>(initialState);
  const sequence = useRef(0);

  const run = useCallback(
    async (silent: boolean): Promise<void> => {
      const seq = ++sequence.current;
      if (!enabled) return;
      if (!silent) setState('loading');
      try {
        const next = await api.assignments({
          limit: ASSIGNMENT_LIMIT,
          ...(status ? { status } : {}),
          ...(agentId ? { agentId } : {}),
        });
        if (seq !== sequence.current) return;
        setList(next);
        setState('ready');
      } catch {
        if (seq !== sequence.current) return;
        // A silent failure must not strand the skeleton: if it invalidated an
        // older visible load still showing `loading`, the newest run owes the
        // view a verdict - error with its retry beats a frozen table. Over a
        // ready view it stays quiet.
        if (silent) setState((previous) => (previous === 'loading' ? 'error' : previous));
        else setState('error');
      }
    },
    [enabled, status, agentId],
  );

  const reload = useCallback(() => run(false), [run]);
  const refresh = useCallback(() => run(true), [run]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { list, state, reload, refresh };
}

/**
 * Refetches once when the socket names an assignment the list does not hold.
 *
 * Only a genuinely new assignment is worth a request; everything else the
 * socket says about a row we already hold is merged in memory by the caller.
 * The timer lives in a ref and is never reset by later broadcasts: a running
 * assignment streams several updates a second, so a timer that every update
 * cancelled would never fire and the new row would never show up.
 */
function useRefreshOnNewAssignments({
  live,
  knownIds,
  paused,
  filterKey,
  refresh,
}: {
  live: Record<string, AssignmentView>;
  knownIds: ReadonlySet<string>;
  paused: boolean;
  /** Changes with the filter; ids already answered for belong to the old one. */
  filterKey: string;
  refresh: () => void;
}): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Ids we have already refetched for, so an id that does not match the
  // current filter cannot re-trigger a load on every single broadcast.
  const handledRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    handledRef.current = new Set();
  }, [filterKey]);

  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (paused) return;
    const fresh = Object.keys(live).filter(
      (id) => !knownIds.has(id) && !handledRef.current.has(id),
    );
    if (fresh.length === 0) return;
    for (const id of fresh) handledRef.current.add(id);

    if (timerRef.current !== undefined) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      refreshRef.current();
    }, REFRESH_DEBOUNCE_MS);
  }, [live, knownIds, paused, filterKey]);

  useEffect(
    () => () => {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    },
    [],
  );
}

export interface AssignmentsData {
  /** The unfiltered window; every number above the table rests on it. */
  base: Assignment[];
  baseState: LoadState;
  /** What the table lists: the unfiltered window, or the narrowed request. */
  list: Assignment[];
  listState: LoadState;
  /** Visible reload of everything on screen, for the "try again" button. */
  retry: () => void;
  /** Silent reload of everything on screen, after something was assigned. */
  refresh: () => void;
}

/**
 * The assignments behind the page: the unfiltered window for the numbers, a
 * server-narrowed one for the table once a tab or agent filter applies, and
 * the socket's word on which assignments exist.
 *
 * The status tabs and the agent filter are server parameters, not client
 * filters - with no paging in the API, filtering after the fact would only
 * ever search inside the newest 500 rows. `status` must therefore be a stable
 * reference (the tab definitions are constants).
 */
export function useAssignmentsData(
  filter: AssignmentFilter,
  live: Record<string, AssignmentView>,
): AssignmentsData {
  const narrowed = filter.status !== undefined || Boolean(filter.agentId);

  const base = useAssignmentWindow({}, true, 'loading');
  const narrow = useAssignmentWindow(filter, narrowed, 'ready');

  const list = narrowed ? narrow.list : base.list;
  const listState = narrowed ? narrow.state : base.state;

  const knownIds = useMemo(() => new Set(list.map((entry) => entry.id)), [list]);

  const retry = useCallback(() => {
    void base.reload();
    void narrow.reload();
  }, [base.reload, narrow.reload]);

  const refresh = useCallback(() => {
    void base.refresh();
    void narrow.refresh();
  }, [base.refresh, narrow.refresh]);

  useRefreshOnNewAssignments({
    live,
    knownIds,
    paused: listState === 'loading',
    filterKey: (filter.status?.join(',') ?? '') + '|' + (filter.agentId ?? ''),
    refresh,
  });

  return {
    base: base.list,
    baseState: base.state,
    list,
    listState,
    retry,
    refresh,
  };
}
