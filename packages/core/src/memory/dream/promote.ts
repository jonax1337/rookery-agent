import type {
  DreamEval,
  DreamSlot,
  DreamSlotFreezeReason,
  DreamSlotState,
  PolicyOrigin,
  PolicyVersion,
  RookeryConfig,
} from '../../types.js';
import type { Store } from '../store.js';
import type { AdmissionResult } from './admission.js';
import type { AgreementReport, DreamEvalResult } from './evaluate.js';

/**
 * The promotion gate (dream stage 2, AP9; concept 10.2, 10.3, 10.4).
 *
 * Everything before this file measures. This one decides, and its whole
 * value is in how many ways it says no. `promotionDecision` is the nine
 * conditions of concept 10.2, each a named predicate of its own, each
 * answerable without running any of the others - because a gate that fails
 * on the first condition and stops tells nobody whether the other eight
 * would have held, and the night has to be able to report exactly what stood
 * in the way.
 *
 * Three things this module holds on to:
 *
 * - **Cumulative, two comparisons, not one** (condition 2). The holdout says
 *   the candidate beat the INCUMBENT by more than the margin with an
 *   interval clear of zero; the frozen audit set says it beats the FACTORY
 *   parameter set. Without the second comparison a chain of individually
 *   significant steps, each measured only against its own predecessor, is a
 *   random walk with a ratchet - every step defensible, the destination
 *   arbitrary.
 * - **A frozen slot keeps measuring and stops promoting** (10.3). Freezing
 *   is a condition here, never a switch in `evaluate.ts`: the measurement is
 *   what a person needs to decide whether to thaw, so taking it away with
 *   the promotion would remove the evidence along with the symptom.
 * - **Nothing here is undone here.** The night's own undo lives in
 *   `store.undoSleepRun` (AP3), inside its transaction (10.4).
 *   `revertPolicy` is the OTHER path - the later, manual one over
 *   `prev_active_id`, for a promotion whose night has long been closed - and
 *   it deliberately restores parameters and nothing else. A revert cannot
 *   reach `access_count` or `usefulness`; they are monotone and carry no
 *   history, so the honest sentence is "reversible in parameters, not in
 *   counters" (E11).
 *
 * And the one place `applyPromotion` refuses to repeat itself:
 * `store.promotePolicyVersion` already retires the previous active version
 * and moves `dream_slot_state.last_promoted` in the same breath. This file
 * calls it and adds what it does not do - the version row, the evaluation
 * row that marks the evidence spent, and the cooldown clock.
 */

/* ------------------------------- constants ------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Decimals a rationale prints a delta with; mirrors the evidence digest. */
const RATIONALE_DIGITS = 4;

/**
 * The flat field names `resolvePolicy` (AP10) reads out of a promoted
 * `params` blob. The list is the reader's, not the writer's: a key in
 * `params` that the resolver never looks at cannot overwrite anything, and
 * condition 7 is about what would actually be overwritten.
 */
export const POLICY_FIELDS = [
  'limit',
  'threshold',
  'hopEntity',
  'hopEdge',
  'relevance',
  'importance',
  'recency',
  'usage',
] as const;

export type PolicyField = (typeof POLICY_FIELDS)[number];

/** The four that live one level down, under `params.w` - again, as AP10 reads them. */
const WEIGHT_FIELDS: readonly PolicyField[] = ['relevance', 'importance', 'recency', 'usage'];

/* --------------------------------- input --------------------------------- */

/**
 * What the gate needs to answer all nine conditions.
 *
 * The slot is not repeated here: it is `holdout.slot`, the one the
 * evaluation was actually run for, and a second copy could only ever
 * disagree with it. Everything else is a reading the caller already has -
 * the gate computes nothing and reads no store, so a decision is
 * reproducible from its input alone.
 */
