import type {
  DreamLabel,
  DreamLabelScope,
  DreamLabelSource,
  MemoryRecordSnapshot,
  Message,
  Role,
} from '../../types.js';
import { confirmedBy, normalizeTokens, similarity } from '../gate.js';
import type { DeltaPosition, GainFunction } from './measure.js';

/**
 * From the source to the label (dream stage 2, AP4; concept 4).
 *
 * Without this module `dream_labels.relevance` has no writer, and the whole
 * apparatus measures nothing. A label is a tuple
 * `(turnId, target, relevance in {0,1}, source, evidence)` and it claims
 * something about ONE turn: "this memory should have been in this prompt" (1)
 * or "this memory was in this prompt and had no business being there" (0). A
 * label that only says "this memory is generally good" is not a retrieval
 * label - an nDCG over it measures whether recall fetched the globally
 * popular rows, and `coreProfile` delivers exactly those in every turn
 * anyway, without any help from a retrieval policy (concept 4.1).
 *
 * Everything here is pure: no store, no clock, no I/O. `now` is a parameter,
 * the reachable set is a parameter, the threshold is a parameter. The night
 * (AP12) and the HTTP path (AP13) hold the state; this file holds the rules,
 * and that is what makes them testable one trap at a time.
 *
 * The four traps the concept names, and where each is closed:
 *
 *   - An ambiguous quote is never guessed at: `locateTurn` answers `null` and
 *     the label goes out session-wide, where `gainFrom` refuses it (S3).
 *   - A memory that did not yet exist at the turn gets no label at all - an
 *     anachronism is not evidence, and `#replay` writes memories in the same
 *     night it writes corrections (S4).
 *   - `merge` produces negative labels only, over at most one `supersedes`
 *     hop, or the label wanders weeks away from what it observed (S7).
 *   - `review` writes the sentinel target `'*'`, and it is `gainFrom` that
 *     keeps it out of DCG, not the discipline of its callers (S8).
 *
 * The one thing this module cannot fix is the missing-label bias: a memory
 * gets a label only through channels that presuppose the incumbent surfaced
 * it - with the single exception of `correctionLabels`' relevance-1 case,
 * which is the most valuable case in the whole concept. Hence the reporting
 * arithmetic at the bottom: every evaluation states its `labelCoverage` and
 * its `costOnlyShare`, and a delta drawn predominantly from unlabelled
 * positions is not a delta (concept 4.4, S10).
 */

/* ------------------------------ what a caller hands in ------------------------------ */

/**
 * A transcript message as the quote locator needs it - the plain shape
 * `getMessages` returns, narrowed to the fields that decide a turn reference.
 * `turnId` is absent on every row written before Schema 24, and a message
 * without one can never anchor a label.
 */
export interface LabelMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  /** The journal's turn id, carried onto the message by AP14. */
  turnId?: string;
}

/** The turn a label is anchored at: its id, and when it began. */
export interface LabelTurn {
  id: string;
  /** Anchors the anachronism lock - a target older than this, or nothing. */
  startedAt: number;
}

/**
 * One row of the frame's reachable set R, as the plain snapshot the frame
 * already holds. `MemoryRecordSnapshot` satisfies this structurally, so a
 * caller passes `Object.values(frame.records)` straight in.
 */
export interface LabelTarget {
  id: string;
  content: string;
  createdAt: number;
}

/** Where a quote landed in the transcript (concept 4.2a). */
export interface TurnLocation {
  /** The located turn, or `null` when the quote was not unambiguous. */
  turnId: string | null;
  /** `'turn'` exactly when `turnId` is set; `'session'` otherwise. */
  scope: DreamLabelScope;
}

/* --------------------------------- the quote locator --------------------------------- */

