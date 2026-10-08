import {
  ASSISTANT_MEMORY_OWNER,
  type AbstainReason,
  type DreamEval,
  type DreamLabel,
  type DreamSlot,
  type PolicyVersion,
  type RecallBox,
  type RecallPolicy,
  type RookeryConfig,
  type Session,
} from '../types.js';
import type { Logger } from '../logger.js';
import type { Store } from './store.js';
import { admit, type AdmissionResult } from './dream/admission.js';
import { proposeCandidates, withIncumbent } from './dream/candidate.js';
import {
  DEFAULT_SPLIT_RATES,
  agreementReport,
  renderEvidenceDigest,
  selectOnTraining,
  splitPool,
  type AgreementReport,
  type DreamEvalResult,
  type FrameEntry,
  type SelectionReport,
  type SplitPool,
} from './dream/evaluate.js';
import { gainFrom, correctionLabels, mergeLabels } from './dream/label.js';
import { measure, type GainFunction } from './dream/measure.js';
import { factoryPolicy, resolvePolicy } from './dream/policy.js';
import { buildGrid, runGridProbe, type ProbeReport } from './dream/probe.js';
import {
  applyPromotion,
  freezeFor,
  freezeReasonFor,
  promotionDecision,
  renderRationale,
} from './dream/promote.js';
import { NIGHT_PHASES, yieldRates, type BudgetRun, type NightPhase } from './dream/slots.js';
import { clampCount } from './sleep-limits.js';
import type { PhaseScope } from './sleep-model.js';
import { liftPolicy, paramsOf, policyFromParams } from './sleep-policy.js';
import { aggregateCases, coverageOf, promptedOf } from './sleep-frames.js';
import { describeWakeTest, plural, type WakeTestReport } from './sleep-report.js';

/**
 * What the night hands whoever wants to tell a person that a retrieval
 * policy changed underneath them (concept 9.6, S26).
 *
 * The night does not send the mail itself, and that is deliberate: mail runs
 * through the `OrgController`, this file has no controller and will not get
 * one - it would drag the whole organisation into the one module that has to
 * keep working when nothing else does. The hook is filled by `runtime.ts`,
 * which has both.
 *
 * Everything in here is either a number or an id. `rationale` is the
 * promotion's own stored sentence, which carries no verbatim text by
 * construction (E19/S21), so a notice can be quoted into a mail without
 * outliving the memories it stands on.
 */
export interface PromotionNotice {
  owner: string;
  slot: DreamSlot;
  /** The night it happened in; `undo(runId)` takes it back in full. */
  runId: string;
  /** The version now in force. */
  version: PolicyVersion;
  /** The evaluation it stands on - the evidence row, now marked spent. */
  evaluation: DreamEval;
  /** What was in force a moment ago; the revert route restores it (10.4). */
  prevActiveId: string | null;
  /** One line a person reads: numbers and closed vocabulary, never a quote. */
  rationale: string;
  /** No further promotion of this slot before then (`dream.cooldownNights`). */
  cooldownUntil: number;
}

/** Called once per promotion, after it is in force. Never throws into the night. */
export type PromotionHook = (notice: PromotionNotice) => void | Promise<void>;

/**
 * The counters the dream phases move, as the run's own tally holds them.
 * Narrower than `SleepRun` on purpose: these are the only ones a dream
 * method may touch, and the type is what says so.
 */
export interface NightCounters {
  dreamTracesSeen: number;
  dreamFramesScored: number;
  dreamCandidates: number;
  dreamPromoted: number;
  dreamLabelsWritten: number;
  modelCalls: number;
}

/** The one sitting the dream's parts share: one wall clock, one signal, one tally. */
export interface DreamSitting {
  owner: string;
  runId: string;
  counters: NightCounters;
  deadline: number;
  signal: AbortSignal;
}

/** What the night knows about the recall slot before it measures anything. */
interface SlotFrame extends DreamSitting {
  slot: DreamSlot;
  incumbent: RecallPolicy;
  /** The box of the newest frame in the pool. */
  box: RecallBox;
  entries: readonly FrameEntry[];
  split: SplitPool;
  /** Everything but the frozen audit sessions: what the wake test may read. */
  awake: readonly FrameEntry[];
}

/** The candidates the night puts forward. */
interface Offer {
  proposals: { version: PolicyVersion; policy: RecallPolicy }[];
  versionOf: Map<RecallPolicy, PolicyVersion>;
  /** The incumbent first, then proposals and grid points; a repeated point is dropped. */
  offered: RecallPolicy[];
}

/** What admission made of the offer. */
interface Admission {
  /** The incumbent at position 0, then every candidate that passed. */
  admitted: RecallPolicy[];
  /** The verdict per admitted position. */
  admissions: Map<number, AdmissionResult>;
  /** Which admitted position carries which proposal. */
  proposalAt: Map<number, PolicyVersion>;
  /** The proposals the night has already reached a verdict on. */
  settled: Set<string>;
  refused: number;
}

/** What selection and the agreement sensor found. */
interface Measured {
  selection: SelectionReport;
  agreement: AgreementReport;
  admissions: Map<number, AdmissionResult>;
}

/** The measured candidate the gate is looking at. */
interface SlotVerdict {
  holdout: DreamEvalResult;
  audit: SelectionReport['audit'];
  params: Record<string, unknown>;
}

/** Frames one night reads: the pool `framesFor` walks, oldest first. */
const DREAM_POOL_LIMIT = 500;

/** Ids per label read: SQLite takes at most 999 bound parameters. */
const LABEL_BATCH = 200;

/** How deep into the version history a proposal may still be offered from. */
const PROPOSAL_WINDOW = 50;

/**
 * How long one night lasts for the run-global model-call ceiling. With
 * `sleep.scope: 'all'` the runtime runs the due banks sequentially in one
 * loop, so they all draw on one wallet; half a day opens a new one.
 */
const DREAM_NIGHT_WINDOW_MS = 12 * 60 * 60 * 1000;

export interface DreamPhaseOptions {
  store: Store;
  config: RookeryConfig;
  logger: Logger;
  /** Told about every promotion the night applies (S26). */
  onPromotion?: PromotionHook;
}

/**
 * The dream's half of a night: measure the retrieval policy, write the
 * labels the measurement stands on, propose candidates for the night after,
 * and - when every condition holds - put a better one in force. Everything
 * here is model-free except the candidate writer, which is why the night can
 * run it above the provider guard.
 */