export interface PromotionInput {
  config: RookeryConfig;
  /**
   * The ONE holdout evaluation (E4/S12). Null when the selection never got
   * that far - a state, not an error, and its own blocker.
   */
  holdout: DreamEvalResult | null;
  /** The chosen candidate against the FACTORY set, on the frozen audit set (2b). */
  audit: DreamEvalResult | null;
  /** How many candidates were measured on the holdout this night for this slot. */
  holdoutChecks: number;
  /** The label agreement sensor (5.5b). */
  agreement: AgreementReport | null;
  /** The admission check (10.1), run BEFORE the evaluation (S17). */
  admission: AdmissionResult | null;
  /** Freeze state and cooldown clock, as `store.slotState` hands them over. */
  slotState: DreamSlotState;
  /** `store.lastPromotedTraceSetHash(owner, slot)`; null before the first one. */
  lastTraceSetHash: string | null;
  /**
   * Field provenance of the policy in force, as `resolvePolicy` reports it.
   * `RecallPolicyOrigin` fits as it is.
   */
  incumbentOrigin?: Partial<Record<PolicyField, PolicyOrigin>>;
  /** The parameter set this promotion would write. */
  params: Record<string, unknown>;
  /** Promotions already applied this night, across every slot (condition 8). */
  promotionsTonight: number;
  /** A paid exploration ran for this slot tonight (S19/E17). */
  exploredTonight?: boolean;
  now?: number;
}

/** What the gate answers. `blockers` is empty exactly when `promote` is true. */
export interface PromotionDecision {
  promote: boolean;
  /**
   * Every condition that failed, never just the first. Findings the
   * admission check and the agreement sensor already named travel under
   * their own names, so a caller can tell a structural rejection from a
   * measurement one without parsing prose.
   */
  blockers: string[];
}

/* ------------------------------ the nine conditions ------------------------------ */

function isNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Clamp to a range; dream keys are clamped where they are read (S23/E21). */
function clampNumber(value: number, lo: number, hi: number): number {
  const safe = Number.isFinite(value) ? value : lo;
  return Math.min(hi, Math.max(lo, safe));
}

/**
 * Condition 1: the evaluation certifies something at all (concept 5.4).
 *
 * An invalid evaluation is not a defeat for the candidate and must never be
 * read as one - below `minTraces`, off the intersection or under the
 * coverage floor, the number is about something else than the question. The
 * gate treats it as absence of evidence, which is why it is its own
 * condition rather than a comparison that happens to fail.
 */
export function evaluationIsValid(holdout: DreamEvalResult): boolean {
  return holdout.valid && holdout.error === null;
}

/**
 * Condition 2a: `delta > dream.margin` AND `ci_low > 0` against the
 * incumbent, on the holdout. Two tests, not one: the margin says the
 * improvement is big enough to bother with, the interval says it is there at
 * all. A delta over the margin with an interval straddling zero is a
 * measurement of noise that happened to land high.
 */
export function holdoutBeatsIncumbent(holdout: DreamEvalResult, margin: number): boolean {
  return holdout.delta > margin && holdout.ciLow > 0;
}

/**
 * Condition 2b: `audit_ci_low > 0` against the FACTORY parameter set, on the
 * frozen audit set (5.5d). Cumulative with 2a rather than instead of it.
 * A candidate that beats last night's winner but no longer beats the set the
 * product shipped with has walked the baseline away with it.
 */
export function auditBeatsFactory(auditCiLow: number | null | undefined): boolean {
  return isNumber(auditCiLow) && (auditCiLow as number) > 0;
}

/**
 * Condition 3: exactly one candidate was checked on the holdout (E4/S12).
 * Six candidates against one 95 percent interval is six-fold testing; the
 * discipline is that the ranking happens on the training half, where a wrong
 * answer costs nothing, and the one interval that will be read is computed
 * once, on data the ranking never saw.
 */
export function oneCandidateOnHoldout(checks: number): boolean {
  return checks === 1;
}

/**
 * Condition 4: the freshness sensor's sign agrees, or the frozen delta sits
 * inside the margin - in which case condition 2a does not bite anyway and
 * the comparison is moot (5.5a).
 *
 * `null` with a delta outside the margin is undetermined, and undetermined
 * does not promote: the sensor either ran and could not decide, or did not
 * run at all, and neither is an agreement.
 */
export function freshnessAgrees(
  signAgree: boolean | null,
  deltaFrozen: number | null | undefined,
  margin: number,
): boolean {
  if (signAgree === true) return true;
  if (!isNumber(deltaFrozen)) return false;
  return Math.abs(deltaFrozen as number) <= margin;
}

