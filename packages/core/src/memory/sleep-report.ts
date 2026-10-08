import type { AbstainReason } from '../types.js';

/** Use explicit singular and plural forms. */
export function plural(count: number, one: string, many: string): string {
  return count + ' ' + (count === 1 ? one : many);
}

/** The night in one line, in the language the user reads. */
export function describeSleep(counters: {
  readCount: number;
  mergedCount: number;
  dormantCount: number;
  edgeCount: number;
  insightCount: number;
  conflictCount: number;
  replayedCount?: number;
  learnedCount?: number;
  resolvedCount?: number;
  skillCount?: number;
  skillRevisedCount?: number;
  /**
   * The dream counters (sixth of the six places in step); optional so
   * callers that predate them keep compiling.
   */
  dreamTracesSeen?: number;
  dreamFramesScored?: number;
  dreamCandidates?: number;
  /** Stage 2's two, optional for the same reason as the three above. */
  dreamPromoted?: number;
  dreamLabelsWritten?: number;
}): string {
  const parts: string[] = [counters.readCount + ' memories read'];
  if (counters.replayedCount) {
    parts.push(plural(counters.replayedCount, 'conversation', 'conversations') + ' re-read');
  }
  if (counters.learnedCount) {
    parts.push(plural(counters.learnedCount, 'memory', 'memories') + ' learned from them');
  }
  if (counters.mergedCount) parts.push(counters.mergedCount + ' condensed');
  if (counters.dormantCount) parts.push(counters.dormantCount + ' tidied');
  if (counters.edgeCount) parts.push(counters.edgeCount + ' connections added');
  if (counters.resolvedCount) {
    parts.push(plural(counters.resolvedCount, 'contradiction', 'contradictions') + ' resolved');
  }
  const openConflicts = Math.max(0, counters.conflictCount - (counters.resolvedCount ?? 0));
  if (openConflicts) {
    parts.push(plural(openConflicts, 'contradiction', 'contradictions') + ' open');
  }
  if (counters.insightCount) {
    parts.push(plural(counters.insightCount, 'insight', 'insights') + ' recorded');
  }
  if (counters.skillRevisedCount) {
    parts.push(plural(counters.skillRevisedCount, 'skill', 'skills') + ' revised');
  }
  if (counters.skillCount) {
    parts.push(plural(counters.skillCount, 'skill', 'skills') + ' written');
  }
  // The dream's own line: grid placements scored, the counter the probe
  // owns in stage 1 (its writer is the paired measure call, and the frame
  // rows it could not score appear in the log and the report suffix, not
  // here - a night that abstained everything still did the work).
  if (counters.dreamFramesScored) {
    parts.push(plural(counters.dreamFramesScored, 'dream placement', 'dream placements') + ' scored');
  }
  // Stage 2's own two. The labels are the supply side of the whole
  // apparatus - without them every delta is a delta over nothing - and a
  // promotion is the only line in this sentence that changed how the
  // assistant will behave tomorrow, so it goes last, where it is read.
  if (counters.dreamLabelsWritten) {
    parts.push(plural(counters.dreamLabelsWritten, 'dream label', 'dream labels') + ' written');
  }
  if (counters.dreamPromoted) {
    parts.push(
      plural(counters.dreamPromoted, 'retrieval policy', 'retrieval policies') + ' promoted',
    );
  }
  return parts.length === 1 ? parts[0] + ', nothing to do.' : parts.join(', ') + '.';
}

/**
 * What the wake test (5.5c) found, or why it could not look.
 *
 * `drift` and `observed` are null in exactly one case: fewer frames closed
 * than `dream.calibrationTraces` asks for. The night then reports what it
 * offered, what closed and what abstained, and freezes nothing - the numbers
 * are the finding.
 */
export interface WakeTestReport {
  /** Frames since the promotion the test was handed. */
  offered: number;
  /** Of those, the ones that scored - the only ones a verdict may be read off. */
  closed: number;
  /** Of those, the ones that abstained, counted rather than dropped. */
  abstained: number;
  /**
   * The abstentions by name (5.4). Offered minus closed minus abstained is
   * what the wall clock or an abort cut off before it was ever looked at.
   */
  reasons: Partial<Record<AbstainReason, number>>;
  /** `dream.calibrationTraces`, clamped: the floor `closed` has to clear. */
  required: number;
  /** Null when `closed` stayed under the floor. */
  drift: number | null;
  observed: number | null;
  /** What the promotion promised - `policy_versions.replay_score`. */
  promised: number;
}

/**
 * The wake test as the night report words it. The verdict is read off what
 * CLOSED, so a pool that closed too little says so and freezes nothing:
 * `calibration` is a freeze somebody has to undo by hand (10.3), and one
 * trace of noise out of fifty offered must not be able to hand it out.
 */
export function describeWakeTest(wake: WakeTestReport): string {
  const abstentions = plural(wake.abstained, 'abstention', 'abstentions') + leadingReason(wake.reasons);
  if (wake.drift === null) {
    return (
      ' The wake test could not run: ' + wake.closed + ' of ' + wake.offered +
      ' frames since the last promotion closed, under dream.calibrationTraces (' +
      wake.required + '), with ' + abstentions + '. Nothing is frozen on a pool that could not be read.'
    );
  }
  return (
    ' The wake test (a regression alarm, not a calibration: the replay value and the live' +
    ' value come out of the same estimator and the same labels, so wrong labels leave both' +
    ' agreeing) measured a drift of ' + signedNumber(wake.drift) + ' over the ' +
    plural(wake.closed, 'trace', 'traces') + ' that closed of ' + wake.offered +
    ' frames since the last promotion, ' + abstentions + '.'
  );
}

/**
 * The abstention that dominated a pool, as half a sentence. Which one it was
 * is the whole point of counting them: `no-reachable-label` says the pool is
 * unlabelled, `corpus-drifted` says the index moved, and the two call for
 * entirely different answers.
 */
function leadingReason(reasons: Partial<Record<string, number>>): string {
  let name = '';
  let most = 0;
  for (const [reason, count] of Object.entries(reasons)) {
    if ((count ?? 0) <= most) continue;
    most = count ?? 0;
    name = reason;
  }
  return name ? ', mostly ' + name : '';
}

/** A delta with its sign, the way the evidence digest prints one. */
function signedNumber(value: number): string {
  if (!Number.isFinite(value)) return 'an unreadable amount';
  return (value >= 0 ? '+' : '') + value.toFixed(4);
}
