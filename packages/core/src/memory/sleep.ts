import { EventEmitter } from 'node:events';
import {
  ASSISTANT_MEMORY_OWNER,
  type AgentEvent,
  type CronTrigger,
  type MemoryEdge,
  type MemoryRecord,
  type Message,
  type ProviderId,
  type RookeryConfig,
  type Session,
  type SleepRun,
  type SleepStage,
  type ToolServerAudience,
} from '../types.js';
import { silentLogger, type Logger } from '../logger.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Store } from './store.js';
import { parseCandidates, smallModelFor } from './extractor.js';
import { admitCandidates, confirmedBy, linkEntities, normalizeTokens, similarity } from './gate.js';
import { recall } from './recall.js';
import { locateTurn } from './dream/label.js';
import { NIGHT_PHASES, type NightPhase } from './dream/slots.js';
import { SkillStore, type Skill } from '../skills/store.js';
import { DreamPhase, type DreamSitting, type NightCounters, type PromotionHook } from './sleep-dream.js';
import {
  CONDENSE_PROMPT,
  INSIGHT_USER_PROMPT,
  INSIGHT_WORK_PROMPT,
  LINK_PROMPT,
  REPLAY_PROMPT,
  RESOLVE_PROMPT,
  REVISE_PROMPT,
  SKILL_PROMPT,
  TRIAGE_PROMPT,
} from './sleep-prompts.js';
import { DAY_MS, clamp01, clampDays, clampMs } from './sleep-limits.js';
import { ask, clipText, parseObject, type PhaseScope, type Voice } from './sleep-model.js';
import { describeSleep, plural } from './sleep-report.js';
import {
  MAX_MERGED_TAGS,
  isProtected,
  readAliases,
  readCondensed,
  readCorrectionClaims,
  readEntityKinds,
  readInsightDrafts,
  readMergeVerdict,
  readProposedEdges,
  readRevision,
  readSkillDrafts,
  unionTags,
  type InsightDraft,
  type MergeVerdict,
  type SkillDraft,
} from './sleep-verdicts.js';

export { describeSleep } from './sleep-report.js';
export { parseObject } from './sleep-model.js';
export type { PromotionHook, PromotionNotice } from './sleep-dream.js';

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
  reason: 'gate' | 'entities' | 'restated';
}

/** Every counter the run carries; the phases move them as they finish. */
type NightTally = NightCounters &
  Pick<
    SleepRun,
    | 'readCount'
    | 'replayedCount'
    | 'learnedCount'
    | 'mergedCount'
    | 'dormantCount'
    | 'edgeCount'
    | 'insightCount'
    | 'skillCount'
    | 'skillRevisedCount'
    | 'conflictCount'
    | 'resolvedCount'
  >;

/** What one phase spent and what it got back for it. */
interface PhaseSpend {
  calls: number;
  value: number;
}

/** One night in progress: whose bank, which run, and everything the phases book on the way. */
interface Night {
  readonly owner: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  /** How many times light, deep and rem repeat. */
  readonly cycles: number;
  readonly tally: NightTally;
  /**
   * Calls and payoff per phase, as this night actually spent them - the
   * raw material of the `budget` slot (concept 7.1). Measured every night,
   * carried only when `dream.slots` says so.
   */
  readonly spend: Record<NightPhase, PhaseSpend>;
  /**
   * The dream lines the stored report carries beyond `describeSleep`, among
   * them the import/reindex invalidation notice, whose numbers live only in
   * the probe result (concept 3.3).
   */
  reportSuffix: string;
  /**
   * Label passes that failed and were skipped instead of ending the night
   * (10.5). Counted here because both writers sit inside phases that must
   * go on without them.
   */
  labelFailures: number;
}

/** The models a night speaks to, all behind one provider. */
interface NightVoices {
  triage: Voice;
  deep: Voice;
  insight: Voice;
}

/** What the cycles need that only a night with a provider has. */
interface NightPlan {
  voices: NightVoices;
  budgets: NightBudgets;
}

/** A contradiction pair neither side of which has been settled yet. */
interface OpenContradiction {
  edge: MemoryEdge;
  a: MemoryRecord;
  b: MemoryRecord;
}

/** One replayed conversation: its messages, and what the user alone said in it. */
interface Conversation {
  session: Session;
  messages: Message[];
  said: string;
}

/** What reading one conversation again yielded, and cost. */
interface SessionReading {
  read: number;
  learned: number;
  corrections: number;
  calls: number;
}

/** What the replay hands back to the night. */
interface ReplayResult extends SessionReading {
  /** Corrections that yielded at least one label - the precision reader. */
  labelled: number;
  /** Label rows written; part of `sleep_runs.dream_labels_written`. */
  labels: number;
  /** Label passes that failed and were skipped rather than thrown (10.5). */
  labelFailures: number;
}

interface CondenseResult {
  merged: number;
  retired: number;
  calls: number;
  labels: number;
  /** Label passes that failed and were skipped rather than thrown (10.5). */
  labelFailures: number;
}

/** What deciding one contradiction changed. */
interface Settlement {
  resolved: number;
  retired: number;
  merged: number;
}

/** Nothing decided: the model gave no usable answer, or the pair had to wait. */
const UNSETTLED: Settlement = { resolved: 0, retired: 0, merged: 0 };

interface ResolveResult extends Settlement {
  calls: number;
}

interface LinkResult {
  edges: number;
  conflicts: number;
  calls: number;
}

interface ReflectResult {
  written: number;
  edges: number;
  calls: number;
}

/** A skill with a live reason to be looked at, and every reason it has. */
interface SkillSuspect {
  skill: Skill;
  /** Sources that were replaced, put to sleep or edited since the skill was written. */
  changed: { memory: MemoryRecord; replacement: MemoryRecord | null }[];
  /** Runs that had the skill open and then failed. */
  failures: { task: string; error: string }[];
  /** Open corrections whose wording bears on the skill. */
  corrections: { id: string; text: string; quote: string }[];
}

export class SleepRunner extends EventEmitter {
  readonly #store: Store;
  readonly #registry: ProviderRegistry;
  readonly #config: RookeryConfig;
  readonly #log: Logger;
  /** One night at a time per bank. */
  readonly #running = new Map<string, AbortController>();
  /** The dream's half of the night: measuring, labelling and proposing. */
  readonly #dreaming: DreamPhase;

