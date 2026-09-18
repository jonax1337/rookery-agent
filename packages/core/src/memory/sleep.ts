import { EventEmitter } from 'node:events';
import {
  ASSISTANT_MEMORY_OWNER,
  type AbstainReason,
  type AgentEvent,
  type CronTrigger,
  type DreamEval,
  type DreamLabel,
  type DreamSlot,
  type EntityKind,
  type MemoryKind,
  type MemoryRecord,
  type MemoryRelation,
  type PolicyVersion,
  type Provider,
  type ProviderId,
  type RecallBox,
  type RecallPolicy,
  type RookeryConfig,
  type Session,
  type SleepRun,
  type SleepStage,
  type ToolServerAudience,
} from '../types.js';
import { silentLogger, type Logger } from '../logger.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { entitySlug, type Store } from './store.js';
import { parseCandidates, smallModelFor } from './extractor.js';
import { admitCandidates, confirmedBy, linkEntities, normalizeTokens, similarity } from './gate.js';
import { MEMORY_KINDS, recall } from './recall.js';
import { admit, type AdmissionResult } from './dream/admission.js';
import {
  buildAggregates,
  proposeCandidates,
  withIncumbent,
  type CandidateAggregates,
  type ComponentMeans,
} from './dream/candidate.js';
import {
  DEFAULT_SPLIT_RATES,
  agreementReport,
  renderEvidenceDigest,
  selectOnTraining,
  splitPool,
  type AgreementReport,
  type DreamEvalResult,
  type FrameEntry,
} from './dream/evaluate.js';
import { gainFrom, correctionLabels, locateTurn, mergeLabels } from './dream/label.js';
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
import { pipelineAgent, pipelineAssistant, type FrameScoringPolicy } from './dream/score.js';
import { NIGHT_PHASES, yieldRates, type BudgetRun, type NightPhase } from './dream/slots.js';
import { SkillStore, skillSlug } from '../skills/store.js';

/**
 * Sleep: what the memory does when nobody is talking to it.
 *
 * A bank that only ever grows is an archive, not a memory. During the day
 * the gate keeps duplicates out, but it cannot decide whether two sentences
 * that are merely related should become one, whether an old fact has been
 * overtaken, or what a week of small observations adds up to. Those are
 * judgements, they need a model, and they are far too slow and too risky to
 * make while somebody is waiting for an answer. So they happen at night.
 *
 * A night is not one uniform chore. It opens by going back over the day, then
 * runs in cycles of three stages, the way sleep actually does:
 *
 *   replay- the day's conversations, read again and properly this time. The
 *           per-turn extractor sees one exchange through a small model; this
 *           sees whole conversations through a good one, and it runs once,
 *           before the cycles, so what it harvests is condensed tonight
 *           rather than waiting a day for it.
 *   light - bookkeeping. Weak, unused, unprotected memories fall asleep;
 *           entity counts are brought up to date. No model, no cost.
 *   deep  - filing. What says the same thing becomes one sentence, and what
 *           cannot both be true gets DECIDED: one side holds, the other is
 *           filed away. This is where the bank actually gets smaller.
 *   rem   - the loose, associative part. Links across distant subjects, and
 *           the conclusions that only surface once the noise is gone.
 *
 * The cycle repeats (two by default) because the stages feed each other: rem
 * finds the contradictions that the next deep stage settles, and deep leaves
 * a tidier bank for the next rem to connect. Budgets are front-loaded for
 * deep work and back-loaded for dreaming, which is roughly how a real night
 * distributes them.
 *
 * Three rules hold everywhere in this file, and they are what make an
 * unattended process that rewrites memory acceptable at all:
 *
 *   - Nothing is ever deleted. Memories go dormant: out of recall, still in
 *     the table, still visible, one click from coming back. Deciding a
 *     contradiction files the losing side away; it does not erase it.
 *   - Everything a run writes carries the run id, so a whole night can be
 *     rolled back in one transaction.
 *   - What the user wrote or pinned is never touched. It may gain edges; it
 *     is never merged away and never put to sleep. In a contradiction it
 *     wins by default, without asking a model.
 */

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

export interface SleepRunnerOptions {
  store: Store;
  registry: ProviderRegistry;
  config: RookeryConfig;
  logger?: Logger;
  /**
   * Told about every promotion the night applies (S26). Optional on purpose:
   * a `SleepRunner` built without one - every test, the CLI - promotes
   * exactly the same way and simply tells nobody.
   */
  onPromotion?: PromotionHook;
}

export interface SleepInput {
  /** Whose bank sleeps. Defaults to the assistant's. */
  owner?: string;
  trigger?: CronTrigger;
  /** Provider for the small-model calls; the config default otherwise. */
  provider?: ProviderId;
  signal?: AbortSignal;
}

/** A group of memories the night will look at together. */
interface Cluster {
  members: MemoryRecord[];
  /** Why they were grouped, for the log. */
  reason: 'gate' | 'entities';
}

/**
 * The counters the dream phases move, as the run's own tally holds them.
 * Narrower than `SleepRun` on purpose: these are the only ones a dream
 * method may touch, and the type is what says so.
 */
interface NightCounters {
  dreamTracesSeen: number;
  dreamFramesScored: number;
  dreamCandidates: number;
  dreamPromoted: number;
  dreamLabelsWritten: number;
  modelCalls: number;
}

export class SleepRunner extends EventEmitter {
  readonly #store: Store;
  readonly #registry: ProviderRegistry;
  readonly #config: RookeryConfig;
  readonly #log: Logger;
  readonly #onPromotion?: PromotionHook;
  /** One night at a time per bank. */
  readonly #running = new Map<string, AbortController>();
  /**
   * The run-global dream wallet (concept 9.4). With `sleep.scope: 'all'` the
   * runtime runs one night per owner, sequentially, in one loop - so a
   * per-run ceiling would multiply the candidate calls by the number of
   * banks. This counter spans those runs: a window opens with the first
   * dream call and closes after `DREAM_NIGHT_WINDOW_MS` of quiet, which is
   * what "one night" means for a process that has no calendar.
   */
  #dreamCalls = { since: 0, spent: 0 };

  constructor(options: SleepRunnerOptions) {
    super();
    this.#store = options.store;
    this.#registry = options.registry;
    this.#config = options.config;
    this.#log = options.logger ?? silentLogger;
    this.#onPromotion = options.onPromotion;
  }

  isRunning(owner = ASSISTANT_MEMORY_OWNER): boolean {
    return this.#running.has(owner);
  }

  get activeOwners(): string[] {
    return [...this.#running.keys()];
  }

  /** Abort a night in progress. The phases already finished stay done. */
  cancel(owner = ASSISTANT_MEMORY_OWNER): boolean {
    const controller = this.#running.get(owner);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /**
   * Which banks are due tonight. The assistant sleeps every night; an agent
   * only once it has actually learned something since the last time, so ten
   * agents do not mean ten nights of model calls for nothing.
   */
  dueOwners(): string[] {
    const sleep = this.#config.memory.sleep;
    const owners = [ASSISTANT_MEMORY_OWNER];
    if (sleep.scope !== 'all') return owners;
    for (const row of this.#store.memoryOwners()) {
      if (row.owner === ASSISTANT_MEMORY_OWNER) continue;
      const since = this.#store.lastSleepAt(row.owner);
      if (row.newest <= since) continue;
      const fresh = this.#store.listMemories({
        owner: row.owner,
        since: since || undefined,
        limit: 500,
      }).length;
      if (fresh >= sleep.agentThreshold) owners.push(row.owner);
    }
    return owners;
  }

