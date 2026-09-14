import { EventEmitter } from 'node:events';
import {
  ASSISTANT_MEMORY_OWNER,
  type AgentEvent,
  type CronTrigger,
  type EntityKind,
  type MemoryKind,
  type MemoryRecord,
  type MemoryRelation,
  type Provider,
  type ProviderId,
  type RookeryConfig,
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

export interface SleepRunnerOptions {
  store: Store;
  registry: ProviderRegistry;
  config: RookeryConfig;
  logger?: Logger;
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

export class SleepRunner extends EventEmitter {
  readonly #store: Store;
  readonly #registry: ProviderRegistry;
  readonly #config: RookeryConfig;
  readonly #log: Logger;
  /** One night at a time per bank. */
  readonly #running = new Map<string, AbortController>();

  constructor(options: SleepRunnerOptions) {
    super();
    this.#store = options.store;
    this.#registry = options.registry;
    this.#config = options.config;
    this.#log = options.logger ?? silentLogger;
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
   */
  undo(runId: string): { woken: number; removed: number; edges: number; skills: number } | null {
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
      modelCalls: 0,
    };
    let error: string | undefined;

    try {
      const providerId = await this.#resolveProvider(input.provider);
      const settings = this.#config.memory.sleep;
      const cycles = Math.max(1, Math.min(Math.round(settings.cycles), 5));
      const provider = providerId ? this.#registry.get(providerId) : null;
      const model = providerId ? settings.model.trim() || smallModelFor(providerId) : undefined;
      const insightModel = settings.insightModel.trim() || model;
      counters.readCount = this.#store.liveMemories(owner).length;

      if (!provider) {
        this.#log.warn('Sleep ran without a provider; only light sleep happened', { owner });
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
          controller.signal,
        );
        counters.replayedCount += replayed.read;
        counters.learnedCount += replayed.learned;
        counters.modelCalls += replayed.calls;
        // The bank changed, so the figure the run reports as "looked at" has
        // to be taken after the harvest, not before it.
        counters.readCount = this.#store.liveMemories(owner).length;
        this.#phase(run.id, 'replay', counters, 1);
        this.#throwIfAborted(controller.signal);
      }

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
        if (!provider) continue;

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
          share(settings.maxMergeCalls, cycles, cycle, 'early'),
        );
        counters.mergedCount += condensed.merged;
        counters.dormantCount += condensed.retired;
        counters.modelCalls += condensed.calls;

        // Contradictions the previous cycle (or an earlier night) turned up.
        const settled = await this.#resolve(
          provider,
          model,
          owner,
          run.id,
          controller.signal,
          share(settings.maxResolveCalls, cycles, cycle, 'late'),
        );
        counters.resolvedCount += settled.resolved;
        counters.dormantCount += settled.retired;
        counters.mergedCount += settled.merged;
        counters.modelCalls += settled.calls;
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
          share(3, cycles, cycle, 'late'),
        );
        counters.edgeCount += linked.edges;
        counters.conflictCount += linked.conflicts;
        counters.modelCalls += linked.calls;

        // Insights come last, once the bank is as tidy as it will get tonight.
        if (cycle === cycles) {
          const insight = await this.#reflect(provider, insightModel, owner, run.id, controller.signal);
          counters.insightCount += insight.written;
          counters.edgeCount += insight.edges;
          counters.modelCalls += insight.calls;

          // And after the insights, the two steps that leave something behind
          // outside the bank. Repair comes first on purpose: a procedure that
          // has gone stale is actively misleading whoever opens it next,
          // which is worth more than a ninth procedure nobody asked for.
          const revised = await this.#revise(provider, insightModel, owner, run.id, controller.signal);
          counters.skillRevisedCount += revised.written;
          counters.modelCalls += revised.calls;

          const practised = await this.#practise(provider, insightModel, owner, run.id, controller.signal);
          counters.skillCount += practised.written;
          counters.modelCalls += practised.calls;
        }
        this.#phase(run.id, 'rem', counters, cycle);
        this.#throwIfAborted(controller.signal);
      }

      this.#store.recountEntities(owner);
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
        report: describeSleep(counters),
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
   */
  async #replay(
    provider: Provider,
    triageModel: string | undefined,
    deepModel: string | undefined,
    owner: string,
    runId: string,
    signal: AbortSignal,
  ): Promise<{ read: number; learned: number; corrections: number; calls: number }> {
    const budget = this.#config.memory.sleep.replaySessions;
    const idle = { read: 0, learned: 0, corrections: 0, calls: 0 };
    // Only the assistant's own bank. An agent learns from its assignments,
    // which its controller already extracts from, and there is no user in
    // those transcripts to quote.
    if (budget <= 0 || signal.aborted || owner !== ASSISTANT_MEMORY_OWNER) return idle;

    const since = this.#store.lastSleepAt(owner);
    const sessions = this.#store.sessionsActiveSince(since, 50);
    if (!sessions.length) return idle;

    let read = 0;
    let learned = 0;
    let corrections = 0;
    let calls = 0;

    for (const session of sessions) {
      if (signal.aborted || read >= budget) break;

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
        this.#store.addCorrection({ owner, text, quote, sessionId: session.id });
        corrections += 1;
      }

      this.#log.info('Replayed a conversation', {
        session: session.id,
        title: session.title,
        learned,
        corrections,
      });
    }

    return { read, learned, corrections, calls };
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
  ): Promise<{ merged: number; retired: number; calls: number }> {
    let merged = 0;
    let retired = 0;
    let calls = 0;

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
        retired += 1;
      }
      merged += 1;
    }

    return { merged, retired, calls };
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
      .listMemories({ owner, since: since || undefined, limit: 60, includeDormant: false })
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
    }

    return { edges, conflicts, calls };
  }

  /* ------------------------------ phase 5 ------------------------------ */

  /**
   * The part that makes it a memory rather than a filing cabinet: notice
   * something across the week that no single memory says. Strictly bounded -
   * one call, at most a couple of sentences, and each one has to point at
   * the evidence it came from or it is thrown away.
   */
  async #reflect(
    provider: Provider,
    model: string | undefined,
    owner: string,
    runId: string,
    signal: AbortSignal,
  ): Promise<{ written: number; edges: number; calls: number }> {
    const wanted = this.#config.memory.sleep.insights;
    if (wanted <= 0 || signal.aborted) return { written: 0, edges: 0, calls: 0 };

    const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recent = this.#store
      .listMemories({ owner, since: week, limit: 40, includeDormant: false })
      .filter((memory) => memory.kind !== 'insight');
    if (recent.length < 4) return { written: 0, edges: 0, calls: 0 };

    const entities = this.#store.listEntities({ owner, limit: 12, minMentions: 2 });
    const numbered = recent
      .map((memory, index) => index + 1 + '. [' + memory.kind + '] ' + memory.content)
      .join('\n');
    const topics = entities.length
      ? '\n\nCOMMON TOPICS:\n' + entities.map((entity) => '- ' + entity.name).join('\n')
      : '';

    const raw = await ask(
      provider,
      INSIGHT_PROMPT.replace('{{MAX}}', String(wanted)) +
        '\n\nMEMORIES FROM RECENT DAYS:\n' + numbered + topics,
      model,
      signal,
    );
    const parsed = parseObject(raw);
    const proposed = parsed && Array.isArray(parsed.insights) ? parsed.insights : [];

    let written = 0;
    let edges = 0;
    for (const entry of proposed.slice(0, wanted)) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      const content = typeof row.content === 'string' ? row.content.trim() : '';
      if (content.length < 12 || content.length > 400) continue;
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

    return { written, edges, calls: 1 };
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
  async #revise(
    provider: Provider,
    model: string | undefined,
    owner: string,
    runId: string,
    signal: AbortSignal,
  ): Promise<{ written: number; calls: number }> {
    const budget = this.#config.memory.sleep.skillRevisions;
    if (budget <= 0 || signal.aborted) return { written: 0, calls: 0 };

    const store = new SkillStore(this.#config.skillsDir);
    const mine = store
      .for(owner === ASSISTANT_MEMORY_OWNER ? 'assistant' : 'agent')
      // Neither the user's own skills nor the ones Rookery ships are the
      // night's to rewrite, so there is no point spending a model call
      // deciding that they should be - the store would refuse the write.
      .filter((skill) => skill.origin === 'agent' || skill.origin === 'sleep');
    if (!mine.length) return { written: 0, calls: 0 };

    // Corrections the night's replay pulled out of the day's conversations.
    // Unlike the other two signals these do not arrive attached to a skill, so
    // each is matched against the shelf by wording - the same lexical judgement
    // the rest of this file uses, and enough to tell "always run the tests
    // first" from a remark about the mail client.
    const open = this.#store.openCorrections(owner, 20);
    const consumed = new Set<string>();

    const suspects = mine
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
      .sort((a, b) => weigh(b) - weigh(a))
      .slice(0, budget);

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
  ): Promise<{ written: number; calls: number }> {
    const wanted = this.#config.memory.sleep.skills;
    if (wanted <= 0 || signal.aborted) return { written: 0, calls: 0 };

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

Reply ONLY with JSON, no prose or code fence:
{"edges":[{"from":1,"to":4,"relation":"refines","weight":0.8}],
 "entities":[{"name":"Rookery","kind":"project"}]}
An empty result is {"edges":[],"entities":[]}`;

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

const INSIGHT_PROMPT = `You are reflecting on a personal assistant's memory overnight.

The memories below come from recent days. What stands out BEYOND the individual sentences?
Look for a pattern, habit, common thread or connection that no single sentence states.

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
