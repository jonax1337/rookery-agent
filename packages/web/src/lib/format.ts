import type {
  AssignmentStatus,
  EffortLevel,
  EntityKind,
  MemoryKind,
  MemoryOrigin,
  MemoryRelation,
  PermissionLevel,
  ProviderId,
  TaskPriority,
  TaskStatus,
} from './types';

/** Relative time in the coarse buckets a conversation list actually needs. */
export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 45) return 'gerade eben';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + ' Min.';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + ' Std.';
  const days = Math.round(hours / 24);
  if (days < 7) return days + ' Tg.';
  return new Date(timestamp).toLocaleDateString();
}

export function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return ms + ' ms';
  const seconds = ms / 1000;
  return seconds < 60 ? seconds.toFixed(1) + ' s' : Math.round(seconds / 60) + ' min';
}

export const MEMORY_KIND_LABEL: Record<MemoryKind, string> = {
  fact: 'Fakt',
  preference: 'Präferenz',
  project: 'Projekt',
  event: 'Ereignis',
  summary: 'Zusammenfassung',
  insight: 'Einsicht',
};

/** What an entity is a name for. */
export const ENTITY_KIND_LABEL: Record<EntityKind, string> = {
  person: 'Person',
  project: 'Projekt',
  tool: 'Werkzeug',
  place: 'Ort',
  org: 'Organisation',
  topic: 'Thema',
};

/** How two memories relate, said the way a person would say it. */
export const RELATION_LABEL: Record<MemoryRelation, string> = {
  refines: 'präzisiert',
  supersedes: 'ersetzt',
  contradicts: 'widerspricht',
  caused_by: 'liegt an',
  co_occurs: 'hängt zusammen mit',
};

/** Who wrote a memory. */
export const ORIGIN_LABEL: Record<MemoryOrigin, string> = {
  extract: 'aus einem Gespräch',
  user: 'von dir',
  sleep: 'im Schlaf verdichtet',
};

/**
 * The stage a running night is in. A night is not one chore: light sleep
 * tidies, deep sleep files and decides, dream sleep connects and concludes.
 */
export const SLEEP_PHASE_LABEL: Record<string, string> = {
  started: 'schläft ein',
  light: 'Leichtschlaf',
  deep: 'Tiefschlaf',
  rem: 'Traumschlaf',
  finished: 'wacht auf',
  undone: 'zurückgenommen',
};

/** What each stage is actually doing, one line for the card. */
export const SLEEP_PHASE_DETAIL: Record<string, string> = {
  started: 'sammelt sich',
  light: 'räumt auf, ohne nachzudenken',
  deep: 'verdichtet und entscheidet Widersprüche',
  rem: 'verknüpft und zieht Schlüsse',
  finished: 'fertig',
};

export const PERMISSION_LABEL: Record<PermissionLevel, string> = {
  chat: 'Nur Gespräch',
  read: 'Lesen',
  write: 'Schreiben',
  full: 'Voll',
};

export const PERMISSION_HINT: Record<PermissionLevel, string> = {
  chat: 'Keine Werkzeuge. Reine Unterhaltung.',
  read: 'Darf Dateien lesen und suchen, aber nichts ändern.',
  write: 'Darf Dateien im Arbeitsverzeichnis ändern.',
  full: 'Darf zusätzlich Befehle ausführen.',
};

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: 'Niedrig',
  medium: 'Mittel',
  high: 'Hoch',
  xhigh: 'Sehr hoch',
  max: 'Maximum',
};

export const EFFORT_HINT: Record<EffortLevel, string> = {
  low: 'Schnell und knapp, kaum Nachdenken.',
  medium: 'Ausgewogen für Alltagsfragen.',
  high: 'Gründlich, für Analysen und Code.',
  xhigh: 'Sehr gründlich, dauert entsprechend.',
  max: 'Alles, was das Modell hat. Nicht jedes Modell kann das.',
};

export const ASSIGNMENT_STATUS_LABEL: Record<AssignmentStatus, string> = {
  pending: 'ausstehend',
  running: 'läuft',
  done: 'fertig',
  failed: 'fehlgeschlagen',
  cancelled: 'abgebrochen',
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
  open: 'Offen',
  planned: 'Geplant',
  running: 'Läuft',
  done: 'Fertig',
  failed: 'Fehlgeschlagen',
  cancelled: 'Abgebrochen',
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

export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: 'Niedrig',
  normal: 'Normal',
  high: 'Hoch',
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

/** Cut a string for display without leaving a dangling word. */
export function shorten(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut) + '…';
}
