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
} from '../types.js';
import { silentLogger, type Logger } from '../logger.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { entitySlug, type Store } from './store.js';
import { smallModelFor } from './extractor.js';
import { linkEntities, normalizeTokens, similarity } from './gate.js';
import { MEMORY_KINDS } from './recall.js';

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
 * A night is not one uniform chore. It runs in cycles of three stages, the
 * way sleep actually does:
 *
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

  /** Roll back one night. Delegated to the store, which does it atomically. */
  undo(runId: string): { woken: number; removed: number; edges: number } | null {
    const result = this.#store.undoSleepRun(runId);
    if (result) {
      const run = this.#store.getSleepRun(runId);
      if (run) this.#announce(run, 'undone');
      this.#log.info('Sleep run undone', { run: runId, ...result });
    }
    return result;
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
      mergedCount: 0,
      dormantCount: 0,
      edgeCount: 0,
      insightCount: 0,
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
          const lock = isProtected(memory) ? ' [geschuetzt]' : '';
          return (
            index + 1 + '. [' + memory.kind + ', ' + memory.importance.toFixed(2) + ', ' + date + ']' +
            lock + ' ' + memory.content
          );
        })
        .join('\n');

      const raw = await ask(provider, CONDENSE_PROMPT + '\n\nERINNERUNGEN:\n' + numbered, model, signal);
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
      const raw = await ask(provider, RESOLVE_PROMPT + '\n\nDIE BEIDEN SAETZE:\n' + pair, model, signal);
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
      const raw = await ask(provider, LINK_PROMPT + '\n\nERINNERUNGEN:\n' + numbered, model, signal);
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
      ? '\n\nHAEUFIGE THEMEN:\n' + entities.map((entity) => '- ' + entity.name).join('\n')
      : '';

    const raw = await ask(
      provider,
      INSIGHT_PROMPT.replace('{{MAX}}', String(wanted)) +
        '\n\nERINNERUNGEN DER LETZTEN TAGE:\n' + numbered + topics,
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

  /* ------------------------------ internals ------------------------------ */

  async #resolveProvider(wanted?: ProviderId): Promise<ProviderId | null> {
    try {
      return await this.#registry.resolveUsable(wanted ?? this.#config.defaultProvider);
    } catch {
      return null;
    }
  }

  #throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new Error('Der Schlaflauf wurde abgebrochen.');
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

const CONDENSE_PROMPT = `Du raeumst nachts das Langzeitgedaechtnis eines persoenlichen Assistenten auf.

Unten stehen Erinnerungen, die dasselbe Thema betreffen. Entscheide, ob sie EINEN Sachverhalt
beschreiben, der sich zu einem Satz zusammenfassen laesst.

Fasse NUR zusammen, wenn:
- die Saetze wirklich denselben Sachverhalt meinen, oder
- ein neuerer Satz einen aelteren ueberholt (dann gilt der neuere).

Fasse NICHT zusammen, wenn es verschiedene Sachverhalte sind, die nur dasselbe Stichwort teilen.
Im Zweifel nicht zusammenfassen - Trennen kostet nichts, falsches Verschmelzen verliert Wissen.

Regeln:
- Das Ergebnis ist EIN vollstaendiger Satz, verstaendlich ohne jeden weiteren Kontext.
- Schreibe in derselben Sprache wie die Vorlagen.
- Nenne unter "supersedes" die Nummern der Erinnerungen, die der neue Satz vollstaendig ersetzt.
- Mit [geschuetzt] markierte Erinnerungen darfst du NIE unter "supersedes" nennen. Sie sind nur Kontext.
- Nenne keine Nummer, deren Inhalt im neuen Satz nicht enthalten ist.

Antworte NUR mit JSON, ohne Prosa, ohne Codefence:
{"merge":true,"content":"...","kind":"fact","importance":0.7,"tags":["..."],"supersedes":[1,3]}
oder
{"merge":false,"reason":"verschiedene Sachverhalte"}`;