  /**
   * Roll back one night.
   *
   * The bank is the store's job and it does that part atomically. The skills
   * cannot join that transaction - they are files - so they are put back
   * afterwards, from the snapshots the run took before it wrote over them. A
   * snapshot with no content means the skill did not exist that evening, so
   * undoing its creation deletes the folder again.
   *
   * Order matters: the memories go back first. If restoring a file then
   * fails, the bank is already consistent and the skill is the only thing
   * left standing - the opposite order would leave a skill pointing at
   * memories that no longer say what it was rewritten for.
   *
   * `policies` is the night's promotions, demoted inside the store's own
   * transaction (10.4) rather than here: a parameter set that went in force
   * tonight has to come out of force in the same breath as the memories it
   * was measured on. What no undo reaches is the counters - `access_count`
   * and `usefulness` are monotone and carry no history, so the honest
   * sentence stays "reversible in parameters, not in counters" (E11).
   */
  undo(
    runId: string,
  ): { woken: number; removed: number; edges: number; policies: number; skills: number } | null {
    const result = this.#store.undoSleepRun(runId);
    if (!result) return null;

    let skills = 0;
    const store = new SkillStore(this.#config.skillsDir);
    const seen = new Set<string>();
    // Oldest snapshot per name: the state as it stood before the night began,
    // even if one run both wrote and later revised the same skill.
    for (const version of this.#store.skillVersionsForRun(runId)) {
      if (seen.has(version.skill)) continue;
      seen.add(version.skill);
      try {
        if (store.restore(version.skill, version.content)) skills += 1;
      } catch (cause) {
        this.#log.warn('Could not put a skill back', { skill: version.skill, error: (cause as Error).message });
      }
    }

    const run = this.#store.getSleepRun(runId);
    if (run) this.#announce(run, 'undone');
    this.#log.info('Sleep run undone', { run: runId, ...result, skills });
    return { ...result, skills };
  }

  /**
   * One night on one bank. Never throws: a failed phase is recorded on the
   * run and the remaining phases are skipped, but everything earlier stays.
   */
  async run(input: SleepInput = {}): Promise<SleepRun> {
    const owner = input.owner ?? ASSISTANT_MEMORY_OWNER;
    if (this.#running.has(owner)) {
      const latest = this.#store.listSleepRuns({ owner, limit: 1 })[0];
      if (latest) return latest;
    }

    const controller = new AbortController();
    if (input.signal) {
      if (input.signal.aborted) controller.abort();
      else input.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    this.#running.set(owner, controller);

    const run = this.#store.createSleepRun({ owner, trigger: input.trigger ?? 'manual' });
    this.#announce(run, 'started');
    this.#log.info('Sleep started', { owner, run: run.id });

    const counters = {
      readCount: 0,
      replayedCount: 0,
      learnedCount: 0,
      mergedCount: 0,
      dormantCount: 0,
      edgeCount: 0,
      insightCount: 0,
      skillCount: 0,
      skillRevisedCount: 0,
      conflictCount: 0,
      resolvedCount: 0,
      // The dream counters (fifth of the six places in step): initialised
      // here or `counters.dreamFramesScored` is a type error before anything
      // ever increments it. `dreamCandidates` stays 0 in stage 1 - its writer
      // is the Phase 3 candidate counter, and the column must not quietly
      // change meaning before then.
      dreamTracesSeen: 0,
      dreamFramesScored: 0,
      dreamCandidates: 0,
      // Stage 2's two: what the label writers wrote tonight, and whether a
      // parameter set went in force. Both are 0 with `dream.enabled` off,
      // because with it off nothing that could move them ever runs.
      dreamPromoted: 0,
      dreamLabelsWritten: 0,
      modelCalls: 0,
    };
    /**
     * Calls and payoff per phase, as this night actually spent them - the
     * raw material of the `budget` slot (concept 7.1). Measured every night,
     * carried only when `dream.slots` says so.
     */
    const spend: Record<NightPhase, { calls: number; value: number }> = {
      condense: { calls: 0, value: 0 },
      resolve: { calls: 0, value: 0 },
      link: { calls: 0, value: 0 },
      reflect: { calls: 0, value: 0 },
      revise: { calls: 0, value: 0 },
      practise: { calls: 0, value: 0 },
    };
    let error: string | undefined;
    // The one dream line the stored report carries beyond describeSleep:
    // the import/reindex invalidation notice, whose numbers live only in the
    // probe result (concept 3.3).
    let dreamReportSuffix = '';
    // Label passes that failed and were skipped instead of ending the night
    // (10.5). Counted here because both writers sit inside phases that must
    // go on without them.
    let labelFailures = 0;

    try {
      const providerId = await this.#resolveProvider(input.provider);
      const settings = this.#config.memory.sleep;
      const cycles = Math.max(1, Math.min(Math.round(settings.cycles), 5));
      const provider = providerId ? this.#registry.get(providerId) : null;
      const model = providerId ? settings.model.trim() || smallModelFor(providerId) : undefined;
      const insightModel = settings.insightModel.trim() || model;
      const live = this.#store.liveMemories(owner);
      counters.readCount = live.length;

      if (!provider) {
        this.#log.warn('Sleep ran without a provider; only light sleep happened', { owner });
      }

      // The replay list is measured first, because the read has to happen
      // before anything else: what the night harvests there should be
      // condensed tonight, not tomorrow.
      let budgets: NightBudgets | null = null;
      let replaySessions: Session[] = [];
      if (provider) {
        replaySessions = owner === ASSISTANT_MEMORY_OWNER ? this.#replayCandidates(owner) : [];
      }

      /* ---- replay: the day, read again and properly. Before the cycles ----
         ---- so tonight's harvest is condensed tonight, not tomorrow.   ---- */
      if (provider) {
        this.#phase(run.id, 'replay', counters, 1);
        const replayed = await this.#replay(
          provider,
          smallModelFor(providerId as ProviderId),
          model,
          owner,
          run.id,
          replaySessions,
          controller.signal,
        );
        counters.replayedCount += replayed.read;
        counters.learnedCount += replayed.learned;
        counters.modelCalls += replayed.calls;
        counters.dreamLabelsWritten += replayed.labels;
        labelFailures += replayed.labelFailures;
        dreamReportSuffix += this.#correctionPrecision(replayed);
        // The bank changed, so the figure the run reports as "looked at" has
        // to be taken after the harvest, not before it.
        counters.readCount = this.#store.liveMemories(owner).length;
        this.#phase(run.id, 'replay', counters, 1);
        this.#throwIfAborted(controller.signal);
      }

      // The night's wallet is filled by need, not by the clock, and it is
      // filled HERE - after the replay, not before it. The re-read grows the
      // bank, surfaces contradictions and pulls corrections out of the day's
      // words, and that is precisely the work the later phases exist to do;
      // a budget measured before the read funds the night for a quieter day
      // than the one it just had. The arithmetic is database-only, but it is
      // not free: #demand clusters the living bank pair by pair, and the
      // dream probe below reads and scores every stored frame. Both carry
      // their own ceilings (#demand's phase budgets, the probe's
      // dream.maxEvalMs), so "measures itself" means "costs up to a declared
      // bound", never "costs nothing".
      if (provider) {
        const demand = this.#demand(owner, this.#store.liveMemories(owner));
        budgets = allocateNightBudget(
          demand,
          settings.nightBudget,
          {
            condense: settings.maxMergeCalls,
            resolve: settings.maxResolveCalls,
            link: settings.maxLinkCalls,
            reflect: settings.insights > 0 ? 2 : 0,
            revise: settings.skillRevisions,
            practise: settings.skills,
          },
        );
        this.#log.info('Night measured', { owner, demand, budgets });
      }

      /* ---- the dream: the measurement of the retrieval policy, and the ----
         ---- one place a parameter set can go in force. Wedged here on    ----
         ---- purpose: BEFORE the cycle loop (R7), so that the freshness    ----
         ---- side sees the bank the day left rather than the supersessions ----
         ---- #condense is about to write, and ABOVE the provider guard     ----
         ---- inside the loop (R8), so the whole of it also runs in a night ----
         ---- without a provider - the one night where it is the only thing ----
         ---- that could run at all. Stage 2 dreams for the assistant's     ----
         ---- bank only (R18); agent frames would be cost without a night   ----
         ---- that ever scores them.                                       ---- */
      const dreamSettings = this.#config.memory.dream;
      dreamReportSuffix += await this.#dream(owner, run.id, counters, controller.signal);

      for (let cycle = 1; cycle <= cycles; cycle += 1) {
        /* -------- light sleep: bookkeeping, no model, costs nothing -------- */
        this.#phase(run.id, 'light', counters, cycle);
        if (cycle === 1) {
          // Catch up anything written before the graph existed: its tags are
          // there, its entities are not. Pure bookkeeping, no model call.
          const orphans = this.#store.memoriesWithoutEntities(owner);
          for (const memory of orphans) linkEntities(this.#store, owner, memory.id, memory.tags);
          if (orphans.length) {
            this.#log.info('Attached entities to memories that had none', { owner, count: orphans.length });
          }
          counters.dormantCount += this.#decay(run.id, this.#store.liveMemories(owner));
        }
        this.#store.recountEntities(owner);
        this.#throwIfAborted(controller.signal);
        if (!provider || !budgets) continue;

        /* ---- deep sleep: filing. What repeats becomes one, what cannot ----
           ---- both be true gets decided.                                ---- */
        this.#phase(run.id, 'deep', counters, cycle);
        const clusters = this.#cluster(owner, this.#store.liveMemories(owner));
        const condensed = await this.#condense(
          provider,
          model,
          owner,
          run.id,
          clusters,
          controller.signal,
          share(budgets.condense, cycles, cycle, 'early'),
        );
        counters.mergedCount += condensed.merged;
        counters.dormantCount += condensed.retired;
        counters.modelCalls += condensed.calls;
        counters.dreamLabelsWritten += condensed.labels;
        labelFailures += condensed.labelFailures;
        spend.condense.calls += condensed.calls;
        spend.condense.value += condensed.merged;

        // Contradictions the previous cycle (or an earlier night) turned up.
        const settled = await this.#resolve(
          provider,
          model,
          owner,
          run.id,
          controller.signal,
          share(budgets.resolve, cycles, cycle, 'late'),
        );
        counters.resolvedCount += settled.resolved;
        counters.dormantCount += settled.retired;
        counters.mergedCount += settled.merged;
        counters.modelCalls += settled.calls;
        spend.resolve.calls += settled.calls;
        spend.resolve.value += settled.resolved;
        this.#phase(run.id, 'deep', counters, cycle);
        this.#throwIfAborted(controller.signal);

        /* ---- dream sleep: the loose, associative part. Connections ----
           ---- across distance, and what the week adds up to.        ---- */
        this.#phase(run.id, 'rem', counters, cycle);
        const linked = await this.#link(
          provider,
          model,
          owner,
          run.id,
          controller.signal,
          share(budgets.link, cycles, cycle, 'late'),
        );
        counters.edgeCount += linked.edges;
        counters.conflictCount += linked.conflicts;
        counters.modelCalls += linked.calls;
        spend.link.calls += linked.calls;
        spend.link.value += linked.edges;

        // Insights come last, once the bank is as tidy as it will get tonight.
        if (cycle === cycles) {
          const insight = await this.#reflect(
            provider,
            insightModel,
            owner,
            run.id,
            controller.signal,
            budgets.reflect,
          );
          counters.insightCount += insight.written;
          counters.edgeCount += insight.edges;
          counters.modelCalls += insight.calls;
          spend.reflect.calls += insight.calls;
          spend.reflect.value += insight.written;

          /* ---- the candidate writer (concept 6.2, 9.4). Here, and not ----
             ---- earlier: the order is deliberate - first it has to be    ----
             ---- settled how well the search control works, then          ----
             ---- procedures get rewritten. Its wallet is run-global       ----
             ---- (`dream.maxCallsPerNight` across ALL owners), because    ----
             ---- with `sleep.scope: 'all'` the runtime runs one night per ----
             ---- bank and a per-run ceiling would multiply by the owner   ----
             ---- count. What it writes are proposals, not policies: the   ----
             ---- night that measures them is the next one, above the      ----
             ---- provider guard, which is what keeps the promotion path   ----
             ---- model-free.                                              ---- */
          const proposed = await this.#propose(
            provider,
            owner,
            run.id,
            controller.signal,
            this.#dreamBudget(),
          );
          counters.dreamCandidates += proposed.written;
          counters.modelCalls += proposed.calls;
          this.#spendDreamCalls(proposed.calls);

          // And after the insights, the two steps that leave something behind
          // outside the bank. Repair comes first on purpose: a procedure that
          // has gone stale is actively misleading whoever opens it next,
          // which is worth more than a ninth procedure nobody asked for.
          const revised = await this.#revise(
            provider,
            insightModel,
            owner,
            run.id,
            controller.signal,
            budgets.revise,
          );
          counters.skillRevisedCount += revised.written;
          counters.modelCalls += revised.calls;
          spend.revise.calls += revised.calls;
          spend.revise.value += revised.written;