/**
 * Locate a correction's quote in the session transcript (concept 4.2a,
 * step 1).
 *
 * Corrections are born session-wide: `#replay` proves the quote against the
 * glued user text of the whole session and `addCorrection` stores a
 * `session_id`. A label needs a turn, and the only honest way from one to the
 * other is to find the quote again in exactly one user message.
 *
 * Exactly one user message carries it: that message's `turnId`. None, several,
 * or one without a turn id: `null` and `scope: 'session'`. Not a guess - a
 * session-wide label still counts for the label agreement check and for
 * calibration, but never for a `gain` (S3), and a wrong turn reference would
 * pollute both.
 *
 * The containment test is `confirmedBy`, the same standard the night used to
 * admit the quote in the first place: normalised words, every
 * ellipsis-separated fragment an unbroken run, at least two words of
 * substance. Two occurrences INSIDE one message are not ambiguity - they
 * still name one turn - so the count that matters is the count of messages.
 */
export function locateTurn(messages: readonly LabelMessage[], quote: string): TurnLocation {
  const ambiguous: TurnLocation = { turnId: null, scope: 'session' };
  const text = quote.trim();
  if (!text) return ambiguous;

  let found: LabelMessage | undefined;
  for (const message of messages) {
    if (message.role !== 'user') continue;
    if (!confirmedBy(text, [message.content])) continue;
    if (found) return ambiguous;
    found = message;
  }
  const turnId = found?.turnId;
  if (!turnId) return ambiguous;
  return { turnId, scope: 'turn' };
}

/* ----------------------------------- the four sources ----------------------------------- */

/** Clamp a label value into the range `dream_labels.relevance` may hold. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** One label, with the optional columns left out rather than nulled. */
function makeLabel(input: {
  turnId: string;
  target: string;
  source: DreamLabelSource;
  relevance: number;
  scope: DreamLabelScope;
  owner: string;
  sessionId?: string;
  evidence?: string;
  now: number;
}): DreamLabel {
  const label: DreamLabel = {
    turnId: input.turnId,
    target: input.target,
    source: input.source,
    relevance: clamp01(input.relevance),
    scope: input.scope,
    owner: input.owner,
    createdAt: input.now,
  };
  if (input.sessionId) label.sessionId = input.sessionId;
  if (input.evidence) label.evidence = input.evidence;
  return label;
}

/** What `correctionLabels` needs to turn one correction into labels. */
export interface CorrectionLabelInput {
  /** The correction sentence `#replay` produced - never its quote. */
  text: string;
  owner: string;
  sessionId: string;
  /** `locateTurn`'s answer, resolved to a turn. `null`: session-wide (S3). */
  turn: LabelTurn | null;
  /**
   * When the session began. It is the anachronism anchor for an ambiguous
   * quote: the session starts no later than any of its turns, so comparing
   * against it is the conservative bound, never the optimistic one.
   */
  sessionStartedAt: number;
  /** The frame's reachable set R of the anchored turn. */
  reachable: readonly LabelTarget[];
  /** The ids that actually stood in the prompt, in prompt order. */
  prompted: readonly string[];
  /** `gate.duplicateThreshold` - passed in, because this module reads no config. */
  duplicateThreshold: number;
  /** The correction's id. */
  evidence?: string;
  now: number;
}

/**
 * `correction` - the only source that can label a memory that was never
 * delivered (concept 4.2a, step 2).
 *
 * The correction names no memory id, so the arithmetic the gate already owns
 * does the naming: Dice similarity over normalised tokens against the
 * reachable set R of the turn. A hit at or above `duplicateThreshold` on a
 * row that STOOD in the prompt is `relevance = 0` - it was there and it was
 * wrong. A hit on a row that existed at the time of the turn and did NOT
 * stand in the prompt is `relevance = 1`, and that second case is the whole
 * reason this source exists: it labels a target the incumbent failed to
 * deliver, which is the one place the missing-label bias does not reach.
 *
 * The anachronism lock (S4) is not optional. `#replay` writes memories in the
 * same night it writes corrections, and a label on a row that did not exist
 * during the turn is not weak evidence, it is no evidence.
 *
 * The rule is applied per row, exactly as the concept states it: a correction
 * that matches three near-duplicates of the same fact labels all three, and
 * at a threshold of 0.82 that means they really are the same sentence.
 *
 * Zero model calls; one Dice computation per row of R.
 */
