import { MessageSquareIcon, MicIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type {
  AssignmentStatus,
  CronJobKind,
  EffortLevel,
  EntityKind,
  MemoryKind,
  MemoryOrigin,
  MemoryRelation,
  PermissionLevel,
  ProviderId,
  RequesterKind,
  SessionKind,
  TaskPriority,
  TaskStatus,
} from './types';

/**
 * The canonical timestamp format, `11. Sep. 2026, 14:03`.
 *
 * It lives in `lib/stats.ts` with the rest of the `en-GB` formatting and is
 * re-exported here (and from `lib/cron.ts`) so every caller reaches the same
 * implementation instead of a second copy drifting away from it.
 */
export { formatDateTime } from './stats';

/** Relative time in the coarse buckets a conversation list actually needs. */
export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + ' min';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + ' hr';
  const days = Math.round(hours / 24);
  if (days < 7) return days + ' d';
  return new Date(timestamp).toLocaleDateString('en-GB');
}

/**
 * The same span, but as a sentence rather than as a column value.
 *
 * `relativeTime` hands back a bare span ("5 Min.", "3 Tg.") because a table
 * column has no room for more. Four footnotes glued their own prefix in front
 * of it and produced "Angelegt 5 Min." and "Zuletzt geändert 2 Tg."; one wrote
 * "zuletzt vor " and tipped over into "zuletzt vor 04.09.2026" as soon as the
 * span passed a week and turned into a date.
 *
 * So the preposition belongs to the formatter, which is the only place that
 * knows whether it is looking at a span or at a date: "vor 5 Min.", "am
 * 04.09.2026", and "gerade eben" with no preposition at all.
 *
 * Prose uses this, table cells keep `relativeTime`.
 */
export function timeAgo(timestamp: number, now = Date.now()): string {
  const span = relativeTime(timestamp, now);
  if (span === 'just now') return span;
  // Past a week `relativeTime` hands back a date instead of a span - the one
  // case that takes "am". Every span it builds carries a space ("5 Min."), a
  // `en-GB` date never does ("04/09/2026"), so the shape tells them apart.
  return span.includes(' ') ? span + ' ago' : 'on ' + span;
}

export function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return ms + ' ms';
  const seconds = ms / 1000;
  return seconds < 60 ? seconds.toFixed(1) + ' s' : Math.round(seconds / 60) + ' min';
}

export const MEMORY_KIND_LABEL: Record<MemoryKind, string> = {
  fact: 'Fact',
  preference: 'Preference',
  project: 'Project',
  event: 'Event',
  summary: 'Summary',
  insight: 'Insight',
};

/**
 * Every kind, in the order the labels declare them.
 *
 * The list and the layout's Merken-dialog derived this the same way in two
 * files; one derivation means a new kind reaches both at once.
 */
export const MEMORY_KINDS = Object.keys(MEMORY_KIND_LABEL) as MemoryKind[];

/** What an entity is a name for. */
export const ENTITY_KIND_LABEL: Record<EntityKind, string> = {
  person: 'Person',
  project: 'Project',
  tool: 'Tool',
  place: 'Place',
  org: 'Organization',
  topic: 'Topic',
};

/** How two memories relate, said the way a person would say it. */
export const RELATION_LABEL: Record<MemoryRelation, string> = {
  refines: 'refines',
  supersedes: 'supersedes',
  contradicts: 'contradicts',
  caused_by: 'is caused by',
  co_occurs: 'is related to',
};

/** Who wrote a memory. */
export const ORIGIN_LABEL: Record<MemoryOrigin, string> = {
  extract: 'from a conversation',
  user: 'from you',
  sleep: 'consolidated during sleep',
};

/**
 * The stage a running night is in. A night is not one chore: light sleep
 * tidies, deep sleep files and decides, dream sleep connects and concludes.
 */
export const SLEEP_PHASE_LABEL: Record<string, string> = {
  started: 'falling asleep',
  light: 'Light sleep',
  deep: 'Deep sleep',
  rem: 'REM sleep',
  finished: 'waking up',
  undone: 'undone',
};

/** What each stage is actually doing, one line for the card. */
export const SLEEP_PHASE_DETAIL: Record<string, string> = {
  started: 'settling in',
  light: 'tidying without reflection',
  deep: 'consolidating and resolving contradictions',
  rem: 'connecting memories and drawing conclusions',
  finished: 'done',
};

export const PERMISSION_LABEL: Record<PermissionLevel, string> = {
  chat: 'Chat only',
  read: 'Read',
  write: 'Write',
  full: 'Full',
};