          const practised = await this.#practise(
            provider,
            insightModel,
            owner,
            run.id,
            controller.signal,
            budgets.practise,
          );
          counters.skillCount += practised.written;
          counters.modelCalls += practised.calls;
          spend.practise.calls += practised.calls;
          spend.practise.value += practised.written;
        }
        this.#phase(run.id, 'rem', counters, cycle);
        this.#throwIfAborted(controller.signal);
      }

      this.#store.recountEntities(owner);
      this.#measureSlots(owner, spend);
      if (labelFailures > 0) {
        // Said out loud rather than swallowed: the consolidation went on,
        // and the night is short of labels it expected to have.
        dreamReportSuffix +=
          ' ' + plural(labelFailures, 'label pass', 'label passes') +
          ' failed and left no labels; the consolidation went on.';
      }

      /* ---- the dream's two retention clocks (concept 8.7, S21). Frames ----
         ---- and the episode index go after `frameRetainDays`, because    ----
         ---- both point at verbatim text - a frame quotes the rows it     ----
         ---- froze, an episode points straight at journal steps. Traces,  ----
         ---- touches, labels and evaluations go after `retainDays`: they  ----
         ---- are small, they carry the calibration, and none of them      ----
         ---- holds a word anybody wrote. Every sweep runs in batches of   ----
         ---- 500 with its own transaction, so the one connection is never ----
         ---- locked for long. Hygiene, not measurement: this runs with    ----
         ---- the dream switched off too, because a verbatim store must    ----
         ---- not outlive its retention window just because measuring was  ----
         ---- turned off (R17).                                            ---- */
      const endedAt = Date.now();
      const frameBefore = endedAt - clampDays(dreamSettings.frameRetainDays) * 24 * 60 * 60 * 1000;
      const traceBefore = endedAt - clampDays(dreamSettings.retainDays) * 24 * 60 * 60 * 1000;
      this.#store.sweepDreamFrames(frameBefore);
      this.#store.sweepDreamEpisodes(frameBefore);
      this.#store.sweepDreamTraces(traceBefore);
      this.#store.sweepDreamLabels(traceBefore);
      this.#store.sweepDreamEvals(traceBefore);
    } catch (cause) {
      error = (cause as Error).message;
      this.#log.warn('Sleep phase failed', { owner, error });
    } finally {
      this.#running.delete(owner);
    }

    const finished = Date.now();
    const updated =
      this.#store.updateSleepRun(run.id, {
        ...counters,
        status: error ? 'failed' : 'done',
        finishedAt: finished,
        durationMs: finished - run.startedAt,
        report: describeSleep(counters) + dreamReportSuffix,
        error,
      }) ?? run;

    this.#announce(updated, 'finished');
    this.#log.info('Sleep finished', {
      owner,
      run: run.id,
      status: updated.status,
      merged: counters.mergedCount,
      dormant: counters.dormantCount,
      calls: counters.modelCalls,
    });
    return updated;
  }

  /* ------------------------------ phase 0 ------------------------------ */

  /**
   * How much work the night actually has, per phase, in model calls.
   *
   * Everything here is database arithmetic, but arithmetic is not free: the
   * condense demand clusters the living bank pair by pair, and the dream
   * probe that follows the wallet reads and scores every stored frame under
   * its own wall clock (`dream.maxEvalMs`). The numbers are ceilings on what
   * each phase may ask for, not promises: a phase that finds less work than
   * its budget simply stops early, exactly as before. The replay pass is
   * measured separately (`#replayCandidates`), because it runs before this
   * and changes what there is to measure.
   */
  #demand(owner: string, live: MemoryRecord[]): NightDemand {
    const settings = this.#config.memory.sleep;
    const since = this.#store.lastSleepAt(owner);

    const condense = this.#cluster(owner, live).length;
    const resolve = this.#openContradictions(owner).length;

    const fresh = this.#store
      .listMemories({ owner, since: since || undefined, limit: 150, includeDormant: false })
      .filter((memory) => !memory.supersededBy);
    // One link call reads up to 25 memories in one portion.
    const link = Math.ceil(fresh.length / 25);

    // Two passes over the same pool, on purpose: one looks for patterns in
    // the user, one in the work - neither prompt sees the other's angle.
    const week = Date.now() - settings.insightWindowDays * 24 * 60 * 60 * 1000;
    const reflect =
      settings.insights > 0 &&
      this.#store
        .listMemories({ owner, since: week, limit: 80, includeDormant: false })
        .filter((memory) => memory.kind !== 'insight').length >= 4
        ? 2
        : 0;

    const revise = this.#skillSuspects(owner).length;
    const practise = settings.skills > 0 && live.length >= 6 ? 1 : 0;

    return { condense, resolve, link, reflect, revise, practise };
  }

  /**
   * The conversations worth reading again tonight, oldest pending first.
   *
   * The scan reaches further back than one night on purpose: a machine that
   * was off for a few days, or a bank whose last night failed halfway,
   * should not silently drop what happened in between. The filter is the
   * same one the deep read applies - at least two real user turns - so the
   * demand number means "conversations that would actually be read".
   */
  #replayCandidates(owner: string): Session[] {
    const budget = this.#config.memory.sleep.replaySessions;
    if (budget <= 0 || owner !== ASSISTANT_MEMORY_OWNER) return [];
    const since = this.#store.lastSleepAt(owner);
    const candidates: Session[] = [];
    for (const session of this.#store.sessionsActiveSince(since, 150)) {
      const spoken = this.#store
        .getMessages(session.id)
        .filter((message) => message.role === 'user' && message.content.trim());
      // Nothing was said, or barely: "thanks" followed by "you're welcome"
      // holds nothing durable no matter how expensively it is read.
      if (spoken.length < 2) continue;
      candidates.push(session);
      if (candidates.length >= budget) break;
    }
    return candidates;
  }

  /** Contradiction pairs neither side of which has been settled yet. */
  #openContradictions(owner: string): { srcId: string; dstId: string }[] {
    return this.#store
      .listEdges(owner, 500)
      .filter((edge) => edge.relation === 'contradicts')
      .map((edge) => {
        const a = this.#store.getMemory(edge.srcId);
        const b = this.#store.getMemory(edge.dstId);
        return { edge, a, b };
      })
      .filter(
        (pair) =>
          pair.a && pair.b &&
          !pair.a.dormantAt && !pair.b.dormantAt &&
          !pair.a.forgotten && !pair.b.forgotten,
      )
      .map((pair) => ({ srcId: pair.edge.srcId, dstId: pair.edge.dstId }));
  }

  /**
   * Read the day again.
   *
   * Every conversation is already extracted from once, right after each turn -
   * by the smallest model available, at low effort, with both sides clipped to
   * four thousand characters, capped at three candidates. That pass sees one
   * exchange at a time and never the shape of a conversation, so whatever only
   * becomes visible across the whole of one is structurally invisible to it: a
   * preference mentioned in passing early and only acted on much later, a
   * decision that emerged rather than being stated, and above all a
   * correction.
   *
   * At night none of those constraints apply. There is no one waiting, so the
   * transcript can be read whole, by a model worth paying for.
   *
   * Cost is kept sane by not spending that model on everything. A cheap pass
   * sorts first - most conversations hold nothing durable at all, and finding
   * that out should cost a fraction of a cent, not a full analysis. Only what
   * survives triage gets read properly.
   *
   * The evidence rule is not relaxed here. The night must quote the user just
   * as the day does; a better model is allowed to find more, not to invent
   * more.
   *
   * And this is where the dream gets its best label (concept 4.2a). A
   * correction is the one source that can say something about a memory the
   * incumbent did NOT deliver, which is the single place the missing-label
   * bias does not reach - so every correction admitted here is located in the
   * transcript, written with its turn reference, and turned into labels
   * against the frames of that session. An ambiguous quote is never guessed
   * at: it lands session-wide, counts for the agreement check and the
   * calibration, and never for a gain (S3).
   */
  async #replay(
    provider: Provider,
    triageModel: string | undefined,
    deepModel: string | undefined,
    owner: string,
    runId: string,
    sessions: Session[],
    signal: AbortSignal,
  ): Promise<{
    read: number;
    learned: number;
    corrections: number;
    /** Corrections that yielded at least one label - the precision reader. */
    labelled: number;
    /** Label rows written; part of `sleep_runs.dream_labels_written`. */
    labels: number;
    /** Label passes that failed and were skipped rather than thrown (10.5). */
    labelFailures: number;
    calls: number;
  }> {
    const idle = {
      read: 0,
      learned: 0,
      corrections: 0,
      labelled: 0,
      labels: 0,
      labelFailures: 0,
      calls: 0,
    };
    // Corrections written from here on are this replay's, whatever else the
    // owner's table already holds - the label pass reads them back by id
    // afterwards, because `addCorrection` hands none out.
    const since = Date.now();
    // Only the assistant's own bank. An agent learns from its assignments,
    // which its controller already extracts from, and there is no user in
    // those transcripts to quote. The candidate list arrives pre-measured
    // from `#replayCandidates`, which applied the same two-turn filter the
    // budget was sized against.
    if (signal.aborted || owner !== ASSISTANT_MEMORY_OWNER || !sessions.length) return idle;

    let read = 0;
    let learned = 0;
    let corrections = 0;
    let calls = 0;

    for (const session of sessions) {
      if (signal.aborted) break;

      const messages = this.#store.getMessages(session.id).filter((message) => message.content.trim());
      const spoken = messages.filter((message) => message.role === 'user');
      // Nothing was said, or barely: no model needed to know there is nothing
      // durable in "thanks" followed by "you're welcome".
      if (spoken.length < 2) continue;

      const said = spoken.map((message) => message.content).join('\n');

      // Triage, on the user's turns alone and heavily clipped. The question is
      // only "is there anything here worth a proper look", and the assistant's
      // side cannot answer that - nothing it said may back a memory anyway.
      const verdict = await ask(
        provider,
        TRIAGE_PROMPT + '\n\nWHAT THE USER SAID:\n' +
          spoken.map((message) => '- ' + clipText(message.content, 220)).join('\n'),
        triageModel,
        signal,
      );
      calls += 1;
      if (parseObject(verdict)?.worth !== true) continue;

      const transcript = messages
        .map((message) => (message.role === 'user' ? 'USER: ' : 'ASSISTANT: ') + clipText(message.content, 2500))
        .join('\n\n');

      const raw = await ask(
        provider,
        REPLAY_PROMPT +
          '\n\nCURRENT DATE: ' + new Date().toISOString().slice(0, 10) +
          '\n\nALREADY KNOWN:\n' + this.#knownFor(owner, said) +
          '\n\nTHE CONVERSATION:\n' + clipText(transcript, 24000),
        deepModel,
        signal,
      );
      calls += 1;
      read += 1;

      const parsed = parseObject(raw);
      const candidates = parseCandidates(JSON.stringify(parsed?.memories ?? []));
      if (candidates.length) {
        const admitted = admitCandidates(this.#store, {
          candidates,
          owner,
          config: this.#config.memory,
          // The user's words only, exactly as during the day.
          sources: [said],
          sourceSessionId: session.id,
          sleepRunId: runId,
        });
        learned += admitted.stored.length;
        if (admitted.rejected.length) {
          this.#log.debug('Replay gate rejected candidates', {
            session: session.id,
            reasons: admitted.rejected.map((entry) => entry.reason).join(','),
          });
        }
      }

      for (const entry of Array.isArray(parsed?.corrections) ? parsed.corrections : []) {
        if (!entry || typeof entry !== 'object') continue;
        const row = entry as Record<string, unknown>;
        const text = typeof row.text === 'string' ? row.text.trim() : '';
        const quote = typeof row.quote === 'string' ? row.quote.trim() : '';
        // A correction has to be quotable too. "The user seemed unhappy" is
        // not a correction, it is a mood.
        if (text.length < 8 || !confirmedBy(quote, [said])) continue;
        // From the session reference to the turn reference (concept 4.2a,
        // step 1): exactly one user message carries the quote, or there is
        // no turn. `locateTurn` reads the same containment test that just
        // admitted the quote, so the two can never disagree.
        const located = locateTurn(messages, quote);
        this.#store.addCorrection({
          owner,
          text,
          quote,
          sessionId: session.id,
          ...(located.turnId ? { turnId: located.turnId } : {}),
        });
        corrections += 1;
      }

      this.#log.info('Replayed a conversation', {
        session: session.id,
        title: session.title,
        learned,
        corrections,
      });
    }

    // One pass over what the night just wrote, once every session is read:
    // the labels need the correction ids, and those only exist in the table.
    const written = this.#writeCorrectionLabels(owner, sessions, since);
    return {
      read,
      learned,
      corrections,
      labelled: written.labelled,
      labels: written.labels,
      labelFailures: written.failed,
      calls,
    };
  }

  /** What the extractor must not write again: whatever this talk touches. */
  #knownFor(owner: string, text: string): string {
    const matched = recall(this.#store, { text, owner, limit: 25, threshold: 0.05, touch: false, expand: false });
    if (!matched.length) return '(nothing yet)';
    return matched.map((memory) => '- ' + memory.content).join('\n');
  }

  /* ------------------------------ phase 1 ------------------------------ */

  /**
   * Let the weak and unused fall asleep.
   *
   * Strength blends what the memory claims to be worth with what it has
   * demonstrably been worth. A memory that keeps getting recalled survives a
   * low importance; one that nothing has ever asked for does not survive a
   * high one forever. Pure arithmetic, no model.
   */
  #decay(runId: string, live: MemoryRecord[]): number {
    const sleep = this.#config.memory.sleep;
    const now = Date.now();
    const cutoff = now - sleep.dormantAfterDays * 24 * 60 * 60 * 1000;
    let count = 0;

    for (const memory of live) {
      if (isProtected(memory)) continue;
      // Never put something to sleep that has not had a fair chance to be used.
      if (memory.createdAt > cutoff) continue;
      const lastTouch = memory.lastAccessedAt ?? memory.createdAt;
      if (lastTouch > cutoff) continue;
      const recency = Math.pow(0.5, (now - memory.updatedAt) / (30 * 24 * 60 * 60 * 1000));
      const strength = 0.5 * memory.importance + 0.3 * memory.usefulness + 0.2 * recency;
      if (strength >= sleep.minStrength) continue;
      this.#store.sleepMemory(memory.id, { runId });
      count += 1;
    }
    return count;
  }

  /* ------------------------------ phase 2 ------------------------------ */

  /**
   * Group what belongs together, without asking anyone.
   *
   * Two sources: pairs the write gate already flagged as similar-but-not-the
   * same, and pairs that share at least two entities. Union-find turns those
   * pairs into groups; groups of one are not groups, and anything over eight
   * is too big to judge in one call and gets cut.
   */
  #cluster(owner: string, live: MemoryRecord[]): Cluster[] {
    const byId = new Map(live.map((memory) => [memory.id, memory]));
    const parent = new Map<string, string>();
    for (const memory of live) parent.set(memory.id, memory.id);

    const find = (id: string): string => {
      let root = id;
      while (parent.get(root) && parent.get(root) !== root) root = parent.get(root)!;
      return root;
    };
    const union = (a: string, b: string): void => {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent.set(rootA, rootB);
    };

    const gatePairs = new Set<string>();

    // Pairs the gate marked during the day.
    for (const edge of this.#store.listEdges(owner, 2000)) {
      if (edge.relation !== 'co_occurs') continue;
      if (!byId.has(edge.srcId) || !byId.has(edge.dstId)) continue;
      union(edge.srcId, edge.dstId);
      gatePairs.add(edge.srcId);
    }

    // Pairs sharing at least two entities: same subject, said twice.
    const entitiesOf = new Map<string, Set<string>>();
    for (const memory of live) {
      entitiesOf.set(memory.id, new Set(this.#store.entitiesFor(memory.id).map((entity) => entity.id)));
    }
    for (let i = 0; i < live.length; i += 1) {
      for (let j = i + 1; j < live.length; j += 1) {
        const a = live[i]!;
        const b = live[j]!;
        const setA = entitiesOf.get(a.id)!;
        const setB = entitiesOf.get(b.id)!;
        if (setA.size < 2 || setB.size < 2) continue;
        let shared = 0;
        for (const id of setA) if (setB.has(id)) shared += 1;
        if (shared < 2) continue;
        union(a.id, b.id);
      }
    }

    const groups = new Map<string, MemoryRecord[]>();
    for (const memory of live) {
      const root = find(memory.id);
      const group = groups.get(root);
      if (group) group.push(memory);
      else groups.set(root, [memory]);
    }

    const clusters: Cluster[] = [];
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      // A cluster made only of protected memories has nothing the night may do.
      if (members.every(isProtected)) continue;
      clusters.push({
        members: members.slice(0, 8),
        reason: members.some((memory) => gatePairs.has(memory.id)) ? 'gate' : 'entities',
      });
    }
    // Biggest first: the largest pile is where condensing pays most.
    return clusters.sort((a, b) => b.members.length - a.members.length);
  }

  /* ------------------------------ phase 3 ------------------------------ */

  /** Fold each cluster into one sentence, or leave it alone. One call each. */
  async #condense(
    provider: Provider,
    model: string | undefined,
    owner: string,
    runId: string,
    clusters: Cluster[],
    signal: AbortSignal,
    budget: number,
  ): Promise<{
    merged: number;
    retired: number;
    calls: number;
    labels: number;
    /** Label passes that failed and were skipped rather than thrown (10.5). */
    labelFailures: number;
  }> {
    let merged = 0;
    let retired = 0;
    let calls = 0;
    /**
     * Victim id to the condensed row that took its place - the one hop the
     * `merge` label source is allowed to walk (concept 4.2c, S7). Collected
     * as they are written, never re-read off the bank afterwards: a second
     * query would pick up supersessions from earlier nights too, and a label
     * that walks that far has stopped describing the prompt it observed.
     */
    const superseded = new Map<string, string>();

    for (const cluster of clusters) {
      if (calls >= budget || signal.aborted) break;
      const numbered = cluster.members
        .map((memory, index) => {
          const date = new Date(memory.createdAt).toISOString().slice(0, 10);
          const lock = isProtected(memory) ? ' [protected]' : '';
          return (
            index + 1 + '. [' + memory.kind + ', ' + memory.importance.toFixed(2) + ', ' + date + ']' +
            lock + ' ' + memory.content
          );
        })
        .join('\n');

      const raw = await ask(provider, CONDENSE_PROMPT + '\n\nMEMORIES:\n' + numbered, model, signal);
      calls += 1;
      const parsed = parseObject(raw);
      if (!parsed || parsed.merge !== true) continue;

      const content = typeof parsed.content === 'string' ? parsed.content.trim() : '';
      if (content.length < 8 || content.length > 500) continue;

      const indices = Array.isArray(parsed.supersedes)
        ? parsed.supersedes
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value) && value >= 1 && value <= cluster.members.length)
        : [];
      const victims = [...new Set(indices)]
        .map((index) => cluster.members[index - 1]!)
        // Protected memories are named in the prompt so the model sees the
        // whole picture, but it may not retire them. This is the enforcement.
        .filter((memory) => !isProtected(memory));
      if (!victims.length) continue;

      // Replacing one memory with a near-identical one gains nothing and
      // costs its history.
      if (
        victims.length < 2 &&
        similarity(normalizeTokens(content), normalizeTokens(victims[0]!.content)) > 0.9
      ) {
        continue;
      }

      const kind: MemoryKind = MEMORY_KINDS.includes(parsed.kind as MemoryKind)
        ? (parsed.kind as MemoryKind)
        : 'summary';
      const importance = clamp01(
        typeof parsed.importance === 'number'
          ? parsed.importance
          : Math.max(...victims.map((memory) => memory.importance)),
      );
      const tags = [
        ...new Set([
          ...victims.flatMap((memory) => memory.tags),
          ...(Array.isArray(parsed.tags)
            ? parsed.tags.filter((tag): tag is string => typeof tag === 'string')
            : []),
        ]),
      ].slice(0, 8);

      const record = this.#store.upsertMemory({
        kind,
        content,
        tags,
        importance,
        owner,
        origin: 'sleep',
        sleepRunId: runId,
      });
      // The condensed memory inherits the entities of everything it replaces,
      // so the graph keeps its shape when the originals fall asleep.
      for (const victim of victims) {
        for (const entity of this.#store.entitiesFor(victim.id)) {
          this.#store.linkEntity(record.id, entity.id);
        }
        this.#store.addEdge({
          owner,
          srcId: record.id,
          dstId: victim.id,
          relation: 'supersedes',
          weight: 1,
          origin: 'sleep',
          runId,
        });
        this.#store.sleepMemory(victim.id, { runId, supersededBy: record.id });
        superseded.set(victim.id, record.id);
        retired += 1;
      }
      merged += 1;
    }

    const written = this.#writeMergeLabels(owner, superseded);
    return { merged, retired, calls, labels: written.labels, labelFailures: written.failed };
  }

  /* --------------------- deep sleep: the decision --------------------- */

  /**
   * Settle contradictions instead of only counting them.
   *
   * Two sentences that cannot both be true are not a curiosity, they are a
   * defect: whichever one the recall happens to surface, half the time the
   * assistant is wrong. So the night decides, and the losing side is filed
   * away - dormant, not erased, so a wrong call is one click from coming back
   * and the whole night stays undoable.
   *
   * Two cases never reach a model. If both sides are protected, the night
   * keeps its hands off and leaves it to the user. If exactly one side is
   * protected, that side wins: what the user wrote themselves outranks
   * anything an extraction inferred from a conversation.
   */
  async #resolve(
    provider: Provider,
    model: string | undefined,
    owner: string,
    runId: string,
    signal: AbortSignal,
    budget: number,
  ): Promise<{ resolved: number; retired: number; merged: number; calls: number }> {
    let resolved = 0;
    let retired = 0;
    let merged = 0;
    let calls = 0;

    const open = this.#store
      .listEdges(owner, 500)
      .filter((edge) => edge.relation === 'contradicts')
      .map((edge) => ({
        edge,
        a: this.#store.getMemory(edge.srcId),
        b: this.#store.getMemory(edge.dstId),
      }))
      // A pair with a sleeping side is already settled; skipping it is also
      // what stops the same contradiction being re-decided every night.
      .filter(
        (pair): pair is { edge: typeof pair.edge; a: MemoryRecord; b: MemoryRecord } =>
          Boolean(pair.a && pair.b) &&
          !pair.a!.dormantAt && !pair.b!.dormantAt &&
          !pair.a!.forgotten && !pair.b!.forgotten,
      );

    for (const { a, b } of open) {
      if (signal.aborted) break;

      // Both untouchable: the user has to sort this one out.
      if (isProtected(a) && isProtected(b)) continue;

      // Exactly one untouchable: it wins, and it costs nothing to know that.
      if (isProtected(a) || isProtected(b)) {
        const winner = isProtected(a) ? a : b;
        const loser = isProtected(a) ? b : a;
        this.#retire(owner, runId, loser, winner);
        resolved += 1;
        retired += 1;
        continue;
      }

      if (calls >= budget) break;
      const pair =
        '1. [' + a.kind + ', ' + new Date(a.createdAt).toISOString().slice(0, 10) + '] ' + a.content +
        '\n2. [' + b.kind + ', ' + new Date(b.createdAt).toISOString().slice(0, 10) + '] ' + b.content;
      const raw = await ask(provider, RESOLVE_PROMPT + '\n\nTHE TWO SENTENCES:\n' + pair, model, signal);
      calls += 1;
      const parsed = parseObject(raw);
      if (!parsed) continue;
      const decision = typeof parsed.decision === 'string' ? parsed.decision : '';

      if (decision === 'first' || decision === 'second') {
        const winner = decision === 'first' ? a : b;
        const loser = decision === 'first' ? b : a;
        this.#retire(owner, runId, loser, winner);
        resolved += 1;
        retired += 1;
        continue;
      }

      if (decision === 'merge') {
        const content = typeof parsed.content === 'string' ? parsed.content.trim() : '';
        if (content.length < 8 || content.length > 500) continue;
        const record = this.#store.upsertMemory({
          kind: a.kind,
          content,
          tags: [...new Set([...a.tags, ...b.tags])].slice(0, 8),
          importance: clamp01(Math.max(a.importance, b.importance)),
          owner,
          origin: 'sleep',
          sleepRunId: runId,
        });
        for (const loser of [a, b]) {
          for (const entity of this.#store.entitiesFor(loser.id)) {
            this.#store.linkEntity(record.id, entity.id);
          }
          this.#retire(owner, runId, loser, record);
          retired += 1;
        }
        resolved += 1;
        merged += 1;
        continue;
      }

      // "both": not a real contradiction after all. Drop the claim rather
      // than leaving a red line in the graph that says something untrue.
      if (decision === 'both') {
        const edge = this.#store
          .edgesFrom([a.id, b.id], ['contradicts'])
          .find((candidate) => candidate.dstId === b.id || candidate.dstId === a.id);
        if (edge) this.#store.deleteEdge(edge.id);
        resolved += 1;
      }
    }

    return { resolved, retired, merged, calls };
  }

  /** File one side of a settled pair away, with the trail that says why. */
  #retire(owner: string, runId: string, loser: MemoryRecord, winner: MemoryRecord): void {
    this.#store.addEdge({
      owner,
      srcId: winner.id,
      dstId: loser.id,
      relation: 'supersedes',
      weight: 1,
      origin: 'sleep',
      runId,
    });
    this.#store.sleepMemory(loser.id, { runId, supersededBy: winner.id });
  }

  /* ------------------------------ phase 4 ------------------------------ */

  /**
   * Draw the relations between what is new and what was already there, and
   * give the entities their proper kind. Contradictions are counted and
   * reported; deciding which side is right is the user's call, never the
   * night's.
   */
  async #link(
    provider: Provider,
    model: string | undefined,
    owner: string,
    runId: string,
    signal: AbortSignal,
    budget: number,
  ): Promise<{ edges: number; conflicts: number; calls: number }> {
    const since = this.#store.lastSleepAt(owner);
    const fresh = this.#store
      .listMemories({ owner, since: since || undefined, limit: 150, includeDormant: false })
      .filter((memory) => !memory.supersededBy);
    if (fresh.length < 2) return { edges: 0, conflicts: 0, calls: 0 };

    // Give the model the new memories plus the neighbours they might relate
    // to, so "contradicts" can actually be found rather than only guessed.
    const entityIds = [
      ...new Set(fresh.flatMap((memory) => this.#store.entitiesFor(memory.id).map((entity) => entity.id))),
    ];
    const neighbours = this.#store.memoriesForEntities(entityIds, {
      // The link table has no owner column, so a stray cross-owner link
      // would otherwise walk the night into another bank.
      owner,
      exclude: fresh.map((memory) => memory.id),
      limit: 40,
    });

    const pool = [...fresh, ...neighbours];
    const relations: MemoryRelation[] = ['refines', 'contradicts', 'caused_by'];
    const kinds: EntityKind[] = ['person', 'project', 'tool', 'place', 'org', 'topic'];
    let edges = 0;
    let conflicts = 0;
    let calls = 0;

    for (const batch of chunk(pool, 25)) {
      if (calls >= budget || signal.aborted) break;
      if (batch.length < 2) continue;
      const numbered = batch
        .map((memory, index) => index + 1 + '. [' + memory.kind + '] ' + memory.content)
        .join('\n');
      const raw = await ask(provider, LINK_PROMPT + '\n\nMEMORIES:\n' + numbered, model, signal);
      calls += 1;
      const parsed = parseObject(raw);
      if (!parsed) continue;

      const proposed = Array.isArray(parsed.edges) ? parsed.edges : [];
      for (const entry of proposed.slice(0, 12)) {
        if (!entry || typeof entry !== 'object') continue;
        const row = entry as Record<string, unknown>;
        const from = Number(row.from);
        const to = Number(row.to);
        const relation = row.relation as MemoryRelation;
        if (!relations.includes(relation)) continue;
        if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
        if (from < 1 || to < 1 || from > batch.length || to > batch.length || from === to) continue;
        const edge = this.#store.addEdge({
          owner,
          srcId: batch[from - 1]!.id,
          dstId: batch[to - 1]!.id,
          relation,
          weight: clamp01(typeof row.weight === 'number' ? row.weight : 0.6),
          origin: 'sleep',
          runId,
        });
        if (!edge) continue;
        edges += 1;
        if (relation === 'contradicts') conflicts += 1;
      }

      // Entity clean-up rides along in the same reply: a name that is really
      // a person or a tool stops being an anonymous topic.
      const named = Array.isArray(parsed.entities) ? parsed.entities : [];
      for (const entry of named) {
        if (!entry || typeof entry !== 'object') continue;
        const row = entry as Record<string, unknown>;
        const name = typeof row.name === 'string' ? row.name.trim() : '';
        const kind = row.kind as EntityKind;
        if (!name || !entitySlug(name) || !kinds.includes(kind)) continue;
        const existing = this.#store.findEntity(owner, name);
        if (!existing) continue;
        this.#store.upsertEntity({ owner, name: existing.name, kind });
      }

      // And so does the other half of a tidy graph: two names that mean one
      // thing ("Rookery", "Rookery-Agent") become one node, links and all.
      // A merge that would not hold - one side missing, both the same - is
      // refused by the store and costs the night nothing.
      const aliases = Array.isArray(parsed.aliases) ? parsed.aliases : [];
      for (const entry of aliases.slice(0, 8)) {
        if (!entry || typeof entry !== 'object') continue;
        const row = entry as Record<string, unknown>;
        const from = typeof row.from === 'string' ? row.from.trim() : '';
        const into = typeof row.into === 'string' ? row.into.trim() : '';
        if (!from || !into || from === into) continue;
        if (this.#store.mergeEntities(owner, from, into)) {
          this.#log.info('Merged duplicate entities', { owner, from, into });
        }
      }
    }

    return { edges, conflicts, calls };
  }

  /* ------------------------------ phase 5 ------------------------------ */

  /**
   * The part that makes it a memory rather than a filing cabinet: notice
   * something across the window that no single memory says. Strictly
   * bounded - each call at most a couple of sentences, and each one has to
   * point at the evidence it came from or it is thrown away.
   *
   * Two passes over the same pool, from two angles. The first looks for
   * patterns in the user: habits, preferences, routines. The second looks
   * for patterns in the work: what keeps recurring, what keeps costing
   * time, what the projects share. One prompt that asks for both at once
   * returns the loudest kind only; separately, each gets its own lens. The
   * configured `insights` count caps the night's total, whichever angle
   * produced them.
   */
  async #reflect(
    provider: Provider,
    model: string | undefined,
    owner: string,
    runId: string,
    signal: AbortSignal,
    budget: number,
  ): Promise<{ written: number; edges: number; calls: number }> {
    const wanted = this.#config.memory.sleep.insights;
    if (wanted <= 0 || budget <= 0 || signal.aborted) return { written: 0, edges: 0, calls: 0 };

    const window = this.#config.memory.sleep.insightWindowDays;
    const since = Date.now() - window * 24 * 60 * 60 * 1000;
    const recent = this.#store
      .listMemories({ owner, since, limit: 80, includeDormant: false })
      .filter((memory) => memory.kind !== 'insight');
    if (recent.length < 4) return { written: 0, edges: 0, calls: 0 };

    const entities = this.#store.listEntities({ owner, limit: 12, minMentions: 2 });
    const numbered = recent
      .map((memory, index) => index + 1 + '. [' + memory.kind + '] ' + memory.content)
      .join('\n');
    const topics = entities.length
      ? '\n\nCOMMON TOPICS:\n' + entities.map((entity) => '- ' + entity.name).join('\n')
      : '';

    let written = 0;
    let edges = 0;
    let calls = 0;

    // The two angles read the same pool, so the same sentence can come back
    // twice - and an insight that is already on record is not knowledge
    // gained. Both passes write against this set; whatever is in it, from
    // earlier nights or earlier in this one, is skipped.
    const onRecord = new Set(
      this.#store
        .listMemories({ owner, kinds: ['insight'], limit: 200, includeDormant: false })
        .map((memory) => memory.content),
    );

    for (const angle of ['user', 'work'] as const) {
      if (calls >= budget || written >= wanted || signal.aborted) break;
      const raw = await ask(
        provider,
        (angle === 'user' ? INSIGHT_USER_PROMPT : INSIGHT_WORK_PROMPT).replace('{{MAX}}', String(wanted - written)) +
          '\n\nMEMORIES FROM RECENT DAYS:\n' + numbered + topics,
        model,
        signal,
      );
      calls += 1;
      const parsed = parseObject(raw);
      const proposed = parsed && Array.isArray(parsed.insights) ? parsed.insights : [];

      for (const entry of proposed.slice(0, wanted - written)) {
        if (!entry || typeof entry !== 'object') continue;
        const row = entry as Record<string, unknown>;
        const content = typeof row.content === 'string' ? row.content.trim() : '';
        if (content.length < 12 || content.length > 400) continue;
        if (onRecord.has(content)) continue;
        const evidence = Array.isArray(row.evidence)
          ? [...new Set(row.evidence.map((value) => Number(value)))]
              .filter((value) => Number.isInteger(value) && value >= 1 && value <= recent.length)
              .map((value) => recent[value - 1]!)
          : [];
        // An insight standing on fewer than two memories is a guess.
        if (evidence.length < 2) continue;

        const record = this.#store.upsertMemory({
          kind: 'insight',
          content,
          tags: [...new Set(evidence.flatMap((memory) => memory.tags))].slice(0, 6),
          importance: clamp01(typeof row.importance === 'number' ? row.importance : 0.75),
          owner,
          origin: 'sleep',
          sleepRunId: runId,
        });
        onRecord.add(content);
        for (const memory of evidence) {
          for (const entity of this.#store.entitiesFor(memory.id)) {
            this.#store.linkEntity(record.id, entity.id);
          }
          // The insight refines its evidence, so recall can walk from either end.
          const edge = this.#store.addEdge({
            owner,
            srcId: record.id,
            dstId: memory.id,
            relation: 'refines',
            weight: 0.8,
            origin: 'sleep',
            runId,
          });
          if (edge) edges += 1;
        }
        written += 1;
      }
    }

    return { written, edges, calls };
  }

  /* ------------------------------ phase 6 ------------------------------ */

  /**
   * Repair before invention.
   *
   * A skill is written once and then followed for months, which makes a
   * stale one worse than none at all: it does not merely fail to help, it
   * confidently sends whoever opens it down a path that no longer exists. So
   * before the night considers writing anything new, it asks which of the
   * procedures it already owns have had the ground move under them.
   *
   * Two signals, both already in the database and neither of them guesswork:
   *
   *   sources  - the memories a skill was distilled from. One of them being
   *              put to sleep, decided against in a contradiction, or edited
   *              means the skill was written from something that no longer
   *              reads that way.
   *   failures - runs that had the skill open and then failed. The error text
   *              comes along, because "the run failed" locates nothing while
   *              "no such script: build:core" points at the exact line that
   *              is lying.
   *
   * A trigger is consumed by being looked at, whatever the outcome: every
   * review leaves a snapshot, and the next night's window starts there.
   * Otherwise one dormant memory would drag the same skill in front of the
   * model every night for ever, at the cost of a call each time.
   */
  /**
   * Every skill of this bank that has a live reason to be looked at, worst
   * first. Pure database and lexical work - no model - so the demand
   * measurement can call it as often as it likes.
   */
  #skillSuspects(owner: string) {
    const store = new SkillStore(this.#config.skillsDir);
    const mine = store
      .for(owner === ASSISTANT_MEMORY_OWNER ? 'assistant' : 'agent')
      // Neither the user's own skills nor the ones Rookery ships are the
      // night's to rewrite, so there is no point spending a model call
      // deciding that they should be - the store would refuse the write.
      .filter((skill) => skill.origin === 'agent' || skill.origin === 'sleep');
    if (!mine.length) return [];

    // Corrections the night's replay pulled out of the day's conversations.
    // Unlike the other two signals these do not arrive attached to a skill, so
    // each is matched against the shelf by wording - the same lexical judgement
    // the rest of this file uses, and enough to tell "always run the tests
    // first" from a remark about the mail client.
    const open = this.#store.openCorrections(owner, 20);

    return mine
      .map((skill) => {
        // Looking counts as clearing, so the window opens at whichever came
        // last: the file being written, or the night last reading it.
        const since = Math.max(skill.updatedAt, this.#store.lastSkillReviewAt(skill.name));
        const changed = this.#store.changedSkillSources(skill.name, since);
        const failures = this.#store.failedRunsForSkill(skill.name, since, 3);
        // Name and description only, never the body. What a skill is ABOUT is
        // its subject line; the body is implementation detail, and every extra
        // step in it dilutes the overlap until nothing matches. A correction
        // shares few words with the procedure it bears on by nature - it is
        // usually introducing something the procedure fails to mention.
        const about = normalizeTokens(skill.name.replace(/-/g, ' ') + ' ' + skill.description);
        const corrections = open.filter(
          (entry) => similarity(about, normalizeTokens(entry.text)) >= CORRECTION_MATCH,
        );
        return { skill, changed, failures, corrections };
      })
      // A failure is the louder signal: it is evidence the procedure was
      // actually followed and actually did not work.
      .filter((entry) => entry.changed.length > 0 || entry.failures.length > 0 || entry.corrections.length > 0)
      .sort((a, b) => weigh(b) - weigh(a));
  }

  async #revise(
    provider: Provider,
    model: string | undefined,
    owner: string,
    runId: string,
    signal: AbortSignal,
    budget: number,
  ): Promise<{ written: number; calls: number }> {
    if (budget <= 0 || signal.aborted) return { written: 0, calls: 0 };

    const store = new SkillStore(this.#config.skillsDir);
    const suspects = this.#skillSuspects(owner).slice(0, budget);
    if (!suspects.length) return { written: 0, calls: 0 };

    const consumed = new Set<string>();

    let written = 0;
    let calls = 0;

    for (const suspect of suspects) {
      if (signal.aborted) break;
      const { skill, changed, failures, corrections } = suspect;
      for (const entry of corrections) consumed.add(entry.id);

      const why: string[] = [];
      for (const entry of changed) {
        const line = entry.replacement
          ? 'This memory was replaced:\n  BEFORE: ' + entry.memory.content + '\n  NOW:    ' + entry.replacement.content
          : entry.memory.dormantAt
            ? 'This memory was put to sleep as no longer worth keeping: ' + entry.memory.content
            : 'This memory was edited since the skill was written: ' + entry.memory.content;
        why.push('- ' + line);
      }
      // The user's own words go first: nothing else in the list carries as
      // much weight as being told outright that this is wrong.
      for (const entry of corrections) {
        why.unshift(
          '- The user corrected this: ' + entry.text +
            '\n  IN THEIR WORDS: "' + clipText(entry.quote, 220) + '"',
        );
      }
      for (const failure of failures) {
        why.push(
          '- A run that had this skill open failed.\n  TASK:  ' + clipText(failure.task, 200) +
            '\n  ERROR: ' + clipText(failure.error, 400),
        );
      }

      const raw = await ask(
        provider,
        REVISE_PROMPT +
          '\n\nTHE SKILL AS IT READS NOW:\nname: ' + skill.name +
          '\ndescription: ' + skill.description +
          '\n\n' + skill.body +
          '\n\nWHAT HAS CHANGED SINCE IT WAS WRITTEN:\n' + why.join('\n'),
        model,
        signal,
      );
      calls += 1;

      const parsed = parseObject(raw);
      const wantsRevision = parsed?.revise === true;
      const description =
        typeof parsed?.description === 'string' && parsed.description.trim()
          ? parsed.description.trim()
          : skill.description;
      const body = typeof parsed?.body === 'string' ? parsed.body.trim() : '';

      if (!wantsRevision || body.length < 120) {
        // Reviewed and left alone. The snapshot carries no run id: there is
        // nothing for undo to take back, but the timestamp still closes the
        // window so tomorrow does not ask the same question again.
        this.#store.snapshotSkill({ skill: skill.name, content: store.raw(skill.name) });
        this.#settleSources(skill.name, owner, changed);
        this.#log.info('Sleep reviewed a skill and left it', { owner, skill: skill.name });
        continue;
      }

      try {
        this.#store.snapshotSkill({ skill: skill.name, content: store.raw(skill.name), sleepRunId: runId });
        store.save({ name: skill.name, description, body, audience: skill.audience, origin: 'sleep' });
        this.#settleSources(skill.name, owner, changed);
        this.#log.info('Sleep revised a skill', {
          owner,
          skill: skill.name,
          changed: changed.length,
          failures: failures.length,
        });
        written += 1;
      } catch (cause) {
        this.#log.info('Sleep left a skill alone', { owner, skill: skill.name, reason: (cause as Error).message });
      }
    }

    // Looked at is looked at, whatever came of it: a correction that has been
    // weighed must not be weighed again tomorrow.
    this.#store.consumeCorrections([...consumed]);
    return { written, calls };
  }

  /**
   * Re-point a skill at the memories that hold now.
   *
   * A superseded source is followed to whatever replaced it, so the chain
   * survives a condensation instead of breaking at it; a sleeping source is
   * dropped, because a memory nobody kept is not something to keep standing
   * on. Without this the same trigger would fire for ever: the memory stays
   * dormant, and dormancy has no timestamp a window could exclude.
   */
  #settleSources(
    skill: string,
    owner: string,
    changed: { memory: MemoryRecord; replacement: MemoryRecord | null }[],
  ): void {
    if (!changed.length) return;
    const current = new Set(this.#store.skillSourceIds(skill));
    for (const entry of changed) {
      current.delete(entry.memory.id);
      if (entry.replacement && !entry.replacement.dormantAt) current.add(entry.replacement.id);
      else if (!entry.memory.dormantAt && !entry.memory.supersededBy) current.add(entry.memory.id);
    }
    this.#store.setSkillSources(skill, owner, [...current]);
  }

  /**
   * The night's last act, and the only one that changes what the assistant
   * can do rather than only what it knows.
   *
   * A memory says that something is true. A skill says how something is
   * done - and that second kind of knowledge is exactly what gets worked out
   * from scratch every time while it lives as a scatter of separate
   * sentences. So once the bank is tidy, the same evidence rule that governs
   * insights is pointed at procedure: where several memories describe the
   * same recurring piece of work, that work is written down as a skill, and
   * from the next turn on it sits in the index the assistant and its agents
   * both read.
   *
   * Three things keep this from filling the shelf with rubbish. It is capped
   * (one a night by default). Nothing is written on fewer than three
   * memories. And a skill the user wrote is never overwritten - the store
   * refuses, and the refusal is logged rather than worked around.
   */
  async #practise(
    provider: Provider,
    model: string | undefined,
    owner: string,
    runId: string,
    signal: AbortSignal,
    budget: number,
  ): Promise<{ written: number; calls: number }> {
    const wanted = this.#config.memory.sleep.skills;
    if (wanted <= 0 || budget <= 0 || signal.aborted) return { written: 0, calls: 0 };

    // What this bank holds, strongest first. Insights are deliberately in:
    // they are precisely the "this keeps happening" observations a procedure
    // grows out of.
    const live = this.#store
      .listMemories({ owner, limit: 60, includeDormant: false })
      .filter((memory) => memory.kind !== 'summary');
    if (live.length < 6) return { written: 0, calls: 0 };

    const numbered = live
      .map((memory, index) => index + 1 + '. [' + memory.kind + '] ' + memory.content)
      .join('\n');

    // Whose shelf this is. The assistant's bank writes skills the assistant
    // may open; an agent's bank writes skills for agents.
    const audience: ToolServerAudience = owner === ASSISTANT_MEMORY_OWNER ? 'assistant' : 'agents';
    const store = new SkillStore(this.#config.skillsDir);
    const existing = store.for(owner === ASSISTANT_MEMORY_OWNER ? 'assistant' : 'agent');
    const shelf = existing.length
      ? existing.map((skill) => '- ' + skill.name + ' (' + skill.origin + '): ' + skill.description).join('\n')
      : '(nothing yet)';

    const raw = await ask(
      provider,
      SKILL_PROMPT.replace('{{MAX}}', String(wanted)) +
        '\n\nSKILLS THAT ALREADY EXIST:\n' + shelf +
        '\n\nWHAT THIS MEMORY HOLDS:\n' + numbered,
      model,
      signal,
    );
    const parsed = parseObject(raw);
    const proposed = parsed && Array.isArray(parsed.skills) ? parsed.skills : [];

    let written = 0;
    for (const entry of proposed.slice(0, wanted)) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      const name = typeof row.name === 'string' ? skillSlug(row.name) : '';
      const description = typeof row.description === 'string' ? row.description.trim() : '';
      const body = typeof row.body === 'string' ? row.body.trim() : '';
      if (!name || !description) continue;
      // Shorter than this is a note, not a procedure worth opening.
      if (body.length < 120) continue;

      const evidence = Array.isArray(row.evidence)
        ? [...new Set(row.evidence.map((value) => Number(value)))].filter(
            (value) => Number.isInteger(value) && value >= 1 && value <= live.length,
          )
        : [];
      // A procedure standing on fewer than three memories is one anecdote
      // with ambitions.
      if (evidence.length < 3) continue;

      try {
        // The snapshot goes in first and carries the run id: writing a skill
        // is part of the night, so undoing the night has to take it back.
        // Null content says the skill did not exist, which is how undo knows
        // to delete rather than restore.
        this.#store.snapshotSkill({ skill: name, content: store.raw(name), sleepRunId: runId });
        const skill = store.save({ name, description, body, audience, origin: 'sleep' });
        // What it stands on, kept: this is what lets a later night notice
        // that the ground under this procedure has moved.
        this.#store.setSkillSources(
          skill.name,
          owner,
          evidence.map((index) => live[index - 1]!.id),
        );
        this.#log.info('Sleep wrote a skill', { owner, skill: skill.name, evidence: evidence.length });
        written += 1;
      } catch (cause) {
        // Almost always "that name belongs to the user". Not worth failing a
        // night over; the night simply does not get that name.
        this.#log.info('Sleep left a skill alone', { owner, skill: name, reason: (cause as Error).message });
      }
    }

    return { written, calls: 1 };
  }

  /* -------------------------------- the dream -------------------------------- */

  /**
   * The dream: measure the retrieval policy, and - when every condition
   * holds - put a better one in force (concept 5, 6, 10).
   *
   * It sits before the cycle loop and above the provider guard because all
   * of it is model-free. The grid is declared, the candidates it ranks were
   * proposed by a night that has already been and gone, and every number
   * comes out of frames frozen during the day. A night without a provider
   * still measures, still promotes and still freezes - and that is exactly
   * the night where this is the only thing that could run at all. It is also
   * why the candidate writer sits at the far end of the night (`#propose`)
   * and writes for tomorrow: a promotion path that needed tonight's model
   * call would stop working on the night it matters most.
   *
   * One wall clock for the whole of it (`dream.maxEvalMs`), not one per
   * part: a pool cut into pieces must not be able to buy itself a second
   * budget. One catch around the whole of it as well - a dream that throws
   * costs the night its measurement, never its consolidation (10.5: a
   * degraded path is never turned into an error).
   */
  async #dream(
    owner: string,
    runId: string,
    counters: NightCounters,
    signal: AbortSignal,
  ): Promise<string> {
    const dream = this.#config.memory.dream;
    // Stage 2 dreams for one bank, the assistant's (R18): nothing scores an
    // agent's frames, so recording and measuring them would be pure cost.
    if (!dream.enabled || owner !== ASSISTANT_MEMORY_OWNER) return '';

    const deadline = Date.now() + clampMs(dream.maxEvalMs);
    this.#phase(runId, 'dream', counters, 1);
    let report = '';
    try {
      report += this.#probe(owner, runId, counters, deadline, signal);
      // `dream.slots` is what the night CARRIES (9.3, S18). `recall` is the
      // one slot this stage has a promotion path for; `budget` and `retry`
      // are measured after the cycles and carried by nobody yet.
      if (dream.slots.includes('recall')) {
        report += await this.#recallSlot(owner, runId, counters, deadline, signal);
      }
    } catch (cause) {
      const message = (cause as Error).message;
      this.#log.warn('The dream phase failed', { owner, error: message });
      report += ' The dream phase failed: ' + message + '.';
    }
    this.#phase(runId, 'dream', counters, 1);
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
  #probe(
    owner: string,
    runId: string,
    counters: NightCounters,
    deadline: number,
    signal: AbortSignal,
  ): string {
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
  async #recallSlot(
    owner: string,
    runId: string,
    counters: NightCounters,
    deadline: number,
    signal: AbortSignal,
  ): Promise<string> {
    const dream = this.#config.memory.dream;
    const slot: DreamSlot = 'recall';
    // The NEWEST frames, not the oldest. Everything below means the frames
    // nearest to now - the box of the last one, the wake test's "since the
    // last promotion" filter, the admission sample's trailing slice - and an
    // owner holding more frames than the cap would otherwise pin all three
    // to a weeks-old slice for good, silently (S3).
    const pool = this.#store.framesFor(owner, { limit: DREAM_POOL_LIMIT, newest: true });
    const entries = pool
      // A night never scores its own writes.
      .filter((entry) => entry.trace.sleepRunId !== runId);
    if (!entries.length) return '';
    let report = '';
    const framesTotal = this.#store.dreamFrameCount(owner);
    if (framesTotal > pool.length) {
      // Disclosed the way the probe discloses its own cut: a measurement
      // over part of the store must be visible as one, never pass for the
      // whole of it.
      report +=
        ' The recall slot measured the ' + pool.length + ' newest of ' + framesTotal +
        ' stored dream frames.';
    }

    const incumbent = resolvePolicy(this.#store, this.#config, owner, slot);
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

    /* ------------------------------ candidates ------------------------------ */
    const proposals = this.#proposals(owner, slot, incumbent, dream.candidates);
    const versionOf = new Map<RecallPolicy, PolicyVersion>(
      proposals.map((entry) => [entry.policy, entry.version] as const),
    );
    const grid = buildGrid(incumbent, box, dream.gridSize).map((placement) =>
      liftPolicy(placement, incumbent),
    );
    // The incumbent goes first and a repeated point is dropped: every delta
    // is then paired against a number measured tonight, on tonight's frames,
    // never against a number from yesterday (E2).
    const offered = withIncumbent([...proposals.map((entry) => entry.policy), ...grid], incumbent);

    /* -------------------- admission, before the measurement -------------------- */
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
    const incumbentCoverage = this.#coverageOf(split.train, incumbent, deadline, signal);
    let refused = 0;
    for (let index = 1; index < offered.length; index += 1) {
      const candidate = offered[index]!;
      const verdict = admit(candidate, incumbent, box, {
        coverage: {
          candidate: this.#coverageOf(split.train, candidate, deadline, signal),
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

    /* ------------------------------ measurement ------------------------------ */
    const selection = selectOnTraining(this.#store, {
      owner,
      slot,
      config: this.#config,
      entries,
      incumbent,
      // The frozen audit set is scored against the set the product shipped
      // with, never against last night's winner (10.2, condition 2b).
      factory: factoryPolicy(),
      candidates: admitted,
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
    });
    this.#log.info('The dream measured the recall slot', {
      owner,
      split: selection.split,
      offered: offered.length,
      admitted: admitted.length - 1,
      refused,
      findings: selection.findings.join(','),
      delta: selection.holdout?.delta,
      ciLow: selection.holdout?.ciLow,
      valid: selection.holdout?.valid,
      violations: selection.holdout?.violations.join(','),
      agreement: agreement.findings.join(','),
    });

    /* --------------------------- the wake test, then the freeze --------------------------- */
    const wake = this.#wakeTest(owner, slot, awake, incumbent, deadline, signal);
    if (wake && wake.drift !== null) {
      report +=
        ' The wake test (a regression alarm, not a calibration: the replay value and the live' +
        ' value come out of the same estimator and the same labels, so wrong labels leave both' +
        ' agreeing) measured a drift of ' + signedNumber(wake.drift) + ' over the ' +
        plural(wake.closed, 'trace', 'traces') + ' that closed of ' + wake.offered +
        ' frames since the last promotion, ' + plural(wake.abstained, 'abstention', 'abstentions') +
        leadingReason(wake.reasons) + '.';
    } else if (wake) {
      // The verdict is read off what CLOSED, so a pool that closed too
      // little says so and freezes nothing: `calibration` is a freeze
      // somebody has to undo by hand (10.3), and one trace of noise out of
      // fifty offered must not be able to hand it out.
      report +=
        ' The wake test could not run: ' + wake.closed + ' of ' + wake.offered +
        ' frames since the last promotion closed, under dream.calibrationTraces (' +
        wake.required + '), with ' + plural(wake.abstained, 'abstention', 'abstentions') +
        leadingReason(wake.reasons) + '. Nothing is frozen on a pool that could not be read.';
    }
    report += this.#freeze(owner, slot, wake, selection.holdout, agreement);

    /* --------------------------------- the gate --------------------------------- */
    const chosen = selection.chosen;
    const params = chosen ? paramsOf(chosen.policy, incumbent) : {};
    const decision = promotionDecision({
      config: this.#config,
      holdout: selection.holdout,
      audit: selection.audit,
      // Exactly one candidate reaches the holdout, or none did (E4/S12).
      holdoutChecks: selection.holdout ? 1 : 0,
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

    if (selection.holdout && chosen && decision.promote) {
      const record = applyPromotion(this.#store, {
        owner,
        slot,
        sleepRunId: runId,
        config: this.#config,
        params,
        box: box as unknown as Record<string, unknown>,
        holdout: selection.holdout,
        audit: selection.audit,
      });
      counters.dreamPromoted += record.promoted;
      await this.#announcePromotion({
        owner,
        slot,
        runId,
        version: record.version,
        evaluation: record.evaluation,
        prevActiveId: record.prevActiveId,
        rationale: record.version.rationale ?? renderRationale(selection.holdout, selection.audit),
        cooldownUntil: record.cooldownUntil,
      });
      report +=
        ' A new ' + slot + ' policy is in force (version ' + record.version.version + '): ' +
        record.version.rationale + '. It can be taken back.';
    } else if (selection.holdout && chosen) {
      // A night that measures and does not promote is the common case, and
      // the record of it is what the next calibration stands on. The
      // evaluation row needs a version to hang off - `dream_evals.policy_id`
      // is a foreign key - so the candidate becomes an unpromoted version
      // carrying its own replay numbers, which is also what keeps it from
      // coming back tomorrow as an unmeasured proposal.
      const version = this.#store.createPolicyVersion({
        owner,
        slot,
        params,
        box: box as unknown as Record<string, unknown>,
        origin: 'dream',
        parentId: this.#store.activePolicy(owner, slot)?.id,
        sleepRunId: runId,
        rationale: renderRationale(selection.holdout, selection.audit),
        replayScore: selection.holdout.score,
        replayN: selection.holdout.closed,
        baselineScore: selection.holdout.baseline,
        auditDelta: selection.audit?.delta ?? selection.holdout.auditDelta,
        auditCiLow: selection.audit?.ciLow ?? selection.holdout.auditCiLow,
      });
      this.#recordEval(selection.holdout, version.id, runId, false);
      if (dream.promote) {
        // Only worth a sentence when promoting is switched on at all -
        // otherwise every night would end with the same blocker.
        report +=
          ' A ' + slot + ' candidate was measured and not promoted: ' +
          decision.blockers.join(', ') + '.';
      }
    }
    this.#log.info('The dream gate answered', {
      owner,
      slot,
      promote: decision.promote,
      blockers: decision.blockers.join(','),
    });

    // A proposal is offered exactly once - once it has been MEASURED.
    // Measured means a number exists for it: its training evaluation closed
    // at least one trace. A night that ran out of wall clock, or aborted, or
    // stood on a pool that closed nothing, measured none of them, and
    // retiring them for it would burn `dream.maxCallsPerNight` every night
    // forever on proposals that never got a number (7). What was measured,
    // or refused on its shape, is spent; the rest is carried over.
    for (const ranked of selection.ranked) {
      if (ranked.training.closed <= 0) continue;
      const version = proposalAt.get(ranked.index);
      if (version) settled.add(version.id);
    }
    let retired = 0;
    for (const entry of proposals) {
      if (!settled.has(entry.version.id)) continue;
      this.#store.retirePolicyVersion(entry.version.id);
      retired += 1;
    }
    const carried = proposals.length - retired;
    if (carried > 0) {
      report +=
        ' ' + plural(carried, 'proposal was', 'proposals were') +
        ' carried over to the next night: nothing measured ' +
        (carried === 1 ? 'it' : 'them') + ' tonight.';
    }
    return report;
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
  async #propose(
    provider: Provider,
    owner: string,
    runId: string,
    signal: AbortSignal,
    budget: number,
  ): Promise<{ written: number; calls: number }> {
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
    const aggregates = this.#aggregateCases(pool, this.#gainsFor(pool, owner), incumbent);
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
  #aggregateCases(
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
  #coverageOf(
    entries: readonly FrameEntry[],
    policy: RecallPolicy,
    deadline: number,
    signal: AbortSignal,
  ): number {
    const seen = new Set<string>();
    for (const entry of entries.slice(-ADMISSION_SAMPLE)) {
      if (signal.aborted || Date.now() > deadline) break;
      for (const id of this.#replayFrame(entry, policy)) seen.add(id);
    }
    return seen.size;
  }

  /** The ids that stood in one frame's block, in prompt order, at one point. */
  #replayFrame(entry: FrameEntry, policy: FrameScoringPolicy): string[] {
    const frame = entry.frame.payload;
    const run =
      frame.pipeline === 'agent' ? pipelineAgent(frame, policy) : pipelineAssistant(frame, policy);
    return run.ok ? run.lines.map((line) => line.id) : [];
  }

  /** What the block actually held, replayed at the policy it was fetched with. */
  #promptedOf(entry: FrameEntry): string[] {
    return this.#replayFrame(entry, entry.trace.policySet.recall ?? {});
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
  #writeCorrectionLabels(
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

  /** The body of `#writeCorrectionLabels`, inside its caller's catch. */
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
        for (const id of this.#promptedOf(entry)) prompted.add(id);
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
  #writeMergeLabels(
    owner: string,
    superseded: Map<string, string>,
  ): { labels: number; failed: number } {
    if (!this.#config.memory.dream.enabled || superseded.size < 2) {
      return { labels: 0, failed: 0 };
    }
    try {
      return { labels: this.#mergeLabelPass(owner, superseded), failed: 0 };
    } catch (cause) {
      // Its own failure, caught here for the reason `#writeCorrectionLabels`
      // gives above: a label is worth a condensation, never a night (10.5).
      this.#log.warn('Writing merge labels failed', {
        owner,
        error: (cause as Error).message,
      });
      return { labels: 0, failed: 1 };
    }
  }

  /** The body of `#writeMergeLabels`, inside its caller's catch. */
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
      const prompted = this.#promptedOf(entry);
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
  #correctionPrecision(replayed: { corrections: number; labelled: number; labels: number }): string {
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
  #measureSlots(owner: string, spend: Record<NightPhase, { calls: number; value: number }>): void {
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
   * A window opens with the first dream call and closes after
   * `DREAM_NIGHT_WINDOW_MS` of quiet. That is what "one night" has to mean
   * for a process with no calendar: the runtime runs the due banks in one
   * sequential loop, so every one of them draws on the same wallet, and a
   * night a day later starts with a full one.
   */
  #dreamBudget(): number {
    const ceiling = Math.max(0, Math.round(this.#config.memory.dream.maxCallsPerNight));
    const now = Date.now();
    if (now - this.#dreamCalls.since > DREAM_NIGHT_WINDOW_MS) {
      this.#dreamCalls = { since: now, spent: 0 };
    }
    return Math.max(0, ceiling - this.#dreamCalls.spent);
  }

  /** Book model calls against that wallet, spent or wasted. */
  #spendDreamCalls(calls: number): void {
    if (calls <= 0) return;
    if (!this.#dreamCalls.since) this.#dreamCalls.since = Date.now();
    this.#dreamCalls.spent += calls;
  }

  /* ------------------------------ internals ------------------------------ */

  async #resolveProvider(wanted?: ProviderId): Promise<ProviderId | null> {
    try {
      return await this.#registry.resolveUsable(wanted ?? this.#config.defaultProvider);
    } catch {
      return null;
    }
  }

  #throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new Error('The sleep run was cancelled.');
  }

  #phase(runId: string, phase: SleepStage, counters: Partial<SleepRun>, cycle: number): void {
    const run = this.#store.updateSleepRun(runId, counters);
    if (run) this.#announce(run, phase, cycle);
  }

  #announce(run: SleepRun, phase: string, cycle?: number): void {
    const event: AgentEvent = { type: 'sleep', run, phase, ...(cycle ? { cycle } : {}) };
    this.emit('sleep', event);
  }
}