/**
 * Condition 5: the label agreement sensor without a finding (5.5b). Thin
 * `user` labels are one of those findings: an unvalidated proxy does not
 * promote a slot, and the report says so rather than falling back on the
 * sources that agree with each other because one process wrote them all.
 */
export function agreementHolds(report: AgreementReport): boolean {
  return report.ok;
}

/** Condition 6a: the admission check (10.1) came back without a finding. */
export function admissionClean(admission: AdmissionResult): boolean {
  return admission.ok;
}

/**
 * Condition 6b: this promotion does not stand on the evidence the last one
 * stood on (H6). Two nights with no new labelled traces produce the same
 * sorted trace ids, hence the same hash, hence no second promotion however
 * good the candidate looks the second time.
 *
 * What the stored hash can carry is identity, not overlap: `dream_evals`
 * keeps the hash and not the id list, so a pool that gained a single trace
 * is a different hash and passes here even though it is almost the same
 * evidence. `cooldownNights` is the guard that covers that gap, and the two
 * are deliberately both in condition 6.
 */
export function traceSetIsDisjoint(hash: string, lastHash: string | null): boolean {
  if (!lastHash) return true;
  return hash !== lastHash;
}

/** Condition 6c: the slot's cooldown has run out. No clock means none is running. */
export function cooldownExpired(state: DreamSlotState, now: number): boolean {
  if (state.cooldownUntil === undefined || state.cooldownUntil === null) return true;
  return state.cooldownUntil <= now;
}

/** Condition 7a: the slot is not frozen (10.3). It keeps measuring either way. */
export function slotIsThawed(state: DreamSlotState): boolean {
  return state.frozenAt === undefined || state.frozenAt === null;
}

/**
 * Condition 7b: every field this promotion would write that the user owns
 * (9.3, the collision rule).
 *
 * The resolver already refuses to lay a promoted value over a field whose
 * config value has moved off the factory default, so writing one would not
 * change behaviour - it would produce a version row claiming a value that is
 * never read, which is worse than a refusal. The gate blocks instead, and
 * names the fields.
 */
export function overwrittenUserFields(
  params: Record<string, unknown>,
  origin: Partial<Record<PolicyField, PolicyOrigin>> | undefined,
): PolicyField[] {
  if (!origin) return [];
  return POLICY_FIELDS.filter((field) => origin[field] === 'user' && setsField(params, field));
}

/** Whether `params` carries a value the resolver would read for this field. */
function setsField(params: Record<string, unknown> | undefined, field: PolicyField): boolean {
  if (!params) return false;
  if (!WEIGHT_FIELDS.includes(field)) return isNumber(params[field]);
  const weights = params.w;
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) return false;
  return isNumber((weights as Record<string, unknown>)[field]);
}

/** Condition 8a: at most `dream.maxPromotionsPerNight`, across every slot. */
export function withinNightlyCap(promotionsTonight: number, cap: number): boolean {
  return promotionsTonight < cap;
}

/**
 * Condition 9: exploration and promotion never share a night in the same
 * slot (E17/S19). An `explorationRate` above zero makes tonight an
 * exploration night for this slot, and an exploration that actually ran says
 * the same thing after the fact - an invariant with a test, not a sentence.
 */
export function explorationHolds(explorationRate: number, exploredTonight: boolean): boolean {
  return explorationRate <= 0 && !exploredTonight;
}

/* ------------------------------ the gate itself ------------------------------ */

/**
 * The nine conditions of concept 10.2, all of them, in order.
 *
 * Every condition that fails adds its own blocker; nothing short-circuits.
 * The night reports this list, the rationale of a refused promotion is this
 * list, and a test can close exactly one condition and read back exactly one
 * name.
 *
 * A missing holdout does NOT cascade into the four conditions that read it.
 * "There is no evaluation" is one fact, and reporting it four times would
 * bury the conditions that could still be checked without one.
 */