export const PERMISSION_HINT: Record<PermissionLevel, string> = {
  chat: 'No tools. Conversation only.',
  read: 'May read and search files, but cannot change them.',
  write: 'May change files in the workspace.',
  full: 'May also run commands.',
};

/**
 * The "leave it to the settings" option, as a value a radio group can hold.
 *
 * `null` is what the API stores for "inherited", but a `RadioGroup` needs a
 * string, so the forms carry this sentinel and translate at the edges. It is
 * the literal `'standard'` rather than a `__marker__` because no permission
 * level is ever called that - and both forms that use it agreed on the word
 * independently before it moved here.
 */
export const STANDARD_CHOICE = 'standard';

/** What a permission radio group holds: a real level, or "inherited". */
export type PermissionChoice = typeof STANDARD_CHOICE | PermissionLevel;

/**
 * The permission radio cards, shared by the agent form and the schedule form.
 *
 * Deliberately typed structurally rather than as `ChoiceOption<…>`: the shape
 * matches, and `lib/` has no business importing from `components/`.
 */
export const PERMISSION_CHOICES: {
  value: PermissionChoice;
  label: string;
  description: string;
}[] = [
  {
    value: STANDARD_CHOICE,
    label: 'Default',
    description: 'Uses the default from Settings.',
  },
  ...(['chat', 'read', 'write', 'full'] as PermissionLevel[]).map((level) => ({
    value: level as PermissionChoice,
    label: PERMISSION_LABEL[level],
    description: PERMISSION_HINT[level],
  })),
];

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Very high',
  max: 'Maximum',
};

export const EFFORT_HINT: Record<EffortLevel, string> = {
  low: 'Fast and concise, with little reasoning.',
  medium: 'Balanced for everyday questions.',
  high: 'Thorough, for analysis and code.',
  xhigh: 'Very thorough, and correspondingly slower.',
  max: 'Uses everything the model has. Not every model supports this.',
};

export const ASSIGNMENT_STATUS_LABEL: Record<AssignmentStatus, string> = {
  pending: 'pending',
  running: 'running',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** Badge variant per status, so a failure reads as one at a glance. */
export const ASSIGNMENT_STATUS_VARIANT: Record<
  AssignmentStatus,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  pending: 'outline',
  running: 'default',
  done: 'secondary',
  failed: 'destructive',
  cancelled: 'outline',
};

/* ----------------------------------- tasks ---------------------------------- */

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  open: 'Open',
  planned: 'Planned',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const TASK_STATUS_VARIANT: Record<
  TaskStatus,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  open: 'outline',
  planned: 'secondary',
  running: 'default',
  done: 'secondary',
  failed: 'destructive',
  cancelled: 'outline',
};

/** Board columns, in the order work moves through them. */
export const TASK_STATUS_ORDER: TaskStatus[] = [
  'open',
  'planned',
  'running',
  'done',
  'failed',
  'cancelled',
];

/**
 * The three states a person may set.
 *
 * `PATCH /api/org/tasks/:id` accepts only these; `planned`, `running` and
 * `failed` belong to the runner and would be rejected. The board's status
 * menu and the task form both need the fact, so it is stated once.
 */
export type SettableTaskStatus = 'open' | 'done' | 'cancelled';

export const SETTABLE_TASK_STATUS: readonly SettableTaskStatus[] = ['open', 'done', 'cancelled'];

export function isSettableTaskStatus(status: TaskStatus): status is SettableTaskStatus {
  return (SETTABLE_TASK_STATUS as readonly string[]).includes(status);
}

export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
};

export const TASK_PRIORITY_VARIANT: Record<
  TaskPriority,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  low: 'outline',
  normal: 'secondary',
  high: 'default',
};

/** High first, then normal, then low - the order the board sorts by. */
export const TASK_PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };

/* ------------------------------ conversations ----------------------------- */

/**
 * How a conversation was held.
 *
 * Two pages named the same field differently - "Sprache"/"Chat" on the
 * conversations list, "Gesprochen"/"Getippt" on the dashboard. The first pair
 * wins: it names the channel, which is what the column head ("Art") asks for,
 * and "Chat" is the word the rest of the app uses for the typed kind
 * (`/chats`, "Neues Gespräch" in the chat hub).
 */
export const SESSION_KIND_LABEL: Record<SessionKind, string> = {
  chat: 'Chat',
  voice: 'Voice',
};

export const SESSION_KIND_ICON: Record<SessionKind, LucideIcon> = {
  chat: MessageSquareIcon,
  voice: MicIcon,
};

/**
 * What a conversation is called before anyone named it.
 *
 * The server stores an empty title until the first turn produces one, so every
 * list needs a stand-in, and three of them invented their own.
 */
export const UNTITLED_SESSION = 'New conversation';