/* -------------------------------- prompts -------------------------------- */

const CONDENSE_PROMPT = `You are tidying a personal assistant's long-term memory overnight.

The memories below concern the same topic. Decide whether they describe ONE fact
that can be condensed into one sentence.

Merge ONLY when:
- the sentences genuinely describe the same fact, or
- a newer sentence supersedes an older one (the newer one takes precedence).

Do NOT merge different facts that merely share a keyword.
When in doubt, keep them separate: separation costs nothing; a false merge loses knowledge.

Rules:
- The result is ONE complete sentence, understandable without any other context.
- Write in the same language as the source memories.
- Under "supersedes", list the numbers of memories the new sentence fully replaces.
- NEVER list memories marked [protected] under "supersedes". They are context only.
- Do not list a number whose content is not included in the new sentence.

Reply ONLY with JSON, no prose or code fence:
{"merge":true,"content":"...","kind":"fact","importance":0.7,"tags":["..."],"supersedes":[1,3]}
or
{"merge":false,"reason":"different facts"}`;

const LINK_PROMPT = `You are connecting a personal assistant's memories overnight.

Find relationships between the numbered memories below.

Relationships:
- "refines":     "from" adds detail to "to" (the same fact, more detail)
- "contradicts": "from" and "to" cannot both be true
- "caused_by":   "from" is true BECAUSE "to" is true

Rules:
- Only relationships supported by the sentences themselves. Do not speculate.
- At most 12 relationships. None is a valid answer.
- "weight" is your confidence between 0 and 1.
- Also classify recognisable proper names as:
  person, project, tool, place, org or topic.
- If two DIFFERENT names in the list clearly mean the same real thing
  ("Rookery" and "Rookery-Agent", "TS" and "TypeScript"), list them under
  "aliases": "from" is the variant, "into" the canonical name. Only when you
  are sure they are the same thing; a wrong merge loses structure.

Reply ONLY with JSON, no prose or code fence:
{"edges":[{"from":1,"to":4,"relation":"refines","weight":0.8}],
 "entities":[{"name":"Rookery","kind":"project"}],
 "aliases":[{"from":"Rookery-Agent","into":"Rookery"}]}
An empty result is {"edges":[],"entities":[],"aliases":[]}`;