export function correctionLabels(input: CorrectionLabelInput): DreamLabel[] {
  const text = normalizeTokens(input.text);
  if (!text.size) return [];

  const anchor = input.turn ? input.turn.startedAt : input.sessionStartedAt;
  const prompted = new Set(input.prompted);
  const labels: DreamLabel[] = [];
  for (const target of input.reachable) {
    // S4: strictly before the turn, or no label at all.
    if (!(target.createdAt < anchor)) continue;
    if (similarity(text, normalizeTokens(target.content)) < input.duplicateThreshold) continue;
    labels.push(
      makeLabel({
        turnId: input.turn ? input.turn.id : input.sessionId,
        target: target.id,
        source: 'correction',
        relevance: prompted.has(target.id) ? 0 : 1,
        scope: input.turn ? 'turn' : 'session',
        owner: input.owner,
        sessionId: input.sessionId,
        evidence: input.evidence,
        now: input.now,
      }),
    );
  }
  return labels;
}

/** One prompted row with the condensation `#condense` has just written on it. */
export interface MergeTarget {
  id: string;
  /** The condensed row that took this one's place. One hop; never followed. */
  supersededBy?: string;
}

/** What `mergeLabels` needs for one turn. */
export interface MergeLabelInput {
  owner: string;
  sessionId?: string;
  /** The turn whose prompt these rows stood in. */
  turnId: string;
  /** The ids that stood in that prompt, in prompt order. */
  prompted: readonly string[];
  /** `superseded_by` per row, as `#condense` left it. */
  targets: readonly MergeTarget[];
  now: number;
}

/**
 * `merge` - cheap, plentiful, and valid in one direction only (concept 4.2c,
 * S7).
 *
 * `#condense` writes a condensed row and sets `superseded_by` on its sources.
 * That says "redundant", not "relevant to this question", which leaves
 * exactly one rule: if two rows stood in ONE prompt and later fell into the
 * same condensation cluster, the worse-placed of the two is proven redundant
 * and gets `relevance = 0`. No positive label can be drawn from this source,
 * and none is written here.
 *
 * At most one `supersedes` hop. The cluster key is a row's own
 * `superseded_by`, never the chain behind it: two rows condensed into
 * different successors that were later condensed into each other are NOT one
 * cluster here, because a label that walks that far has stopped describing
 * the prompt it observed. For the same reason a row that is itself the
 * successor forms no cluster of its own - the claim needs two members that
 * both stood in the prompt.
 *
 * The evidence is the condensed row's id: it is the artefact that proves the
 * redundancy, and it stays resolvable long after the night that wrote it.
 *
 * Zero model calls; one `superseded_by` lookup per frame.
 */
export function mergeLabels(input: MergeLabelInput): DreamLabel[] {
  const position = new Map<string, number>();
  input.prompted.forEach((id, index) => {
    if (!position.has(id)) position.set(id, index);
  });

  const clusters = new Map<string, string[]>();
  for (const target of input.targets) {
    const into = target.supersededBy;
    if (!into) continue;
    if (!position.has(target.id)) continue;
    const members = clusters.get(into);
    if (members) members.push(target.id);
    else clusters.set(into, [target.id]);
  }

  const labels: DreamLabel[] = [];
  for (const [into, members] of clusters) {
    if (members.length < 2) continue;
    // Prompt order decides which one was better placed; the rest are the
    // ones the block paid for twice.
    members.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
    for (const id of members.slice(1)) {
      labels.push(
        makeLabel({
          turnId: input.turnId,
          target: id,
          source: 'merge',
          relevance: 0,
          scope: 'turn',
          owner: input.owner,
          sessionId: input.sessionId,
          evidence: into,
          now: input.now,
        }),
      );
    }
  }
  return labels;
}

/** The sentinel target of a `review` label: the trace, not a memory. */
export const REVIEW_TARGET = '*';

/** What `reviewLabel` needs from `upsertReview` (AP14). */
export interface ReviewLabelInput {
  owner: string;
  /** The assignment the review scored. It keys the label, in place of a turn. */
  assignmentId: string;
  sessionId?: string;
  /** `overall`, 1 to 5 as `upsertReview` stores it. */
  overall: number;
  /** The review's id and source. */
  evidence?: string;
  now: number;
}