export function promotionDecision(input: PromotionInput): PromotionDecision {
  const dream = input.config.memory.dream;
  const now = input.now ?? Date.now();
  const margin = clampNumber(dream.margin, 0, 1);
  const cap = Math.max(0, Math.floor(clampNumber(dream.maxPromotionsPerNight, 0, 1000)));
  const explorationRate = clampNumber(dream.explorationRate, 0, 1);
  const blockers: string[] = [];

  // 8b, the switch. It stands first in the list because it is the reason
  // every night of this stage refuses - but it does not short-circuit: a
  // night with promotion off still measures, and what the measurement WOULD
  // have run into is exactly what a person needs before turning it on.
  if (!dream.promote) blockers.push('promote-disabled');

  const holdout = input.holdout;
  if (!holdout) {
    blockers.push('holdout-missing');
  } else {
    // 1
    if (!evaluationIsValid(holdout)) blockers.push('evaluation-invalid');
    // 2a
    if (!holdoutBeatsIncumbent(holdout, margin)) {
      if (!(holdout.delta > margin)) blockers.push('delta-below-margin');
      if (!(holdout.ciLow > 0)) blockers.push('ci-low-not-positive');
    }
    // 4
    if (!freshnessAgrees(holdout.signAgree, holdout.freshness?.deltaFrozen, margin)) {
      blockers.push(
        holdout.signAgree === false ? 'freshness-sign-disagrees' : 'freshness-undetermined',
      );
    }
    // 6b
    if (!traceSetIsDisjoint(holdout.traceSetHash, input.lastTraceSetHash)) {
      blockers.push('trace-set-not-disjoint');
    }
  }

  // 2b. The audit numbers ride on the holdout row (`dream_evals.audit_ci_low`)
  // but the evaluation that produced them is the argument here, so an audit
  // that was never run is its own blocker and never a silent pass.
  const auditCiLow = input.audit ? input.audit.ciLow : holdout?.auditCiLow;
  if (!input.audit && !isNumber(auditCiLow)) blockers.push('audit-missing');
  else if (!auditBeatsFactory(auditCiLow)) blockers.push('audit-ci-low-not-positive');

  // 3
  if (!oneCandidateOnHoldout(input.holdoutChecks)) {
    blockers.push(
      input.holdoutChecks < 1 ? 'no-candidate-on-holdout' : 'multiple-candidates-on-holdout',
    );
  }

  // 5. The sensor's own findings keep their names - `user-labels-thin`,
  // `agreement-below-floor`, `influenceable-only-delta` (5.5b).
  if (!input.agreement) blockers.push('agreement-missing');
  else if (!agreementHolds(input.agreement)) blockers.push(...input.agreement.findings);

  // 6a. Fail closed: a candidate nobody admitted is a candidate nobody
  // checked for the nine gaming paths of 10.1, and S17 puts that check
  // BEFORE the measurement, not after it.
  if (!input.admission) blockers.push('admission-missing');
  else if (!admissionClean(input.admission)) blockers.push(...input.admission.findings);

  // 6c
  if (!cooldownExpired(input.slotState, now)) blockers.push('cooldown-active');

  // 7a
  if (!slotIsThawed(input.slotState)) blockers.push('slot-frozen');

  // 7b
  for (const field of overwrittenUserFields(input.params, input.incumbentOrigin)) {
    blockers.push('user-field-overwritten:' + field);
  }

  // 8a
  if (!withinNightlyCap(input.promotionsTonight, cap)) blockers.push('promotion-cap-reached');

  // 9
  if (!explorationHolds(explorationRate, input.exploredTonight === true)) {
    blockers.push('exploration-night');
  }

  return { promote: blockers.length === 0, blockers };
}

/* ------------------------------ applying one ------------------------------ */

/** What `applyPromotion` writes and what it needs to write it. */
export interface ApplyPromotionInput {
  owner: string;
  slot: DreamSlot;
  /** The night this promotion belongs to - E18: every promotion carries its run id. */
  sleepRunId: string;
  config: RookeryConfig;
  /** The parameter set that goes in force. */
  params: Record<string, unknown>;
  /** The box it was validated against (8.5). */
  box: Record<string, unknown>;
  /** The holdout evaluation this promotion stands on; its row is the receipt. */
  holdout: DreamEvalResult;
  /** The audit evaluation, when it was run separately from the holdout row. */
  audit?: DreamEvalResult | null;
  /** Defaults to the version this one replaces. */
  parentId?: string;
  /** Defaults to the numbers below, rendered without any verbatim text (E19). */
  rationale?: string;
  now?: number;
}