  constructor(options: SleepRunnerOptions) {
    super();
    this.#store = options.store;
    this.#registry = options.registry;
    this.#config = options.config;
    this.#log = options.logger ?? silentLogger;
    this.#dreaming = new DreamPhase({
      store: this.#store,
      config: this.#config,
      logger: this.#log,
      onPromotion: options.onPromotion,
    });
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

    const run = this.#store.createSleepRun({ owner, trigger: input.trigger ?? 'manual' });
    const controller = new AbortController();
    const stopFollowing = followSignal(input.signal, controller);
    this.#running.set(owner, controller);
    this.#announce(run, 'started');
    this.#log.info('Sleep started', { owner, run: run.id });

    const night = this.#openNight(owner, run.id, controller.signal);
    let error: string | undefined;
    try {
      await this.#sleepThrough(night, input.provider);
    } catch (cause) {
      error = (cause as Error).message;
      this.#log.warn('Sleep phase failed', { owner, error });
    } finally {
      // Hygiene is not work the night can fail at: it runs after a finished,
      // a failed and a cancelled night alike, or a night that keeps failing
      // would keep the verbatim frame store past its window (R17).
      error ??= this.#tidyAfterNight(owner);
      this.#running.delete(owner);
      stopFollowing();
    }
    return this.#closeRun(run, night, error);
  }

  #openNight(owner: string, runId: string, signal: AbortSignal): Night {
    const cycles = Math.max(1, Math.min(Math.round(this.#config.memory.sleep.cycles), MAX_CYCLES));
    return {
      owner,
      runId,
      signal,
      cycles,
      tally: emptyTally(),
      spend: emptySpend(),
      reportSuffix: '',
      labelFailures: 0,
    };
  }

  /**
   * The night's work, in order. A phase that throws ends it here; whatever
   * finished before stays done.
   */
  async #sleepThrough(night: Night, requested: ProviderId | undefined): Promise<void> {
    const { owner, runId, tally } = night;
    const voices = await this.#gatherVoices(night.signal, requested);
    tally.readCount = this.#store.liveMemories(owner).length;
    if (!voices) {
      this.#log.warn('Sleep ran without a provider; only light sleep happened', { owner });
    }

    // The replay comes first, because the read has to happen before anything
    // else: what the night harvests there should be condensed tonight, not
    // tomorrow.
    if (voices) await this.#replayDay(night, voices);
    const plan = voices ? { voices, budgets: this.#fundNight(owner) } : null;

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
    night.reportSuffix += await this.#dream(owner, runId, tally, night.signal);

    for (let cycle = 1; cycle <= night.cycles; cycle += 1) {
      this.#lightSleep(night, cycle);
      if (!plan) continue;
      await this.#deepSleep(night, plan, cycle);
      await this.#remSleep(night, plan, cycle);
    }

    this.#dreaming.measureSlots(owner, night.spend);
  }

  /** The three models the night talks to; null when no provider is usable. */
  async #gatherVoices(signal: AbortSignal, requested: ProviderId | undefined): Promise<NightVoices | null> {
    const providerId = await this.#resolveProvider(requested);
    const provider = providerId ? this.#registry.get(providerId) : null;
    if (!providerId || !provider) return null;

    const settings = this.#config.memory.sleep;
    const deepModel = settings.model.trim() || smallModelFor(providerId);
    const insightModel = settings.insightModel.trim() || deepModel;
    const voice = (model: string | undefined): Voice => ({ provider, model, signal, log: this.#log });
    return {
      triage: voice(smallModelFor(providerId)),
      deep: voice(deepModel),
      insight: voice(insightModel),
    };
  }

  /**
   * Replay: the day, read again and properly, before the cycles - so
   * tonight's harvest is condensed tonight, not tomorrow.
   */
  async #replayDay(night: Night, voices: NightVoices): Promise<void> {
    const { owner, runId, tally } = night;
    const sessions = this.#replayCandidates(owner);
    this.#phase(runId, 'replay', tally, 1);
    const replayed = await this.#replay({ owner, runId, voice: voices.deep }, voices.triage, sessions);
    tally.replayedCount += replayed.read;
    tally.learnedCount += replayed.learned;
    tally.modelCalls += replayed.calls;
    tally.dreamLabelsWritten += replayed.labels;
    night.labelFailures += replayed.labelFailures;
    night.reportSuffix += this.#dreaming.correctionPrecision(replayed);
    // The bank changed, so the figure the run reports as "looked at" has
    // to be taken after the harvest, not before it.
    tally.readCount = this.#store.liveMemories(owner).length;
    this.#phase(runId, 'replay', tally, 1);
    this.#throwIfAborted(night.signal);
  }

  /**
   * The night's wallet is filled by need, not by the clock, and it is
   * filled after the replay, not before it. The re-read grows the bank,
   * surfaces contradictions and pulls corrections out of the day's words,
   * and that is precisely the work the later phases exist to do; a budget
   * measured before the read funds the night for a quieter day than the one
   * it just had. The arithmetic is database-only, but it is not free:
   * #demand clusters the living bank pair by pair, and the dream probe that
   * follows reads and scores every stored frame. Both carry their own
   * ceilings (#demand's phase budgets, the probe's dream.maxEvalMs), so
   * "measures itself" means "costs up to a declared bound", never "costs
   * nothing".
   */
  #fundNight(owner: string): NightBudgets {
    const settings = this.#config.memory.sleep;
    const demand = this.#demand(owner, this.#store.liveMemories(owner));
    const budgets = allocateNightBudget(demand, settings.nightBudget, {
      condense: settings.maxMergeCalls,
      resolve: settings.maxResolveCalls,
      link: settings.maxLinkCalls,
      reflect: settings.insights > 0 ? INSIGHT_ANGLES.length : 0,
      revise: settings.skillRevisions,
      practise: settings.skills,
    });
    this.#log.info('Night measured', { owner, demand, budgets });
    return budgets;
  }

  /** Light sleep: bookkeeping, no model, costs nothing. */
  #lightSleep(night: Night, cycle: number): void {
    const { owner, runId, tally } = night;
    this.#phase(runId, 'light', tally, cycle);
    if (cycle === 1) {
      this.#attachOrphanEntities(owner);
      tally.dormantCount += this.#decay(runId, this.#store.liveMemories(owner));
    }
    this.#store.recountEntities(owner);
    this.#throwIfAborted(night.signal);
  }

  /**
   * Catch up anything written before the graph existed: its tags are there,
   * its entities are not. Pure bookkeeping, no model call.
   */
  #attachOrphanEntities(owner: string): void {
    const orphans = this.#store.memoriesWithoutEntities(owner);
    for (const memory of orphans) linkEntities(this.#store, owner, memory.id, memory.tags);
    if (orphans.length) {
      this.#log.info('Attached entities to memories that had none', { owner, count: orphans.length });
    }
  }

  /**
   * Deep sleep: filing. What repeats becomes one, what cannot both be true
   * gets decided.
   */
  async #deepSleep(night: Night, plan: NightPlan, cycle: number): Promise<void> {
    const { owner, runId, tally } = night;
    const scope: PhaseScope = { owner, runId, voice: plan.voices.deep };
    this.#phase(runId, 'deep', tally, cycle);

    const clusters = this.#cluster(owner, this.#store.liveMemories(owner));
    const condensed = await this.#condense(
      scope,
      clusters,
      share(plan.budgets.condense, night.cycles, cycle, 'early'),
    );
    tally.mergedCount += condensed.merged;
    tally.dormantCount += condensed.retired;
    tally.modelCalls += condensed.calls;
    tally.dreamLabelsWritten += condensed.labels;
    night.labelFailures += condensed.labelFailures;
    bookSpend(night, 'condense', condensed.calls, condensed.merged);

    // Contradictions the previous cycle (or an earlier night) turned up.
    const settled = await this.#resolve(scope, share(plan.budgets.resolve, night.cycles, cycle, 'late'));
    tally.resolvedCount += settled.resolved;
    tally.dormantCount += settled.retired;
    tally.mergedCount += settled.merged;
    tally.modelCalls += settled.calls;
    bookSpend(night, 'resolve', settled.calls, settled.resolved);

    this.#phase(runId, 'deep', tally, cycle);
    this.#throwIfAborted(night.signal);
  }

  /**
   * Dream sleep: the loose, associative part. Connections across distance,
   * and what the week adds up to.
   */
  async #remSleep(night: Night, plan: NightPlan, cycle: number): Promise<void> {
    const { owner, runId, tally } = night;
    this.#phase(runId, 'rem', tally, cycle);

    const scope: PhaseScope = { owner, runId, voice: plan.voices.deep };
    const linked = await this.#link(scope, share(plan.budgets.link, night.cycles, cycle, 'late'));
    tally.edgeCount += linked.edges;
    tally.conflictCount += linked.conflicts;
    tally.modelCalls += linked.calls;
    bookSpend(night, 'link', linked.calls, linked.edges);

    // Insights come last, once the bank is as tidy as it will get tonight.
    if (cycle === night.cycles) {
      await this.#recordInsights(night, plan);
      await this.#writeCandidates(night, plan);
      await this.#tendSkills(night, plan);
    }

    this.#phase(runId, 'rem', tally, cycle);
    this.#throwIfAborted(night.signal);
  }

  async #recordInsights(night: Night, plan: NightPlan): Promise<void> {
    const { owner, runId, tally } = night;
    const insight = await this.#reflect({ owner, runId, voice: plan.voices.insight }, plan.budgets.reflect);
    tally.insightCount += insight.written;
    tally.edgeCount += insight.edges;
    tally.modelCalls += insight.calls;
    bookSpend(night, 'reflect', insight.calls, insight.written);
  }

  /**
   * The candidate writer (concept 6.2, 9.4). Here, and not earlier: the
   * order is deliberate - first it has to be settled how well the search
   * control works, then procedures get rewritten. Its wallet is run-global
   * (`dream.maxCallsPerNight` across ALL owners), because with
   * `sleep.scope: 'all'` the runtime runs one night per bank and a per-run
   * ceiling would multiply by the owner count. What it writes are
   * proposals, not policies: the night that measures them is the next one,
   * above the provider guard, which is what keeps the promotion path
   * model-free.
   */
  async #writeCandidates(night: Night, plan: NightPlan): Promise<void> {
    const { owner, runId, tally } = night;
    const proposed = await this.#dreaming.propose(
      { owner, runId, voice: plan.voices.deep },
      this.#dreaming.remainingCalls(),
    );
    tally.dreamCandidates += proposed.written;
    tally.modelCalls += proposed.calls;
    this.#dreaming.bookCalls(proposed.calls);
  }

  /**
   * After the insights, the two steps that leave something behind outside
   * the bank. Repair comes first on purpose: a procedure that has gone stale
   * is actively misleading whoever opens it next, which is worth more than a
   * ninth procedure nobody asked for.
   */
  async #tendSkills(night: Night, plan: NightPlan): Promise<void> {
    const { owner, runId, tally } = night;
    const scope: PhaseScope = { owner, runId, voice: plan.voices.insight };

    const revised = await this.#revise(scope, plan.budgets.revise);
    tally.skillRevisedCount += revised.written;
    tally.modelCalls += revised.calls;
    bookSpend(night, 'revise', revised.calls, revised.written);

    const practised = await this.#practise(scope, plan.budgets.practise);
    tally.skillCount += practised.written;
    tally.modelCalls += practised.calls;
    bookSpend(night, 'practise', practised.calls, practised.written);
  }

  /**
   * What closes every night, whatever became of its work: entity counts are
   * brought up to date and the dream's retention clocks run. Never throws;
   * the failure, if any, comes back for the run to carry.
   */
  #tidyAfterNight(owner: string): string | undefined {
    try {
      this.#store.recountEntities(owner);
      this.#sweepRetention();
      return undefined;
    } catch (cause) {
      const error = (cause as Error).message;
      this.#log.warn('Sleep tidy-up failed', { owner, error });
      return error;
    }
  }

  /**
   * The dream's two retention clocks (concept 8.7, S21). Frames and the
   * episode index go after `frameRetainDays`, because both point at verbatim
   * text - a frame quotes the rows it froze, an episode points straight at
   * journal steps. Traces, touches, labels and evaluations go after
   * `retainDays`: they are small, they carry the calibration, and none of
   * them holds a word anybody wrote. Every sweep runs in batches of 500 with
   * its own transaction, so the one connection is never locked for long.
   * Hygiene, not measurement: this runs with the dream switched off too,
   * because a verbatim store must not outlive its retention window just
   * because measuring was turned off (R17).
   */
  #sweepRetention(): void {
    const dream = this.#config.memory.dream;
    const now = Date.now();
    const frameBefore = now - clampDays(dream.frameRetainDays) * DAY_MS;
    const traceBefore = now - clampDays(dream.retainDays) * DAY_MS;
    this.#store.sweepDreamFrames(frameBefore);
    this.#store.sweepDreamEpisodes(frameBefore);
    this.#store.sweepDreamTraces(traceBefore);
    this.#store.sweepDreamLabels(traceBefore);
    this.#store.sweepDreamEvals(traceBefore);
  }

  #closeRun(run: SleepRun, night: Night, error: string | undefined): SleepRun {
    const finished = Date.now();
    const updated =
      this.#store.updateSleepRun(run.id, {
        ...night.tally,
        status: error ? 'failed' : 'done',
        finishedAt: finished,
        durationMs: finished - run.startedAt,
        report: describeSleep(night.tally) + night.reportSuffix + labelFailureNote(night.labelFailures),
        error,
      }) ?? run;

    this.#announce(updated, 'finished');
    this.#log.info('Sleep finished', {
      owner: night.owner,
      run: run.id,
      status: updated.status,
      merged: night.tally.mergedCount,
      dormant: night.tally.dormantCount,
      calls: night.tally.modelCalls,
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
    const condense = this.#cluster(owner, live).length;
    const resolve = this.#openContradictions(owner).length;
    const link = Math.ceil(this.#freshMemories(owner).length / LINK_PORTION);
    // One pass per angle, on purpose: one looks for patterns in the user, one
    // in the work - neither prompt sees the other's angle.
    const reflect =
      settings.insights > 0 && this.#reflectionDue(owner) ? INSIGHT_ANGLES.length : 0;
    const revise = this.#skillSuspects(owner).length;
    const practise = settings.skills > 0 && live.length >= MIN_PRACTISE_MEMORIES ? 1 : 0;

    return { condense, resolve, link, reflect, revise, practise };
  }

  /** What this bank learned since its last finished night, and still stands. */
  #freshMemories(owner: string): MemoryRecord[] {
    const since = this.#store.lastSleepAt(owner);
    return this.#store
      .listMemories({ owner, since: since || undefined, limit: FRESH_LIMIT, includeDormant: false })
      .filter((memory) => !memory.supersededBy);
  }

  /** What the insight window holds that is not itself an insight. */
  #reflectPool(owner: string): MemoryRecord[] {
    const since = Date.now() - this.#config.memory.sleep.insightWindowDays * DAY_MS;
    return this.#store
      .listMemories({ owner, since, limit: REFLECT_POOL_LIMIT, includeDormant: false })
      .filter((memory) => memory.kind !== 'insight');
  }

  /**
   * Whether the insight window holds enough to look for a pattern in, and
   * something the last insight pass had not read. Asked again over the same
   * memories plus a day's three, the model words yesterday's insight a
   * little differently, and the bank fills with paraphrases of itself.
   */
  #reflectionDue(owner: string): boolean {
    const pool = this.#reflectPool(owner);
    if (pool.length < MIN_REFLECT_POOL) return false;
    const reflectedUntil = newestCreation(this.#insightsOnRecord(owner));
    return pool.some((memory) => memory.createdAt > reflectedUntil);
  }

  /** The insights already standing in the bank. */
  #insightsOnRecord(owner: string): MemoryRecord[] {
    return this.#store.listMemories({
      owner,
      kinds: ['insight'],
      limit: ON_RECORD_LIMIT,
      includeDormant: false,
    });
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
    for (const session of this.#store.sessionsActiveSince(since, REPLAY_SCAN)) {
      // Nothing was said, or barely: "thanks" followed by "you're welcome"
      // holds nothing durable no matter how expensively it is read.
      if (userTurns(this.#store.getMessages(session.id)).length < MIN_SPOKEN_TURNS) continue;
      candidates.push(session);
      if (candidates.length >= budget) break;
    }
    return candidates;
  }

  /** Contradiction pairs neither side of which has been settled yet. */
  #openContradictions(owner: string): OpenContradiction[] {
    const open: OpenContradiction[] = [];
    for (const edge of this.#store.listEdges(owner, CONTRADICTION_SCAN)) {
      if (edge.relation !== 'contradicts') continue;
      const sides = this.#openSides(edge);
      if (sides) open.push({ edge, ...sides });
    }
    return open;
  }

  /**
   * Both memories of a contradiction as they stand right now, or null when a
   * side is gone or asleep. A pair with a sleeping side is already settled;
   * skipping it is also what stops the same contradiction being re-decided
   * every night - and, read again just before each decision, what stops a
   * memory that lost one contradiction a moment ago from being put in front
   * of the model, or merged, in the next.
   */
  #openSides(edge: MemoryEdge): { a: MemoryRecord; b: MemoryRecord } | null {
    const a = this.#store.getMemory(edge.srcId);
    const b = this.#store.getMemory(edge.dstId);
    if (!a || !b || a.dormantAt || b.dormantAt || a.forgotten || b.forgotten) return null;
    return { a, b };
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
  async #replay(scope: PhaseScope, triage: Voice, sessions: Session[]): Promise<ReplayResult> {
    // Corrections written from here on are this replay's, whatever else the
    // owner's table already holds - the label pass reads them back by id
    // afterwards, because `addCorrection` hands none out.
    const since = Date.now();
    // Only the assistant's own bank. An agent learns from its assignments,
    // which its controller already extracts from, and there is no user in
    // those transcripts to quote. The candidate list arrives pre-measured
    // from `#replayCandidates`, which applied the same two-turn filter the
    // budget was sized against.
    if (scope.voice.signal.aborted || scope.owner !== ASSISTANT_MEMORY_OWNER || !sessions.length) {
      return { read: 0, learned: 0, corrections: 0, labelled: 0, labels: 0, labelFailures: 0, calls: 0 };
    }

    const total = { read: 0, learned: 0, corrections: 0, calls: 0 };
    for (const session of sessions) {
      if (scope.voice.signal.aborted) break;
      const reading = await this.#replaySession(scope, triage, session);
      total.read += reading.read;
      total.learned += reading.learned;
      total.corrections += reading.corrections;
      total.calls += reading.calls;
    }

    // One pass over what the night just wrote, once every session is read:
    // the labels need the correction ids, and those only exist in the table.
    const written = this.#dreaming.writeCorrectionLabels(scope.owner, sessions, since);
    return {
      ...total,
      labelled: written.labelled,
      labels: written.labels,
      labelFailures: written.failed,
    };
  }

  async #replaySession(scope: PhaseScope, triage: Voice, session: Session): Promise<SessionReading> {
    const messages = this.#store.getMessages(session.id).filter((message) => message.content.trim());
    const spoken = userTurns(messages);
    // Nothing was said, or barely: no model needed to know there is nothing
    // durable in "thanks" followed by "you're welcome".
    if (spoken.length < MIN_SPOKEN_TURNS) return { read: 0, learned: 0, corrections: 0, calls: 0 };
    if (!(await this.#worthReading(triage, spoken))) {
      return { read: 0, learned: 0, corrections: 0, calls: 1 };
    }

    const conversation: Conversation = {
      session,
      messages,
      said: spoken.map((message) => message.content).join('\n'),
    };
    const transcript = messages
      .map(
        (message) =>
          (message.role === 'user' ? 'USER: ' : 'ASSISTANT: ') + clipText(message.content, TURN_CLIP_CHARS),
      )
      .join('\n\n');
    const raw = await ask(
      scope.voice,
      REPLAY_PROMPT +
        '\n\nCURRENT DATE: ' + isoDay(Date.now()) +
        '\n\nALREADY KNOWN:\n' + this.#knownFor(scope.owner, conversation.said) +
        '\n\nTHE CONVERSATION:\n' + clipText(transcript, TRANSCRIPT_CHARS),
    );

    const parsed = parseObject(raw);
    const learned = this.#admitReplayed(scope, conversation, parsed);
    const corrections = this.#recordCorrections(scope, conversation, parsed);
    this.#log.info('Replayed a conversation', {
      session: session.id,
      title: session.title,
      learned,
      corrections,
    });
    return { read: 1, learned, corrections, calls: 2 };
  }

  /**
   * Triage, on the user's turns alone and heavily clipped. The question is
   * only "is there anything here worth a proper look", and the assistant's
   * side cannot answer that - nothing it said may back a memory anyway.
   */
  async #worthReading(triage: Voice, spoken: Message[]): Promise<boolean> {
    const verdict = await ask(
      triage,
      TRIAGE_PROMPT + '\n\nWHAT THE USER SAID:\n' +
        spoken.map((message) => '- ' + clipText(message.content, TRIAGE_CLIP_CHARS)).join('\n'),
    );
    return parseObject(verdict)?.worth === true;
  }

  /** Run what the deep read found through the same gate as the day's extraction. */
  #admitReplayed(
    scope: PhaseScope,
    { session, said }: Conversation,
    parsed: Record<string, unknown> | null,
  ): number {
    const candidates = parseCandidates(JSON.stringify(parsed?.memories ?? []));
    if (!candidates.length) return 0;
    const admitted = admitCandidates(this.#store, {
      candidates,
      owner: scope.owner,
      config: this.#config.memory,
      // The user's words only, exactly as during the day.
      sources: [said],
      sourceSessionId: session.id,
      sleepRunId: scope.runId,
    });
    if (admitted.rejected.length) {
      this.#log.debug('Replay gate rejected candidates', {
        session: session.id,
        reasons: admitted.rejected.map((entry) => entry.reason).join(','),
      });
    }
    return admitted.stored.length;
  }

  /**
   * Write down what the user corrected. A correction has to be quotable too:
   * "The user seemed unhappy" is not a correction, it is a mood.
   */
  #recordCorrections(
    scope: PhaseScope,
    { session, messages, said }: Conversation,
    parsed: Record<string, unknown> | null,
  ): number {
    let recorded = 0;
    for (const { text, quote } of readCorrectionClaims(parsed)) {
      if (!confirmedBy(quote, [said])) continue;
      // From the session reference to the turn reference (concept 4.2a,
      // step 1): exactly one user message carries the quote, or there is
      // no turn. `locateTurn` reads the same containment test that just
      // admitted the quote, so the two can never disagree.
      const located = locateTurn(messages, quote);
      this.#store.addCorrection({
        owner: scope.owner,
        text,
        quote,
        sessionId: session.id,
        ...(located.turnId ? { turnId: located.turnId } : {}),
      });
      recorded += 1;
    }
    return recorded;
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
    const cutoff = now - sleep.dormantAfterDays * DAY_MS;
    let count = 0;

    for (const memory of live) {
      if (isProtected(memory)) continue;
      // Never put something to sleep that has not had a fair chance to be used.
      if (memory.createdAt > cutoff) continue;
      const lastTouch = memory.lastAccessedAt ?? memory.createdAt;
      if (lastTouch > cutoff) continue;
      const recency = Math.pow(0.5, (now - memory.updatedAt) / RECENCY_HALF_LIFE_MS);
      const strength =
        IMPORTANCE_WEIGHT * memory.importance +
        USEFULNESS_WEIGHT * memory.usefulness +
        RECENCY_WEIGHT * recency;
      if (strength >= sleep.minStrength) continue;
      this.#store.sleepMemory(memory.id, { runId });
      count += 1;
    }
    return count;
  }

  /* ------------------------------ phase 2 ------------------------------ */

  /**
   * Everything the night may fold together: insights that restate one
   * another first, then what the links and the entities say belongs
   * together. A restated insight leaves the second pass, so one memory
   * never stands in two clusters of the same night.
   */
  #cluster(owner: string, live: MemoryRecord[]): Cluster[] {
    const restated = this.#restatedInsights(live);
    const taken = new Set(restated.flatMap((cluster) => cluster.members.map((member) => member.id)));
    const linked = this.#clusterByLinks(owner, live.filter((memory) => !taken.has(memory.id)));
    return [...restated, ...linked];
  }

  /**
   * Insights that say the same thing in other words, one cluster per
   * observation. Their own source rather than a third kind of pair in
   * `#clusterByLinks`: those clusters are unions over shared entities, which
   * pull a dozen unrelated insights into one pile that is cut at eight and
   * that no model will fold, while a restated observation is a small, tight
   * group the condensation can actually merge. Oldest first, so the oldest
   * wording seeds the group.
   */
  #restatedInsights(live: MemoryRecord[]): Cluster[] {
    const groups: { members: MemoryRecord[]; tokens: Set<string>[] }[] = [];
    for (const insight of live.filter((memory) => memory.kind === 'insight')) {
      const tokens = normalizeTokens(insight.content);
      const group = groups.find((candidate) =>
        candidate.tokens.some((other) => similarity(tokens, other) >= INSIGHT_RESTATEMENT_SIMILARITY),
      );
      if (group) {
        group.members.push(insight);
        group.tokens.push(tokens);
      } else {
        groups.push({ members: [insight], tokens: [tokens] });
      }
    }
    return groups
      .filter((group) => group.members.length >= 2)
      .map((group) => ({ members: group.members.slice(0, CLUSTER_LIMIT), reason: 'restated' as const }))
      .filter((cluster) => !cluster.members.every(isProtected))
      .sort((a, b) => b.members.length - a.members.length);
  }

  /**
   * Group what belongs together, without asking anyone.
   *
   * Two sources: pairs the write gate already flagged as similar-but-not-the
   * same, and pairs that share at least two entities. Union-find turns those
   * pairs into groups; groups of one are not groups, and anything over eight
   * is too big to judge in one call and gets cut.
   */
  #clusterByLinks(owner: string, live: MemoryRecord[]): Cluster[] {
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
    for (const edge of this.#store.listEdges(owner, CO_OCCURRENCE_SCAN)) {
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
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const members = group.slice(0, CLUSTER_LIMIT);
      // A cluster made only of protected memories has nothing the night may
      // do - and neither has one whose first eight are, which would only
      // cost a call that retires nobody.
      if (members.every(isProtected)) continue;
      clusters.push({
        members,
        reason: group.some((memory) => gatePairs.has(memory.id)) ? 'gate' : 'entities',
      });
    }
    // Biggest first: the largest pile is where condensing pays most.
    return clusters.sort((a, b) => b.members.length - a.members.length);
  }

  /* ------------------------------ phase 3 ------------------------------ */

  /** Fold each cluster into one sentence, or leave it alone. One call each. */
  async #condense(scope: PhaseScope, clusters: Cluster[], budget: number): Promise<CondenseResult> {
    const result = { merged: 0, retired: 0, calls: 0 };
    /**
     * Victim id to the condensed row that took its place - the one hop the
     * `merge` label source is allowed to walk (concept 4.2c, S7). Collected
     * as they are written, never re-read off the bank afterwards: a second
     * query would pick up supersessions from earlier nights too, and a label
     * that walks that far has stopped describing the prompt it observed.
     */
    const superseded = new Map<string, string>();

    for (const cluster of clusters) {
      if (result.calls >= budget || scope.voice.signal.aborted) break;
      result.calls += 1;
      const raw = await ask(scope.voice, CONDENSE_PROMPT + '\n\nMEMORIES:\n' + describeCluster(cluster.members));
      const verdict = readMergeVerdict(parseObject(raw), cluster.members);
      if (!verdict) continue;

      const { into, retired } = this.#writeCondensed(scope, verdict);
      for (const id of retired) superseded.set(id, into);
      result.retired += retired.length;
      result.merged += 1;
    }

    const written = this.#dreaming.writeMergeLabels(scope.owner, superseded);
    return { ...result, labels: written.labels, labelFailures: written.failed };
  }

  /** Write the condensed sentence and file its sources away, each under it. */
  #writeCondensed(scope: PhaseScope, verdict: MergeVerdict): { into: string; retired: string[] } {
    const { owner, runId } = scope;
    const record = this.#store.upsertMemory({
      kind: verdict.kind,
      content: verdict.content,
      tags: verdict.tags,
      importance: verdict.importance,
      owner,
      origin: 'sleep',
      sleepRunId: runId,
    });
    // `upsertMemory` reinforces a row that already says exactly this sentence,
    // and that row can be one of the memories being replaced. It then IS the
    // condensed memory: filing it away as superseded by itself would lose
    // the sentence and its sources together.
    const victims = verdict.victims.filter((victim) => victim.id !== record.id);
    // The condensed memory inherits the entities of everything it replaces,
    // so the graph keeps its shape when the originals fall asleep.
    for (const victim of victims) {
      this.#carryEntities(victim.id, record.id);
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
    }
    return { into: record.id, retired: victims.map((victim) => victim.id) };
  }

  /** Link every entity of one memory to another, so the graph follows a rewrite. */
  #carryEntities(fromMemoryId: string, toMemoryId: string): void {
    for (const entity of this.#store.entitiesFor(fromMemoryId)) {
      this.#store.linkEntity(toMemoryId, entity.id);
    }
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
  async #resolve(scope: PhaseScope, budget: number): Promise<ResolveResult> {
    const result = { resolved: 0, retired: 0, merged: 0, calls: 0 };

    for (const { edge } of this.#openContradictions(scope.owner)) {
      if (scope.voice.signal.aborted) break;
      const sides = this.#openSides(edge);
      if (!sides) continue;
      const { a, b } = sides;

      // Both untouchable: the user has to sort this one out.
      if (isProtected(a) && isProtected(b)) continue;

      // Exactly one untouchable: it wins, and it costs nothing to know that.
      if (isProtected(a) || isProtected(b)) {
        const winner = isProtected(a) ? a : b;
        this.#retire(scope, winner === a ? b : a, winner);
        result.resolved += 1;
        result.retired += 1;
        continue;
      }

      if (result.calls >= budget) break;
      result.calls += 1;
      const settlement = await this.#askSettlement(scope, { edge, a, b });
      result.resolved += settlement.resolved;
      result.retired += settlement.retired;
      result.merged += settlement.merged;
    }

    return result;
  }

  /** Put one contradiction to the model and act on its decision. */
  async #askSettlement(scope: PhaseScope, { edge, a, b }: OpenContradiction): Promise<Settlement> {
    const raw = await ask(scope.voice, RESOLVE_PROMPT + '\n\nTHE TWO SENTENCES:\n' + describePair(a, b));
    const parsed = parseObject(raw);
    const decision = typeof parsed?.decision === 'string' ? parsed.decision : '';

    if (decision === 'first' || decision === 'second') {
      const winner = decision === 'first' ? a : b;
      this.#retire(scope, winner === a ? b : a, winner);
      return { resolved: 1, retired: 1, merged: 0 };
    }
    if (decision === 'merge') return this.#mergeContradiction(scope, a, b, parsed?.content);
    if (decision === 'both') {
      // Not a real contradiction after all. Drop the claim rather than
      // leaving a red line in the graph that says something untrue.
      this.#store.deleteEdge(edge.id);
      return { resolved: 1, retired: 0, merged: 0 };
    }
    return UNSETTLED;
  }

  /** Both sides were half right: one new sentence takes both places. */
  #mergeContradiction(scope: PhaseScope, a: MemoryRecord, b: MemoryRecord, content: unknown): Settlement {
    const merged = readCondensed(content);
    if (!merged) return UNSETTLED;
    const record = this.#store.upsertMemory({
      kind: a.kind,
      content: merged,
      tags: unionTags([...a.tags, ...b.tags], MAX_MERGED_TAGS),
      importance: clamp01(Math.max(a.importance, b.importance)),
      owner: scope.owner,
      origin: 'sleep',
      sleepRunId: scope.runId,
    });
    // As in `#writeCondensed`: when the sentence is one a side already says,
    // that side stands as the merged memory and only the other is filed away.
    const losers = [a, b].filter((side) => side.id !== record.id);
    for (const loser of losers) {
      this.#carryEntities(loser.id, record.id);
      this.#retire(scope, loser, record);
    }
    return { resolved: 1, retired: losers.length, merged: 1 };
  }

  /** File one side of a settled pair away, with the trail that says why. */
  #retire(scope: PhaseScope, loser: MemoryRecord, winner: MemoryRecord): void {
    this.#store.addEdge({
      owner: scope.owner,
      srcId: winner.id,
      dstId: loser.id,
      relation: 'supersedes',
      weight: 1,
      origin: 'sleep',
      runId: scope.runId,
    });
    this.#store.sleepMemory(loser.id, { runId: scope.runId, supersededBy: winner.id });
  }

  /* ------------------------------ phase 4 ------------------------------ */

  /**
   * Draw the relations between what is new and what was already there, and
   * give the entities their proper kind. Contradictions are counted and
   * reported; deciding which side is right is the user's call, never the
   * night's.
   */
  async #link(scope: PhaseScope, budget: number): Promise<LinkResult> {
    const result = { edges: 0, conflicts: 0, calls: 0 };

    for (const portion of chunk(this.#linkPool(scope.owner), LINK_PORTION)) {
      if (result.calls >= budget || scope.voice.signal.aborted) break;
      if (portion.length < 2) continue;
      result.calls += 1;
      const raw = await ask(scope.voice, LINK_PROMPT + '\n\nMEMORIES:\n' + numberMemories(portion));
      const parsed = parseObject(raw);
      if (!parsed) continue;

      const drawn = this.#drawEdges(scope, parsed, portion);
      result.edges += drawn.edges;
      result.conflicts += drawn.conflicts;
      // Entity clean-up rides along in the same reply: a name that is really
      // a person or a tool stops being an anonymous topic.
      this.#retypeEntities(scope.owner, parsed);
      this.#mergeAliases(scope.owner, parsed);
    }

    return result;
  }

  /**
   * The new memories plus the neighbours they might relate to, so
   * "contradicts" can actually be found rather than only guessed. Empty when
   * there is nothing new to relate.
   */
  #linkPool(owner: string): MemoryRecord[] {
    const fresh = this.#freshMemories(owner);
    if (fresh.length < 2) return [];

    const entityIds = [
      ...new Set(fresh.flatMap((memory) => this.#store.entitiesFor(memory.id).map((entity) => entity.id))),
    ];
    const neighbours = this.#store.memoriesForEntities(entityIds, {
      // The link table has no owner column, so a stray cross-owner link
      // would otherwise walk the night into another bank.
      owner,
      exclude: fresh.map((memory) => memory.id),
      limit: NEIGHBOUR_LIMIT,
    });
    return [...fresh, ...neighbours];
  }

  #drawEdges(
    scope: PhaseScope,
    parsed: Record<string, unknown>,
    portion: readonly MemoryRecord[],
  ): { edges: number; conflicts: number } {
    let edges = 0;
    let conflicts = 0;
    for (const proposed of readProposedEdges(parsed, portion)) {
      const edge = this.#store.addEdge({
        owner: scope.owner,
        srcId: proposed.from.id,
        dstId: proposed.to.id,
        relation: proposed.relation,
        weight: proposed.weight,
        origin: 'sleep',
        runId: scope.runId,
      });
      if (!edge) continue;
      edges += 1;
      if (proposed.relation === 'contradicts') conflicts += 1;
    }
    return { edges, conflicts };
  }

  #retypeEntities(owner: string, parsed: Record<string, unknown>): void {
    for (const { name, kind } of readEntityKinds(parsed)) {
      const existing = this.#store.findEntity(owner, name);
      if (!existing) continue;
      this.#store.upsertEntity({ owner, name: existing.name, kind });
    }
  }

  /**
   * The other half of a tidy graph: two names that mean one thing
   * ("Rookery", "Rookery-Agent") become one node, links and all. A merge that
   * would not hold - one side missing, both the same - is refused by the
   * store and costs the night nothing.
   */
  #mergeAliases(owner: string, parsed: Record<string, unknown>): void {
    for (const { from, into } of readAliases(parsed)) {
      if (this.#store.mergeEntities(owner, from, into)) {
        this.#log.info('Merged duplicate entities', { owner, from, into });
      }
    }
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
  async #reflect(scope: PhaseScope, budget: number): Promise<ReflectResult> {
    const wanted = this.#config.memory.sleep.insights;
    const result = { written: 0, edges: 0, calls: 0 };
    if (wanted <= 0 || budget <= 0 || scope.voice.signal.aborted) return result;

    const { owner } = scope;
    const recent = this.#reflectPool(owner);
    if (recent.length < MIN_REFLECT_POOL) return result;

    // An insight that is already on record is not knowledge gained, and
    // neither is one worded differently. Two guards, because a model told
    // to say something new still rewords last night's pattern when the pool
    // is last night's pool plus a day: the pass only runs when something
    // new is in the pool, and an insight has to stand on at least one such
    // memory. Both angles write against the same list, so a sentence from
    // earlier tonight is a restatement too.
    const onRecord = this.#insightsOnRecord(owner);
    const reflectedUntil = newestCreation(onRecord);
    if (!recent.some((memory) => memory.createdAt > reflectedUntil)) return result;
    const stated = onRecord.map((insight) => normalizeTokens(insight.content));

    const topics = this.#store.listEntities({ owner, limit: COMMON_TOPICS, minMentions: 2 });
    const material =
      '\n\nMEMORIES FROM RECENT DAYS:\n' + numberMemories(recent) +
      (topics.length ? '\n\nCOMMON TOPICS:\n' + topics.map((entity) => '- ' + entity.name).join('\n') : '') +
      (onRecord.length ? '\n\nALREADY ON RECORD:\n' + listNewestInsights(onRecord) : '');

    for (const angle of INSIGHT_ANGLES) {
      if (result.calls >= budget || result.written >= wanted || scope.voice.signal.aborted) break;
      const room = wanted - result.written;
      const prompt = angle === 'user' ? INSIGHT_USER_PROMPT : INSIGHT_WORK_PROMPT;
      result.calls += 1;
      const raw = await ask(scope.voice, prompt.replace('{{MAX}}', String(room)) + material);

      for (const draft of readInsightDrafts(parseObject(raw), recent, room)) {
        if (!standsOnNews(draft, reflectedUntil) || restates(draft.content, stated)) continue;
        result.edges += this.#writeInsight(scope, draft);
        stated.push(normalizeTokens(draft.content));
        result.written += 1;
      }
    }

    return result;
  }

  /** Write one insight and tie it to the memories it stands on; how many edges that made. */
  #writeInsight(scope: PhaseScope, draft: InsightDraft): number {
    const { owner, runId } = scope;
    const record = this.#store.upsertMemory({
      kind: 'insight',
      content: draft.content,
      tags: unionTags(draft.evidence.flatMap((memory) => memory.tags), MAX_INSIGHT_TAGS),
      importance: draft.importance,
      owner,
      origin: 'sleep',
      sleepRunId: runId,
    });
    let edges = 0;
    for (const memory of draft.evidence) {
      this.#carryEntities(memory.id, record.id);
      // The insight refines its evidence, so recall can walk from either end.
      const edge = this.#store.addEdge({
        owner,
        srcId: record.id,
        dstId: memory.id,
        relation: 'refines',
        weight: INSIGHT_EDGE_WEIGHT,
        origin: 'sleep',
        runId,
      });
      if (edge) edges += 1;
    }
    return edges;
  }

  /* ------------------------------ phase 6 ------------------------------ */

  /**
   * Every skill of this bank that has a live reason to be looked at, worst
   * first. Pure database and lexical work - no model - so the demand
   * measurement can call it as often as it likes.
   */
  #skillSuspects(owner: string): SkillSuspect[] {
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
    const open = this.#store.openCorrections(owner, OPEN_CORRECTIONS);

    return mine
      .map((skill) => {
        // Looking counts as clearing, so the window opens at whichever came
        // last: the file being written, or the night last reading it.
        const since = Math.max(skill.updatedAt, this.#store.lastSkillReviewAt(skill.name));
        const changed = this.#store.changedSkillSources(skill.name, since);
        const failures = this.#store.failedRunsForSkill(skill.name, since, FAILED_RUNS_SHOWN);
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
  async #revise(scope: PhaseScope, budget: number): Promise<{ written: number; calls: number }> {
    const result = { written: 0, calls: 0 };
    if (budget <= 0 || scope.voice.signal.aborted) return result;

    const consumed = new Set<string>();
    for (const suspect of this.#skillSuspects(scope.owner).slice(0, budget)) {
      if (scope.voice.signal.aborted) break;
      for (const entry of suspect.corrections) consumed.add(entry.id);
      result.calls += 1;
      if (await this.#reviseSkill(scope, suspect)) result.written += 1;
    }

    // Looked at is looked at, whatever came of it: a correction that has been
    // weighed must not be weighed again tomorrow.
    this.#store.consumeCorrections([...consumed]);
    return result;
  }

  /** Put one suspect skill in front of the model; whether it was rewritten. */
  async #reviseSkill(scope: PhaseScope, suspect: SkillSuspect): Promise<boolean> {
    const { owner, runId } = scope;
    const { skill, changed, failures } = suspect;
    const raw = await ask(
      scope.voice,
      REVISE_PROMPT +
        '\n\nTHE SKILL AS IT READS NOW:\nname: ' + skill.name +
        '\ndescription: ' + skill.description +
        '\n\n' + skill.body +
        '\n\nWHAT HAS CHANGED SINCE IT WAS WRITTEN:\n' + describeWhy(suspect),
    );
    const revision = readRevision(parseObject(raw), skill);
    const store = new SkillStore(this.#config.skillsDir);

    if (!revision) {
      // Reviewed and left alone. The snapshot carries no run id: there is
      // nothing for undo to take back, but the timestamp still closes the
      // window so tomorrow does not ask the same question again.
      this.#store.snapshotSkill({ skill: skill.name, content: store.raw(skill.name) });
      this.#settleSources(skill.name, owner, changed);
      this.#log.info('Sleep reviewed a skill and left it', { owner, skill: skill.name });
      return false;
    }

    try {
      this.#store.snapshotSkill({ skill: skill.name, content: store.raw(skill.name), sleepRunId: runId });
      store.save({
        name: skill.name,
        description: revision.description,
        body: revision.body,
        audience: skill.audience,
        origin: 'sleep',
      });
      this.#settleSources(skill.name, owner, changed);
      this.#log.info('Sleep revised a skill', {
        owner,
        skill: skill.name,
        changed: changed.length,
        failures: failures.length,
      });
      return true;
    } catch (cause) {
      this.#log.info('Sleep left a skill alone', { owner, skill: skill.name, reason: (cause as Error).message });
      return false;
    }
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
  #settleSources(skill: string, owner: string, changed: SkillSuspect['changed']): void {
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
  async #practise(scope: PhaseScope, budget: number): Promise<{ written: number; calls: number }> {
    const wanted = this.#config.memory.sleep.skills;
    const none = { written: 0, calls: 0 };
    if (wanted <= 0 || budget <= 0 || scope.voice.signal.aborted) return none;

    // What this bank holds, strongest first. Insights are deliberately in:
    // they are precisely the "this keeps happening" observations a procedure
    // grows out of.
    const live = this.#store
      .listMemories({ owner: scope.owner, limit: PRACTISE_POOL_LIMIT, includeDormant: false })
      .filter((memory) => memory.kind !== 'summary');
    if (live.length < MIN_PRACTISE_MEMORIES) return none;

    const existing = new SkillStore(this.#config.skillsDir).for(
      scope.owner === ASSISTANT_MEMORY_OWNER ? 'assistant' : 'agent',
    );
    const shelf = existing.length
      ? existing.map((skill) => '- ' + skill.name + ' (' + skill.origin + '): ' + skill.description).join('\n')
      : '(nothing yet)';

    const raw = await ask(
      scope.voice,
      SKILL_PROMPT.replace('{{MAX}}', String(wanted)) +
        '\n\nSKILLS THAT ALREADY EXIST:\n' + shelf +
        '\n\nWHAT THIS MEMORY HOLDS:\n' + numberMemories(live),
    );

    let written = 0;
    for (const draft of readSkillDrafts(parseObject(raw), live.length, wanted)) {
      const sourceIds = draft.evidence.map((index) => live[index - 1]!.id);
      if (this.#writeSkill(scope, draft, sourceIds)) written += 1;
    }
    return { written, calls: 1 };
  }

  /** Write one new skill and remember what it stands on; whether the store took it. */
  #writeSkill(scope: PhaseScope, draft: SkillDraft, sourceIds: string[]): boolean {
    const { owner, runId } = scope;
    const { name, description, body } = draft;
    // Whose shelf this is. The assistant's bank writes skills the assistant
    // may open; an agent's bank writes skills for agents.
    const audience: ToolServerAudience = owner === ASSISTANT_MEMORY_OWNER ? 'assistant' : 'agents';
    const store = new SkillStore(this.#config.skillsDir);
    try {
      // The snapshot goes in first and carries the run id: writing a skill
      // is part of the night, so undoing the night has to take it back.
      // Null content says the skill did not exist, which is how undo knows
      // to delete rather than restore.
      this.#store.snapshotSkill({ skill: name, content: store.raw(name), sleepRunId: runId });
      const skill = store.save({ name, description, body, audience, origin: 'sleep' });
      // What it stands on, kept: this is what lets a later night notice
      // that the ground under this procedure has moved.
      this.#store.setSkillSources(skill.name, owner, sourceIds);
      this.#log.info('Sleep wrote a skill', { owner, skill: skill.name, evidence: sourceIds.length });
      return true;
    } catch (cause) {
      // Almost always "that name belongs to the user". Not worth failing a
      // night over; the night simply does not get that name.
      this.#log.info('Sleep left a skill alone', { owner, skill: name, reason: (cause as Error).message });
      return false;
    }
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
   * why the candidate writer sits at the far end of the night (`#writeCandidates`)
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

    const sitting: DreamSitting = {
      owner,
      runId,
      counters,
      deadline: Date.now() + clampMs(dream.maxEvalMs),
      signal,
    };
    this.#phase(runId, 'dream', counters, 1);
    const report = await this.#dreaming.measure(sitting);
    this.#phase(runId, 'dream', counters, 1);
    return report;
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


/* ------------------------------- helpers ------------------------------- */

/** The most cycles of light, deep and rem one night may run. */
const MAX_CYCLES = 5;

/** One link call reads up to this many memories in one portion. */
const LINK_PORTION = 25;

/** The two angles insights are looked for from, one call each. */
const INSIGHT_ANGLES = ['user', 'work'] as const;

/** Fewer recent memories than this have no pattern worth a call. */
const MIN_REFLECT_POOL = 4;

/** Fewer memories than this hold no recurring work worth writing down. */
const MIN_PRACTISE_MEMORIES = 6;

/** A real conversation has at least this many user turns. */
const MIN_SPOKEN_TURNS = 2;

/** Newest fresh memories a night looks at. */
const FRESH_LIMIT = 150;

/** Conversations the replay scan looks back over. */
const REPLAY_SCAN = 150;

/** Most memories the insight window reads. */
const REFLECT_POOL_LIMIT = 80;

/** Most insights already on record that a new one is compared against. */
const ON_RECORD_LIMIT = 200;

/** Insights already on record that the prompt shows, newest first. */
const ON_RECORD_SHOWN = 30;

/**
 * Dice similarity at which a new insight counts as a restatement of one on
 * record. Read off one bank's sixty-five insights: the nearest earlier one
 * had a median similarity of 0.34 and one insight in five reached 0.5, among
 * them the same observation reworded on consecutive nights. Lower would also
 * turn away distinct insights that merely share a subject's vocabulary.
 */
const INSIGHT_RESTATEMENT_SIMILARITY = 0.5;

/** Entities offered to the insight prompt as common topics. */
const COMMON_TOPICS = 12;

/** Most memories one skill distillation reads. */
const PRACTISE_POOL_LIMIT = 60;

/** Neighbouring memories the link pass adds to what is fresh. */
const NEIGHBOUR_LIMIT = 40;

/** Edges read when looking for open contradictions. */
const CONTRADICTION_SCAN = 500;

/** Edges read when looking for pairs the gate flagged. */
const CO_OCCURRENCE_SCAN = 2000;

/** More members than this are too many to judge in one call. */
const CLUSTER_LIMIT = 8;

/** Corrections matched against the skill shelf per night. */
const OPEN_CORRECTIONS = 20;

/** Failed runs shown to the model per skill. */
const FAILED_RUNS_SHOWN = 3;

const MAX_INSIGHT_TAGS = 6;
const INSIGHT_EDGE_WEIGHT = 0.8;

/** When the newest of these memories was written; zero for none. */
function newestCreation(memories: readonly MemoryRecord[]): number {
  return memories.reduce((newest, memory) => Math.max(newest, memory.createdAt), 0);
}

/** The newest insights as bullet lines, the way the prompt lists what is on record. */
function listNewestInsights(insights: readonly MemoryRecord[]): string {
  return [...insights]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, ON_RECORD_SHOWN)
    .map((insight) => '- ' + insight.content)
    .join('\n');
}

/** Whether an insight stands on at least one memory written after the last pass. */
function standsOnNews(draft: InsightDraft, reflectedUntil: number): boolean {
  return draft.evidence.some((memory) => memory.createdAt > reflectedUntil);
}

/** Whether an insight says what one already on record says, in other words or the same. */
function restates(content: string, stated: readonly Set<string>[]): boolean {
  const tokens = normalizeTokens(content);
  return stated.some((other) => similarity(tokens, other) >= INSIGHT_RESTATEMENT_SIMILARITY);
}

/** How much of one turn, and of a whole conversation, the deep read sees. */
const TURN_CLIP_CHARS = 2500;
const TRANSCRIPT_CHARS = 24_000;

/** How much of one user turn the triage sees. */
const TRIAGE_CLIP_CHARS = 220;

/**
 * How close a correction's wording has to be to a skill before it counts as
 * being about that skill. Low on purpose: a correction and the procedure it
 * bears on rarely share many words, and the cost of a false match is one
 * reading that concludes "leave it alone", while the cost of a miss is a skill
 * that goes on being wrong.
 */
const CORRECTION_MATCH = 0.12;

/**
 * How strong a memory is: what it claims to be worth, what it has
 * demonstrably been worth, and how recently it was touched, blended 5:3:2.
 * Recency halves every thirty days.
 */
const IMPORTANCE_WEIGHT = 0.5;
const USEFULNESS_WEIGHT = 0.3;
const RECENCY_WEIGHT = 0.2;
const RECENCY_HALF_LIFE_MS = 30 * DAY_MS;

function emptyTally(): NightTally {
  return {
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
    // here or `tally.dreamFramesScored` is a type error before anything
    // ever increments it. `dreamCandidates` is written by the candidate
    // writer alone.
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
}

function emptySpend(): Record<NightPhase, PhaseSpend> {
  return Object.fromEntries(
    NIGHT_PHASES.map((phase) => [phase, { calls: 0, value: 0 }]),
  ) as Record<NightPhase, PhaseSpend>;
}

function bookSpend(night: Night, phase: NightPhase, calls: number, value: number): void {
  night.spend[phase].calls += calls;
  night.spend[phase].value += value;
}

/** Abort `controller` when `signal` does; the returned function stops listening. */
function followSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    controller.abort();
    return () => undefined;
  }
  const onAbort = (): void => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/**
 * Said out loud rather than swallowed: the consolidation went on, and the
 * night is short of labels it expected to have.
 */
function labelFailureNote(failures: number): string {
  if (failures <= 0) return '';
  return (
    ' ' + plural(failures, 'label pass', 'label passes') +
    ' failed and left no labels; the consolidation went on.'
  );
}

/** The turns where the user actually said something. */
function userTurns(messages: readonly Message[]): Message[] {
  return messages.filter((message) => message.role === 'user' && message.content.trim());
}

/** A moment as the calendar day the prompts name. */
function isoDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/** Memories as the numbered list the prompts refer to by number. */
function numberMemories(memories: readonly MemoryRecord[]): string {
  return memories
    .map((memory, index) => index + 1 + '. [' + memory.kind + '] ' + memory.content)
    .join('\n');
}

/** A cluster as the numbered list the condense prompt decides over. */
function describeCluster(members: readonly MemoryRecord[]): string {
  return members
    .map((memory, index) => {
      const lock = isProtected(memory) ? ' [protected]' : '';
      return (
        index + 1 + '. [' + memory.kind + ', ' + memory.importance.toFixed(2) + ', ' +
        isoDay(memory.createdAt) + ']' + lock + ' ' + memory.content
      );
    })
    .join('\n');
}

function describePair(a: MemoryRecord, b: MemoryRecord): string {
  return (
    '1. [' + a.kind + ', ' + isoDay(a.createdAt) + '] ' + a.content +
    '\n2. [' + b.kind + ', ' + isoDay(b.createdAt) + '] ' + b.content
  );
}

/** What has changed under a skill, as the lines the revise prompt weighs. */
function describeWhy({ changed, corrections, failures }: SkillSuspect): string {
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
  return why.join('\n');
}

/** Which suspect gets the night's attention first. */
function weigh(entry: { changed: unknown[]; failures: unknown[]; corrections: unknown[] }): number {
  // Being told outright beats a failed run, which beats shifted ground.
  return entry.corrections.length * 4 + entry.failures.length * 2 + entry.changed.length;
}