const RESOLVE_PROMPT = `You are resolving a contradiction in a personal assistant's memory overnight.

The two sentences below contradict each other. Decide which takes precedence. You must decide,
unless they do not actually contradict each other.

Rules:
- The newer sentence wins when both describe the same thing and circumstances have changed.
  ("has switched to" supersedes the older state.)
- The more specific sentence wins when both concern the same time and one is imprecise.
- Use "both" only when both can be true together and the contradiction label was incorrect.
- Use "merge" only when both together describe the fact correctly. Then "content" is
  ONE complete sentence in the language of the source memories.

Reply ONLY with JSON, no prose or code fence:
{"decision":"first"}
{"decision":"second"}
{"decision":"both"}
{"decision":"merge","content":"..."}`;

const INSIGHT_USER_PROMPT = `You are reflecting on a personal assistant's memory overnight.

The memories below come from recent days. What stands out BEYOND the individual sentences
ABOUT THE USER - the person this memory belongs to? Look for a pattern, habit, routine,
preference or common thread that no single sentence states.

Rules:
- At most {{MAX}} insights. None is the right answer when nothing stands out.
- Every insight needs at least TWO sources: the numbers supporting it.
- Never repeat an individual memory as an insight. An insight says something new.
- One sentence, third person, in the same language as the source memories.
- Do not invent or speculate. Only state what the evidence actually supports.

Reply ONLY with JSON, no prose or code fence:
{"insights":[{"content":"...","importance":0.8,"evidence":[1,4,7],"tags":["..."]}]}
An empty result is {"insights":[]}`;