/** What one applied promotion produced, and what the night counts off it. */
export interface PromotionRecord {
  version: PolicyVersion;
  /** The `dream_evals` row, marked `promoted` - the evidence is now spent (H6). */
  evaluation: DreamEval;
  /** What was in force a moment ago, or null when nothing was (8.5). */
  prevActiveId: string | null;
  cooldownUntil: number;
  /** What the night adds to `sleep_runs.dream_promoted` (S20) - always 1. */
  promoted: number;
}

function signed(value: number | null | undefined): string {
  if (!isNumber(value)) return 'na';
  const amount = value as number;
  return (amount >= 0 ? '+' : '') + amount.toFixed(RATIONALE_DIGITS);
}

/**
 * The stored justification of a promotion: numbers and this file's closed
 * vocabulary, never a word of the frames it stands on.
 *
 * Retention is the reason (E19/S21). Frames die after `frameRetainDays` and
 * a `policy_versions` row outlives every one of them, so a rationale that
 * quoted a frame would outlive the memory it quoted. The evidence digest on
 * the evaluation row carries the long form; this is the sentence a person
 * reads next to the version.
 */
export function renderRationale(holdout: DreamEvalResult, audit?: DreamEvalResult | null): string {
  const auditDelta = audit ? audit.delta : holdout.auditDelta;
  const auditCiLow = audit ? audit.ciLow : holdout.auditCiLow;
  return [
    'slot=' + holdout.slot,
    'n=' + holdout.closed,
    'sess=' + holdout.sessions,
    'd=' + signed(holdout.delta),
    'ci=[' + signed(holdout.ciLow) + ',' + signed(holdout.ciHigh) + ']',
    'audit=' + signed(auditDelta) + '/' + signed(auditCiLow),
    'cov=' + holdout.labelCoverage.toFixed(3),
    'sign=' + (holdout.signAgree === null ? 'na' : holdout.signAgree ? '1' : '0'),
    'hash=' + holdout.traceSetHash.slice(0, 12),
    'bound=lower',
    'ci-kind=approximate',
  ].join(' ');
}

/**
 * The `dream_evals` row of a promoted evaluation.
 *
 * Written out field by field rather than spread, and only the columns 8.6
 * declares: `DreamEvalResult` also carries the certificate (`valid`,
 * `violations`, `error`) and the paired counts, which belong to the decision
 * and not to the row. AP8's `Satisfies` assertion is what keeps the two
 * lists from drifting apart unnoticed.
 */
function evalRowFrom(
  result: DreamEvalResult,
  keys: { sleepRunId: string; policyId: string },
  audit: DreamEvalResult | null | undefined,
): Omit<DreamEval, 'id' | 'createdAt'> {
  return {
    sleepRunId: keys.sleepRunId,
    policyId: keys.policyId,
    slot: result.slot,
    traces: result.traces,
    closed: result.closed,
    abstained: result.abstained,
    abstainReasons: result.abstainReasons,
    reachableRate: result.reachableRate,
    labelCoverage: result.labelCoverage,
    costOnlyShare: result.costOnlyShare,
    score: result.score,
    baseline: result.baseline,
    delta: result.delta,
    ciLow: result.ciLow,
    ciHigh: result.ciHigh,
    auditDelta: audit ? audit.delta : result.auditDelta,
    auditCiLow: audit ? audit.ciLow : result.auditCiLow,
    deltaLive: result.deltaLive,
    signAgree: result.signAgree,
    evalMs: result.evalMs,
    traceSetHash: result.traceSetHash,
    evidenceDigest: result.evidenceDigest,
    promoted: true,
    detail: result.detail,
  };
}

