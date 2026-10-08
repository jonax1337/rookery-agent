import type { RecallPolicy } from '../types.js';
import {
  buildAggregates,
  type CandidateAggregates,
  type ComponentMeans,
} from './dream/candidate.js';
import type { FrameEntry } from './dream/evaluate.js';
import type { GainFunction } from './dream/measure.js';
import { pipelineAgent, pipelineAssistant, type FrameScoringPolicy } from './dream/score.js';

/**
 * Frames the admission check compares coverage over - the newest slice of
 * the pool. Both arms are counted the same way over the same sample, which
 * is the whole of what `admit` asks for; the full pool would double the
 * evaluation's work for a predicate.
 */
const ADMISSION_SAMPLE = 50;

/** The ids that stood in one frame's block, in prompt order, at one point. */
export function replayFrame(entry: FrameEntry, policy: FrameScoringPolicy): string[] {
  const frame = entry.frame.payload;
  const run =
    frame.pipeline === 'agent' ? pipelineAgent(frame, policy) : pipelineAssistant(frame, policy);
  return run.ok ? run.lines.map((line) => line.id) : [];
}

/** What the block actually held, replayed at the policy it was fetched with. */
export function promptedOf(entry: FrameEntry): string[] {
  return replayFrame(entry, entry.trace.policySet.recall ?? {});
}

/**
 * H1's coverage figure (10.1): how many distinct memories an arm ever
 * surfaced over the same sample of frames. The absolute number means
 * nothing; both arms are counted the same way over the same sample, which
 * is all `admit` asks for. The newest slice of the TRAINING half, because
 * the whole pool would double the evaluation's work for a predicate - and
 * because the frozen audit set is not something a predicate may read
 * (5.5d).
 *
 * It replays whole frames through the pipeline, which is real work, so it
 * runs under the night's one wall clock and its abort signal like every
 * other part of the dream - both checked BEFORE the first frame, so a
 * clock that is already spent costs the predicate rather than overrunning
 * it. A sample cut short leaves both arms at the count they reached, and
 * `coverageFloorHolds` compares them as it always does.
 */
export function coverageOf(
  entries: readonly FrameEntry[],
  policy: RecallPolicy,
  deadline: number,
  signal: AbortSignal,
): number {
  const seen = new Set<string>();
  for (const entry of entries.slice(-ADMISSION_SAMPLE)) {
    if (signal.aborted || Date.now() > deadline) break;
    for (const id of replayFrame(entry, policy)) seen.add(id);
  }
  return seen.size;
}

/**
 * One night's bad cases, aggregated into the only thing the candidate
 * writer gets to see (concept 6.2).
 *
 * Frame by frame, each with its OWN turn's gain: a gain is a statement
 * about one turn, and folding every turn's labels into one function would
 * let a memory proven relevant in one turn score in every other - the same
 * reason the freshness sensor walks its pool entry by entry. What comes
 * out is therefore a macro-average over cases rather than over rows, and
 * that is what the writer needs: it reads directions out of these numbers,
 * not magnitudes.
 */
export function aggregateCases(
  entries: readonly FrameEntry[],
  gainFor: (turnId: string) => GainFunction,
  policy: RecallPolicy,
): CandidateAggregates {
  const missed = zeroMeans();
  const delivered = zeroMeans();
  const firstHitRanks: number[] = [];
  let scored = 0;
  let abstained = 0;
  let cases = 0;
  let missedRows = 0;
  let renderedRows = 0;
  let budgetCut = 0;
  let hop2 = 0;
  let coverage = 0;
  let chars = 0;

  for (const entry of entries) {
    const one = buildAggregates([entry.frame.payload], gainFor(entry.trace.turnId), policy);
    scored += one.scored;
    abstained += one.abstained;
    if (one.scored) {
      renderedRows += one.renderedRows;
      coverage += one.coverage;
      chars += one.chars;
    }
    if (!one.cases) continue;
    cases += one.cases;
    addMeans(missed, one.missed);
    addMeans(delivered, one.delivered);
    missedRows += one.missedRows;
    budgetCut += one.budgetCutShare;
    hop2 += one.hop2Share;
    firstHitRanks.push(...one.firstHitRanks);
  }

  return {
    frames: entries.length,
    scored,
    abstained,
    cases,
    missed: divideMeans(missed, cases),
    delivered: divideMeans(delivered, cases),
    missedRows: cases ? missedRows / cases : 0,
    renderedRows: scored ? renderedRows / scored : 0,
    firstHitRanks,
    budgetCutShare: cases ? budgetCut / cases : 0,
    hop2Share: cases ? hop2 / cases : 0,
    coverage: scored ? coverage / scored : 0,
    chars: scored ? chars / scored : 0,
  };
}

function zeroMeans(): ComponentMeans {
  return { relevance: 0, importance: 0, recency: 0, usage: 0, tagHit: 0 };
}

function addMeans(target: ComponentMeans, source: ComponentMeans): void {
  target.relevance += source.relevance;
  target.importance += source.importance;
  target.recency += source.recency;
  target.usage += source.usage;
  target.tagHit += source.tagHit;
}

function divideMeans(target: ComponentMeans, count: number): ComponentMeans {
  if (count <= 0) return target;
  return {
    relevance: target.relevance / count,
    importance: target.importance / count,
    recency: target.recency / count,
    usage: target.usage / count,
    tagHit: target.tagHit / count,
  };
}