/**
 * `review` - a trace weight, not a `gain` (concept 4.2d, S8).
 *
 * `upsertReview` is the one funnel every review source runs through, but it
 * scores an ASSIGNMENT from 1 to 5, not a memory. There is no observable path
 * from "the assignment went well" to "this memory belonged in the prompt", so
 * this label carries the sentinel target `'*'`, `relevance = (overall - 1)/4`
 * and `scope: 'session'`. It serves the label agreement check as a control
 * quantity and stage 2 as a reward. It is `gainFrom` that keeps it out of
 * DCG - a rule the callers cannot forget.
 *
 * Two warnings that belong to this source and not to this function:
 * `upsertReview` REPLACES the row for the same `(assignmentId, source)` and
 * resets `created_at`, so a reward once attached can later be silently
 * revoked; and an agent never receives a correction through `#replay`, which
 * makes this one blurry source nearly its whole label supply.
 */
export function reviewLabel(input: ReviewLabelInput): DreamLabel {
  return makeLabel({
    turnId: input.assignmentId,
    target: REVIEW_TARGET,
    source: 'review',
    relevance: (input.overall - 1) / 4,
    scope: 'session',
    owner: input.owner,
    sessionId: input.sessionId,
    evidence: input.evidence,
    now: input.now,
  });
}

/** What `userLabel` needs from the HTTP path (AP13). */
export interface UserLabelInput {
  owner: string;
  /** The memory the user acted on. */
  target: string;
  /** 0 for forget/delete/unpin, 1 for pin or an explicit "was the point". */
  relevance: number;
  /**
   * The turn the chat highlight named (S6). Absent for a plain edit on the
   * memory page, which carries no turn at all and lands session-wide.
   */
  turnId?: string;
  /** The session the edit is attributed to; the key when there is no turn. */
  sessionId: string;
  /** Route name plus actor, as concept 8.3 prescribes for this source. */
  evidence?: string;
  now: number;
}

/**
 * `user` - the only source the retrieval policy has no causal path to
 * (concept 4.2b).
 *
 * The VALUE of this label is independent of recall: the user pinned, unpinned,
 * edited or forgot a row, and none of that is a function of what the policy
 * surfaced. Its ATTRIBUTION is not independent, which is why an edit without
 * a turn is attributed to the session window and never to "the turns that
 * surfaced this memory" - that rule would be a function of the policy, and
 * scoring a policy against its own output measures nothing.
 *
 * The chat highlight is the exception and the reason S6 exists: it already
 * knows which memories this turn surfaced, so a click on it writes a label
 * with a real turn reference. Precision 1 by construction, as long as the
 * user clicks; the open quantity is the volume, and Phase 2 measures it.
 */
export function userLabel(input: UserLabelInput): DreamLabel {
  return makeLabel({
    turnId: input.turnId ?? input.sessionId,
    target: input.target,
    source: 'user',
    relevance: input.relevance,
    scope: input.turnId ? 'turn' : 'session',
    owner: input.owner,
    sessionId: input.sessionId,
    evidence: input.evidence,
    now: input.now,
  });
}

/**
 * The sessions a `user` edit at `at` is attributed over: `[at - window, at]`
 * (concept 4.2b, `dream.userLabelWindow`).
 *
 * The window is a parameter like everything else here, and the caller's own
 * clock decides `at` - the night attributes with the correction's timestamp,
 * the HTTP path with the moment of the edit.
 */
export function sessionsInUserLabelWindow(
  sessions: readonly { id: string; at: number }[],
  at: number,
  window: number,
): string[] {
  const from = at - Math.max(0, window);
  return sessions
    .filter((session) => session.at >= from && session.at <= at)
    .map((session) => session.id);
}

/* ---------------------------------- the primary source ---------------------------------- */

/**
 * The precedence of the sources over one target (concept 4.1):
 * `user > correction > merge`. `review` is not on this scale at all - it
 * scores an assignment, and its rank exists only so the table is total.
 */