const INSIGHT_WORK_PROMPT = `You are reflecting on a personal assistant's memory overnight.

The memories below come from recent days. What stands out BEYOND the individual sentences
ABOUT THE WORK - the projects, the tools, the way things get done? Look for what keeps
recurring, what keeps costing time, what several efforts share, or what keeps going wrong
the same way. The user has to be able to act on it.

Rules:
- At most {{MAX}} insights. None is the right answer when nothing stands out.
- Every insight needs at least TWO sources: the numbers supporting it.
- Never repeat an individual memory as an insight. An insight says something new.
- One sentence, third person, in the same language as the source memories.
- Do not invent or speculate. Only state what the evidence actually supports.

Reply ONLY with JSON, no prose or code fence:
{"insights":[{"content":"...","importance":0.8,"evidence":[1,4,7],"tags":["..."]}]}
An empty result is {"insights":[]}`;

const TRIAGE_PROMPT = `You decide whether one conversation is worth reading closely tonight.

Below are only the things the USER said in it, shortened. Answer one question: could a careful
reading of this conversation yield something durable - a stable fact about the user, a preference
about how they want things done, a project constraint, or a correction of something that was
done wrong?

Say false for small talk, one-off requests, pure question-and-answer where the user reveals
nothing about themselves, and anything that is only about the here and now. Most conversations
are false. That is fine and expected - being wrong the cheap way costs one more reading, being
wrong the expensive way costs nothing at all.

Reply ONLY with JSON, no prose or code fence:
{"worth":true}  or  {"worth":false}`;

