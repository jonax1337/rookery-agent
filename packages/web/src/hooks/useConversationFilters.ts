import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router';

import {
  ANY_PROJECT,
  readConversationTab,
  type ConversationPeriod,
  type ConversationTab,
} from '@/lib/conversation-filters';

/** The facet lives in the URL so a filtered list can be linked to and survives a reload. */
const TAB_PARAM = 'art';

export interface ConversationFilters {
  tab: ConversationTab;
  project: string;
  period: ConversationPeriod;
  search: string;
  /** Anything narrows the list beyond the default "All" tab. */
  filtersActive: boolean;
  setTab(value: string): void;
  setProject(value: string): void;
  setPeriod(value: ConversationPeriod): void;
  setSearch(value: string): void;
  resetFilters(): void;
}

/** The tab (in the URL) and the project, period and search (passing choices) of the list. */
export function useConversationFilters(): ConversationFilters {
  const [params, setParams] = useSearchParams();
  const tab = readConversationTab(params.get(TAB_PARAM));

  const [project, setProject] = useState(ANY_PROJECT);
  const [period, setPeriod] = useState<ConversationPeriod>('alle');
  const [search, setSearch] = useState('');

  const writeTabParam = useCallback(
    (value: string | null) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (value === null) next.delete(TAB_PARAM);
          else next.set(TAB_PARAM, value);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const setTab = useCallback(
    (value: string) => writeTabParam(value === 'alle' ? null : value),
    [writeTabParam],
  );

  const resetFilters = useCallback(() => {
    setProject(ANY_PROJECT);
    setPeriod('alle');
    setSearch('');
    writeTabParam(null);
  }, [writeTabParam]);

  const filtersActive =
    tab !== 'alle' || project !== ANY_PROJECT || period !== 'alle' || search.trim() !== '';

  return {
    tab,
    project,
    period,
    search,
    filtersActive,
    setTab,
    setProject,
    setPeriod,
    setSearch,
    resetFilters,
  };
}