const SOURCE_RANK: Record<DreamLabelSource, number> = {
  user: 3,
  correction: 2,
  merge: 1,
  review: 0,
};

/** `gain(m)` for one turn, plus the contradictions it had to resolve. */
export interface GainResult {
  gain: GainFunction;
  /**
   * How often two sources claimed different values for the same target. The
   * ranking decides the value, but the disagreement is COUNTED and goes into
   * the label agreement check (concept 5.5b) - never silently overwritten.
   */
  conflicts: number;
}

/**
 * Fold the labels of ONE turn into the gain function `measure` consumes
 * (concept 4.1, S2/S3/S8).
 *
 * Three refusals are built in here rather than left to the callers:
 *
 *   - `scope: 'session'` never yields a gain. An unlocatable quote claims
 *     something about a session, and a session is not a ranked list (S3).
 *   - `review` never yields a gain, neither by source nor through its
 *     sentinel target. That is the enforcement point named in S8.
 *   - A contradiction is resolved by rank and counted, and on equal rank the
 *     first label stands. No source silently overwrites another (S2).
 *
 * A label whose target has since died keeps its gain. The row is gone from
 * the frame's deliverable set either way, so dropping it here would only make
 * `reachableRate` look better than the bank is - and the whole point of
 * `dead_at` over deletion is that a removal stays visible (concept 8.3).
 *
 * Precondition: every label belongs to the same turn. The caller holds the
 * turn; this function keys on the target alone, so labels of two turns folded
 * together would count contradictions that never met.
 */
export function gainFrom(labels: readonly DreamLabel[]): GainResult {
  const primary = new Map<string, { rank: number; relevance: number }>();
  const seen = new Map<string, Set<number>>();
  let conflicts = 0;

  for (const label of labels) {
    if (label.scope !== 'turn') continue;
    if (label.source === 'review' || label.target === REVIEW_TARGET) continue;

    const relevance = clamp01(label.relevance);
    const values = seen.get(label.target);
    if (!values) seen.set(label.target, new Set([relevance]));
    else if (!values.has(relevance)) {
      values.add(relevance);
      conflicts += 1;
    }

    const rank = SOURCE_RANK[label.source];
    const current = primary.get(label.target);
    if (!current || rank > current.rank) primary.set(label.target, { rank, relevance });
  }

  const gain: GainFunction = (memoryId: string) => primary.get(memoryId)?.relevance ?? 0;
  return { gain, conflicts };
}

/* -------------------------------- the reporting arithmetic -------------------------------- */

/**
 * `label_coverage` - the share of the compared positions for which a label
 * could exist at all (concept 4.4, S10).
 *
 * `positions` is the union of the top-k of every compared arm; the universe
 * is the set of targets the session window knows a label for. Below
 * `dream.coverageFloor` an evaluation cannot tell a real delta from missing
 * labels, and AP8 declares it invalid rather than reporting it.
 *
 * An empty position list covers nothing and returns 0, the same answer
 * `measure` gives for an empty block - a rate over no positions is not a
 * rate, and returning 1 would let a vacuous evaluation clear the floor.
 */
export function labelCoverage(
  positions: readonly string[],
  labelledUniverse: ReadonlySet<string>,
): number {
  if (!positions.length) return 0;
  const covered = positions.filter((id) => labelledUniverse.has(id)).length;
  return covered / positions.length;
}

/**
 * `cost_only_share` - the share of traces whose delta came from the cost term
 * alone (concept 4.4, S10).
 *
 * One entry per paired trace: the positions where the two arms differ, each
 * carrying whether a label could exist for it. A trace on which no labelled
 * position moved is `no-labelled-move` - the arms agreed on everything that
 * could be judged, and whatever is left is block length. Above
 * `dream.costOnlyCeiling` the delta is not a delta.
 */
export function costOnlyShare(deltaPositions: readonly (readonly DeltaPosition[])[]): number {
  if (!deltaPositions.length) return 0;
  const costOnly = deltaPositions.filter(
    (positions) => !positions.some((position) => position.labelPossible),
  ).length;
  return costOnly / deltaPositions.length;
}