/**
 * Put one candidate in force (concept 8.5, 10.2, E18).
 *
 * Four writes, in this order and no other: the version row, the evaluation
 * row that marks its evidence spent, the promotion itself, the cooldown
 * clock. The order is not taste - `dream_evals.policy_id` references
 * `policy_versions(id)`, so the evaluation cannot be recorded before the
 * version exists, and `lastPromotedTraceSetHash` reads exactly that
 * evaluation row when the NEXT night asks whether this evidence was already
 * spent (H6).
 *
 * What this function deliberately does not do: retire the previous version,
 * or move `dream_slot_state.last_promoted`. `store.promotePolicyVersion`
 * already does both, in one breath with the promotion, and a second copy
 * here would be a second truth about which version is in force. It also does
 * not touch `sleep_runs`: the run's counters are the night's bookkeeping
 * (AP12), so the number it should add comes back in `promoted` instead.
 *
 * The caller decides; this applies. `promotionDecision` is not called from
 * here, because a function that both decides and writes cannot be tested for
 * either half on its own.
 */
export function applyPromotion(store: Store, input: ApplyPromotionInput): PromotionRecord {
  const at = input.now ?? Date.now();
  const nights = Math.max(
    0,
    Math.floor(clampNumber(input.config.memory.dream.cooldownNights, 0, 365)),
  );
  const cooldownUntil = at + nights * DAY_MS;
  const audit = input.audit ?? null;

  // All four writes in one savepoint, through the store's own nestable
  // bracket. The name says `recordDreamTurn` because the recorder was its
  // first caller, but what it is is a SAVEPOINT that nests (R9) - and the
  // half-written state this rules out is a real one: an evaluation row
  // marked `promoted` with no promoted version behind it would tell the next
  // night the evidence was spent on a promotion that never happened.
  let record!: PromotionRecord;
  store.recordDreamTurn(() => {
    // What is in force right now, read here rather than passed in: this is
    // the moment the answer has to be true for, and `prev_active_id` is the
    // only thing a revert has to bring back (8.5).
    const active = store.activePolicy(input.owner, input.slot);

    const version = store.createPolicyVersion({
      owner: input.owner,
      slot: input.slot,
      params: input.params,
      box: input.box,
      origin: 'dream',
      parentId: input.parentId ?? active?.id,
      sleepRunId: input.sleepRunId,
      rationale: input.rationale ?? renderRationale(input.holdout, audit),
      replayScore: input.holdout.score,
      replayN: input.holdout.closed,
      baselineScore: input.holdout.baseline,
      auditDelta: audit ? audit.delta : input.holdout.auditDelta,
      auditCiLow: audit ? audit.ciLow : input.holdout.auditCiLow,
    });

    const evaluation = store.recordDreamEval({
      ...evalRowFrom(input.holdout, { sleepRunId: input.sleepRunId, policyId: version.id }, audit),
      createdAt: at,
    });

    const promoted = store.promotePolicyVersion(version.id, {
      prevActiveId: active?.id,
      sleepRunId: input.sleepRunId,
      at,
    });
    store.setSlotCooldown(input.owner, input.slot, cooldownUntil);

    record = {
      version: promoted ?? version,
      evaluation,
      prevActiveId: active?.id ?? null,
      cooldownUntil,
      promoted: 1,
    };
  });
  return record;
}

/* -------------------------------- freezing -------------------------------- */

/** The sensor readings the four freeze causes of 10.3 are read out of. */
export interface FreezeSignals {
  /**
   * The wake test's observed drift after a promotion (AP12): how far the
   * live score moved from what the replay promised.
   */
  calibrationDrift?: number | null;
  /**
   * `dream.tolerance` - the drift the wake test still tolerates. Left out it
   * is zero, so any drift at all freezes: a caller that measured a drift and
   * forgot its tolerance gets the careful answer, not the generous one.
   */
  tolerance?: number;
  /** The freshness sensor's verdict (5.5a); `false` means the signs disagree. */
  signAgree?: boolean | null;
  /** The label agreement sensor's report (5.5b). */
  agreement?: AgreementReport | null;
  /** A person's decision. Nothing in the night ever sets this. */
  manual?: boolean;
}

