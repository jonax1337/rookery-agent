import { NO_PROJECT } from './format';
import type { Session } from './types';

/**
 * Client-side filters of the conversations list. The tab and period values
 * are the page's public contract (`?art=sprache`), which is why they keep the
 * names links already use.
 */

/** The "everything" entry of the project filter combobox. */
export const ANY_PROJECT = '__any__';

export type ConversationTab = 'alle' | 'sprache' | 'archiv';

export const CONVERSATION_TABS: readonly ConversationTab[] = ['alle', 'sprache', 'archiv'];

export const CONVERSATION_TAB_LABEL: Record<ConversationTab, string> = {
  alle: 'All',
  sprache: 'Voice',
  archiv: 'Archive',
};

export type ConversationPeriod = 'alle' | 'heute' | 'woche' | 'monat' | 'aelter';

export const CONVERSATION_PERIODS: readonly ConversationPeriod[] = [
  'alle',
  'heute',
  'woche',
  'monat',
  'aelter',
];

export const CONVERSATION_PERIOD_LABEL: Record<ConversationPeriod, string> = {
  alle: 'Any time',
  heute: 'Today',
  woche: 'This week',
  monat: 'This month',
  aelter: 'Older',
};

export interface ConversationFilter {
  tab: ConversationTab;
  /** A project id, `NO_PROJECT`, or `ANY_PROJECT`. */
  project: string;
  period: ConversationPeriod;
}

export function readConversationTab(value: string | null): ConversationTab {
  // `?art=voice` is the spelling a link from elsewhere in the app uses;
  // `?art=chat` and anything unknown fall back to the full list.
  if (value === 'voice') return 'sprache';
  return CONVERSATION_TABS.find((tab) => tab === value) ?? 'alle';
}

export function isConversationPeriod(value: string): value is ConversationPeriod {
  return (CONVERSATION_PERIODS as readonly string[]).includes(value);
}

export function tabCounts(sessions: readonly Session[]): Record<ConversationTab, number> {
  const counts: Record<ConversationTab, number> = { alle: 0, sprache: 0, archiv: 0 };
  for (const session of sessions) {
    for (const tab of CONVERSATION_TABS) if (matchesTab(session, tab)) counts[tab] += 1;
  }
  return counts;
}

export function filterSessions(
  sessions: readonly Session[],
  { tab, project, period }: ConversationFilter,
): Session[] {
  const inPeriod = periodPredicate(period);
  return sessions.filter(
    (session) =>
      matchesTab(session, tab) && matchesProject(session, project) && inPeriod(session.updatedAt),
  );
}

/** What the toolbar search looks at: the row's own fields plus the assistant's name. */
export function searchTextOf(session: Session, assistantName: string): string {
  return [session.title, assistantName, session.model ?? '', session.cwd].join(' ');
}

/** The most recently active conversation, or `null` for an empty list. */
export function newestSession(sessions: readonly Session[]): Session | null {
  return sessions.reduce<Session | null>(
    (best, session) => (!best || session.updatedAt > best.updatedAt ? session : best),
    null,
  );
}

function matchesTab(session: Session, tab: ConversationTab): boolean {
  if (tab === 'archiv') return session.archived;
  // Every other facet is a view of the conversations still in use.
  if (session.archived) return false;
  return tab !== 'sprache' || session.kind === 'voice';
}

function matchesProject(session: Session, project: string): boolean {
  return project === ANY_PROJECT || (session.projectId ?? NO_PROJECT) === project;
}

type BoundedPeriod = Exclude<ConversationPeriod, 'alle' | 'aelter'>;

function periodPredicate(period: ConversationPeriod): (updatedAt: number) => boolean {
  if (period === 'alle') return () => true;
  // "Older" is everything before this month began.
  if (period === 'aelter') {
    const monthBegan = startOfPeriod('monat');
    return (updatedAt) => updatedAt < monthBegan;
  }
  const start = startOfPeriod(period);
  return (updatedAt) => updatedAt >= start;
}

/** Local midnight on the first day of the period. */
function startOfPeriod(period: BoundedPeriod): number {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  switch (period) {
    case 'heute':
      return date.getTime();
    case 'woche': {
      // Monday starts the week, the way a German calendar prints it.
      const daysSinceMonday = (date.getDay() + 6) % 7;
      date.setDate(date.getDate() - daysSinceMonday);
      return date.getTime();
    }
    case 'monat':
      date.setDate(1);
      return date.getTime();
  }
}