/* ------------------------------- schedules ------------------------------- */

/**
 * Who a schedule fires.
 *
 * `sleep` is the system's own row - `ensureSleepSchedule` keeps exactly one,
 * nobody wrote its prompt and nobody may delete it - so it is labelled as
 * what it is rather than left with an empty Wer-column.
 */
export const CRON_JOB_KIND_LABEL: Record<CronJobKind, string> = {
  script: 'Imported script',
  assistant: 'Assistant',
  agent: 'Agent',
  sleep: 'System',
};

/* ------------------------------- requesters ------------------------------ */

/**
 * Who asked for a task, a run or a schedule. Third person, like the rest of
 * the app - the API only knows these three.
 *
 * Three detail pages wrote this map out with identical wording; the column is
 * called "Erteilt von" on one and "Angelegt von" on another, but the values
 * are the same three sentences either way.
 */
export const REQUESTER_LABEL: Record<RequesterKind, string> = {
  user: 'Manually',
  assistant: 'By the assistant',
  agent: 'By an agent',
};

/* -------------------------------- sentinels ------------------------------- */

/**
 * "Not filed under a project", as a value a select can hold.
 *
 * The API stores `null`; Radix selects and comboboxes cannot, so the pickers
 * carry this marker and translate at the edges. Four pages picked the same
 * string on their own, which is the argument for stating it once.
 */
export const NO_PROJECT = '__none__';

/* ------------------------------- greetings ------------------------------- */

/**
 * The empty chat's opening line, by time of day.
 *
 * Both the typed chat and the hands-free screen greet an empty session, and
 * they disagreed by one bucket before this moved here. `/voice` appends its
 * own "Ich höre." rather than keeping a second table.
 */
export function greeting(now: Date = new Date(), user?: { honorific?: string; userName?: string }): string {
  const hour = now.getHours();
  const line = hour < 5 ? 'Still awake?' : hour < 11 ? 'Good morning.'
    : hour < 14 ? 'Hello.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';
  const address = user?.honorific?.trim() || user?.userName?.trim();
  return address ? line.replace(/([.?])$/, (_, punctuation: string) => `, ${address}${punctuation}`) : line;
}

/* ------------------------------- recency --------------------------------- */

/** A run of items that share a recency label, newest run first. */
export interface RecencyGroup<T> {
  label: string;
  items: T[];
}

/**
 * Buckets anything with a timestamp by how recent it is: Heute, Gestern,
 * Diese Woche, Früher.
 *
 * Lifted out of the sidebar's thread list, which is going away, and kept as a
 * plain function so the conversations table can draw the same group rows.
 *
 * Returns `null` when not a single item carries a usable date - then there is
 * nothing to group by and the caller should render the list flat, exactly as
 * the thread list did.
 *
 * Undated items sort first and land in "Heute", which is the old behaviour: a
 * conversation the server has not dated yet was just created.
 */
export function groupByRecency<T>(
  items: readonly T[],
  getTime: (item: T) => number | null | undefined,
  now: number = Date.now(),
): RecencyGroup<T>[] | null {
  const dated = items.map((item) => ({ item, at: usableTime(getTime(item)) }));
  if (!dated.some((entry) => entry.at !== undefined)) return null;

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const startOfToday = today.getTime();
  // Calendar arithmetic, not minus 86 400 000: across a DST change a day is
  // 23 or 25 hours and a fixed subtraction misfiles an hour's worth of rows.
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const startOfYesterday = yesterday.getTime();
  const week = new Date(today);
  // Monday starts the week here, the way a German calendar prints it.
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
  const startOfWeek = week.getTime();

  const sorted = [...dated].sort(
    (a, b) => (b.at ?? Number.MAX_SAFE_INTEGER) - (a.at ?? Number.MAX_SAFE_INTEGER),
  );

  const groups: RecencyGroup<T>[] = [];
  for (const { item, at } of sorted) {
    const label = recencyLabel(at, startOfToday, startOfYesterday, startOfWeek);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

function usableTime(at: number | null | undefined): number | undefined {
  return typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : undefined;
}

function recencyLabel(
  at: number | undefined,
  startOfToday: number,
  startOfYesterday: number,
  startOfWeek: number,
): string {
  if (at === undefined || at >= startOfToday) return 'Today';
  if (at >= startOfYesterday) return 'Yesterday';
  // Only worth a "Diese Woche" row when the week actually started earlier
  // than yesterday; on a Monday everything older is simply "Früher".
  if (at >= startOfWeek && startOfWeek < startOfYesterday) return 'This week';
  return 'Earlier';
}

/** Cut a string for display without leaving a dangling word. */
export function shorten(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut) + '…';
}