export class DreamPhase {
  readonly #store: Store;
  readonly #config: RookeryConfig;
  readonly #log: Logger;
  readonly #onPromotion?: PromotionHook;
  /**
   * The run-global dream wallet (concept 9.4). With `sleep.scope: 'all'` the
   * runtime runs one night per owner, sequentially, in one loop - so a
   * per-run ceiling would multiply the candidate calls by the number of
   * banks. This counter spans those runs: a window opens with the first
   * budget query of a night and closes `DREAM_NIGHT_WINDOW_MS` after it
   * opened, which is what "one night" means for a process that has no
   * calendar.
   */
  #wallet = { since: 0, spent: 0 };

  constructor(options: DreamPhaseOptions) {
    this.#store = options.store;
    this.#config = options.config;
    this.#log = options.logger;
    this.#onPromotion = options.onPromotion;
  }

  /**
   * The probe, then - when `dream.slots` carries it - the recall slot. One
   * catch around the whole of it: a dream that throws costs the night its
   * measurement, never its consolidation (10.5: a degraded path is never
   * turned into an error). What the probe already reported is kept.
   */
  async measure(sitting: DreamSitting): Promise<string> {
    const dream = this.#config.memory.dream;
    let report = '';
    try {
      report += this.#probe(sitting);
      // `dream.slots` is what the night CARRIES (9.3, S18). `recall` is the
      // one slot this stage has a promotion path for; `budget` and `retry`
      // are measured after the cycles and carried by nobody yet.
      if (dream.slots.includes('recall')) report += await this.#recallSlot(sitting);
    } catch (cause) {
      const message = (cause as Error).message;
      this.#log.warn('The dream phase failed', { owner: sitting.owner, error: message });
      report += ' The dream phase failed: ' + message + '.';
    }
    return report;
  }