const REPLAY_PROMPT = `You are re-reading one conversation at night, after it has ended.

It was already skimmed once, right after each turn, by a small fast model that saw one exchange
at a time and never the whole. Your advantage is exactly that: you can see the arc. Look for what
only shows up across the conversation - a preference mentioned early in passing, a constraint the
user repeated in different words, a decision that emerged rather than being stated in one line.

TWO THINGS TO RETURN.

1. memories - durable facts the USER STATED THEMSELVES, worth remembering weeks from now.
   Every one needs "evidence": a span copied VERBATIM, character for character, from a USER turn.
   Not from the assistant's. Not reworded, not translated, not tidied. A memory whose evidence is
   not found word for word in what the user wrote is thrown away before it is stored, so there is
   nothing to gain by inventing one.
   - one self-contained sentence each, third person about the user, in the user's own language
   - kinds: fact, preference, project, event
   - nothing already under ALREADY KNOWN, nothing the assistant worked out, nothing you inferred
   - a question is not a fact. "How do I deploy this?" says nothing durable.
   - importance: 0.9 identity and hard constraints, 0.7 preferences and active projects,
     0.5 useful context, 0.3 minor detail

2. corrections - places where the user put the assistant right: rejected an approach, restated
   something that had been misunderstood, or said a thing should be done differently in future.
   This is the signal nothing else in the system captures. Each needs the user's own words as
   "quote", under the same verbatim rule, and one sentence in "text" saying what should be done
   differently from now on. Irritation alone is not a correction; there has to be a should.

Returning empty lists is the ordinary answer for most conversations.

Reply ONLY with JSON, no prose or code fence:
{"memories":[{"kind":"preference","content":"The user wants releases cut from main.","tags":["release"],"importance":0.7,"evidence":"cut releases from main"}],
 "corrections":[{"text":"Do not open a PR without running the tests first.","quote":"du hast wieder keine Tests laufen lassen"}]}`;

const REVISE_PROMPT = `You maintain one written procedure that an assistant follows unattended.

Below is a skill as it currently reads, and everything that has changed since it was written:
memories it was built on that have been replaced, retired or edited, and runs that had it open
and then failed, with the real error text.

Decide ONE thing: does the skill still hold, or does it now mislead whoever opens it next?

Revise it when:
- a step names something that has been replaced (a command, a path, a tool, a threshold)
- an error shows a step simply does not work the way the skill claims
- the skill is silent about a trap that has now caught a run

Do NOT revise when:
- the change is unrelated to what the skill actually says
- the run failed for a reason the skill never claimed to cover
- you would only be rewording it. Churn is worse than an old sentence that is still true.

When you revise:
- return the COMPLETE new body, not a diff and not only the changed part
- change what is wrong and leave the rest alone, word for word
- keep the same structure and the same language
- fix the cause, not the symptom: if a command was renamed, rename it, do not add a note
  saying it might have been renamed
- never invent a step you have no evidence for. If the error shows a step is wrong but not
  what the right one is, say so plainly in the skill rather than guessing a replacement.

Reply ONLY with JSON, no prose or code fence:
{"revise":true,"description":"when to open this skill","body":"## Steps\\n1. ..."}
Leaving it alone is {"revise":false}`;

const SKILL_PROMPT = `You turn what an assistant has learned into something it can actually follow.

Below are the memories this assistant holds and the skills it already has. A memory says THAT
something is true. A skill says HOW a kind of work is done, so it does not have to be figured out
again. Your job is to notice where the memories have quietly documented a procedure, and to write
that procedure down.

Write a skill ONLY when all of these hold:
- the memories point at a RECURRING kind of task, not one thing that happened once
- there is an actual procedure in them: an order to do things in, a tool to reach for, a mistake
  worth avoiding, a rule that keeps coming back
- no existing skill already covers it
- at least THREE of the numbered memories support it

Write at most {{MAX}}. Writing none is the ordinary answer - reply with an empty list and stop.

Revising a skill you wrote before (one marked "sleep" or "agent") counts towards the limit and is
usually better than adding another one: reuse its exact name and write the improved version in
full. NEVER reuse the name of a skill marked "user" - those belong to the person and are refused.

For the body: Markdown, written for somebody who has never seen these memories. Concrete names,
paths, commands, thresholds. Steps in the order they are done. State the traps explicitly. No
preamble, no restating of the memories, no "as an AI".

Write in the same language the memories are written in.

Reply ONLY with JSON, no prose or code fence:
{"skills":[{"name":"release-checklist","description":"When cutting a release of the web package","body":"## Steps\\n1. ...","evidence":[2,5,9]}]}
An empty result is {"skills":[]}`;