/**
 * Which of the four causes of 10.3 a set of sensor readings names, or null
 * when none of them does.
 *
 * Precedence, when more than one fires: `manual` first, because a person
 * naming a reason should see their own reason in the record; then
 * `calibration`, which is the only one measured on the LIVE system after a
 * promotion; then `staleness`; then `agreement`.
 *
 * Thin `user` labels (`validated: false`) are deliberately NOT a freeze.
 * They block a promotion - that is condition 5 - but a bank that has never
 * been corrected by its user would otherwise freeze on its first night and
 * stay frozen, and a slot frozen for lack of evidence looks exactly like a
 * slot frozen for a regression while meaning the opposite.
 */
export function freezeReasonFor(signals: FreezeSignals): DreamSlotFreezeReason | null {
  if (signals.manual) return 'manual';
  const tolerance = clampNumber(signals.tolerance ?? 0, 0, 1);
  const drift = signals.calibrationDrift;
  if (isNumber(drift) && Math.abs(drift as number) > tolerance) return 'calibration';
  if (signals.signAgree === false) return 'staleness';
  const agreement = signals.agreement;
  if (agreement && agreement.validated && !agreement.floorHolds) return 'agreement';
  return null;
}

/**
 * Freeze one slot for one named cause (10.3) and hand back what the slot
 * looks like afterwards.
 *
 * A frozen slot keeps measuring: nothing here touches the recorder, the
 * evaluation or the labels, and `promotionDecision` is the single place the
 * freeze has an effect. That is what makes the freeze readable later - the
 * evaluations that were written while it was frozen are the evidence a
 * person thaws it on.
 */
export function freezeFor(
  store: Store,
  owner: string,
  slot: DreamSlot,
  reason: DreamSlotFreezeReason,
  at = Date.now(),
): DreamSlotState {
  store.freezeSlot(owner, slot, reason, at);
  return store.slotState(owner, slot);
}

/* -------------------------------- reverting -------------------------------- */

/** What one manual revert did, or refused to do. */
export interface RevertResult {
  ok: boolean;
  /** The version that was in force and no longer is. */
  retired: PolicyVersion | null;
  /** What `prev_active_id` pointed at, back in force. Null when there was none. */
  restored: PolicyVersion | null;
  /** Why nothing happened. Empty exactly when `ok`. */
  findings: string[];
}

/**
 * The later, manual revert (concept 10.4, `POST /api/dream/policies/:id/revert`).
 *
 * The night's own undo is `store.undoSleepRun` (AP3) and lives inside its
 * transaction, after the edge delete and before the `undone_at` stamp. That
 * one is once per run and only while the run is the newest thing that
 * happened. This is the other path: a promotion from any night, reverted by
 * a person, over `prev_active_id`.
 *
 * `restored: null` with `ok: true` is a real outcome, not a failure - the
 * precedent is `snapshotSkill`, where NULL means "there was none". The
 * resolver then falls back to the config and the factory defaults, which is
 * exactly the state before the first promotion.
 *
 * The owner check is optional and, when given, is the second of the two
 * filters 10.5 asks for: `policy_versions` carries its owner, and a route
 * that already filtered in SQL still passes it here.
 */
export function revertPolicy(
  store: Store,
  policyId: string,
  options: { owner?: string; at?: number } = {},
): RevertResult {
  const at = options.at ?? Date.now();
  const version = store.policyVersion(policyId);
  if (!version) return { ok: false, retired: null, restored: null, findings: ['policy-not-found'] };
  if (options.owner && version.owner !== options.owner) {
    return { ok: false, retired: null, restored: null, findings: ['foreign-owner'] };
  }
  if (!version.promotedAt) {
    return { ok: false, retired: null, restored: null, findings: ['policy-never-promoted'] };
  }
  if (version.retiredAt) {
    return { ok: false, retired: null, restored: null, findings: ['policy-already-retired'] };
  }

  store.retirePolicyVersion(policyId, at);
  let restored: PolicyVersion | null = null;
  if (version.prevActiveId) {
    store.reactivatePolicyVersion(version.prevActiveId);
    restored = store.policyVersion(version.prevActiveId);
  }
  return { ok: true, retired: store.policyVersion(policyId), restored, findings: [] };
}
