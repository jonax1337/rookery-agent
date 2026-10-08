import type { SleepRun } from '@/lib/types';

/** One counter a night reports, with the words the table and the report both use for it. */
interface NightCounter {
  key: keyof SleepRun & string;
  label: string;
  /**
   * Kept out of the table until asked for. The dream's counters stay at zero
   * until the dream is switched on, and a column of zeroes pushes the ones
   * that carry news off a narrow screen.
   */
  hiddenByDefault?: boolean;
}

/** Every counter of a night, in the order the table and the report list them. */
export const NIGHT_COUNTERS: readonly NightCounter[] = [
  { key: 'readCount', label: 'read', hiddenByDefault: true },
  { key: 'replayedCount', label: 'Conversations' },
  { key: 'learnedCount', label: 'learned' },
  { key: 'mergedCount', label: 'condensed' },
  { key: 'edgeCount', label: 'linked' },
  { key: 'dormantCount', label: 'put to sleep' },
  { key: 'insightCount', label: 'Insights' },
  { key: 'skillRevisedCount', label: 'Skills revised' },
  { key: 'skillCount', label: 'Skills written' },
  { key: 'modelCalls', label: 'Model calls', hiddenByDefault: true },
  { key: 'dreamTracesSeen', label: 'Dream traces', hiddenByDefault: true },
  { key: 'dreamFramesScored', label: 'Dream frames scored', hiddenByDefault: true },
  { key: 'dreamCandidates', label: 'Dream candidates', hiddenByDefault: true },
  { key: 'dreamPromoted', label: 'Policies promoted', hiddenByDefault: true },
  { key: 'dreamLabelsWritten', label: 'Dream labels', hiddenByDefault: true },
];

/** A counter's value; the dream's are absent on nights that predate it. */
export function counterValue(run: SleepRun, key: NightCounter['key']): number {
  return Number(run[key] ?? 0);
}

/** A night is undoable only while it actually changed something. */
export function undoable(run: SleepRun): boolean {
  if (run.undoneAt) return false;
  if (run.status !== 'done') return false;
  // The skill counts belong here too: undoing a night now puts the skill
  // files back as well, so a night that only rewrote a procedure is every bit
  // as undoable as one that touched the bank.
  //
  // The dream counters belong here for a harder reason than symmetry: a
  // promotion changes how the assistant recalls, falls under this night's undo
  // (E18), and may be the only thing a night did. Without these two terms the
  // page would hide the undo button for exactly the nights that have to stay
  // reversible. `dreamLabelsWritten` counts rows the undo removes as well, so
  // it joins them; the three measuring counters do not - looking at a trace
  // changes nothing and gives nothing to take back.
  return (
    run.mergedCount > 0 ||
    run.dormantCount > 0 ||
    run.edgeCount > 0 ||
    run.insightCount > 0 ||
    run.skillCount > 0 ||
    run.skillRevisedCount > 0 ||
    run.learnedCount > 0 ||
    (run.dreamPromoted ?? 0) > 0 ||
    (run.dreamLabelsWritten ?? 0) > 0
  );
}

/** What a night has to say for itself: its error, else its report. */
export function reportText(run: SleepRun): string {
  return run.error ?? run.report ?? '';
}