  /**
   * The grid probe (stage 1): the declared placements, scored against each
   * frame's own incumbent. Unchanged by stage 2 on purpose - it takes ONE
   * gain function for a whole pool, and a gain is a statement about one
   * turn, so a label-derived gain handed in here would let a memory proven
   * relevant in one turn score in every other. The labelled measurement is
   * `#recallSlot` below, which carries a gain per turn.
   */
  #probe({ owner, runId, counters, deadline, signal }: DreamSitting): string {
    const dream = this.#config.memory.dream;
    // The night's deadline, not a second one computed from the same key.
    // Without this the probe could spend the whole of `dream.maxEvalMs` and
    // `#recallSlot` would start already past its own - every evaluation
    // invalid, no row written, and last night's proposals retired for a
    // measurement that never happened (concept 6.1).
    const probe: ProbeReport = runGridProbe(this.#store, this.#config, owner, runId, signal, {
      deadline,
    });
    counters.dreamTracesSeen = probe.tracesSeen;
    counters.dreamFramesScored = probe.framesScored;

    let report = '';
    if (probe.invalidated > 0) {
      // Concept 3.3: frames older than a reindex or bulk import are declared
      // invalid outright, and the night report says so instead of letting
      // every following night guess at it as corpus drift.
      const since = probe.invalidatedAt
        ? new Date(probe.invalidatedAt).toISOString()
        : 'an unknown import';
      report +=
        ' ' + probe.invalidated + ' of ' + probe.frames +
        ' dream frames unusable since the import/reindex at ' + since + '.';
    }
    if (probe.poolTruncated) {
      // The pool walks the oldest frames first, so above the cap it is the
      // NEWEST frames that fall out of the measurement - a smaller pool must
      // be reported, not passed off as the whole one.
      report +=
        ' The dream probe read the ' + probe.frames + ' oldest of ' +
        probe.framesTotal + ' stored dream frames.';
    }
    // R18: the probe is model-free, and the run-global ceiling is what
    // certifies it. A probe that ever exceeds it has stopped being the
    // probe, and the night should say so rather than shrug.
    const ceiling = Math.max(0, Math.round(dream.maxCallsPerNight));
    if (probe.modelCalls > ceiling) {
      this.#log.warn('Dream probe exceeded dream.maxCallsPerNight', {
        owner,
        calls: probe.modelCalls,
        ceiling,
      });
    }
    this.#log.info('Dream probe measured', {
      owner,
      tracesSeen: probe.tracesSeen,
      frames: probe.frames,
      framesTotal: probe.framesTotal,
      poolTruncated: probe.poolTruncated,
      framesScored: probe.framesScored,
      evalMs: probe.evalMs,
      modelCalls: probe.modelCalls,
      deadlineHit: probe.deadlineHit,
      error: probe.error ?? undefined,
    });
    return report;
  }

  /**
   * The `recall` slot, end to end: candidates, admission, selection, the
   * three sensors, the freeze and the gate.
   *
   * The order is the contract and it is not taste:
   *
   *   1. The candidates - last night's proposals and tonight's declared
   *      grid, the incumbent first (E2/6.3).
   *   2. Admission BEFORE the measurement (S17/10.1). Every mechanism in the
   *      gaming table is a legal point inside the box, so a comparison on
   *      the score cannot catch one; what catches it is a predicate about
   *      the candidate's shape, decided without touching a score.
   *   3. Selection on the training half, exactly one candidate on the
   *      holdout, the frozen audit set opened only when a promotion is
   *      actually on the table (E4/S12/S13).
   *   4. The label agreement sensor over the pool's labels, `user`
   *      privileged (5.5b).
   *   5. The wake test on what is already in force (5.5c), then the freeze,
   *      then the gate - so tonight's regression alarm blocks tonight's
   *      promotion rather than the one after it.
   */
  async #recallSlot(sitting: DreamSitting): Promise<string> {
    const { owner, runId } = sitting;
    // The NEWEST frames, not the oldest. Everything below means the frames
    // nearest to now - the box of the last one, the wake test's "since the
    // last promotion" filter, the admission sample's trailing slice - and an
    // owner holding more frames than the cap would otherwise pin all three
    // to a weeks-old slice for good, silently (S3).
    const pool = this.#store.framesFor(owner, { limit: DREAM_POOL_LIMIT, newest: true });
    // A night never scores its own writes.
    const entries = pool.filter((entry) => entry.trace.sleepRunId !== runId);
    if (!entries.length) return this.#evidenceNote(owner, entries);

    let report = this.#truncationNote(owner, pool.length);
    const frame = this.#openSlotFrame(sitting, entries);
    const offer = this.#offerCandidates(frame);
    const admission = this.#admitOffered(frame, offer);
    const measured = this.#measureRecall(frame, offer, admission);

    report += this.#wakeAndFreeze(frame, measured);
    report += await this.#decideRecall(frame, measured);
    // A night that read no evaluation says why instead of staying silent: an
    // empty pool and a pool the gate never opens look the same from outside.
    if (!measured.selection.holdout) report += this.#evidenceNote(owner, entries);
    report += this.#retireMeasured(offer, admission, measured.selection);
    return report;
  }

  /**
   * Disclosed the way the probe discloses its own cut: a measurement over
   * part of the store must be visible as one, never pass for the whole of it.
   */
  #truncationNote(owner: string, poolSize: number): string {
    const framesTotal = this.#store.dreamFrameCount(owner);
    if (framesTotal <= poolSize) return '';
    return ' The recall slot measured the ' + poolSize + ' newest of ' + framesTotal + ' stored dream frames.';
  }

  #openSlotFrame(sitting: DreamSitting, entries: readonly FrameEntry[]): SlotFrame {
    const slot: DreamSlot = 'recall';
    const incumbent = resolvePolicy(this.#store, this.#config, sitting.owner, slot);
    // The box of the newest frame in the pool. The recorder derives it from
    // the policy in force, so every frame recorded under one policy carries
    // the same one; a candidate that leaves an older frame's box costs that
    // frame an abstention (`limit-out-of-box`), counted like every other.
    const box = entries[entries.length - 1]!.frame.box;

    // The frozen audit set is touched exactly once per promotion and serves
    // neither for selection nor as a holdout (5.5d). `selectOnTraining`
    // splits the pool itself, so every OTHER reader of the pool has to keep
    // the audit sessions out on its own: the admission predicate reads the
    // training half, exactly as the candidate writer does, and the wake test
    // reads everything but the audit.
    const split = splitPool(entries, DEFAULT_SPLIT_RATES);
    const audited = new Set(split.audit);
    const awake = entries.filter((entry) => !audited.has(entry));
    return { ...sitting, slot, incumbent, box, entries, split, awake };
  }

  /**
   * Last night's proposals and tonight's declared grid, the incumbent first
   * and a repeated point dropped: every delta is then paired against a
   * number measured tonight, on tonight's frames, never against a number
   * from yesterday (E2).
   */
  #offerCandidates({ owner, slot, incumbent, box }: SlotFrame): Offer {
    const dream = this.#config.memory.dream;
    const proposals = this.#proposals(owner, slot, incumbent, dream.candidates);
    const versionOf = new Map<RecallPolicy, PolicyVersion>(
      proposals.map((entry) => [entry.policy, entry.version] as const),
    );
    const grid = buildGrid(incumbent, box, dream.gridSize).map((placement) =>
      liftPolicy(placement, incumbent),
    );
    const offered = withIncumbent([...proposals.map((entry) => entry.policy), ...grid], incumbent);
    return { proposals, versionOf, offered };
  }

  /** Admission, before the measurement. */
  #admitOffered(
    { owner, incumbent, box, split, deadline, signal }: SlotFrame,
    { proposals, versionOf, offered }: Offer,
  ): Admission {
    const admissions = new Map<number, AdmissionResult>();
    const admitted: RecallPolicy[] = [offered[0]!];
    // Which admitted position carries which proposal, and which proposals
    // the night has reached a verdict on. Only a settled proposal is retired
    // at the end; one that was never measured is carried over (7).
    const proposalAt = new Map<number, PolicyVersion>();
    const settled = new Set<string>();
    const onOffer = new Set(offered);
    for (const entry of proposals) {
      // Dropped as a duplicate of a point already on offer - the incumbent's
      // own, usually (E2). There is nothing to measure about it tonight or
      // any other night, so it is spent rather than carried forever.
      if (!onOffer.has(entry.policy)) settled.add(entry.version.id);
    }
    const incumbentCoverage = coverageOf(split.train, incumbent, deadline, signal);
    let refused = 0;
    for (let index = 1; index < offered.length; index += 1) {
      const candidate = offered[index]!;
      const verdict = admit(candidate, incumbent, box, {
        coverage: {
          candidate: coverageOf(split.train, candidate, deadline, signal),
          incumbent: incumbentCoverage,
        },
        // H3: only the write gate's reinforcement branch ever un-parks a
        // memory, and this stage ships no `gate` slot - so neither arm
        // revives anything. Two measured zeroes, not a waived predicate.
        revivalRate: { candidate: 0, incumbent: 0 },
      });
      const version = versionOf.get(candidate);
      if (!verdict.ok) {
        refused += 1;
        // A refusal is a decision about the candidate's SHAPE, taken without
        // a score, so it comes out the same tomorrow and every night after:
        // the proposal is spent. Carrying it over would block the quota for
        // good rather than give it another chance.
        if (version) settled.add(version.id);
        this.#log.debug('A dream candidate was refused admission', {
          owner,
          findings: verdict.findings.join(','),
        });
        continue;
      }
      // Keyed by the position the candidate takes in `admitted`, which is
      // the index `selectOnTraining` reports back on the chosen one.
      if (version) proposalAt.set(admitted.length, version);
      admissions.set(admitted.length, verdict);
      admitted.push(candidate);
    }
    return { admitted, admissions, proposalAt, settled, refused };
  }

  /** Selection on the training half, then the label agreement sensor. */
  #measureRecall(frame: SlotFrame, offer: Offer, admission: Admission): Measured {
    const { owner, slot, incumbent, entries, deadline, signal } = frame;
    const dream = this.#config.memory.dream;
    const selection = selectOnTraining(this.#store, {
      owner,
      slot,
      config: this.#config,
      entries,
      incumbent,
      // The frozen audit set is scored against the set the product shipped
      // with, never against last night's winner (10.2, condition 2b).
      factory: factoryPolicy(),
      candidates: admission.admitted,
      // Tonight's fingerprint, as the probe above just stamped it: a frame
      // whose corpus has moved abstains instead of being scored (5.4).
      corpus: this.#store.currentCorpusStamp(owner),
      freshness: true,
      sourceDeltas: true,
      deadline,
      signal,
    });
    const agreement = agreementReport(this.#labelsFor(entries, owner), {
      floor: dream.agreementFloor,
      margin: dream.margin,
      deltaBySource: selection.holdout?.detail?.deltaBySource,
      requireUserLabels: dream.requireUserLabels,
    });
    this.#log.info('The dream measured the recall slot', {
      owner,
      split: selection.split,
      offered: offer.offered.length,
      admitted: admission.admitted.length - 1,
      refused: admission.refused,
      findings: selection.findings.join(','),
      delta: selection.holdout?.delta,
      ciLow: selection.holdout?.ciLow,
      valid: selection.holdout?.valid,
      violations: selection.holdout?.violations.join(','),
      agreement: agreement.findings.join(','),
    });
    return { selection, agreement, admissions: admission.admissions };
  }

  /** The wake test on what is already in force, then the freeze it may call for. */
  #wakeAndFreeze(
    { owner, slot, incumbent, awake, deadline, signal }: SlotFrame,
    { selection, agreement }: Measured,
  ): string {
    const wake = this.#wakeTest(owner, slot, awake, incumbent, deadline, signal);
    const report = wake ? describeWakeTest(wake) : '';
    return report + this.#freeze(owner, slot, wake, selection.holdout, agreement);
  }

  /** The gate: promote the chosen candidate, or record that it was measured and kept out. */
  async #decideRecall(frame: SlotFrame, { selection, agreement, admissions }: Measured): Promise<string> {
    const { owner, slot, incumbent, counters } = frame;
    const { holdout, audit, chosen } = selection;
    const params = chosen ? paramsOf(chosen.policy, incumbent) : {};
    const decision = promotionDecision({
      config: this.#config,
      holdout,
      audit,
      // Exactly one candidate reaches the holdout, or none did (E4/S12).
      holdoutChecks: holdout ? 1 : 0,
      agreement,
      admission: chosen ? admissions.get(chosen.index) ?? null : null,
      // Read after the freeze above, so a slot frozen tonight blocks
      // tonight's promotion (condition 7a).
      slotState: this.#store.slotState(owner, slot),
      lastTraceSetHash: this.#store.lastPromotedTraceSetHash(owner, slot),
      incumbentOrigin: incumbent.origin,
      params,
      // Stage 2 promotes for the assistant alone, so the night's own count
      // is the count across every slot (condition 8).
      promotionsTonight: counters.dreamPromoted,
    });

    let report = '';
    if (holdout && chosen && decision.promote) {
      report = await this.#putInForce(frame, { holdout, audit, params });
    } else if (holdout && chosen) {
      report = this.#recordMeasured(frame, { holdout, audit, params }, decision.blockers);
    }
    this.#log.info('The dream gate answered', {
      owner,
      slot,
      promote: decision.promote,
      blockers: decision.blockers.join(','),
    });
    return report;
  }

  async #putInForce(
    { owner, slot, runId, counters, box }: SlotFrame,
    { holdout, audit, params }: SlotVerdict,
  ): Promise<string> {
    const record = applyPromotion(this.#store, {
      owner,
      slot,
      sleepRunId: runId,
      config: this.#config,
      params,
      box: box as unknown as Record<string, unknown>,
      holdout,
      audit,
    });
    counters.dreamPromoted += record.promoted;
    await this.#announcePromotion({
      owner,
      slot,
      runId,
      version: record.version,
      evaluation: record.evaluation,
      prevActiveId: record.prevActiveId,
      rationale: record.version.rationale ?? renderRationale(holdout, audit),
      cooldownUntil: record.cooldownUntil,
    });
    return (
      ' A new ' + slot + ' policy is in force (version ' + record.version.version + '): ' +
      record.version.rationale + '. It can be taken back.'
    );
  }

  /**
   * A night that measures and does not promote is the common case, and the
   * record of it is what the next calibration stands on. The evaluation row
   * needs a version to hang off - `dream_evals.policy_id` is a foreign key -
   * so the candidate becomes an unpromoted version carrying its own replay
   * numbers, which is also what keeps it from coming back tomorrow as an
   * unmeasured proposal.
   */
  #recordMeasured(
    { owner, slot, runId, box }: SlotFrame,
    { holdout, audit, params }: SlotVerdict,
    blockers: readonly string[],
  ): string {
    const version = this.#store.createPolicyVersion({
      owner,
      slot,
      params,
      box: box as unknown as Record<string, unknown>,
      origin: 'dream',
      parentId: this.#store.activePolicy(owner, slot)?.id,
      sleepRunId: runId,
      rationale: renderRationale(holdout, audit),
      replayScore: holdout.score,
      replayN: holdout.closed,
      baselineScore: holdout.baseline,
      auditDelta: audit?.delta ?? holdout.auditDelta,
      auditCiLow: audit?.ciLow ?? holdout.auditCiLow,
    });
    this.#recordEval(holdout, version.id, runId, false);
    // Only worth a sentence when promoting is switched on at all -
    // otherwise every night would end with the same blocker.
    if (!this.#config.memory.dream.promote) return '';
    return ' A ' + slot + ' candidate was measured and not promoted: ' + blockers.join(', ') + '.';
  }

  /**
   * A proposal is offered exactly once - once it has been MEASURED.
   * Measured means a number exists for it: its training evaluation closed
   * at least one trace. A night that ran out of wall clock, or aborted, or
   * stood on a pool that closed nothing, measured none of them, and
   * retiring them for it would burn `dream.maxCallsPerNight` every night
   * forever on proposals that never got a number (7). What was measured,
   * or refused on its shape, is spent; the rest is carried over.
   */
  #retireMeasured(
    { proposals }: Offer,
    { settled, proposalAt }: Admission,
    selection: SelectionReport,
  ): string {
    const spent = new Set(settled);
    for (const ranked of selection.ranked) {
      if (ranked.training.closed <= 0) continue;
      const version = proposalAt.get(ranked.index);
      if (version) spent.add(version.id);
    }
    let retired = 0;
    for (const entry of proposals) {
      if (!spent.has(entry.version.id)) continue;
      this.#store.retirePolicyVersion(entry.version.id);
      retired += 1;
    }
    const carried = proposals.length - retired;
    if (carried <= 0) return '';
    return (
      ' ' + plural(carried, 'proposal was', 'proposals were') +
      ' carried over to the next night: nothing measured ' +
      (carried === 1 ? 'it' : 'them') + ' tonight.'
    );
  }

  /**
   * One sentence on what the dream has to work with: how many frames, from
   * how many sessions, how they split, what an evaluation needs, and how many
   * recent turns were recorded without a frame at all (the recorder refused
   * them, or a delete took the frame). The first answer to "why does nothing
   * happen".
   */
  #evidenceNote(owner: string, entries: readonly FrameEntry[]): string {
    const dream = this.#config.memory.dream;
    const sessions = new Set(entries.map((entry) => entry.trace.sessionId)).size;
    const split = splitPool(entries, DEFAULT_SPLIT_RATES);
    const frameless = this.#store.countFramelessTraces(owner, Date.now() - DREAM_NIGHT_WINDOW_MS);
    return (
      ' Dream evidence: ' + plural(entries.length, 'frame', 'frames') + ' from ' +
      plural(sessions, 'session', 'sessions') + ' (train ' + split.train.length + ', holdout ' +
      split.holdout.length + ', audit ' + split.audit.length + '); an evaluation needs ' +
      dream.minTraces + ' closed traces.' +
      (frameless > 0
        ? ' ' + plural(frameless, 'turn', 'turns') + ' of the last day had no frame.'
        : '')
    );
  }

  /**
   * The wake test (concept 5.5c): after `dream.calibrationTraces` traces,
   * how far the live score has moved from what the promotion promised.
   *
   * It is a **regression alarm, not a calibration**, and the report says so.
   * The replay value and the live value come out of the same estimator and
   * the same labels, so if the labels are wrong the two agree with each
   * other and both are wrong together. What this catches is the trace
   * distribution shifting after a promotion - that, and nothing more.
   *
   * The arm is the policy in force, which `resolvePolicy` has already laid
   * the promoted parameters into, and it is measured frame by frame with
   * `measure` - the same estimator and the same per-turn gains the holdout
   * used, which is the whole basis of the comparison. Deliberately NOT
   * through `evaluateCandidate`: that machinery is paired, and an arm
   * scored against itself moves nothing on any trace, so every one of them
   * would drop out as `no-labelled-move` and the pool would close empty.
   *
   * What it is allowed to conclude anything from is the frames that CLOSED.
   * `dream.calibrationTraces` decides when the test is due - that many
   * frames since the promotion have to exist at all - and then decides again
   * whether the pool it actually read is thick enough to read a verdict off.
   * The abstentions in between are counted by reason and reported, because
   * they are the finding when they dominate: the alternative, a verdict off
   * one trace out of fifty, freezes a slot until somebody thaws it by hand
   * (5.4, 10.3).
   */
  #wakeTest(
    owner: string,
    slot: DreamSlot,
    entries: readonly FrameEntry[],
    arm: RecallPolicy,
    deadline: number,
    signal: AbortSignal,
  ): WakeTestReport | null {
    const dream = this.#config.memory.dream;
    const active = this.#store.activePolicy(owner, slot);
    // Nothing has been promoted, or the promotion carries no promise to
    // compare against: there is no regression to alarm about.
    if (!active?.promotedAt || active.replayScore === undefined) return null;
    const promotedAt = active.promotedAt;
    const required = clampCount(dream.calibrationTraces);
    const fresh = entries.filter((entry) => entry.frame.createdAt >= promotedAt);
    // Not due yet. Fewer frames exist since the promotion than the floor
    // asks for, so no pool could clear it and there is nothing to say.
    if (fresh.length < required) return null;

    const costWeight = Math.min(1, Math.max(0, dream.costWeight));
    const gainFor = this.#gainsFor(fresh, owner);
    const reasons: Partial<Record<AbstainReason, number>> = {};
    let total = 0;
    let closed = 0;
    let abstained = 0;
    for (const entry of fresh) {
      if (signal.aborted || Date.now() > deadline) break;
      const result = measure(
        entry.frame.payload,
        arm,
        gainFor(entry.trace.turnId),
        costWeight,
      );
      // An abstention is not a low score; it is the absence of one - and a
      // counted quantity with a name (5.4), never a frame that drops out of
      // the pool unnoticed.
      if (!result.ok) {
        abstained += 1;
        reasons[result.abstain] = (reasons[result.abstain] ?? 0) + 1;
        continue;
      }
      total += result.score;
      closed += 1;
    }
    const seen = {
      offered: fresh.length,
      closed,
      abstained,
      reasons,
      required,
      promised: active.replayScore,
    };
    // The floor is read against what CLOSED, not against what was offered.
    // Fifty offered frames of which forty-nine abstain carry one trace of
    // noise, and `calibration` is a freeze a person has to undo by hand
    // (10.3): a test that could not close enough frames reports that it
    // could not run, and freezes nothing.
    if (closed < required) return { ...seen, drift: null, observed: null };
    const observed = total / closed;
    // The reading itself goes on the version it judges. The drift decides
    // whether the slot freezes tonight; `online_score` is what a person
    // reads next to `replay_score` later - "this is what the promise was
    // worth once it was actually in force" (5.5c). A test that could not
    // close enough frames returned above and writes nothing: an absent
    // reading stays absent rather than being recorded as a bad one.
    this.#store.setPolicyOnlineScore(active.id, observed);
    return { ...seen, drift: observed - active.replayScore, observed };
  }

  /**
   * Freeze the slot if one of the four causes of 10.3 fired.
   *
   * A frozen slot keeps measuring and stops promoting, which is what makes
   * it readable later: the evaluations written while it was frozen are the
   * evidence a person thaws it on. An already frozen slot keeps the reason
   * it was frozen for - re-stamping tonight's cause over last night's would
   * lose the one thing somebody needs in order to decide.
   */
  #freeze(
    owner: string,
    slot: DreamSlot,
    wake: WakeTestReport | null,
    holdout: DreamEvalResult | null,
    agreement: AgreementReport,
  ): string {
    const state = this.#store.slotState(owner, slot);
    if (state.frozenAt) return '';
    const reason = freezeReasonFor({
      // Null where the wake test could not read a verdict: a drift nobody
      // measured freezes nothing (10.3).
      calibrationDrift: wake ? wake.drift : null,
      tolerance: this.#config.memory.dream.tolerance,
      signAgree: holdout?.signAgree ?? null,
      agreement,
    });
    if (!reason) return '';
    freezeFor(this.#store, owner, slot, reason);
    this.#log.warn('A dream slot was frozen', { owner, slot, reason });
    return (
      ' The ' + slot + ' slot is frozen (' + reason +
      '): it goes on measuring and stops promoting until somebody thaws it.'
    );
  }

  /** Tell whoever wants to know that a parameter set went in force (S26). */
  async #announcePromotion(notice: PromotionNotice): Promise<void> {
    this.#log.info('A retrieval policy went in force', {
      owner: notice.owner,
      slot: notice.slot,
      version: notice.version.version,
      policy: notice.version.id,
      previous: notice.prevActiveId,
      run: notice.runId,
    });
    if (!this.#onPromotion) return;
    try {
      await this.#onPromotion(notice);
    } catch (cause) {
      // Telling somebody is not part of the promotion. A hook that throws
      // costs the message, never the night.
      this.#log.warn('The promotion hook failed', {
        owner: notice.owner,
        error: (cause as Error).message,
      });
    }
  }

  /**
   * The candidate writer (concept 6.2): one model call per candidate, on
   * `dream.model`, at `dream.effort` - never at `ask`'s wired `'low'`,
   * because designing a parameter set out of failure cases is judgement and
   * not extraction (S16/E14). Its own caller lives in `dream/candidate.ts`
   * for exactly that reason.
   *
   * What it writes are PROPOSALS, not policies: unpromoted `policy_versions`
   * rows that the next night's dream measures, ranks and possibly promotes.
   * That is what keeps the promotion path model-free and above the provider
   * guard - a night without a provider proposes nothing and still promotes
   * what the last one proposed.
   *
   * The wallet is run-global (`dream.maxCallsPerNight` across ALL owners,
   * concept 9.4): with `sleep.scope: 'all'` the runtime runs one night per
   * bank, sequentially, so a per-run ceiling would multiply by the number of
   * banks. The budget arrives already measured; the first line spends
   * nothing if there is none, and there is no abort throw between here and
   * the caller's next one.
   */
  async propose(scope: PhaseScope, budget: number): Promise<{ written: number; calls: number }> {
    const { owner, runId } = scope;
    const { provider, signal } = scope.voice;
    if (budget <= 0 || signal.aborted) return { written: 0, calls: 0 };
    const idle = { written: 0, calls: 0 };
    const dream = this.#config.memory.dream;
    if (!dream.enabled || owner !== ASSISTANT_MEMORY_OWNER) return idle;
    if (!dream.slots.includes('recall')) return idle;

    // The newest frames, for the reason `#recallSlot` gives: a writer that
    // reads the oldest slice of a full store writes candidates for a day
    // weeks gone (S3).
    const entries = this.#store
      .framesFor(owner, { limit: DREAM_POOL_LIMIT, newest: true })
      .filter((entry) => entry.trace.sleepRunId !== runId);
    // The writer reads the TRAINING half and nothing else. A proposal
    // written out of holdout traces is a proposal measured on evidence the
    // search has already seen, and the one interval that will be read would
    // stop being the one interval nobody looked at (E4/6.2).
    const pool = splitPool(entries, DEFAULT_SPLIT_RATES).train;
    if (!pool.length) return idle;

    const incumbent = resolvePolicy(this.#store, this.#config, owner, 'recall');
    const box = pool[pool.length - 1]!.frame.box;
    const aggregates = aggregateCases(pool, this.#gainsFor(pool, owner), incumbent);
    // Nothing went wrong that a parameter set could have fixed, so nothing
    // is asked of a model.
    if (!aggregates.cases) return idle;

    const proposal = await proposeCandidates(
      provider,
      {
        aggregates,
        box,
        incumbent,
        count: Math.min(Math.max(0, Math.round(dream.candidates)), budget),
        model: dream.model.trim() || undefined,
        effort: dream.effort,
      },
      signal,
    );

    const parentId = this.#store.activePolicy(owner, 'recall')?.id;
    for (const candidate of proposal.candidates) {
      this.#store.createPolicyVersion({
        owner,
        slot: 'recall',
        params: paramsOf(candidate, incumbent),
        box: box as unknown as Record<string, unknown>,
        origin: 'dream',
        parentId,
        sleepRunId: runId,
        // Numbers and this file's vocabulary, never a word out of the frames
        // it was written from: a version row outlives every one of them
        // (E19/S21).
        rationale:
          'proposal cases=' + aggregates.cases +
          ' scored=' + aggregates.scored +
          ' missed=' + aggregates.missedRows.toFixed(2) +
          ' budget-cut=' + aggregates.budgetCutShare.toFixed(3) +
          ' hop2=' + aggregates.hop2Share.toFixed(3),
      });
    }
    this.#log.info('The dream wrote candidates', {
      owner,
      cases: aggregates.cases,
      calls: proposal.calls,
      written: proposal.candidates.length,
      failures: proposal.failures,
      rejected: proposal.rejected,
    });
    return { written: proposal.candidates.length, calls: proposal.calls };
  }

  /** `gain(m)` per turn over a pool, read once and folded per turn (4.1). */
  #gainsFor(entries: readonly FrameEntry[], owner: string): (turnId: string) => GainFunction {
    const byTurn = new Map<string, DreamLabel[]>();
    for (const label of this.#labelsFor(entries, owner)) {
      const bucket = byTurn.get(label.turnId);
      if (bucket) bucket.push(label);
      else byTurn.set(label.turnId, [label]);
    }
    const cache = new Map<string, GainFunction>();
    return (turnId: string): GainFunction => {
      const known = cache.get(turnId);
      if (known) return known;
      // `gainFrom` is what refuses a session-wide label and a `review` row a
      // gain, so no caller here has to remember to (S3/S8).
      const gain = gainFrom(byTurn.get(turnId) ?? []).gain;
      cache.set(turnId, gain);
      return gain;
    };
  }

  /**
   * Every label behind a pool: the turn-scoped ones that can carry a gain,
   * and the session-scoped ones that cannot but still count for the
   * agreement sensor and the coverage rate (4.4/5.5b). Read in batches, so a
   * pool of five hundred frames cannot walk into SQLite's bound-parameter
   * limit, and owner-filtered in SQL the way 10.5 asks.
   */
  #labelsFor(entries: readonly FrameEntry[], owner: string): DreamLabel[] {
    const turnIds = [...new Set(entries.map((entry) => entry.trace.turnId))];
    const sessionIds = [
      ...new Set(entries.map((entry) => entry.trace.sessionId).filter((id): id is string => !!id)),
    ];
    const labels: DreamLabel[] = [];
    for (let index = 0; index < turnIds.length; index += LABEL_BATCH) {
      labels.push(...this.#store.labelsForTurns(turnIds.slice(index, index + LABEL_BATCH), owner));
    }
    for (let index = 0; index < sessionIds.length; index += LABEL_BATCH) {
      labels.push(
        ...this.#store.labelsForSessions(sessionIds.slice(index, index + LABEL_BATCH), owner),
      );
    }
    return labels;
  }

  /**
   * The proposals a previous night wrote and nothing has measured yet.
   *
   * The discriminator is `replayScore`: a version that carries one has had
   * its night, and one that was promoted or retired is not on offer. Nothing
   * else is needed, because a measured candidate gets its replay numbers
   * written onto its row in the same breath as its evaluation.
   */
  #proposals(
    owner: string,
    slot: DreamSlot,
    incumbent: RecallPolicy,
    limit: number,
  ): { version: PolicyVersion; policy: RecallPolicy }[] {
    const wanted = Math.max(0, Math.round(limit));
    if (!wanted) return [];
    const out: { version: PolicyVersion; policy: RecallPolicy }[] = [];
    for (const version of this.#store.policyHistory(owner, slot, PROPOSAL_WINDOW)) {
      if (version.origin !== 'dream' || version.promotedAt || version.retiredAt) continue;
      if (version.replayScore !== undefined) continue;
      // A row nobody can read back into a policy point is not a candidate.
      const policy = policyFromParams(version.params, incumbent);
      if (!policy) continue;
      out.push({ version, policy });
      if (out.length >= wanted) break;
    }
    return out;
  }

  /**
   * One `dream_evals` row out of one finished evaluation (concept 8.6).
   *
   * Written out field by field rather than spread: `DreamEvalResult` also
   * carries the certificate (`valid`, `violations`, `error`) and the paired
   * counts, and those belong to the decision, not to the row.
   */
  #recordEval(
    result: DreamEvalResult,
    policyId: string,
    sleepRunId: string,
    promoted: boolean,
  ): DreamEval {
    return this.#store.recordDreamEval({
      sleepRunId,
      policyId,
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
      auditDelta: result.auditDelta,
      auditCiLow: result.auditCiLow,
      deltaLive: result.deltaLive,
      signAgree: result.signAgree,
      evalMs: result.evalMs,
      traceSetHash: result.traceSetHash,
      evidenceDigest: result.evidenceDigest ?? renderEvidenceDigest(result),
      promoted,
      detail: result.detail,
    });
  }

  /**
   * From the corrections this replay wrote to the labels they prove
   * (concept 4.2a, step 2).
   *
   * The pass runs once, after every session has been read, because
   * `addCorrection` hands no id back and a label's evidence is the
   * correction's id - so the rows are read back out of the table, which is
   * also where the turn reference the write already put on them lives.
   *
   * Two refusals are built in. A located turn whose frame was never recorded
   * (`dream.frameRate` frames a quarter of the sessions) has no reachable
   * set of its own, so its label goes out session-wide rather than claiming
   * a turn over a union of other turns' rows. And an unlocatable quote is
   * anchored at the session's start, which is no later than any of its turns
   * and therefore the conservative side of the anachronism lock (S4).
   */
  writeCorrectionLabels(
    owner: string,
    sessions: readonly Session[],
    since: number,
  ): { labelled: number; labels: number; failed: number } {
    const idle = { labelled: 0, labels: 0, failed: 0 };
    if (!this.#config.memory.dream.enabled || !sessions.length) return idle;
    try {
      return this.#correctionLabelPass(owner, sessions, since);
    } catch (cause) {
      // The dream never turns a degraded path into an error (10.5). One
      // unreadable frame payload, or a store that refuses the write, used to
      // throw all the way into the night's outer catch - which ends the run
      // failed and skips `recountEntities` AND every retention sweep behind
      // it, so the verbatim frame store outlives its window for exactly the
      // reason the dream must never cause (10.4, 8.7). It costs its labels
      // and nothing else.
      this.#log.warn('Writing correction labels failed', {
        owner,
        error: (cause as Error).message,
      });
      return { labelled: 0, labels: 0, failed: 1 };
    }
  }

  /** The body of `writeCorrectionLabels`, inside its caller's catch. */
  #correctionLabelPass(
    owner: string,
    sessions: readonly Session[],
    since: number,
  ): { labelled: number; labels: number; failed: number } {
    const idle = { labelled: 0, labels: 0, failed: 0 };
    const rows = this.#store.correctionsSince(owner, since);
    if (!rows.length) return idle;

    const bySession = new Map(sessions.map((session) => [session.id, session] as const));
    const frames = this.#framesBySession(owner, sessions);
    const threshold = this.#config.memory.gate.duplicateThreshold;
    const now = Date.now();
    const labels: DreamLabel[] = [];
    let labelled = 0;

    for (const row of rows) {
      const session = row.sessionId ? bySession.get(row.sessionId) : undefined;
      if (!session) continue;
      const pool = frames.get(session.id) ?? [];
      if (!pool.length) continue;

      const anchored = row.turnId
        ? pool.find((entry) => entry.trace.turnId === row.turnId)
        : undefined;
      const scope = anchored ? [anchored] : pool;
      const reachable = new Map<string, { id: string; content: string; createdAt: number }>();
      const prompted = new Set<string>();
      for (const entry of scope) {
        for (const record of Object.values(entry.frame.payload.records)) {
          reachable.set(record.id, record);
        }
        for (const id of promptedOf(entry)) prompted.add(id);
      }

      const made = correctionLabels({
        text: row.text,
        owner,
        sessionId: session.id,
        turn: anchored && row.turnId ? { id: row.turnId, startedAt: anchored.trace.startedAt } : null,
        sessionStartedAt: session.createdAt,
        reachable: [...reachable.values()],
        prompted: [...prompted],
        // The same arithmetic the write gate already owns; passed in,
        // because `label.ts` reads no config.
        duplicateThreshold: threshold,
        evidence: row.id,
        now,
      });
      if (made.length) labelled += 1;
      labels.push(...made);
    }

    return { labelled, labels: this.#store.putLabels(labels), failed: 0 };
  }

  /**
   * The `merge` labels of one condensation pass (concept 4.2c, S7).
   *
   * The claim is narrow and it only points one way: if two rows stood in ONE
   * prompt and later fell into the same condensation cluster, the
   * worse-placed of the two is proven redundant. Redundant is not
   * "irrelevant to this question", so no positive label can come out of this
   * source and none is written.
   *
   * At most one `supersedes` hop, and it is the map this night filled that
   * enforces it: re-reading `superseded_by` off the bank would pick up
   * chains from earlier nights, and a label that walks that far has stopped
   * describing the prompt it observed. The pre-filter is what keeps this
   * cheap - a frame that never held two of tonight's victims cannot carry a
   * cluster, and replaying it would cost a pipeline run for nothing.
   */
  writeMergeLabels(
    owner: string,
    superseded: Map<string, string>,
  ): { labels: number; failed: number } {
    if (!this.#config.memory.dream.enabled || superseded.size < 2) {
      return { labels: 0, failed: 0 };
    }
    try {
      return { labels: this.#mergeLabelPass(owner, superseded), failed: 0 };
    } catch (cause) {
      // Its own failure, caught here for the reason `writeCorrectionLabels`
      // gives above: a label is worth a condensation, never a night (10.5).
      this.#log.warn('Writing merge labels failed', {
        owner,
        error: (cause as Error).message,
      });
      return { labels: 0, failed: 1 };
    }
  }

  /** The body of `writeMergeLabels`, inside its caller's catch. */
  #mergeLabelPass(owner: string, superseded: Map<string, string>): number {
    const now = Date.now();
    const labels: DreamLabel[] = [];
    // The newest frames, like every other reader that means "lately": an
    // owner past the cap would otherwise have its merge labels written only
    // against a slice of frames weeks older than the condensation they
    // describe (S3).
    for (const entry of this.#store.framesFor(owner, { limit: DREAM_POOL_LIMIT, newest: true })) {
      let held = 0;
      for (const id of Object.keys(entry.frame.payload.records)) {
        if (superseded.has(id)) held += 1;
      }
      if (held < 2) continue;
      const prompted = promptedOf(entry);
      if (prompted.length < 2) continue;
      labels.push(
        ...mergeLabels({
          owner,
          sessionId: entry.trace.sessionId,
          turnId: entry.trace.turnId,
          prompted,
          targets: prompted.map((id) => {
            const into = superseded.get(id);
            return into ? { id, supersededBy: into } : { id };
          }),
          now,
        }),
      );
    }
    return this.#store.putLabels(labels);
  }

  /** The frames of the replayed sessions, grouped by session. */
  #framesBySession(owner: string, sessions: readonly Session[]): Map<string, FrameEntry[]> {
    const map = new Map<string, FrameEntry[]>();
    if (!sessions.length) return map;
    const wanted = new Set(sessions.map((session) => session.id));
    // From the oldest replayed session onwards, not from the last night: a
    // conversation that began days ago has its early frames back there too.
    const since = Math.min(...sessions.map((session) => session.createdAt));
    for (const entry of this.#store.framesFor(owner, { since, limit: DREAM_POOL_LIMIT })) {
      const id = entry.trace.sessionId;
      if (!id || !wanted.has(id)) continue;
      const bucket = map.get(id);
      if (bucket) bucket.push(entry);
      else map.set(id, [entry]);
    }
    return map;
  }

  /**
   * What `correction` actually yielded tonight, and what the night says when
   * it is not enough (`dream.correctionPrecisionFloor`, concept 4.2a).
   *
   * Be exact about what this number is. The concept asks for the hand-judged
   * hit rate over at least fifty corrections, and no night can compute that.
   * What a night CAN observe without a model is the yield: the share of
   * admitted corrections that found any target at all. The two are not the
   * same quantity, and the asymmetry is what makes the yield worth reading -
   * a source that finds nothing cannot be precise about anything, so a yield
   * under the floor is reason enough to distrust `correction`, while a yield
   * over it proves nothing about precision.
   *
   * And when it falls short, the night SAYS so rather than carrying on
   * quietly. The named alternative is a model call per correction, which is
   * `dream.labelModelCalls` and is 0: the post exists in the report so that
   * turning it on is a decision somebody takes, not a default that arrives.
   */
  correctionPrecision(replayed: { corrections: number; labelled: number; labels: number }): string {
    const dream = this.#config.memory.dream;
    if (!dream.enabled || replayed.corrections <= 0) return '';
    const precision = replayed.labelled / replayed.corrections;
    this.#log.info('Correction labelling measured', {
      corrections: replayed.corrections,
      labelled: replayed.labelled,
      labels: replayed.labels,
      precision,
      floor: dream.correctionPrecisionFloor,
      modelCalls: dream.labelModelCalls,
    });
    if (precision >= dream.correctionPrecisionFloor) return '';
    return (
      ' Correction labelling reached ' + Math.round(precision * 100) + ' percent of ' +
      plural(replayed.corrections, 'correction', 'corrections') +
      ', below dream.correctionPrecisionFloor (' + dream.correctionPrecisionFloor +
      '): while it stays there, corrections are not a label source. The named alternative is a' +
      ' model call per correction (dream.labelModelCalls is ' + dream.labelModelCalls +
      '), and it is not built.'
    );
  }

  /**
   * The `budget` and `retry` slots, measured (concept 7.1, S24).
   *
   * `budget` is measured out of what this night actually spent per phase and
   * got back for it - `yieldRates` reports the observed rate WITH its
   * spread, labelled approximate, and a projection that would have to
   * extrapolate past the call counts anybody was ever seen spending abstains
   * instead of guessing. One night is one sample; the record accumulates in
   * the log, night by night, which is what a later stage would promote on.
   *
   * `retry` is not measured here and the reason is worth writing down: it
   * judges a realized sequence of attempts, and no attempt sequence reaches
   * this file. Those live on the assignment path, which is the organisation's
   * side of the house. `judgeRetry` is built and tested; its caller is not
   * the night.
   *
   * Neither slot is carried. `dream.slots` is what decides that, and this
   * stage has a promotion path for `recall` alone - so a `budget` in the
   * list changes exactly one thing today: this line says the night would
   * have carried it.
   */
  measureSlots(owner: string, spend: Record<NightPhase, { calls: number; value: number }>): void {
    const dream = this.#config.memory.dream;
    if (!dream.enabled) return;
    const rates = yieldRates(
      NIGHT_PHASES.map(
        (phase): BudgetRun => ({
          owner,
          phase,
          calls: spend[phase].calls,
          value: spend[phase].value,
        }),
      ),
    );
    if (!rates.length) return;
    this.#log.info('The night measured its own yield', {
      owner,
      wouldCarry: dream.slots.filter((slot) => slot !== 'recall').join(',') || 'nothing',
      rates: rates.map((rate) => ({
        phase: rate.phase,
        perCall: rate.meanPerCall,
        low: rate.low,
        high: rate.high,
        calls: rate.callsRange,
        samples: rate.samples,
        approximated: rate.approximated,
      })),
    });
  }

  /**
   * What is left of the run-global dream wallet (concept 9.4).
   *
   * A window opens with the first query of a night and closes
   * `DREAM_NIGHT_WINDOW_MS` after it opened. That is what "one night" has to
   * mean for a process with no calendar: the runtime runs the due banks in
   * one sequential loop, so every one of them draws on the same wallet, and
   * a night a day later starts with a full one.
   */
  remainingCalls(): number {
    const ceiling = Math.max(0, Math.round(this.#config.memory.dream.maxCallsPerNight));
    return Math.max(0, ceiling - this.#openWallet().spent);
  }

  /** Book model calls against that wallet, spent or wasted. */
  bookCalls(calls: number): void {
    if (calls <= 0) return;
    this.#openWallet().spent += calls;
  }

  /** The wallet of the night in progress; a night that has run its course gets a fresh one. */
  #openWallet(): { since: number; spent: number } {
    const now = Date.now();
    if (now - this.#wallet.since > DREAM_NIGHT_WINDOW_MS) this.#wallet = { since: now, spent: 0 };
    return this.#wallet;
  }
}