/* ------------------------------- helpers ------------------------------- */

/** What the night may never touch. */
function isProtected(memory: MemoryRecord): boolean {
  return memory.origin === 'user' || memory.pinned;
}

/** One small-model call. Never throws; an empty string means "nothing usable". */
async function ask(
  provider: Provider,
  prompt: string,
  model: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  let output = '';
  try {
    for await (const event of provider.run({
      prompt,
      model,
      // Housekeeping must never out-think the work it is tidying up after.
      effort: 'low',
      permission: 'chat',
      signal,
    })) {
      if (event.type === 'done') output = event.text || output;
      else if (event.type === 'text') output += event.delta;
      else if (event.type === 'error' && event.fatal) return output;
    }
  } catch {
    return '';
  }
  return output;
}

/** Pull one JSON object out of a reply that may carry prose or a fence. */
export function parseObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed: unknown = JSON.parse(body.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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
 * Split a budget of model calls across the cycles of one night.
 *
 * `early` front-loads it, which is what deep sleep wants: the big piles are
 * worth condensing first. `late` back-loads it, which is what dreaming wants:
 * connections are worth more once the bank has been tidied. The parts always
 * add up to exactly `total`, however the weights fall.
 */
export function share(total: number, cycles: number, cycle: number, bias: 'early' | 'late'): number {
  if (cycles <= 1) return total;
  const weight = (index: number): number => (bias === 'early' ? cycles - index : index + 1);
  let sum = 0;
  for (let index = 0; index < cycles; index += 1) sum += weight(index);
  const upTo = (count: number): number => {
    let prefix = 0;
    for (let index = 0; index < count; index += 1) prefix += weight(index);
    return Math.round((total * prefix) / sum);
  };
  return upTo(cycle) - upTo(cycle - 1);
}

/** How much work each phase says is waiting, in model calls. */
export interface NightDemand {
  /** Clusters that could be condensed. */
  condense: number;
  /** Contradictions that could be decided. */
  resolve: number;
  /** Portions of fresh memories waiting to be linked. */
  link: number;
  /** Insight passes over the window's pool. */
  reflect: number;
  /** Skills with a live reason to be reviewed. */
  revise: number;
  /** The one distillation call. */
  practise: number;
}

/** What each phase is funded with for one night. */
export type NightBudgets = NightDemand;

/** Per-phase maximum, whatever the demand says. */
export interface NightCeilings {
  condense: number;
  resolve: number;
  link: number;
  reflect: number;
  revise: number;
  practise: number;
}

/**
 * Fund one night's work out of a fixed wallet.
 *
 * Every phase first asks for what it can actually use - demand, capped by
 * its own ceiling. If all of that fits under `cap`, everyone is funded in
 * full: a quiet week sleeps cheap because there is simply less to do. Only
 * when the demand overflows the wallet does the night have to choose, and
 * the rule is that the volume phases give way first. Condensing, deciding
 * and linking scale with the day's load, so one call shaved off each loses
 * the least; whatever they leave unfunded waits for tomorrow, which is
 * exactly what tomorrow is for. The judgement phases - insight, skill
 * repair, distillation - are a handful of calls and keep theirs until only
 * they are left, because an insight or a repair that never happens is not
 * deferred work, it is work that quietly never happens at all.
 *
 * The replay pass sits outside this wallet on purpose: its deep reads are
 * bounded by their own ceiling (`replaySessions`) and its triage is the
 * cheap model, and the replay has to run before the wallet can even be
 * measured - what it harvests is part of the workload being measured.
 */
export function allocateNightBudget(
  demand: NightDemand,
  cap: number,
  ceilings: NightCeilings,
): NightBudgets {
  const volume = ['condense', 'resolve', 'link'] as const;
  const judgement = ['reflect', 'revise', 'practise'] as const;
  // Derived, never re-listed (R20): a key present in a hand-written tuple
  // but in neither sub-list kept its uncapped allocation while the volume
  // phases were squeezed, and a demand key missing from the tuple never
  // reached `funded` at all - `budgets.x` read undefined, the phase guard
  // let it through and the phase ran unbudgeted. With the tuple derived
  // from the two lists, neither failure mode can be written.
  const keys = [...volume, ...judgement] as const;
  const funded = new Map<string, number>();
  for (const key of keys) {
    funded.set(key, Math.max(0, Math.min(demand[key] ?? 0, ceilings[key] ?? Number.POSITIVE_INFINITY)));
  }

  const sumOf = (which: readonly string[]): number =>
    which.reduce((total, key) => total + (funded.get(key) ?? 0), 0);

  if (sumOf(keys) <= cap) return Object.fromEntries(funded) as unknown as NightBudgets;

  const judgementSum = sumOf(judgement);

  if (judgementSum >= cap) {
    // A starved night: only the judgement phases fit at all, and even they
    // have to share what is left.
    for (const key of volume) funded.set(key, 0);
    distribute(funded, judgement, cap);
  } else {
    distribute(funded, volume, cap - judgementSum);
  }
  return Object.fromEntries(funded) as unknown as NightBudgets;
}

/**
 * Share `cap` calls among `keys`, in proportion to what each asked for.
 * Floors first, then the rounding remainder one call at a time to whoever
 * asked for the most - so the parts always sum to exactly `cap` and no
 * phase is handed a fraction of a call. Never exceeds what was asked.
 */
function distribute(funded: Map<string, number>, keys: readonly string[], cap: number): void {
  const asked = keys.map((key) => funded.get(key) ?? 0);
  const askedSum = asked.reduce((total, want) => total + want, 0);
  if (askedSum <= 0 || cap <= 0) {
    for (const key of keys) funded.set(key, 0);
    return;
  }
  const given = asked.map((want) => Math.floor((cap * want) / askedSum));
  let left = cap - given.reduce((total, part) => total + part, 0);
  const order = keys
    .map((key, index) => ({ index, want: asked[index]! }))
    .sort((a, b) => b.want - a.want);
  while (left > 0) {
    let moved = false;
    for (const entry of order) {
      if (left <= 0) break;
      if (given[entry.index]! < asked[entry.index]!) {
        given[entry.index]! += 1;
        left -= 1;
        moved = true;
      }
    }
    if (!moved) break;
  }
  keys.forEach((key, index) => funded.set(key, given[index]!));
}

/** Use explicit singular and plural forms. */
function plural(count: number, one: string, many: string): string {
  return count + ' ' + (count === 1 ? one : many);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

/**
 * A retention span in days, clamped for a config that bypassed the patch
 * schema (E21): `rookery config set` writes anything, so the night clamps
 * what it reads rather than trusting what was written. A hundred years is
 * the ceiling - beyond that the caller means "never sweep", and a negative
 * span would instead sweep everything, every night.
 */
function clampDays(value: number): number {
  const days = Number.isFinite(value) ? Math.round(value) : 0;
  return Math.min(36_500, Math.max(0, days));
}

/* ---------------------------- the dream's helpers ---------------------------- */

/**
 * What the wake test (5.5c) found, or why it could not look.
 *
 * `drift` and `observed` are null in exactly one case: fewer frames closed
 * than `dream.calibrationTraces` asks for. The night then reports what it
 * offered, what closed and what abstained, and freezes nothing - the numbers
 * are the finding.
 */
interface WakeTestReport {
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

/** Frames one night reads: the pool `framesFor` walks, oldest first. */
const DREAM_POOL_LIMIT = 500;

/**
 * Frames the admission check compares coverage over - the newest slice of
 * the pool. Both arms are counted the same way over the same sample, which
 * is the whole of what `admit` asks for; the full pool would double the
 * evaluation's work for a predicate.
 */
const ADMISSION_SAMPLE = 50;

/** Ids per label read: SQLite takes at most 999 bound parameters. */
const LABEL_BATCH = 200;

/** How deep into the version history a proposal may still be offered from. */
const PROPOSAL_WINDOW = 50;

/**
 * How long one night lasts for the run-global model-call ceiling. With
 * `sleep.scope: 'all'` the runtime runs the due banks sequentially in one
 * loop, so they all draw on one wallet; half a day of quiet opens a new one.
 */
const DREAM_NIGHT_WINDOW_MS = 12 * 60 * 60 * 1000;

/** Every field of a proposed point comes from the dream, by construction. */
const DREAM_ORIGIN: RecallPolicy['origin'] = {
  limit: 'dream',
  threshold: 'dream',
  hopEntity: 'dream',
  hopEdge: 'dream',
  relevance: 'dream',
  importance: 'dream',
  recency: 'dream',
  usage: 'dream',
};

/**
 * A grid placement is a point, not a policy: it carries the four weights and
 * the four knobs and nothing else. `kinds` and `minImportance` come from the
 * incumbent, because they are SQL filters rather than scoring terms and
 * widening either would admit rows the frame never fetched (concept 3.4).
 */
function liftPolicy(placement: FrameScoringPolicy, incumbent: RecallPolicy): RecallPolicy {
  return {
    limit: Math.round(placement.limit ?? incumbent.limit),
    threshold: placement.threshold ?? incumbent.threshold,
    w: placement.w ?? incumbent.w,
    hopEntity: placement.hopEntity ?? incumbent.hopEntity,
    hopEdge: placement.hopEdge ?? incumbent.hopEdge,
    kinds: incumbent.kinds,
    minImportance: incumbent.minImportance,
    origin: DREAM_ORIGIN,
  };
}

/**
 * The `params` blob a promoted version stores, in exactly the shape
 * `resolvePolicy` reads back (`POLICY_FIELDS`, dream/promote.ts). A key the
 * resolver never looks at could not change behaviour and does not belong in
 * a version row.
 */
function paramsOf(policy: FrameScoringPolicy, incumbent: RecallPolicy): Record<string, unknown> {
  const point = liftPolicy(policy, incumbent);
  return {
    limit: point.limit,
    threshold: point.threshold,
    hopEntity: point.hopEntity,
    hopEdge: point.hopEdge,
    w: { ...point.w },
  };
}

/** A stored `params` blob back to a policy point, or null if it cannot be read. */
function policyFromParams(
  params: Record<string, unknown>,
  incumbent: RecallPolicy,
): RecallPolicy | null {
  const read = (source: Record<string, unknown> | undefined, key: string): number | null => {
    const value = source?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const weights = params.w;
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) return null;
  const w = weights as Record<string, unknown>;

  const limit = read(params, 'limit');
  const threshold = read(params, 'threshold');
  const hopEntity = read(params, 'hopEntity');
  const hopEdge = read(params, 'hopEdge');
  const relevance = read(w, 'relevance');
  const importance = read(w, 'importance');
  const recency = read(w, 'recency');
  const usage = read(w, 'usage');
  if (
    limit === null || threshold === null || hopEntity === null || hopEdge === null ||
    relevance === null || importance === null || recency === null || usage === null
  ) {
    return null;
  }
  return {
    limit: Math.round(limit),
    threshold,
    w: { relevance, importance, recency, usage },
    hopEntity,
    hopEdge,
    kinds: incumbent.kinds,
    minImportance: incumbent.minImportance,
    origin: DREAM_ORIGIN,
  };
}

/**
 * A wall-clock span in milliseconds, clamped for a config that bypassed the
 * patch schema (E21), like `clampDays` above. An hour is the ceiling: past
 * that the night is no longer a night.
 */
function clampMs(value: number): number {
  const ms = Number.isFinite(value) ? Math.round(value) : 0;
  return Math.min(3_600_000, Math.max(0, ms));
}

/** A count of things, clamped, and never below one: zero would mean "always". */
function clampCount(value: number): number {
  const count = Number.isFinite(value) ? Math.round(value) : 0;
  return Math.max(1, Math.min(1_000_000, count));
}

/** A delta with its sign, the way the evidence digest prints one. */
function signedNumber(value: number): string {
  if (!Number.isFinite(value)) return 'an unreadable amount';
  return (value >= 0 ? '+' : '') + value.toFixed(4);
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

/**
 * How close a correction's wording has to be to a skill before it counts as
 * being about that skill. Low on purpose: a correction and the procedure it
 * bears on rarely share many words, and the cost of a false match is one
 * reading that concludes "leave it alone", while the cost of a miss is a skill
 * that goes on being wrong.
 */
const CORRECTION_MATCH = 0.12;

/** Which suspect gets the night's attention first. */
function weigh(entry: { changed: unknown[]; failures: unknown[]; corrections: unknown[] }): number {
  // Being told outright beats a failed run, which beats shifted ground.
  return entry.corrections.length * 4 + entry.failures.length * 2 + entry.changed.length;
}

/** A task or an error trimmed to the part that still says something. */
function clipText(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max) + ' [...]';
}