/** Two sources' values for one target they both labelled. */
export interface RatingPair {
  /** `turnId` and `target`, the key both sources had to agree on to pair. */
  turnId: string;
  target: string;
  a: number;
  b: number;
}

/** The key two labels must share to be a rating of the same thing. */
function ratingKey(label: DreamLabel): string {
  return label.turnId + ' ' + label.target;
}

/**
 * Pair two label sources on the targets they both judged (concept 5.5b).
 *
 * Session-wide labels take part: they carry the session id in `turnId`, so
 * they pair with each other and never with a turn label - which is exactly
 * the intent, since they count for the agreement check and never for a score.
 * Duplicates within one source keep their first value; the store's primary
 * key `(turn_id, target, source)` makes that case impossible in practice.
 */
export function pairedRatings(a: readonly DreamLabel[], b: readonly DreamLabel[]): RatingPair[] {
  const left = new Map<string, DreamLabel>();
  for (const label of a) if (!left.has(ratingKey(label))) left.set(ratingKey(label), label);

  const pairs: RatingPair[] = [];
  const taken = new Set<string>();
  for (const label of b) {
    const key = ratingKey(label);
    const counterpart = left.get(key);
    if (!counterpart || taken.has(key)) continue;
    taken.add(key);
    pairs.push({
      turnId: label.turnId,
      target: label.target,
      a: counterpart.relevance,
      b: label.relevance,
    });
  }
  return pairs;
}

/**
 * Plain pairwise agreement between two label sources: the share of common
 * targets they gave the same value.
 *
 * `null` when the two share no target - that is undetermined, not
 * disagreement, and the same distinction `DreamEval.signAgree` draws. Thin
 * `user` labels are a finding in their own right, not a zero (concept 5.5b).
 */
export function pairwiseAgreement(a: readonly DreamLabel[], b: readonly DreamLabel[]): number | null {
  const pairs = pairedRatings(a, b);
  if (!pairs.length) return null;
  return pairs.filter((pair) => pair.a === pair.b).length / pairs.length;
}

/**
 * Cohen's kappa between two label sources over their common targets
 * (concept 5.5b): observed agreement corrected for the agreement two raters
 * would reach by chance alone, given how often each of them used each value.
 *
 * `null` when it is undefined: no common target, or chance agreement of
 * exactly 1 because both sources used a single value throughout. That second
 * case is the one worth naming - `merge` writes nothing but zeroes, so a
 * comparison against it is degenerate by construction and the caller falls
 * back to `pairwiseAgreement` instead of reading a fabricated number.
 *
 * Values are compared as they stand; with `relevance in {0,1}` from every
 * source but `review`, the categories are the two the concept assumes.
 */
export function cohensKappa(a: readonly DreamLabel[], b: readonly DreamLabel[]): number | null {
  const pairs = pairedRatings(a, b);
  if (!pairs.length) return null;

  const marginalA = new Map<number, number>();
  const marginalB = new Map<number, number>();
  let observed = 0;
  for (const pair of pairs) {
    marginalA.set(pair.a, (marginalA.get(pair.a) ?? 0) + 1);
    marginalB.set(pair.b, (marginalB.get(pair.b) ?? 0) + 1);
    if (pair.a === pair.b) observed += 1;
  }

  const n = pairs.length;
  let expected = 0;
  for (const [value, count] of marginalA) {
    expected += (count / n) * ((marginalB.get(value) ?? 0) / n);
  }
  if (expected >= 1) return null;
  return (observed / n - expected) / (1 - expected);
}

/* ------------------------------ the structural contract ------------------------------ */

/**
 * The compiler's assertion that the plain shapes this module asks for are the
 * shapes the rest of the system already holds: a frozen frame record goes
 * into `correctionLabels` and a stored message into `locateTurn`, both
 * unconverted. A field renamed on either side fails the build here, where the
 * reason is written down, instead of at whichever call site AP12 writes next.
 */
type Satisfies<Shape, T extends Shape> = T;

type FrameRecordIsLabelTarget = Satisfies<LabelTarget, MemoryRecordSnapshot>;
type StoredMessageIsLabelMessage = Satisfies<LabelMessage, Message>;