const LINK_PROMPT = `Du verbindest nachts die Erinnerungen eines persoenlichen Assistenten.

Unten stehen nummerierte Erinnerungen. Finde die Beziehungen zwischen ihnen.

Beziehungen:
- "refines":     from praezisiert to (gleicher Sachverhalt, mehr Detail)
- "contradicts": from und to koennen nicht beide stimmen
- "caused_by":   from ist so, WEIL to so ist

Regeln:
- Nur Beziehungen, die aus den Saetzen selbst hervorgehen. Nichts vermuten.
- Hoechstens 12 Beziehungen. Keine ist eine gute Antwort.
- "weight" ist deine Sicherheit zwischen 0 und 1.
- Bestimme zusaetzlich fuer erkennbare Eigennamen, was sie sind:
  person, project, tool, place, org oder topic.

Antworte NUR mit JSON, ohne Prosa, ohne Codefence:
{"edges":[{"from":1,"to":4,"relation":"refines","weight":0.8}],
 "entities":[{"name":"Rookery","kind":"project"}]}
Leer ist {"edges":[],"entities":[]}`;

const RESOLVE_PROMPT = `Du raeumst nachts einen Widerspruch im Gedaechtnis eines persoenlichen Assistenten auf.

Unten stehen zwei Saetze, die einander widersprechen. Entscheide, welcher gilt. Nicht entscheiden
ist keine Option, ausser die beiden widersprechen einander in Wahrheit gar nicht.

Woran du dich haeltst:
- Der neuere Satz gewinnt, wenn beide dasselbe beschreiben und sich die Lage geaendert hat.
  ("ist umgestiegen auf" schlaegt den aelteren Zustand.)
- Der konkretere Satz gewinnt, wenn beide dieselbe Zeit meinen und einer davon ungenau ist.
- "both" nur, wenn beide nebeneinander wahr sein koennen und die Kennzeichnung als Widerspruch
  schlicht falsch war.
- "merge" nur, wenn erst beide zusammen den Sachverhalt richtig beschreiben. Dann ist "content"
  EIN vollstaendiger Satz in der Sprache der Vorlagen.

Antworte NUR mit JSON, ohne Prosa, ohne Codefence:
{"decision":"first"}
{"decision":"second"}
{"decision":"both"}
{"decision":"merge","content":"..."}`;

const INSIGHT_PROMPT = `Du ziehst nachts Bilanz ueber das Gedaechtnis eines persoenlichen Assistenten.

Unten stehen die Erinnerungen der letzten Tage. Frage: Was faellt UEBER die einzelnen Saetze
hinaus auf? Ein Muster, eine Gewohnheit, ein roter Faden, ein Zusammenhang, den kein einzelner
Satz ausspricht.

Regeln:
- Hoechstens {{MAX}} Einsichten. Keine ist die richtige Antwort, wenn nichts auffaellt.
- Jede Einsicht braucht mindestens ZWEI Belege: die Nummern, aus denen sie folgt.
- Wiederhole niemals eine einzelne Erinnerung als Einsicht. Eine Einsicht sagt etwas Neues.
- Ein Satz, dritte Person, dieselbe Sprache wie die Vorlagen.
- Nichts erfinden, nichts vermuten. Nur was aus den Belegen wirklich folgt.

Antworte NUR mit JSON, ohne Prosa, ohne Codefence:
{"insights":[{"content":"...","importance":0.8,"evidence":[1,4,7],"tags":["..."]}]}
Leer ist {"insights":[]}`;

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
  resolvedCount?: number;
}): string {
  const parts: string[] = [counters.readCount + ' Erinnerungen gelesen'];
  if (counters.mergedCount) parts.push(counters.mergedCount + ' verdichtet');
  if (counters.dormantCount) parts.push(counters.dormantCount + ' aufgeraeumt');
  if (counters.edgeCount) parts.push(counters.edgeCount + ' Verbindungen gezogen');
  if (counters.resolvedCount) {
    parts.push(plural(counters.resolvedCount, 'Widerspruch', 'Widersprüche') + ' entschieden');
  }
  const openConflicts = Math.max(0, counters.conflictCount - (counters.resolvedCount ?? 0));
  if (openConflicts) {
    parts.push(plural(openConflicts, 'Widerspruch', 'Widersprüche') + ' offen');
  }
  if (counters.insightCount) {
    parts.push(plural(counters.insightCount, 'Einsicht', 'Einsichten') + ' notiert');
  }
  return parts.length === 1 ? parts[0] + ', nichts zu tun.' : parts.join(', ') + '.';
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

/** German plurals are not a suffix rule, so the forms are given outright. */
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
