import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { StatementSync } from 'node:sqlite';
import {
  ASSISTANT_MEMORY_OWNER,
  type CronTrigger,
  type DreamEpisode,
  type DreamEval,
  type DreamFrame,
  type DreamLabel,
  type DreamLabelSource,
  type DreamSlot,
  type DreamSlotFreezeReason,
  type DreamSlotState,
  type DreamTrace,
  type DreamTraceInput,
  type DreamTracePatch,
  type EntityKind,
  type FrameCorpus,
  type MemoryActor,
  type MemoryEdge,
  type MemoryEntity,
  type MemoryGraph,
  type MemoryKind,
  type MemoryNeighbourhood,
  type MemoryOrigin,
  type MemoryRecord,
  type MemoryRelation,
  type Message,
  type PolicyOrigin,
  type PolicyVersion,
  type ProviderId,
  type RecallFrame,
  type Role,
  type Session,
  type SessionKind,
  type SleepRun,
  type StatsDay,
  type StatsSnapshot,
  type StatsTotals,
  type TurnUsage,
} from '../types.js';
import { openDatabase, type Db } from './db.js';
import { OrgStore } from '../org/store.js';
import { CronStore } from '../cron/store.js';
import { TurnJournal } from '../turns/journal.js';
import {
  frameQuotes,
  mapDreamEpisode,
  mapDreamEval,
  mapDreamFrame,
  mapDreamLabel,
  mapDreamSlotState,
  mapDreamTrace,
  mapEdge,
  mapEntity,
  mapMemory,
  mapMessage,
  mapPolicyVersion,
  mapSession,
  mapSleepRun,
  parseJsonColumn,
  parseTags,
  type Row,
} from './store-rows.js';

export { mapEdge, mapEntity, mapMemory, mapSleepRun };

/** A partial UPDATE: `column = ?` terms and the values that fill them, in order. */
type Assignments = { sets: string[]; values: unknown[] };
/** The span a statistics query covers, in epoch milliseconds. */
type StatsWindow = { since: number; until: number };
/** An extra `WHERE` term of a per-day count, with its bound values. */
type DayScope = { sql: string; values: unknown[] };
type CountedDayField = 'sessions' | 'messages' | 'assignments' | 'tasks' | 'cronRuns' | 'memories';

/** meta key prefix under which one corpus fingerprint per night is stored. */
const CORPUS_STAMP_PREFIX = 'dream.corpus_stamp.';
/** meta key prefix holding which stamp id is current for an owner. */
const CORPUS_CURRENT_PREFIX = 'dream.corpus_current.';
/**
 * The shipped `dream.maxFrameBytes`. The Store holds no config, so the caller
 * reads the key (key table in the build plan, E21: clamped where it is read)
 * and passes it to `saveFrame`; this default is what a caller gets that does
 * not carry the config with it.
 */
const DEFAULT_MAX_FRAME_BYTES = 120_000;
/** How many rows one sweep batch deletes before it commits and continues. */
const SWEEP_BATCH = 500;

const DEFAULT_MEMORY_IMPORTANCE = 0.5;
const DEFAULT_EDGE_WEIGHT = 0.5;
/**
 * Reinforcing a known sentence is damped and stops entirely near the top:
 * below the ceiling it adds one step, from the ceiling up it adds nothing.
 */
const REINFORCE_STEP = 0.02;
const REINFORCE_CEILING = 0.8;
/** One actual use raises `usefulness` by this much, up to 1. */
const TOUCH_USEFULNESS_STEP = 0.03;
/** The memory graph's node cap: asked-for limits are clamped into this range. */
const GRAPH_MIN_NODES = 10;
const GRAPH_DEFAULT_NODES = 300;
const GRAPH_MAX_NODES = 1000;

/** Patchable fields of each table, as patch key -> column. */
const SESSION_PATCH_COLUMNS: Readonly<Record<string, string>> = {
  title: 'title',
  provider: 'provider',
  model: 'model',
  cwd: 'cwd',
  projectId: 'project_id',
  providerSessionId: 'provider_session_id',
  archived: 'archived',
};
const MEMORY_PATCH_COLUMNS: Readonly<Record<string, string>> = {
  content: 'content',
  kind: 'kind',
  importance: 'importance',
  pinned: 'pinned',
  dormantAt: 'dormant_at',
  supersededBy: 'superseded_by',
  forgotten: 'forgotten',
  sleepRunId: 'sleep_run_id',
};
const SLEEP_RUN_PATCH_COLUMNS: Readonly<Record<string, string>> = {
  status: 'status',
  finishedAt: 'finished_at',
  durationMs: 'duration_ms',
  readCount: 'read_count',
  replayedCount: 'replayed_count',
  learnedCount: 'learned_count',
  mergedCount: 'merged_count',
  dormantCount: 'dormant_count',
  edgeCount: 'edge_count',
  insightCount: 'insight_count',
  skillCount: 'skill_count',
  skillRevisedCount: 'skill_revised_count',
  conflictCount: 'conflict_count',
  resolvedCount: 'resolved_count',
  dreamTracesSeen: 'dream_traces_seen',
  dreamFramesScored: 'dream_frames_scored',
  dreamCandidates: 'dream_candidates',
  dreamPromoted: 'dream_promoted',
  dreamLabelsWritten: 'dream_labels_written',
  modelCalls: 'model_calls',
  report: 'report',
  error: 'error',
  undoneAt: 'undone_at',
};

/** All persistence for sessions, transcripts, long-term memories, the organisation and schedules. */
export class Store {
  readonly db: Db;
  /** Companies, teams, agents, assignments and messages. */
  readonly org: OrgStore;
  /** Schedules and their runs. */
  readonly cron: CronStore;
  /** The running-turn journal: every event of a conversation turn, as it happens. */
  readonly turns: TurnJournal;

  constructor(pathOrDb: string | Db) {
    this.db = typeof pathOrDb === 'string' ? openDatabase(pathOrDb) : pathOrDb;
    this.org = new OrgStore(this.db);
    this.cron = new CronStore(this.db);
    this.turns = new TurnJournal(this.db);
  }

  close(): void {
    this.db.close();
  }

  /* ---------------------------- sessions ---------------------------- */

  createSession(input: {
    title?: string;
    kind?: SessionKind;
    provider: ProviderId;
    model?: string;
    cwd: string;
    projectId?: string;
    agentId?: string;
  }): Session {
    const now = Date.now();
    const session: Session = {
      id: randomUUID(),
      title: input.title?.trim() || 'New conversation',
      kind: input.kind ?? 'chat',
      provider: input.provider,
      model: input.model,
      cwd: input.cwd,
      projectId: input.projectId,
      agentId: input.agentId,
      createdAt: now,
      updatedAt: now,
      archived: false,
      messageCount: 0,
    };

    this.db
      .prepare(
        // `agent` is omitted on purpose: the column survives for old rows but
        // a session no longer has one, so it falls back to its SQL default.
        `INSERT INTO sessions
           (id, title, kind, provider, model, cwd, project_id, agent_id, provider_session_id, created_at, updated_at, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0)`,
      )
      .run(
        session.id,
        session.title,
        session.kind,
        session.provider,
        session.model ?? null,
        session.cwd,
        session.projectId ?? null,
        session.agentId ?? null,
        now,
        now,
      );

    return session;
  }

  getSession(id: string): Session | null {
    const row = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
           FROM sessions s WHERE s.id = ?`,
      )
      .get(id) as Row | undefined;
    return row ? mapSession(row) : null;
  }

  /**
   * Recent sessions. `agentId` narrows to one counterpart: an agent id for
   * direct chats with that agent, `null` for conversations with the assistant.
   */
  listSessions(
    options: { limit?: number; includeArchived?: boolean; agentId?: string | null; kind?: SessionKind } = {},
  ): Session[] {
    const limit = options.limit ?? 50;
    const scope =
      (options.agentId === undefined ? '' : options.agentId === null ? ' AND s.agent_id IS NULL' : ' AND s.agent_id = ?') +
      // A mail answer's or a cron run's transcript is not a conversation to
      // browse, so both stay out of every open list. Asking for `kind:
      // 'mail'` or `kind: 'schedule'` still finds them - the rule is "not by
      // default", not "never".
      (options.kind ? ' AND s.kind = ?' : " AND s.kind NOT IN ('mail', 'schedule')");
    const values: unknown[] = [options.includeArchived ? 1 : 0];
    if (typeof options.agentId === 'string') values.push(options.agentId);
    if (options.kind) values.push(options.kind);
    values.push(limit);
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
           FROM sessions s
          WHERE (? = 1 OR s.archived = 0)` + scope + `
          ORDER BY s.updated_at DESC
          LIMIT ?`,
      )
      .all(...(values as never[])) as Row[];
    return rows.map(mapSession);
  }

  updateSession(
    id: string,
    patch: Partial<
      Pick<Session, 'title' | 'provider' | 'model' | 'cwd' | 'projectId' | 'providerSessionId' | 'archived'>
    >,
  ): void {
    const assignments = assignmentsFor(SESSION_PATCH_COLUMNS, patch);
    if (!assignments.sets.length) return;
    assignments.sets.push('updated_at = ?');
    assignments.values.push(Date.now());
    this.#updateById('sessions', assignments, id);
  }

  deleteSession(id: string): void {
    // A run's transcript is not part of the conversation that ordered it.
    //
    // `turns.session_id` cascades on session delete, which is right for the
    // chat turns of that conversation - they are the conversation. It is
    // wrong for the runs started from it: deleting a chat silently took the
    // transcripts of every agent run it had launched, while the assignment
    // rows (which have no foreign key) stayed behind holding results whose
    // working record had just been thrown away. Cutting the link first
    // keeps the transcript and loses only what it was - a pointer back to a
    // conversation that no longer exists.
    this.#atomically(() => {
      this.db.prepare("UPDATE turns SET session_id = NULL WHERE session_id = ? AND kind = 'assign'").run(id);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    });
  }

  /* ---------------------------- messages ---------------------------- */

  addMessage(input: {
    sessionId: string;
    role: Role;
    content: string;
    provider?: ProviderId;
    model?: string;
    agent?: string;
    usage?: TurnUsage;
    toolCalls?: Message['toolCalls'];
    blocks?: Message['blocks'];
    /**
     * The journal's turn id, when the caller has one. It is what makes a
     * quote locatable to the exact turn it was written in (concept 9.4),
     * instead of to a position counted off the transcript.
     */
    turnId?: string;
  }): Message {
    const message: Message = {
      id: randomUUID(),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      provider: input.provider,
      model: input.model,
      agent: input.agent,
      usage: input.usage,
      toolCalls: input.toolCalls,
      blocks: input.blocks,
      turnId: input.turnId,
      createdAt: Date.now(),
    };

    this.#atomically(() => {
      this.db
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, provider, model, agent, usage, created_at, tool_calls, blocks, turn_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          message.id,
          message.sessionId,
          message.role,
          message.content,
          message.provider ?? null,
          message.model ?? null,
          message.agent ?? null,
          message.usage ? JSON.stringify(message.usage) : null,
          message.createdAt,
          message.toolCalls?.length ? JSON.stringify(message.toolCalls) : null,
          message.blocks?.length ? JSON.stringify(message.blocks) : null,
          message.turnId ?? null,
        );
      this.db
        .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
        .run(message.createdAt, message.sessionId);
    });

    return message;
  }

  /** Transcript in chronological order. `limit` keeps the most recent turns. */
  getMessages(sessionId: string, limit?: number): Message[] {
    const rows = limit
      ? (this.db
          .prepare(
            `SELECT * FROM (
               SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
             ) ORDER BY created_at ASC`,
          )
          .all(sessionId, limit) as Row[])
      : (this.db
          .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC')
          .all(sessionId) as Row[]);
    return rows.map(mapMessage);
  }

  countMessages(sessionId: string): number {
    return this.#countRows('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?', sessionId);
  }

  /* ---------------------------- memories ---------------------------- */

  /**
   * Insert a memory, or reinforce the existing one when the same sentence is
   * already known to the same owner. Reinforcing raises importance instead of
   * creating noise.
   */
  upsertMemory(input: {
    kind: MemoryKind;
    content: string;
    tags?: string[];
    importance?: number;
    owner?: string;
    sourceSessionId?: string;
    /** The quote this memory stands on, when it was extracted from one. */
    evidence?: string;
    /** Who is writing. `user` marks the record as protected from the night. */
    origin?: MemoryOrigin;
    pinned?: boolean;
    /** The sleep run that produced this, so a night can be undone. */
    sleepRunId?: string;
  }): MemoryRecord {
    const content = input.content.trim();
    if (!content) throw new Error('A memory needs content.');
    const owner = input.owner ?? ASSISTANT_MEMORY_OWNER;

    const now = Date.now();
    const existing = this.db
      .prepare('SELECT * FROM memories WHERE owner = ? AND kind = ? AND content = ?')
      .get(owner, input.kind, content) as Row | undefined;

    if (existing) {
      // Reinforcement is damped and stops entirely near the top. Hearing the
      // same sentence again says the extractor likes saying it, not that the
      // memory earned its rank - that is what `usefulness` is for, and this
      // path deliberately never touches it.
      const base = Math.max(Number(existing.importance), input.importance ?? DEFAULT_MEMORY_IMPORTANCE);
      const importance = base >= REINFORCE_CEILING ? Math.min(1, base) : Math.min(1, base + REINFORCE_STEP);
      const tags = mergeTags(parseTags(existing.tags), input.tags ?? []);
      // The quote is only ever filled in, never replaced: the first words
      // that confirmed a fact are the ones worth keeping, and a row written
      // before evidence existed gets one the next time it is heard again.
      const evidence = (existing.evidence as string | null) ?? input.evidence?.trim() ?? null;
      // Waking a dormant row is a change to what the night did, so when a
      // sleep run condensed a sentence that byte-exactly matches a memory an
      // earlier night had filed away, the revival carries that run's id like
      // every other touch - otherwise undoing the run cannot know it happened.
      // A plain reinforcement of an awake row keeps the id it already has.
      const revivedByRun = input.sleepRunId && existing.dormant_at != null ? input.sleepRunId : null;
      this.db
        .prepare(
          `UPDATE memories
              SET importance = ?, tags = ?, evidence = ?, updated_at = ?, forgotten = 0,
                  dormant_at = NULL, superseded_by = NULL,
                  sleep_run_id = COALESCE(?, sleep_run_id)
            WHERE id = ?`,
        )
        .run(importance, JSON.stringify(tags), evidence, now, revivedByRun, existing.id as string);
      return this.getMemory(existing.id as string) as MemoryRecord;
    }

    const record: MemoryRecord = {
      id: randomUUID(),
      kind: input.kind,
      content,
      tags: input.tags ?? [],
      importance: clamp01(input.importance ?? DEFAULT_MEMORY_IMPORTANCE),
      owner,
      evidence: input.evidence?.trim() || undefined,
      sourceSessionId: input.sourceSessionId,
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
      forgotten: false,
      origin: input.origin ?? 'extract',
      pinned: input.pinned ?? false,
      sleepRunId: input.sleepRunId,
      usefulness: 0,
    };

    this.db
      .prepare(
        `INSERT INTO memories
           (id, kind, content, tags, importance, owner, evidence, source_session_id, created_at,
            updated_at, access_count, forgotten, origin, pinned, sleep_run_id, usefulness)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 0)`,
      )
      .run(
        record.id,
        record.kind,
        record.content,
        JSON.stringify(record.tags),
        record.importance,
        record.owner,
        record.evidence ?? null,
        record.sourceSessionId ?? null,
        now,
        now,
        record.origin,
        record.pinned ? 1 : 0,
        record.sleepRunId ?? null,
      );

    return record;
  }

  /**
   * Edit a memory in place. Used by the inspector (pin, re-word, change
   * weight, wake it up) and by the sleep run when it retires one.
   *
   * `actor` says who asked for the edit (concept 4.2b, S5). It defaults to
   * `'model'` so no existing call site changes meaning, and only `'user'`
   * leaves a `user` label behind: pinning is the user saying "this was the
   * point", forgetting is the user saying "this was ballast", and neither
   * claim may be manufactured by the model's own tool.
   */
  updateMemory(
    id: string,
    patch: {
      content?: string;
      kind?: MemoryKind;
      tags?: string[];
      importance?: number;
      pinned?: boolean;
      /** `null` wakes a sleeping memory, a number puts it to sleep. */
      dormantAt?: number | null;
      supersededBy?: string | null;
      forgotten?: boolean;
      sleepRunId?: string | null;
    },
    actor: MemoryActor = 'model',
  ): MemoryRecord | null {
    const assignments = assignmentsFor(MEMORY_PATCH_COLUMNS, patch);
    if (patch.tags) {
      assignments.sets.push('tags = ?');
      assignments.values.push(JSON.stringify([...new Set(patch.tags)]));
    }
    if (!assignments.sets.length) return this.getMemory(id);
    assignments.sets.push('updated_at = ?');
    assignments.values.push(Date.now());
    this.#atomically(() => {
      this.#updateById('memories', assignments, id);
      // Two patch fields carry a verdict, and only those two: pinning says the
      // row belonged in the prompt, forgetting says it did not. Everything else
      // the inspector can change (wording, weight, tags) says nothing about any
      // turn and writes no label.
      if (actor === 'user' && patch.pinned === true) this.#writeUserLabel(id, 1, 'updateMemory:user');
      if (actor === 'user' && patch.forgotten === true) this.#writeUserLabel(id, 0, 'updateMemory:user');
    });
    return this.getMemory(id);
  }

  /**
   * Put a memory to sleep: out of recall, still in the table and in the UI.
   * `sleep_run_id` records the run that did it, which is what undo looks for,
   * so it is overwritten rather than kept - undo always targets the night
   * that last touched a memory.
   */
  sleepMemory(id: string, options: { runId?: string; supersededBy?: string } = {}): void {
    // `updated_at` is deliberately left alone: it means "when the content
    // last changed", and filing a memory away is not a change to what it
    // says. Bumping it made an old memory look fresh to the recency score,
    // so after an undo the night would no longer recognise it as stale.
    this.db
      .prepare(
        `UPDATE memories
            SET dormant_at = ?, superseded_by = ?,
                sleep_run_id = COALESCE(?, sleep_run_id)
          WHERE id = ?`,
      )
      .run(Date.now(), options.supersededBy ?? null, options.runId ?? null, id);
  }

  /** Bring one back. The inspector's "wake" button, and what undo uses. */
  wakeMemory(id: string): void {
    this.db
      .prepare('UPDATE memories SET dormant_at = NULL, superseded_by = NULL WHERE id = ?')
      .run(id);
  }

  getMemory(id: string): MemoryRecord | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Row | undefined;
    return row ? mapMemory(row) : null;
  }

  /**
   * Browse the bank. Sleeping memories are included by default because this
   * is what the inspector lists; the recall path filters them out itself.
   */
  listMemories(
    options: {
      kinds?: MemoryKind[];
      limit?: number;
      includeForgotten?: boolean;
      /** Set false to see only what the assistant can still recall. */
      includeDormant?: boolean;
      owner?: string;
      /** Only memories written since this timestamp. */
      since?: number;
    } = {},
  ): MemoryRecord[] {
    const limit = options.limit ?? 200;
    const kinds = options.kinds ?? [];
    const owner = options.owner ?? ASSISTANT_MEMORY_OWNER;
    const sql =
      'SELECT * FROM memories WHERE owner = ? AND (? = 1 OR forgotten = 0)' +
      (options.includeDormant === false ? ' AND dormant_at IS NULL' : '') +
      (options.since ? ' AND created_at >= ?' : '') +
      (kinds.length ? ' AND kind IN (' + placeholders(kinds) + ')' : '') +
      ' ORDER BY importance DESC, updated_at DESC LIMIT ?';
    const values: unknown[] = [owner, options.includeForgotten ? 1 : 0];
    if (options.since) values.push(options.since);
    values.push(...kinds, limit);
    const rows = this.db.prepare(sql).all(...(values as never[])) as Row[];
    return rows.map(mapMemory);
  }

  /**
   * Live memories that carry tags but hang off no entity yet.
   *
   * Everything written before the graph existed is in this state, and so is
   * anything whose entity links were lost. Light sleep uses this to catch a
   * bank up without a single model call.
   */
  memoriesWithoutEntities(owner: string, limit = 500): MemoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM memories m
          WHERE m.owner = ? AND m.forgotten = 0 AND m.dormant_at IS NULL
            AND m.tags != '[]'
            AND NOT EXISTS (SELECT 1 FROM memory_entity_links l WHERE l.memory_id = m.id)
          ORDER BY m.importance DESC
          LIMIT ?`,
      )
      .all(owner, limit) as Row[];
    return rows.map(mapMemory);
  }

  /** Every live memory of one owner, oldest first. The sleep run's input. */
  liveMemories(owner: string): MemoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
          WHERE owner = ? AND forgotten = 0 AND dormant_at IS NULL
          ORDER BY created_at ASC`,
      )
      .all(owner) as Row[];
    return rows.map(mapMemory);
  }

  /** Owners with at least one live memory. Used to decide which banks sleep. */
  memoryOwners(): { owner: string; live: number; newest: number }[] {
    const rows = this.db
      .prepare(
        `SELECT owner, COUNT(*) AS live, MAX(created_at) AS newest
           FROM memories
          WHERE forgotten = 0 AND dormant_at IS NULL
          GROUP BY owner`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      owner: row.owner as string,
      live: Number(row.live ?? 0),
      newest: Number(row.newest ?? 0),
    }));
  }

  /**
   * Soft delete, so a wrong memory can be audited rather than vanishing.
   *
   * Frames quote the memories they froze verbatim, so forgetting one must
   * reach them too (R17): never keep a wording longer than the memory it
   * came from. The drop is owner-level because a frame is a snapshot of
   * many rows and cannot be edited piecemeal.
   *
   * `actor` follows `updateMemory`: `'model'` unless the HTTP path says
   * otherwise, and only `'user'` leaves a label (S5).
   */
  forgetMemory(id: string, actor: MemoryActor = 'model'): void {
    // The owner is read first so the frame drop below still knows whose
    // bank the memory belonged to (R17).
    const owner = this.#ownerOf(id);
    this.#atomically(() => {
      this.db.prepare('UPDATE memories SET forgotten = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
      // The old labels die with the target, the new one is born alive (S9):
      // what a label about a forgotten memory claims is still true of the
      // turns it was written about, and `dead_at` is what keeps that history
      // readable instead of deleting it.
      this.markLabelsDead(id);
      if (actor === 'user') this.#writeUserLabel(id, 0, 'forgetMemory:user');
      if (owner) this.dropDreamFramesQuoting(owner, [id]);
    });
  }

  /**
   * Retiring an agent (agent-performance-management, phase 4): its whole
   * bank goes out of recall for good, but stays on the record rather than
   * being deleted - unlike `forgetMemory`, there is no path back from this.
   * Returns how many rows it touched, for the report.
   */
  archiveMemories(owner: string): number {
    return this.#atomically(() => {
      const archived = changesOf(
        this.db
          .prepare('UPDATE memories SET archived_at = ? WHERE owner = ? AND archived_at IS NULL')
          .run(Date.now(), owner),
      );
      // The whole bank leaves recall, so its frames are verbatim text without
      // a corpus left to replay against (R17).
      this.dropDreamFramesForOwner(owner);
      // Every target of this owner is gone from recall at once, so the labels
      // go dead in one statement rather than one per memory (S9).
      this.markOwnerLabelsDead(owner);
      return archived;
    });
  }

  /** See `forgetMemory` for `actor`; this path is the hard one (`?hard`). */
  deleteMemory(id: string, actor: MemoryActor = 'model'): void {
    // The owner is read before the row goes, so the frame drop afterwards
    // still knows whose bank the deleted memory belonged to (R17).
    const owner = this.#ownerOf(id);
    this.#atomically(() => {
      // Both label steps run while the row is still there: the user label
      // reads the memory's owner and source session off it, and neither is
      // recoverable once the DELETE has run.
      this.markLabelsDead(id);
      if (actor === 'user') this.#writeUserLabel(id, 0, 'deleteMemory:user');
      this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      if (owner) this.dropDreamFramesQuoting(owner, [id]);
    });
  }

  /**
   * The `user` label funnel (concept 4.2b, S5). Only `actor === 'user'`
   * reaches it: the model's own memory tool calls the very same three
   * methods, and a source that can be manufactured by the thing being
   * measured is not a source.
   *
   * The label is session-scoped, because a memory edit names no turn. The
   * only rule that would name one is "the turns that surfaced this memory",
   * and that is a function of the very policy under evaluation - 4.2b rules
   * it out and assigns the label to a session window instead. `turn_id`
   * therefore carries the SESSION id, the way every session-scoped label
   * does, and the evaluator spreads it over `dream.userLabelWindow` around
   * `created_at`. A memory with no source session has no locator at all, so
   * nothing is written rather than a guessed one.
   */
  #writeUserLabel(memoryId: string, relevance: number, evidence: string): void {
    const row = this.db
      .prepare('SELECT owner, source_session_id FROM memories WHERE id = ?')
      .get(memoryId) as Row | undefined;
    if (!row) return;
    const sessionId = row.source_session_id as string | null;
    if (!sessionId) return;
    this.putLabel({
      turnId: sessionId,
      target: memoryId,
      source: 'user',
      relevance,
      scope: 'session',
      evidence,
      createdAt: Date.now(),
      owner: (row.owner as string) ?? ASSISTANT_MEMORY_OWNER,
      sessionId,
    });
  }

  /**
   * Record that a memory was actually used. This is the only path that
   * raises `usefulness`, and it is damped so a single busy day cannot make
   * a memory permanent.
   *
   * With `ctx` the same call appends one `memory_touches` row per id as
   * well: the counters it raises are monotone and carry no history, so the
   * append-only record is the only place a later night could ever
   * recompute them from (R4). Without `ctx` nothing extra is written - an
   * unrecorded turn costs exactly what it costs today.
   */
  touchMemories(ids: string[], ctx?: { traceId: string; owner: string; policyId?: string }): void {
    if (!ids.length) return;
    const now = Date.now();
    const statement = this.db.prepare(
      `UPDATE memories
          SET last_accessed_at = ?,
              access_count = access_count + 1,
              usefulness = MIN(1.0, usefulness + ${TOUCH_USEFULNESS_STEP})
        WHERE id = ?`,
    );
    this.#atomically(() => {
      for (const id of ids) statement.run(now, id);
      if (ctx) this.recordTouches(ctx.traceId, ctx.owner, ids, ctx.policyId);
    });
  }

  memoryStats(owner = ASSISTANT_MEMORY_OWNER): {
    total: number;
    byKind: Record<string, number>;
    forgotten: number;
    dormant: number;
    pinned: number;
    entities: number;
    edges: number;
  } {
    const count = (sql: string): number => this.#countRows(sql, owner);
    const total = count('SELECT COUNT(*) AS n FROM memories WHERE owner = ? AND forgotten = 0 AND dormant_at IS NULL');
    const forgotten = count('SELECT COUNT(*) AS n FROM memories WHERE owner = ? AND forgotten = 1');
    const dormant = count('SELECT COUNT(*) AS n FROM memories WHERE owner = ? AND forgotten = 0 AND dormant_at IS NOT NULL');
    const pinned = count('SELECT COUNT(*) AS n FROM memories WHERE owner = ? AND forgotten = 0 AND pinned = 1');
    const entities = count('SELECT COUNT(*) AS n FROM memory_entities WHERE owner = ?');
    const edges = count('SELECT COUNT(*) AS n FROM memory_edges WHERE owner = ?');
    const rows = this.db
      .prepare(
        `SELECT kind, COUNT(*) AS n FROM memories
          WHERE owner = ? AND forgotten = 0 AND dormant_at IS NULL GROUP BY kind`,
      )
      .all(owner) as { kind: string; n: number }[];
    const byKind: Record<string, number> = {};
    for (const row of rows) byKind[row.kind] = row.n;
    return { total, byKind, forgotten, dormant, pinned, entities, edges };
  }

  /* ----------------------------- statistics ---------------------------- */

  /**
   * The dashboard's numbers: real totals, plus a day-by-day series.
   *
   * `memoryStats` answers "what does the bank hold"; this answers "how much
   * is there across the whole system, and when did it happen". Both count in
   * SQL rather than over a fetched page, because every list endpoint is
   * capped and a number derived from a capped list is silently wrong once
   * the cap bites.
   *
   * Days are local calendar days. The server runs on the same machine as the
   * person reading the chart, so "Tuesday" should mean the Tuesday they had,
   * not the one UTC had. Empty days are not emitted - the client knows which
   * window it wants and fills the gaps itself.
   */
  stats(options: { orgId: string; since: number; until?: number; owner?: string }): StatsSnapshot {
    const owner = options.owner || ASSISTANT_MEMORY_OWNER;
    const until = options.until ?? Date.now();
    const window: StatsWindow = { since: Math.min(options.since, until), until };

    // Reused rather than recounted, so the dashboard and the memory page can
    // never disagree about how many memories there are.
    const totals = this.#statsTotals(options.orgId, this.memoryStats(owner).total);
    const tokenRows = this.#tokensPerDay(window);
    const series = this.#dailySeries({ orgId: options.orgId, owner }, window, tokenRows);
    return {
      since: window.since,
      until,
      orgId: options.orgId,
      owner,
      totals,
      series,
      tokensAvailable: tokenRows.length > 0,
    };
  }

  /** The cross-table counts of the dashboard's totals row. */
  #statsTotals(orgId: string, memories: number): StatsTotals {
    return {
      // Mail and cron transcripts are left out here for the same reason
      // `listSessions` hides them: they are not conversations. Counting them
      // would put a number on the conversations card that its own list
      // cannot produce.
      sessions: this.#countRows("SELECT COUNT(*) AS n FROM sessions WHERE archived = 0 AND kind NOT IN ('mail', 'schedule')"),
      archivedSessions: this.#countRows("SELECT COUNT(*) AS n FROM sessions WHERE archived = 1 AND kind NOT IN ('mail', 'schedule')"),
      messages: this.#countRows(
        "SELECT COUNT(*) AS n FROM messages m WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = m.session_id AND s.kind IN ('mail', 'schedule'))",
      ),
      assignments: this.#countRows('SELECT COUNT(*) AS n FROM assignments WHERE org_id = ?', orgId),
      runningAssignments: this.#countRows(
        "SELECT COUNT(*) AS n FROM assignments WHERE org_id = ? AND status IN ('pending', 'running')",
        orgId,
      ),
      tasks: this.#countRows('SELECT COUNT(*) AS n FROM tasks WHERE org_id = ?', orgId),
      openTasks: this.#countRows(
        "SELECT COUNT(*) AS n FROM tasks WHERE org_id = ? AND status IN ('open', 'planned', 'running')",
        orgId,
      ),
      cronJobs: this.#countRows('SELECT COUNT(*) AS n FROM cron_jobs WHERE org_id = ?', orgId),
      cronRuns: this.#countRows('SELECT COUNT(*) AS n FROM cron_runs WHERE org_id = ?', orgId),
      memories,
      agents: this.#countRows('SELECT COUNT(*) AS n FROM agents WHERE org_id = ? AND archived = 0', orgId),
    };
  }

  /** The day-by-day series, oldest day first; a day with nothing to report is not emitted. */
  #dailySeries(scope: { orgId: string; owner: string }, window: StatsWindow, tokenRows: Row[]): StatsDay[] {
    const buckets = new Map<string, StatsDay>();
    const bucket = (day: string): StatsDay => {
      let entry = buckets.get(day);
      if (!entry) {
        entry = {
          day,
          sessions: 0,
          messages: 0,
          assignments: 0,
          tasks: 0,
          cronRuns: 0,
          memories: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
        buckets.set(day, entry);
      }
      return entry;
    };

    const org: DayScope = { sql: 'org_id = ?', values: [scope.orgId] };
    const bank: DayScope = { sql: 'owner = ?', values: [scope.owner] };
    const counted: { field: CountedDayField; table: string; column: string; scope?: DayScope }[] = [
      { field: 'sessions', table: 'sessions', column: 'created_at' },
      { field: 'messages', table: 'messages', column: 'created_at' },
      { field: 'assignments', table: 'assignments', column: 'created_at', scope: org },
      { field: 'tasks', table: 'tasks', column: 'created_at', scope: org },
      // A run is dated by when it started; `finished_at` is null while it runs.
      { field: 'cronRuns', table: 'cron_runs', column: 'started_at', scope: org },
      { field: 'memories', table: 'memories', column: 'created_at', scope: bank },
    ];
    for (const { field, table, column, scope: filter } of counted) {
      for (const [day, n] of this.#countPerDay(table, column, window, filter)) bucket(day)[field] = n;
    }
    for (const row of tokenRows) {
      const entry = bucket(String(row.day));
      entry.inputTokens = Number(row.input_tokens ?? 0);
      entry.outputTokens = Number(row.output_tokens ?? 0);
    }
    return [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day));
  }

  /**
   * One GROUP BY per table. Timestamps are milliseconds and SQLite's date
   * functions want seconds, hence the division; `localtime` is what turns
   * an instant into the day the user had. Table and column are literals
   * from `#dailySeries`, never anything a request carried.
   */
  #countPerDay(table: string, column: string, window: StatsWindow, scope?: DayScope): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT strftime('%Y-%m-%d', ${column} / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS n
           FROM ${table}
          WHERE ${column} >= ? AND ${column} <= ?` +
          (scope ? ' AND ' + scope.sql : '') +
          ' GROUP BY day',
      )
      .all(...([window.since, window.until, ...(scope?.values ?? [])] as never[])) as Row[];
    return new Map(rows.map((row) => [String(row.day), Number(row.n ?? 0)]));
  }

  /**
   * `messages.usage` is a JSON blob rather than columns, so the tokens can
   * only be summed with json_extract. That is the difference between one
   * query and one request per conversation, and worth the guard: json_valid
   * skips anything an older build may have written, and if the function is
   * missing altogether the two figures simply stay unknown (no rows).
   */
  #tokensPerDay(window: StatsWindow): Row[] {
    try {
      return this.db
        .prepare(
          `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day,
                  SUM(COALESCE(json_extract(usage, '$.inputTokens'), 0))  AS input_tokens,
                  SUM(COALESCE(json_extract(usage, '$.outputTokens'), 0)) AS output_tokens
             FROM messages
            WHERE created_at >= ? AND created_at <= ? AND usage IS NOT NULL AND json_valid(usage)
            GROUP BY day`,
        )
        .all(window.since, window.until) as Row[];
    } catch {
      return [];
    }
  }

  /* ---------------------------- entities ---------------------------- */

  /**
   * Find or create the entity for a name, and count the mention. Entities
   * come from memory tags at write time and get their proper kind and their
   * merged spellings from the nightly run.
   */
  upsertEntity(input: { owner: string; name: string; kind?: EntityKind }): MemoryEntity {
    const name = input.name.trim();
    const slug = entitySlug(name);
    if (!slug) throw new Error('An entity needs a name.');
    const now = Date.now();
    const existing = this.db
      .prepare('SELECT * FROM memory_entities WHERE owner = ? AND slug = ?')
      .get(input.owner, slug) as Row | undefined;

    if (existing) {
      // A concrete kind wins over the default `topic`, but never the other way.
      const kind = input.kind && input.kind !== 'topic' ? input.kind : (existing.kind as EntityKind);
      this.db
        .prepare('UPDATE memory_entities SET kind = ?, last_seen_at = ? WHERE id = ?')
        .run(kind, now, existing.id as string);
      return mapEntity({ ...existing, kind, last_seen_at: now });
    }

    const entity: MemoryEntity = {
      id: randomUUID(),
      owner: input.owner,
      name,
      slug,
      kind: input.kind ?? 'topic',
      mentions: 0,
      firstSeenAt: now,
      lastSeenAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO memory_entities (id, owner, name, slug, kind, mentions, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(entity.id, entity.owner, entity.name, entity.slug, entity.kind, now, now);
    return entity;
  }

  getEntity(id: string): MemoryEntity | null {
    const row = this.db.prepare('SELECT * FROM memory_entities WHERE id = ?').get(id) as Row | undefined;
    return row ? mapEntity(row) : null;
  }

  findEntity(owner: string, name: string): MemoryEntity | null {
    const row = this.db
      .prepare('SELECT * FROM memory_entities WHERE owner = ? AND slug = ?')
      .get(owner, entitySlug(name)) as Row | undefined;
    return row ? mapEntity(row) : null;
  }

  /** Entities of one owner, most-mentioned first. */
  listEntities(options: { owner?: string; limit?: number; minMentions?: number } = {}): MemoryEntity[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_entities
          WHERE owner = ? AND mentions >= ?
          ORDER BY mentions DESC, last_seen_at DESC
          LIMIT ?`,
      )
      .all(options.owner ?? ASSISTANT_MEMORY_OWNER, options.minMentions ?? 1, options.limit ?? 200) as Row[];
    return rows.map(mapEntity);
  }

  /** Attach a memory to an entity. Idempotent; the mention count follows. */
  linkEntity(memoryId: string, entityId: string, weight = 1): void {
    this.#atomically(() => {
      this.db
        .prepare('INSERT OR REPLACE INTO memory_entity_links (memory_id, entity_id, weight) VALUES (?, ?, ?)')
        .run(memoryId, entityId, weight);
      this.recountEntity(entityId);
    });
  }

  unlinkEntity(memoryId: string, entityId: string): void {
    this.#atomically(() => {
      this.db
        .prepare('DELETE FROM memory_entity_links WHERE memory_id = ? AND entity_id = ?')
        .run(memoryId, entityId);
      this.recountEntity(entityId);
    });
  }

  /** Recount live mentions of one entity. One left with none stays at zero; `listEntities` hides it. */
  recountEntity(entityId: string): void {
    const mentions = this.#countRows(
      `SELECT COUNT(*) AS n
         FROM memory_entity_links l
         JOIN memories m ON m.id = l.memory_id
        WHERE l.entity_id = ? AND m.forgotten = 0 AND m.dormant_at IS NULL`,
      entityId,
    );
    this.db.prepare('UPDATE memory_entities SET mentions = ? WHERE id = ?').run(mentions, entityId);
  }

  /** Recount every entity of one owner. Cheap enough to run after a night. */
  recountEntities(owner: string): void {
    this.db
      .prepare(
        `UPDATE memory_entities
            SET mentions = (
              SELECT COUNT(*) FROM memory_entity_links l
                JOIN memories m ON m.id = l.memory_id
               WHERE l.entity_id = memory_entities.id
                 AND m.forgotten = 0 AND m.dormant_at IS NULL
            )
          WHERE owner = ?`,
      )
      .run(owner);
  }

  /**
   * Fold one entity into another: two names that mean the same real thing
   * become one node, links and all.
   *
   * Links the surviving entity already holds must go first - the pair table
   * has no room for a second row for the same memory - and memories that
   * were covered on both sides simply keep the one link. Everything runs in
   * one transaction, so a half-merged entity can never exist; the mention
   * recount afterwards is the only thing that can still lag, and it is
   * rebuilt from scratch anyway. Returns false (and changes nothing) when
   * either side is unknown or both names are the same entity; a merge that
   * would not hold must not cost the caller anything.
   */
  mergeEntities(owner: string, fromName: string, intoName: string): boolean {
    const from = this.findEntity(owner, fromName);
    const into = from ? this.findEntity(owner, intoName) : null;
    if (!from || !into || from.id === into.id) return false;
    this.#atomically(() => {
      this.db
        .prepare(
          `DELETE FROM memory_entity_links
            WHERE entity_id = ?
              AND memory_id IN (SELECT memory_id FROM memory_entity_links WHERE entity_id = ?)`,
        )
        .run(from.id, into.id);
      this.db.prepare('UPDATE memory_entity_links SET entity_id = ? WHERE entity_id = ?').run(into.id, from.id);
      this.db.prepare('DELETE FROM memory_entities WHERE id = ?').run(from.id);
    });
    this.recountEntities(owner);
    return true;
  }

  /**
   * Entities of one memory, most-mentioned first. `e.id` breaks ties in
   * `mentions`: `groupByEntity` in recall.ts keeps the first of the equal
   * minima, so which entity that is must never depend on SQLite's internal
   * row order.
   */
  entitiesFor(memoryId: string): MemoryEntity[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM memory_entities e
           JOIN memory_entity_links l ON l.entity_id = e.id
          WHERE l.memory_id = ?
          ORDER BY e.mentions DESC, e.id`,
      )
      .all(memoryId) as Row[];
    return rows.map(mapEntity);
  }

  /**
   * Entities of many memories, in one query instead of one per memory. The
   * dream recorder needs the entities of every row a frame can reach, and a
   * per-memory call would turn one frame into dozens of statements. Per
   * memory the order matches `entitiesFor` (mentions DESC, id ASC); a memory
   * with no entities maps to an empty list rather than to a missing key.
   */
  entitiesForMany(memoryIds: string[]): Map<string, MemoryEntity[]> {
    const grouped = new Map<string, MemoryEntity[]>();
    const ids = [...new Set(memoryIds)];
    for (const id of ids) grouped.set(id, []);
    if (!ids.length) return grouped;
    const rows = this.db
      .prepare(
        `SELECT l.memory_id, e.* FROM memory_entities e
           JOIN memory_entity_links l ON l.entity_id = e.id
          WHERE l.memory_id IN (` + placeholders(ids) + `)
          ORDER BY l.memory_id, e.mentions DESC, e.id`,
      )
      .all(...(ids as never[])) as Row[];
    for (const row of rows) grouped.get(row.memory_id as string)?.push(mapEntity(row));
    return grouped;
  }

  /**
   * Live memories linked to any of these entities, excluding the ones given.
   * `owner` keeps the result inside one bank: the link table has no owner
   * column, so without the filter a cross-owner link would read across banks.
   *
   * The filter lets `superseded_by` through while it drops archived rows, and
   * that asymmetry is deliberate: `offer` in recall.ts drops superseded rows
   * only after the LIMIT has bitten, so a caller that replays this query must
   * see them too. This is not the gate's form - `similarMemories` there
   * filters neither column.
   *
   * With `perEntity: true` the limit applies per entity instead of over the
   * union, which is the shape the live second hop uses (one call per entity,
   * limit 8); a single LIMIT over a bundled IN (...) call would keep the
   * union's top N instead. In that mode a memory linked to several of the
   * queried entities comes back once per entity, on a row carrying
   * `hopEntityId` - that duplication is wanted, the recorder buckets the rows
   * by entity, so do not "repair" it away with DISTINCT.
   */
  memoriesForEntities(
    entityIds: string[],
    options: { owner?: string; exclude?: string[]; limit?: number; perEntity?: boolean } = {},
  ): (MemoryRecord & { hopEntityId?: string })[] {
    if (!entityIds.length) return [];
    const exclude = options.exclude ?? [];
    const where =
      ' WHERE l.entity_id IN (' + placeholders(entityIds) + ')' +
      ' AND m.forgotten = 0 AND m.dormant_at IS NULL AND m.archived_at IS NULL' +
      (options.owner ? ' AND m.owner = ?' : '') +
      (exclude.length ? ' AND m.id NOT IN (' + placeholders(exclude) + ')' : '');
    const values: unknown[] = [
      ...entityIds,
      ...(options.owner ? [options.owner] : []),
      ...exclude,
      options.limit ?? 40,
    ];

    // `m.id` breaks ties in importance: which row a LIMIT keeps when two
    // importances are equal must not depend on SQLite's internal order.
    const rows = options.perEntity
      ? (this.db
          .prepare(
            `SELECT * FROM (
               SELECT m.*, l.entity_id AS hop_entity_id,
                      ROW_NUMBER() OVER (PARTITION BY l.entity_id
                                         ORDER BY m.importance DESC, m.id) AS rn
                 FROM memories m
                 JOIN memory_entity_links l ON l.memory_id = m.id` + where + `
             ) WHERE rn <= ? ORDER BY hop_entity_id, rn`,
          )
          .all(...(values as never[])) as Row[])
      : (this.db
          .prepare(
            `SELECT DISTINCT m.* FROM memories m
               JOIN memory_entity_links l ON l.memory_id = m.id` + where +
              ' ORDER BY m.importance DESC, m.id LIMIT ?',
          )
          .all(...(values as never[])) as Row[]);

    // mapMemory builds a fresh object from named columns, so the partition
    // key is re-attached instead of riding through the row.
    return rows.map((row) =>
      row.hop_entity_id === undefined
        ? mapMemory(row)
        : { ...mapMemory(row), hopEntityId: row.hop_entity_id as string },
    );
  }

  /* ------------------------------ edges ------------------------------ */

  /**
   * Draw a relation between two memories. The same triple is never stored
   * twice; a repeat raises the weight instead.
   */
  addEdge(input: {
    owner: string;
    srcId: string;
    dstId: string;
    relation: MemoryRelation;
    weight?: number;
    origin?: MemoryEdge['origin'];
    runId?: string;
  }): MemoryEdge | null {
    if (input.srcId === input.dstId) return null;
    // An edge whose endpoints do not both sit in the writer's bank would wire
    // two banks together — refuse it rather than persist the bridge.
    const endpoints = this.db
      .prepare('SELECT owner FROM memories WHERE id IN (?, ?)')
      .all(input.srcId, input.dstId) as Row[];
    if (endpoints.length !== 2 || endpoints.some((row) => row.owner !== input.owner)) return null;
    const now = Date.now();
    const existing = this.db
      .prepare(
        'SELECT * FROM memory_edges WHERE src_id = ? AND dst_id = ? AND relation = ? AND owner = ?',
      )
      .get(input.srcId, input.dstId, input.relation, input.owner) as Row | undefined;
    if (existing) {
      const weight = Math.min(1, Math.max(Number(existing.weight), input.weight ?? DEFAULT_EDGE_WEIGHT));
      this.db.prepare('UPDATE memory_edges SET weight = ? WHERE id = ?').run(weight, existing.id as string);
      return mapEdge({ ...existing, weight });
    }
    const edge: MemoryEdge = {
      id: randomUUID(),
      owner: input.owner,
      srcId: input.srcId,
      dstId: input.dstId,
      relation: input.relation,
      weight: clamp01(input.weight ?? DEFAULT_EDGE_WEIGHT),
      origin: input.origin ?? 'sleep',
      runId: input.runId,
      createdAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO memory_edges (id, owner, src_id, dst_id, relation, weight, origin, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        edge.id,
        edge.owner,
        edge.srcId,
        edge.dstId,
        edge.relation,
        edge.weight,
        edge.origin,
        edge.runId ?? null,
        now,
      );
    return edge;
  }

  /** Edges leaving these memories, optionally narrowed to some relations. */
  edgesFrom(ids: string[], relations?: MemoryRelation[]): MemoryEdge[] {
    if (!ids.length) return [];
    const sql =
      'SELECT * FROM memory_edges WHERE src_id IN (' + placeholders(ids) + ')' +
      (relations?.length ? ' AND relation IN (' + placeholders(relations) + ')' : '');
    const rows = this.db.prepare(sql).all(...([...ids, ...(relations ?? [])] as never[])) as Row[];
    return rows.map(mapEdge);
  }

  listEdges(owner: string, limit = 500): MemoryEdge[] {
    const rows = this.db
      .prepare('SELECT * FROM memory_edges WHERE owner = ? ORDER BY created_at DESC LIMIT ?')
      .all(owner, limit) as Row[];
    return rows.map(mapEdge);
  }

  deleteEdge(id: string): void {
    this.db.prepare('DELETE FROM memory_edges WHERE id = ?').run(id);
  }

  /** Everything hanging off one memory, for the inspector's detail panel. */
  neighbourhood(id: string): MemoryNeighbourhood | null {
    const memory = this.getMemory(id);
    if (!memory) return null;
    return {
      memory,
      entities: this.entitiesFor(id),
      outgoing: this.#edgesWithFarMemory(id, memory.owner, 'src_id', 'dst_id'),
      incoming: this.#edgesWithFarMemory(id, memory.owner, 'dst_id', 'src_id'),
    };
  }

  /**
   * The edges of one owner that hang off `nearEnd` of a memory, each with the
   * memory at its `farEnd`. Both ends are column names from the two callers
   * above, never anything a request carried.
   */
  #edgesWithFarMemory(
    id: string,
    owner: string,
    nearEnd: 'src_id' | 'dst_id',
    farEnd: 'src_id' | 'dst_id',
  ): MemoryNeighbourhood['outgoing'] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM memory_edges e JOIN memories m ON m.id = e.${farEnd}
          WHERE e.${nearEnd} = ? AND e.owner = ?`,
      )
      .all(id, owner) as Row[];
    const farMemories = this.#memoriesById(rows.map((row) => row[farEnd] as string));
    return rows.map((row) => ({ ...mapEdge(row), other: farMemories.get(row[farEnd] as string)! }));
  }

  /**
   * The graph the web view draws. Capped hard: a hairball of every memory
   * ever stored is not a picture of anything.
   */
  memoryGraph(options: {
    owner?: string;
    entityId?: string;
    kinds?: MemoryKind[];
    since?: number;
    includeDormant?: boolean;
    limit?: number;
  } = {}): MemoryGraph {
    const owner = options.owner ?? ASSISTANT_MEMORY_OWNER;
    const limit = Math.max(GRAPH_MIN_NODES, Math.min(options.limit ?? GRAPH_DEFAULT_NODES, GRAPH_MAX_NODES));
    const kinds = options.kinds ?? [];

    const filters =
      ' AND m.forgotten = 0' +
      (options.includeDormant ? '' : ' AND m.dormant_at IS NULL') +
      (options.since ? ' AND m.created_at >= ?' : '') +
      (kinds.length ? ' AND m.kind IN (' + placeholders(kinds) + ')' : '');
    const values: unknown[] = [owner];
    if (options.entityId) values.push(options.entityId);
    if (options.since) values.push(options.since);
    values.push(...kinds, limit + 1);

    const sql = options.entityId
      ? `SELECT m.* FROM memories m
           JOIN memory_entity_links l ON l.memory_id = m.id
          WHERE m.owner = ? AND l.entity_id = ?` + filters +
        ' ORDER BY m.importance DESC, m.updated_at DESC LIMIT ?'
      : `SELECT m.* FROM memories m WHERE m.owner = ?` + filters +
        ' ORDER BY m.importance DESC, m.updated_at DESC LIMIT ?';

    const rows = this.db.prepare(sql).all(...(values as never[])) as Row[];
    const truncated = rows.length > limit;
    const memories = rows.slice(0, limit).map(mapMemory);
    const ids = memories.map((memory) => memory.id);
    if (!ids.length) return { entities: [], memories: [], edges: [], links: [], truncated: false };

    const inIds = placeholders(ids);
    const linkRows = this.db
      .prepare('SELECT memory_id, entity_id FROM memory_entity_links WHERE memory_id IN (' + inIds + ')')
      .all(...(ids as never[])) as Row[];
    const links = linkRows.map((row) => ({
      memoryId: row.memory_id as string,
      entityId: row.entity_id as string,
    }));

    const entityIds = [...new Set(links.map((link) => link.entityId))];
    const entities = entityIds.length
      ? (this.db
          .prepare('SELECT * FROM memory_entities WHERE id IN (' + placeholders(entityIds) + ')')
          .all(...(entityIds as never[])) as Row[]).map(mapEntity)
      : [];

    // Only edges with both ends inside the picture; a dangling line is noise.
    const edges = (this.db
      .prepare('SELECT * FROM memory_edges WHERE src_id IN (' + inIds + ') AND dst_id IN (' + inIds + ')')
      .all(...([...ids, ...ids] as never[])) as Row[]).map(mapEdge);

    return { entities, memories, edges, links, truncated };
  }

  /* --------------------------- the day's talk --------------------------- */

  /**
   * Conversations that moved since `since`, newest first.
   *
   * Mail and cron-run sessions are left out on purpose: those are the
   * assistant answering a mail or carrying out a schedule with nobody on the
   * other end, so there is no user in them to quote, and the evidence rule
   * would throw away everything they yielded anyway. Archived ones are out
   * for the same reason they are out of the list - the user put them away.
   */
  sessionsActiveSince(since: number, limit = 50): Session[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
           FROM sessions s
          WHERE s.archived = 0
            AND s.kind NOT IN ('mail', 'schedule')
            AND s.updated_at > ?
          ORDER BY s.updated_at DESC
          LIMIT ?`,
      )
      .all(since, limit) as Row[];
    return rows.map(mapSession);
  }

  /* ---------------------------- corrections ---------------------------- */

  /**
   * Record that the user put something right.
   *
   * Kept apart from memories because it is not a fact about the user, it is
   * evidence about the system: something written down is wrong. The revision
   * pass consumes these; nothing else reads them.
   *
   * `turnId` is what the correction label hangs on (concept 4.2a, S3): the
   * turn the quote was located in, or absent when the quote could not be
   * pinned to exactly one turn. Absent is a real answer here - a guessed
   * turn is worse than no turn, because the label would then claim
   * something about a turn that never carried the quote.
   */
  addCorrection(input: {
    owner: string;
    text: string;
    quote: string;
    sessionId?: string;
    turnId?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO corrections (id, owner, text, quote, session_id, created_at, turn_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.owner,
        input.text.trim(),
        input.quote.trim(),
        input.sessionId ?? null,
        Date.now(),
        input.turnId ?? null,
      );
  }

  /** Corrections no revision pass has looked at yet, oldest first. */
  openCorrections(owner: string, limit = 20): { id: string; text: string; quote: string }[] {
    const rows = this.db
      .prepare(
        `SELECT id, text, quote FROM corrections
          WHERE owner = ? AND consumed_at IS NULL
          ORDER BY created_at ASC LIMIT ?`,
      )
      .all(owner, limit) as Row[];
    return rows.map((row) => ({
      id: row.id as string,
      text: row.text as string,
      quote: row.quote as string,
    }));
  }

  /**
   * Mark corrections as looked at. Not removed: a correction is a fact about
   * what happened, and the record of it outlives the repair it caused.
   */
  consumeCorrections(ids: string[]): void {
    if (!ids.length) return;
    const mark = this.db.prepare('UPDATE corrections SET consumed_at = ? WHERE id = ?');
    const now = Date.now();
    this.#atomically(() => {
      for (const id of ids) mark.run(now, id);
    });
  }

  /**
   * Corrections of one owner written since `since`, consumed or not.
   *
   * `openCorrections` is the revision pass's reader and deliberately hides
   * everything a pass has already looked at. The label writer needs the
   * other view: a correction stays evidence about its turn long after the
   * repair it caused, and the night that writes labels is not the night
   * that consumed it.
   */
  correctionsSince(
    owner: string,
    since: number,
    limit = 200,
  ): { id: string; text: string; quote: string; sessionId?: string; turnId?: string; createdAt: number }[] {
    const rows = this.db
      .prepare(
        `SELECT id, text, quote, session_id, turn_id, created_at FROM corrections
          WHERE owner = ? AND created_at >= ?
          ORDER BY created_at ASC LIMIT ?`,
      )
      .all(owner, since, limit) as Row[];
    return rows.map((row) => ({
      id: row.id as string,
      text: row.text as string,
      quote: row.quote as string,
      sessionId: (row.session_id as string) ?? undefined,
      turnId: (row.turn_id as string) ?? undefined,
      createdAt: Number(row.created_at),
    }));
  }

  /* ------------------------ skill bookkeeping ------------------------ */

  /**
   * Note that a skill was opened.
   *
   * On its own this is a usage counter. Joined against the assignment it was
   * opened in, it becomes the only thing that can say a written procedure is
   * actually wrong: the run that followed it failed, and the error text is
   * right there to hand to the rewrite.
   */
  recordSkillUse(input: {
    skill: string;
    owner: string;
    assignmentId?: string;
    sessionId?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO skill_uses (id, skill, owner, assignment_id, session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.skill,
        input.owner,
        input.assignmentId ?? null,
        input.sessionId ?? null,
        Date.now(),
      );
  }

  /** The memories a distilled skill stands on. Replaces whatever was there. */
  setSkillSources(skill: string, owner: string, memoryIds: string[]): void {
    const now = Date.now();
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO skill_sources (skill, memory_id, owner, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    this.#atomically(() => {
      this.db.prepare('DELETE FROM skill_sources WHERE skill = ?').run(skill);
      for (const id of memoryIds) insert.run(skill, id, owner, now);
    });
  }

  /** The memory ids a skill currently stands on. */
  skillSourceIds(skill: string): string[] {
    const rows = this.db
      .prepare('SELECT memory_id FROM skill_sources WHERE skill = ?')
      .all(skill) as Row[];
    return rows.map((row) => row.memory_id as string);
  }

  /**
   * The ground under a skill, where it has moved since `since`.
   *
   * Three ways a source memory stops supporting what stands on it: the night
   * put it to sleep, the night decided a contradiction against it and filed
   * it away behind a winner, or somebody edited it. All three mean the same
   * thing to the skill above - what it was written from no longer reads the
   * way it did.
   */
  changedSkillSources(
    skill: string,
    since: number,
  ): { memory: MemoryRecord; replacement: MemoryRecord | null }[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM skill_sources s
           JOIN memories m ON m.id = s.memory_id
          WHERE s.skill = ?
            AND (m.dormant_at IS NOT NULL OR m.superseded_by IS NOT NULL OR m.updated_at > ?)
          ORDER BY m.updated_at DESC
          LIMIT 12`,
      )
      .all(skill, since) as Row[];
    return rows.map((row) => {
      const memory = mapMemory(row);
      return {
        memory,
        replacement: memory.supersededBy ? this.getMemory(memory.supersededBy) : null,
      };
    });
  }

  /**
   * Runs that failed with this skill open, newest first.
   *
   * The error text matters more than the count. "That the run failed" says
   * only that something is wrong somewhere; "npm run build:core: no such
   * script" says which line of the skill is lying.
   */
  failedRunsForSkill(
    skill: string,
    since: number,
    limit = 5,
  ): { task: string; error: string }[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT a.id, a.task, a.error, a.finished_at FROM skill_uses u
           JOIN assignments a ON a.id = u.assignment_id
          WHERE u.skill = ?
            AND a.status = 'failed'
            AND a.error IS NOT NULL
            AND a.finished_at > ?
          ORDER BY a.finished_at DESC
          LIMIT ?`,
      )
      .all(skill, since, limit) as Row[];
    return rows.map((row) => ({ task: row.task as string, error: row.error as string }));
  }

  /**
   * Keep the file as it reads right now, before something unattended
   * overwrites it. `content` is null when the skill does not exist yet, which
   * is how undo knows to delete the folder rather than restore text.
   */
  snapshotSkill(input: { skill: string; content: string | null; sleepRunId?: string }): void {
    this.db
      .prepare(
        'INSERT INTO skill_versions (id, skill, content, sleep_run_id, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), input.skill, input.content, input.sleepRunId ?? null, Date.now());
  }

  /**
   * When the night last looked at this skill, revision or not.
   *
   * Without it a trigger never clears. A source memory that went dormant
   * stays dormant, so a skill standing on it would be dragged in front of the
   * model every single night, and a night that decided "this still reads
   * fine" would decide it again tomorrow at the same cost. Looking counts,
   * which is why a review that changed nothing still leaves a snapshot.
   */
  lastSkillReviewAt(skill: string): number {
    const row = this.db
      .prepare('SELECT MAX(created_at) AS at FROM skill_versions WHERE skill = ?')
      .get(skill) as { at: number | null } | undefined;
    return Number(row?.at ?? 0);
  }

  /**
   * What the skills of one night looked like before it touched them, oldest
   * snapshot first - so a caller that keeps the first entry per name gets the
   * state as it stood before the night began, even if a run wrote twice.
   */
  skillVersionsForRun(runId: string): { skill: string; content: string | null }[] {
    const rows = this.db
      .prepare(
        'SELECT skill, content FROM skill_versions WHERE sleep_run_id = ? ORDER BY created_at ASC',
      )
      .all(runId) as Row[];
    return rows.map((row) => ({
      skill: row.skill as string,
      content: (row.content as string) ?? null,
    }));
  }

  /* --------------------------- sleep runs --------------------------- */

  createSleepRun(input: { owner: string; trigger: CronTrigger }): SleepRun {
    const run: SleepRun = {
      id: randomUUID(),
      startedAt: sleepRunStart(this.db),
      owner: input.owner,
      trigger: input.trigger,
      status: 'running',
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
      dreamTracesSeen: 0,
      dreamFramesScored: 0,
      dreamCandidates: 0,
      dreamPromoted: 0,
      dreamLabelsWritten: 0,
      modelCalls: 0,
    };
    this.db
      .prepare('INSERT INTO sleep_runs (id, owner, trigger, status, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(run.id, run.owner, run.trigger, run.status, run.startedAt);
    return run;
  }

  updateSleepRun(
    id: string,
    patch: Partial<Omit<SleepRun, 'id' | 'owner' | 'trigger' | 'startedAt'>>,
  ): SleepRun | null {
    const assignments = assignmentsFor(SLEEP_RUN_PATCH_COLUMNS, patch);
    if (assignments.sets.length) this.#updateById('sleep_runs', assignments, id);
    return this.getSleepRun(id);
  }

  getSleepRun(id: string): SleepRun | null {
    const row = this.db.prepare('SELECT * FROM sleep_runs WHERE id = ?').get(id) as Row | undefined;
    return row ? mapSleepRun(row) : null;
  }

  listSleepRuns(options: { owner?: string; limit?: number } = {}): SleepRun[] {
    const rows = options.owner
      ? (this.db
          .prepare('SELECT * FROM sleep_runs WHERE owner = ? ORDER BY started_at DESC LIMIT ?')
          .all(options.owner, options.limit ?? 30) as Row[])
      : (this.db
          .prepare('SELECT * FROM sleep_runs ORDER BY started_at DESC LIMIT ?')
          .all(options.limit ?? 30) as Row[]);
    return rows.map(mapSleepRun);
  }

  /**
   * Sleep runs still marked running from a previous process are failed on
   * startup, mirroring `CronStore.failStaleRuns` (cron/store.ts) and
   * `OrgStore.failStaleAssignments`/`failStaleTasks` (org/store.ts). Returns
   * the rows it changed so the caller can announce them.
   */
  failStaleSleepRuns(reason: string): SleepRun[] {
    return this.#atomically(() => {
      const rows = this.db.prepare("SELECT * FROM sleep_runs WHERE status = 'running'").all() as Row[];
      if (!rows.length) return [];
      const now = Date.now();
      this.db
        .prepare("UPDATE sleep_runs SET status = 'failed', error = ?, finished_at = ? WHERE status = 'running'")
        .run(reason, now);
      return rows.map((row) => mapSleepRun({ ...row, status: 'failed', error: reason, finished_at: now }));
    });
  }

  /** When this owner last finished a night. Drives "what is new since then". */
  lastSleepAt(owner: string): number {
    const row = this.db
      .prepare(
        "SELECT MAX(finished_at) AS at FROM sleep_runs WHERE owner = ? AND status = 'done' AND undone_at IS NULL",
      )
      .get(owner) as { at: number | null };
    return Number(row?.at ?? 0);
  }

  /**
   * Take back one night, in a single transaction: the memories the run wrote
   * are deleted, everything it put to sleep wakes up, and its edges go. The
   * frames go with them - they quote the deleted rows verbatim, and the drop
   * is the same owner-level mechanics the other memory delete paths use
   * (R17). This is what makes an unattended nightly process acceptable at
   * all.
   *
   * The night's promotions come back with them (concept 10.4, S25): a
   * policy version is as much a product of the night as an insight is, and
   * a night that cannot be taken back in full is not undoable.
   */
  undoSleepRun(id: string): { woken: number; removed: number; edges: number; policies: number } | null {
    const run = this.getSleepRun(id);
    if (!run || run.undoneAt) return null;

    // Counted up front: deleting a memory cascades its edges away, so a
    // count taken afterwards would report a fraction of what actually went.
    const edges = this.#countRows('SELECT COUNT(*) AS n FROM memory_edges WHERE run_id = ?', id);
    const counts = this.#atomically(() => {
      const { woken, removed } = this.#undoMemoryChanges(run);
      this.db.prepare('DELETE FROM memory_edges WHERE run_id = ?').run(id);
      const policies = this.#undoPolicyPromotions(run);
      // The evaluations of an undone night certify nothing: their traces are
      // partly gone with the memories above, and `trace_set_hash` disjointness
      // must not be blocked by a measurement that no longer stands.
      this.db
        .prepare('DELETE FROM dream_evals WHERE sleep_run_id = ? AND created_at >= ?')
        .run(id, run.startedAt);
      this.db.prepare('UPDATE sleep_runs SET undone_at = ? WHERE id = ?').run(Date.now(), id);
      return { woken, removed, edges, policies };
    });
    this.recountEntities(run.owner);
    return counts;
  }

  /**
   * The memory half of an undo: the rows the run wrote go, the rows it put
   * to sleep wake. Frames quote the rows this run wrote verbatim, and undo
   * deletes those rows outright, so the frames holding them fall first,
   * inside the same transaction (R17). Only those frames: every other frame
   * still describes a bank that exists.
   */
  #undoMemoryChanges(run: SleepRun): { woken: number; removed: number } {
    // The two sets are kept disjoint: a memory this run wrote and a memory
    // it put to sleep are handled by different branches, never both - so
    // the rows are picked before anything wakes.
    const written = this.db
      // `extract` belongs here as well as `sleep`: the replay phase harvests
      // memories out of the day's conversations, and those are as much a
      // product of the night as an insight is. Still disjoint from the
      // branch below, which takes the memories the run put to SLEEP - a row
      // the run wrote is never also a row the run retired. Nor can a run
      // have written a memory older than itself: a row that carries this
      // run's id but predates it is one the run revived (see `upsertMemory`)
      // or one somebody woke again, never one it created, so undo must not
      // delete it. `sleepRunStart` is what keeps that comparison honest at
      // millisecond resolution.
      .prepare(
        `SELECT id FROM memories
          WHERE sleep_run_id = ? AND origin IN ('sleep', 'extract') AND dormant_at IS NULL
            AND created_at >= ?`,
      )
      .all(run.id, run.startedAt)
      .map((row) => row.id as string);
    // Anything that pointed at a memory this run created must let go first.
    const letGo = this.db.prepare('UPDATE memories SET superseded_by = NULL WHERE superseded_by = ?');
    for (const memoryId of written) letGo.run(memoryId);
    const woken = changesOf(
      this.db
        .prepare(
          `UPDATE memories SET dormant_at = NULL, superseded_by = NULL, sleep_run_id = NULL
            WHERE sleep_run_id = ? AND dormant_at IS NOT NULL`,
        )
        .run(run.id),
    );
    this.dropDreamFramesQuoting(run.owner, written);
    const remove = this.db.prepare('DELETE FROM memories WHERE id = ?');
    for (const memoryId of written) remove.run(memoryId);
    return { woken, removed: written.length };
  }

  /**
   * The promotions of the night, in the same transaction and with the same
   * "written by" against "touched by" distinction the memory half makes: a
   * version carrying this run's id that predates the run was promoted by an
   * earlier night and merely re-read here. Returns how many it took back.
   */
  #undoPolicyPromotions(run: SleepRun): number {
    const promoted = this.db
      .prepare(
        `SELECT id, prev_active_id FROM policy_versions
          WHERE sleep_run_id = ? AND created_at >= ?`,
      )
      .all(run.id, run.startedAt) as Row[];
    const retire = this.db.prepare('UPDATE policy_versions SET retired_at = ? WHERE id = ?');
    const reactivate = this.db.prepare('UPDATE policy_versions SET retired_at = NULL WHERE id = ?');
    const retiredAt = Date.now();
    for (const row of promoted) {
      retire.run(retiredAt, row.id as string);
      // NULL means "nothing was active when this was promoted", the same
      // way `snapshotSkill` records a skill that did not exist yet - there
      // is then nothing to bring back, and the slot falls to the defaults.
      const previous = row.prev_active_id as string | null;
      if (previous) reactivate.run(previous);
    }
    return promoted.length;
  }

  /* ------------------------------ dream ------------------------------ */

  /**
   * Every write of one framed turn runs inside this bracket: trace, frame
   * and touches are one transaction, or none of them are.
   *
   * A SAVEPOINT rather than a hand-rolled BEGIN (R9): the store runs its
   * own transactions over raw `exec`, and a bare nested BEGIN throws
   * exactly when the recorder happens to run inside one of them. A
   * savepoint nests by construction, so no "am I inside" flag is needed -
   * that flag is the thing that silently rots the next time someone adds
   * a transactional procedure. A throw inside the bracket rolls the whole
   * turn back and propagates, so the caller still sees the recorder error.
   */
  recordDreamTurn(write: () => void): void {
    this.#atomically(write);
  }

  /** Open one trace per recall call; the turn groups them under `turnId` (R19). */
  beginTrace(input: DreamTraceInput): DreamTrace {
    const now = Date.now();
    const trace: DreamTrace = {
      id: randomUUID(),
      turnId: input.turnId,
      owner: input.owner,
      kind: input.kind,
      site: input.site,
      pipeline: input.pipeline,
      sessionId: input.sessionId,
      sessionKind: input.sessionKind,
      assignmentId: input.assignmentId,
      sleepRunId: input.sleepRunId,
      turnIndex: input.turnIndex ?? 0,
      policySet: input.policySet,
      framed: input.framed ?? false,
      holdout: input.holdout ?? false,
      audit: input.audit ?? false,
      degraded: null,
      startedAt: now,
      createdAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO dream_traces
           (id, turn_id, owner, kind, site, pipeline, session_id, session_kind, assignment_id,
            sleep_run_id, turn_index, policy_set, framed, holdout, audit, started_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trace.id,
        trace.turnId,
        trace.owner,
        trace.kind,
        trace.site,
        trace.pipeline,
        trace.sessionId ?? null,
        trace.sessionKind ?? null,
        trace.assignmentId ?? null,
        trace.sleepRunId ?? null,
        trace.turnIndex,
        JSON.stringify(trace.policySet),
        trace.framed ? 1 : 0,
        trace.holdout ? 1 : 0,
        trace.audit ? 1 : 0,
        trace.startedAt,
        trace.createdAt,
      );
    return trace;
  }

  /**
   * Close a trace. `degraded` is the one closable fact, and an explicit
   * `null` is a real value ("the call did not degrade"), never a default:
   * "rows came but all fell below the threshold" is a legitimate miss that
   * must stay scoreable.
   */
  finishTrace(id: string, patch: DreamTracePatch): void {
    this.db
      .prepare('UPDATE dream_traces SET degraded = ?, finished_at = ? WHERE id = ?')
      .run(patch.degraded ?? null, Date.now(), id);
  }

  /**
   * Traces still open from a previous process are closed on startup, after
   * the pattern of `failStaleSleepRuns` - deliberately without an owner or
   * PID filter, and with the same reservation. The reason reaches the
   * caller's log line rather than the row: `dream_traces` carries no error
   * column on purpose, because the "unfinished" abstention is derived from
   * `finished_at` itself at scoring time. Returns how many traces closed.
   */
  failStaleTraces(reason: string): number {
    // Kept for signature parity with the sibling stale-failers; see above.
    void reason;
    return changesOf(
      this.db.prepare('UPDATE dream_traces SET finished_at = ? WHERE finished_at IS NULL').run(Date.now()),
    );
  }

  /** Traces without `finished_at`: what a restart owes its closing pass to. */
  openTraces(): DreamTrace[] {
    const rows = this.db
      .prepare('SELECT * FROM dream_traces WHERE finished_at IS NULL ORDER BY started_at ASC, id')
      .all() as Row[];
    return rows.map(mapDreamTrace);
  }

  /**
   * Persist one frame for one slot of a trace. The payload is stored gzipped:
   * a frame freezes up to four times the recall limit in rows plus their
   * entities and edges, which is 150-240 KB of JSON on a bank of a few
   * hundred memories and compresses roughly tenfold. Serialise and compress
   * first, measure second: the cap guards STORED bytes, and a frame still
   * over it is refused with `false` rather than thrown at the turn - the
   * trace is closed without a frame and the night simply never scores that
   * turn.
   *
   * The Store holds no config, so the caller reads `dream.maxFrameBytes`
   * (key table, E21: clamped where it is read) and passes it; the default
   * here is the shipped value. A payload that cannot be serialised at all
   * is a recorder error and propagates - the bracket around the turn
   * takes care of the half-written state.
   */
  saveFrame(traceId: string, slot: string, frame: RecallFrame, options: { maxFrameBytes?: number } = {}): boolean {
    const payload = gzipSync(JSON.stringify(frame));
    const bytes = payload.byteLength;
    if (bytes > (options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES)) return false;
    // The session is read from the trace: the frame itself does not carry
    // it, and the delete paths need it as a column (R17). A missing trace
    // fails the insert on the foreign key, which is the correct outcome -
    // a frame cannot exist without its trace.
    const trace = this.db
      .prepare('SELECT session_id FROM dream_traces WHERE id = ?')
      .get(traceId) as { session_id: string | null } | undefined;
    this.db
      .prepare(
        `INSERT INTO dream_frames
           (trace_id, slot, frame_v, owner, session_id, box, corpus_stamp_id, payload, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        traceId,
        slot,
        frame.v,
        frame.owner,
        trace?.session_id ?? null,
        JSON.stringify(frame.box),
        frame.corpusStampId,
        payload,
        bytes,
        Date.now(),
      );
    return true;
  }

  /**
   * Append one touch row per memory id. Deliberately append-only (R4):
   * two touches of the same (trace, memory) are two rows, because the
   * record exists to make the historyless counters reconstructable, not
   * to dedupe them.
   */
  recordTouches(traceId: string, owner: string, ids: string[], policyId?: string): void {
    if (!ids.length) return;
    const now = Date.now();
    // The turn id rides along from the trace, so labels can attach at the
    // turn without a second lookup (R19).
    const insert = this.db.prepare(
      `INSERT INTO memory_touches (id, owner, memory_id, turn_id, trace_id, policy_id, at)
       VALUES (?, ?, ?, (SELECT turn_id FROM dream_traces WHERE id = ?), ?, ?, ?)`,
    );
    this.#atomically(() => {
      for (const memoryId of ids) {
        insert.run(randomUUID(), owner, memoryId, traceId, traceId, policyId ?? null, now);
      }
    });
  }

  /**
   * The night's read path: stored frames of one owner with their traces.
   * Oldest first with (trace, slot) as the tiebreaker, so the probe walks
   * a deterministic order; `since` selects on the frame's own creation.
   *
   * `newest` says WHICH end the limit cuts from, never which order comes
   * back: the rows are handed over oldest first either way, so the last
   * entry is always the newest one and every caller that reads a box or a
   * trailing slice off the tail keeps reading the same thing. Without it a
   * limited pool is the OLDEST rows, and a reader that means "since the
   * last promotion" or "the newest slice" goes structurally dead the moment
   * an owner holds more frames than the cap - it is pinned to a
   * weeks-old slice for good. The default stays oldest, because the grid
   * probe walks and reports exactly that pool.
   */
  framesFor(
    owner: string,
    options: { since?: number; limit?: number; newest?: boolean } = {},
  ): { trace: DreamTrace; frame: DreamFrame }[] {
    // Descending on all three keys, so the cut is the exact tail of the
    // ascending order and reversing it restores that order row for row.
    const order = options.newest
      ? ' ORDER BY f.created_at DESC, f.trace_id DESC, f.slot DESC LIMIT ?'
      : ' ORDER BY f.created_at ASC, f.trace_id, f.slot LIMIT ?';
    const sql =
      `SELECT t.*, f.trace_id AS f_trace_id, f.owner AS f_owner, f.session_id AS f_session_id,
              f.slot AS f_slot, f.frame_v AS f_frame_v, f.box AS f_box,
              f.corpus_stamp_id AS f_corpus_stamp_id, f.payload AS f_payload,
              f.bytes AS f_bytes, f.created_at AS f_created_at
         FROM dream_frames f
         JOIN dream_traces t ON t.id = f.trace_id
        WHERE f.owner = ?` +
      (options.since ? ' AND f.created_at >= ?' : '') +
      order;
    const values: unknown[] = [owner];
    if (options.since) values.push(options.since);
    values.push(options.limit ?? 500);
    const rows = this.db.prepare(sql).all(...(values as never[])) as Row[];
    if (options.newest) rows.reverse();
    return rows.map((row) => ({ trace: mapDreamTrace(row), frame: mapDreamFrame(row) }));
  }

  /**
   * How many stored frames one owner has, regardless of any pool limit.
   * `framesFor` walks a capped pool from one end or the other, so every
   * reader that can hit the cap reports this count beside the pool it
   * actually read - a measurement over half the frames must be visible as
   * one, not pass silently.
   */
  dreamFrameCount(owner: string): number {
    return this.#countRows('SELECT COUNT(*) AS n FROM dream_frames WHERE owner = ?', owner);
  }

  /**
   * Traces opened as framed since `since` that hold no frame: turns the
   * recorder refused for size, or whose frame a delete took. The night
   * reports it, because a recorder that fails quietly leaves the pool empty
   * without anything looking wrong.
   */
  countFramelessTraces(owner: string, since: number): number {
    return this.#countRows(
      `SELECT COUNT(*) AS n FROM dream_traces t
        WHERE t.owner = ? AND t.framed = 1 AND t.started_at >= ?
          AND NOT EXISTS (SELECT 1 FROM dream_frames f WHERE f.trace_id = t.id)`,
      owner,
      since,
    );
  }

  /**
   * Delete frames older than `before`, in batches that each own their
   * transaction. With foreign keys on, deleting a trace cascades its
   * frames and touches inside the same statement, and an unbounded sweep
   * would be one long exclusive write lock on the only connection. See
   * `#sweepOlderThan`; night-side by design.
   */
  sweepDreamFrames(before: number): number {
    // Row values pick the exact (trace, slot) pairs: the table's key is a
    // pair, and deleting by trace_id alone would be wrong the day a second
    // slot arrives.
    return this.#sweepOlderThan('dream_frames', ['trace_id', 'slot'], before);
  }

  /**
   * Delete traces older than `before` (their frames and touches cascade),
   * batched like `sweepDreamFrames` and for the same reasons.
   */
  sweepDreamTraces(before: number): number {
    return this.#sweepOlderThan('dream_traces', ['id'], before);
  }

  /**
   * The delete paths of R17: a frame is a verbatim store, so it may never
   * outlive the memories or the session it came from. Owner and session
   * sit on the frame as their own columns so the whole-bank and the
   * per-session drops never have to read a payload. `Assistant.deleteSession`
   * calls the session variant; `archiveMemories` retires a whole bank and
   * calls the owner one.
   */
  dropDreamFramesForOwner(owner: string): number {
    return changesOf(this.db.prepare('DELETE FROM dream_frames WHERE owner = ?').run(owner));
  }

  /**
   * Drop the frames of one bank that quote any of these memories. A frame
   * cannot be edited piecemeal - replaying it needs every row it froze - so
   * it goes whole, but only when it actually holds one of the ids. Dropping
   * the owner's frames instead made every single `forget` wipe the evidence
   * pool the night measures on, which is how the dream sat at a handful of
   * frames for weeks. A frame that cannot be read cannot be checked either,
   * so it goes with them: the safe direction for a verbatim store.
   */
  dropDreamFramesQuoting(owner: string, memoryIds: readonly string[]): number {
    if (!memoryIds.length) return 0;
    const frames = this.db
      .prepare('SELECT trace_id, slot, payload FROM dream_frames WHERE owner = ?')
      .all(owner) as Row[];
    const drop = this.db.prepare('DELETE FROM dream_frames WHERE trace_id = ? AND slot = ?');
    return this.#atomically(() => {
      let dropped = 0;
      for (const frame of frames) {
        if (frameQuotes(frame.payload, memoryIds)) {
          drop.run(frame.trace_id as string, frame.slot as string);
          dropped += 1;
        }
      }
      return dropped;
    });
  }

  /** See `dropDreamFramesForOwner`. */
  dropDreamFramesForSession(sessionId: string): number {
    return changesOf(this.db.prepare('DELETE FROM dream_frames WHERE session_id = ?').run(sessionId));
  }

  /**
   * The document-frequency fingerprint of the corpus, over exactly the
   * tokens the frames of one night use (R10). bm25 is frozen in the frame
   * and can never be revalidated, so the corpus is the only observable
   * that correlates with a frame going stale - and the vocabulary scan
   * walks the whole index, which is why this runs once per night in the
   * probe and never inside a turn. The result is cached in `meta` under
   * its own id; turns stamp only that id onto their frames.
   */
  corpusFingerprint(owner: string, tokens: string[]): FrameCorpus {
    const distinct = [...new Set(tokens)].sort();
    const df: Record<string, number> = {};
    if (distinct.length) {
      const rows = this.db
        .prepare('SELECT term, doc FROM memories_fts_v WHERE term IN (' + placeholders(distinct) + ')')
        .all(...(distinct as never[])) as { term: string; doc: number }[];
      for (const row of rows) df[row.term] = Number(row.doc);
    }
    // A token the index has never seen still belongs in the fingerprint:
    // df 0 then and df > 0 today is the largest relative move there is.
    for (const term of distinct) if (df[term] === undefined) df[term] = 0;

    const corpus: FrameCorpus = { id: randomUUID(), owner, at: Date.now(), df };
    this.#atomically(() => {
      this.setMeta(CORPUS_STAMP_PREFIX + corpus.id, JSON.stringify(corpus));
      this.setMeta(CORPUS_CURRENT_PREFIX + owner, corpus.id);
      this.pruneCorpusStamps(owner, corpus.id);
    });
    return corpus;
  }

  /**
   * Retention for the stamp rows: one is written per night and nothing ever
   * removed them, so `meta` grew a full df map per night without bound. A
   * stamp is only ever read through a frame's `corpus_stamp_id` or the
   * current pointer, so a stamp of this owner that no frame cites and that
   * is not the fresh one is dead the moment the pointer moves. Corrupt rows
   * are left alone - a row nothing can parse certifies nothing either way,
   * and this method never throws into the night.
   */
  pruneCorpusStamps(owner: string, keepId: string): void {
    // `substr`, not LIKE: the `_` in the prefix is a LIKE wildcard.
    const rows = this.db
      .prepare('SELECT key, value FROM meta WHERE substr(key, 1, ?) = ?')
      .all(CORPUS_STAMP_PREFIX.length, CORPUS_STAMP_PREFIX) as Row[];
    if (rows.length <= 1) return;
    const cited = new Set(
      (this.db
        .prepare('SELECT DISTINCT corpus_stamp_id AS id FROM dream_frames WHERE corpus_stamp_id IS NOT NULL')
        .all() as { id: string }[]).map((row) => row.id),
    );
    const drop = this.db.prepare('DELETE FROM meta WHERE key = ?');
    this.#atomically(() => {
      for (const row of rows) {
        const id = (row.key as string).slice(CORPUS_STAMP_PREFIX.length);
        if (id === keepId || cited.has(id)) continue;
        if (parseJsonColumn<FrameCorpus>(row.value)?.owner !== owner) continue;
        drop.run(row.key as string);
      }
    });
  }

  /**
   * The stamp a turn should carry: the newest fingerprint of this owner.
   * A meta read and nothing more - computing here would drag the
   * vocabulary scan into the turn. Null until the first night has stamped
   * one, and null for a corrupted row rather than a throw: a stamp that
   * cannot be read simply does not certify anything.
   */
  currentCorpusStamp(owner: string): FrameCorpus | null {
    const id = this.getMeta(CORPUS_CURRENT_PREFIX + owner);
    if (!id) return null;
    const stored = this.getMeta(CORPUS_STAMP_PREFIX + id);
    if (!stored) return null;
    return parseJsonColumn<FrameCorpus>(stored) ?? null;
  }

  /* --------------------------- dream, stage 2+ --------------------------- */

  /*
   * Labels, policy versions, slot state, evaluations and episodes: what
   * turns a measurement into a promotion that can be taken back again.
   * Stage 1 above only records and scores.
   *
   * Two rules hold for everything in this block. Every read path filters by
   * owner in SQL, and once more in JS wherever a join could carry a row
   * across an owner boundary (concept 10.5) - `dream_evals` has no owner
   * column of its own and reaches it only through `policy_versions`. And
   * nothing here deletes evidence: a label whose target is gone gets
   * `dead_at`, never a DELETE (8.3, S9).
   */

  /**
   * Write one label; see `putLabels`.
   */
  putLabel(label: DreamLabel): void {
    this.putLabels([label]);
  }

  /**
   * Write a batch of labels, returning how many rows went in - that count is
   * the run's `dreamLabelsWritten`.
   *
   * `(turn_id, target, source)` is the key, so one source re-stating its
   * claim about the same target in the same turn replaces its own row
   * instead of stacking a second one. A contradiction BETWEEN two sources
   * keeps both rows, which is exactly what makes it countable rather than
   * silently overwritten (concept 4.1, S2).
   *
   * A session-scoped label carries the SESSION id in `turn_id`: the column
   * is NOT NULL and part of the key, and `scope` is what says which of the
   * two a row holds (the comment AP1 left on the table).
   */
  putLabels(labels: DreamLabel[]): number {
    if (!labels.length) return 0;
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO dream_labels
         (turn_id, target, source, relevance, scope, evidence, dead_at, created_at, owner, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#atomically(() => {
      for (const label of labels) {
        insert.run(
          label.turnId,
          label.target,
          label.source,
          label.relevance,
          label.scope,
          label.evidence ?? null,
          label.deadAt ?? null,
          label.createdAt,
          label.owner,
          label.sessionId ?? null,
        );
      }
    });
    return labels.length;
  }

  /**
   * Labels of these turns, oldest first. `owner` is optional because a turn
   * id already belongs to exactly one owner; the paths that have it to hand
   * pass it, so the filter is in the SQL where 10.5 wants it.
   */
  labelsForTurns(turnIds: string[], owner?: string): DreamLabel[] {
    return this.#selectLabels('', turnIds, owner);
  }

  /**
   * The session-scoped labels of these sessions - the unlocatable quote
   * (4.2a) and the user's edits (4.2b) both land here. Selected on
   * `turn_id`, not on `session_id`: for `scope = 'session'` the turn column
   * is where the session id lives, and it is the only one guaranteed to be
   * filled.
   */
  labelsForSessions(sessionIds: string[], owner?: string): DreamLabel[] {
    return this.#selectLabels("scope = 'session' AND ", sessionIds, owner);
  }

  /** `scopeFilter` is a SQL fragment from the two callers, ending in `AND ` or empty. */
  #selectLabels(scopeFilter: string, turnColumnValues: string[], owner?: string): DreamLabel[] {
    if (!turnColumnValues.length) return [];
    const sql =
      'SELECT * FROM dream_labels WHERE ' + scopeFilter + 'turn_id IN (' + placeholders(turnColumnValues) + ')' +
      (owner ? ' AND owner = ?' : '') +
      ' ORDER BY created_at ASC, target, source';
    const values: unknown[] = [...turnColumnValues];
    if (owner) values.push(owner);
    const rows = this.db.prepare(sql).all(...(values as never[])) as Row[];
    return rows.map(mapDreamLabel);
  }

  /**
   * Mark every label about one memory dead (S9). The row stays: what it
   * claims about the turns it was written for is still true, and the label
   * history is calibration material. Without this, a deleted memory would
   * drag `reachable_rate` down for a reason that has nothing to do with
   * labelling and invalidate the evaluation from the wrong end (8.3).
   */
  markLabelsDead(memoryId: string, at = Date.now()): number {
    return changesOf(
      this.db
        .prepare('UPDATE dream_labels SET dead_at = ? WHERE target = ? AND dead_at IS NULL')
        .run(at, memoryId),
    );
  }

  /** `markLabelsDead` for a whole bank at once - the archive path (S9). */
  markOwnerLabelsDead(owner: string, at = Date.now()): number {
    return changesOf(
      this.db.prepare('UPDATE dream_labels SET dead_at = ? WHERE owner = ? AND dead_at IS NULL').run(at, owner),
    );
  }

  /**
   * How many labels of each source this owner gained since `since` - the
   * supply side of 4.5, and what the night reports. Counted on creation, so
   * a label that has since gone dead still counts: it was written, and the
   * question here is how much a window actually produces.
   */
  labelCounts(owner: string, since: number): Record<DreamLabelSource, number> {
    const counts: Record<DreamLabelSource, number> = { correction: 0, review: 0, merge: 0, user: 0 };
    const rows = this.db
      .prepare(
        `SELECT source, COUNT(*) AS n FROM dream_labels
          WHERE owner = ? AND created_at >= ?
          GROUP BY source`,
      )
      .all(owner, since) as Row[];
    for (const row of rows) {
      const source = row.source as DreamLabelSource;
      if (source in counts) counts[source] = Number(row.n ?? 0);
    }
    return counts;
  }

  /** Retention for the label table (`dream.retainDays`), batched like the frames. */
  sweepDreamLabels(before: number): number {
    // The table has no single-column primary key, so the sweep picks the
    // exact key triples, the way `sweepDreamFrames` picks (trace, slot).
    return this.#sweepOlderThan('dream_labels', ['turn_id', 'target', 'source'], before);
  }

  /**
   * Write a new, unpromoted policy version. The version number is the next
   * one for this `(owner, slot)`; the unique index is what makes that a
   * constraint rather than a hope.
   */
  createPolicyVersion(input: {
    owner: string;
    slot: DreamSlot;
    params: Record<string, unknown>;
    box: Record<string, unknown>;
    origin: PolicyOrigin;
    parentId?: string;
    sleepRunId?: string;
    rationale?: string;
    replayScore?: number;
    replayN?: number;
    baselineScore?: number;
    auditDelta?: number;
    auditCiLow?: number;
  }): PolicyVersion {
    const row = this.db
      .prepare('SELECT MAX(version) AS top FROM policy_versions WHERE owner = ? AND slot = ?')
      .get(input.owner, input.slot) as { top: number | null };
    const version: PolicyVersion = {
      id: randomUUID(),
      owner: input.owner,
      slot: input.slot,
      version: Number(row?.top ?? 0) + 1,
      params: input.params,
      box: input.box,
      origin: input.origin,
      parentId: input.parentId,
      sleepRunId: input.sleepRunId,
      rationale: input.rationale,
      replayScore: input.replayScore,
      replayN: input.replayN,
      baselineScore: input.baselineScore,
      auditDelta: input.auditDelta,
      auditCiLow: input.auditCiLow,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO policy_versions
           (id, owner, slot, version, params, box, origin, parent_id, sleep_run_id, rationale,
            replay_score, replay_n, baseline_score, audit_delta, audit_ci_low, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        version.id,
        version.owner,
        version.slot,
        version.version,
        JSON.stringify(version.params),
        JSON.stringify(version.box),
        version.origin,
        version.parentId ?? null,
        version.sleepRunId ?? null,
        version.rationale ?? null,
        version.replayScore ?? null,
        version.replayN ?? null,
        version.baselineScore ?? null,
        version.auditDelta ?? null,
        version.auditCiLow ?? null,
        version.createdAt,
      );
    return version;
  }

  policyVersion(id: string): PolicyVersion | null {
    const row = this.db.prepare('SELECT * FROM policy_versions WHERE id = ?').get(id) as Row | undefined;
    return row ? mapPolicyVersion(row) : null;
  }

  /**
   * The version the resolver lays over the defaults: promoted, not retired,
   * highest version. Null until the first promotion, which is the whole of
   * today's behaviour (AP10 reads this).
   */
  activePolicy(owner: string, slot: DreamSlot): PolicyVersion | null {
    const row = this.db
      .prepare(
        `SELECT * FROM policy_versions
          WHERE owner = ? AND slot = ? AND promoted_at IS NOT NULL AND retired_at IS NULL
          ORDER BY version DESC LIMIT 1`,
      )
      .get(owner, slot) as Row | undefined;
    return row ? mapPolicyVersion(row) : null;
  }

  /** Newest version first - the version curve and the history drawer. */
  policyHistory(owner: string, slot: DreamSlot, limit = 50): PolicyVersion[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM policy_versions
          WHERE owner = ? AND slot = ?
          ORDER BY version DESC LIMIT ?`,
      )
      .all(owner, slot, limit) as Row[];
    return rows.map(mapPolicyVersion);
  }

  /**
   * Put one version in charge. `prevActiveId` is what was active at that
   * moment (8.5) - it is stored on the new row AND retired in the same
   * breath, because a revert or a night's undo has nothing to bring back
   * otherwise. Undefined means "nothing was active", the way `snapshotSkill`
   * records a skill that did not exist yet.
   */
  promotePolicyVersion(
    id: string,
    options: { prevActiveId?: string; sleepRunId?: string; at?: number } = {},
  ): PolicyVersion | null {
    const at = options.at ?? Date.now();
    return this.#atomically(() => {
      this.db
        .prepare(
          `UPDATE policy_versions
              SET promoted_at = ?, retired_at = NULL, prev_active_id = ?,
                  sleep_run_id = COALESCE(?, sleep_run_id)
            WHERE id = ?`,
        )
        .run(at, options.prevActiveId ?? null, options.sleepRunId ?? null, id);
      if (options.prevActiveId) this.retirePolicyVersion(options.prevActiveId, at);
      const version = this.policyVersion(id);
      // The slot's own clock moves with the promotion, so "when did this slot
      // last change" never has to be derived from the version table.
      if (version) this.#updateSlotState(version.owner, version.slot, 'last_promoted = ?', [at]);
      return version;
    });
  }

  retirePolicyVersion(id: string, at = Date.now()): void {
    this.db
      .prepare('UPDATE policy_versions SET retired_at = ? WHERE id = ? AND retired_at IS NULL')
      .run(at, id);
  }

  /** The other half of a revert: the version `prev_active_id` points at. */
  reactivatePolicyVersion(id: string): void {
    this.db.prepare('UPDATE policy_versions SET retired_at = NULL WHERE id = ?').run(id);
  }

  /**
   * What the wake test actually read, written back next to what the
   * promotion promised (concept 5.5c).
   *
   * `replay_score` is the claim a version was promoted on; `online_score` is
   * the same quantity measured again, live, once `dream.calibrationTraces`
   * frames have accumulated since the promotion. The night computes that
   * drift and freezes the slot on it, but until this setter existed it had
   * nowhere to put the number it had just read - the column was written by
   * nothing, so the one reading that could tell a person "the promise held"
   * survived only inside the night's own report sentence.
   */
  setPolicyOnlineScore(id: string, score: number): void {
    this.db.prepare('UPDATE policy_versions SET online_score = ? WHERE id = ?').run(score, id);
  }

  /**
   * Freeze state and cooldown clock of one slot. A slot with no row has
   * never been promoted and is not frozen, which is a state, not a gap - so
   * this returns a record rather than null and the callers stay free of a
   * null check that only ever means "the defaults".
   */
  slotState(owner: string, slot: DreamSlot): DreamSlotState {
    const row = this.db
      .prepare('SELECT * FROM dream_slot_state WHERE owner = ? AND slot = ?')
      .get(owner, slot) as Row | undefined;
    return row ? mapDreamSlotState(row) : { owner, slot };
  }

  /** One of the four causes of 10.3. A frozen slot keeps measuring, never promotes. */
  freezeSlot(owner: string, slot: DreamSlot, reason: DreamSlotFreezeReason, at = Date.now()): void {
    this.#updateSlotState(owner, slot, 'frozen_at = ?, frozen_reason = ?', [at, reason]);
  }

  /** Thawing is a person's decision; nothing in the night calls this. */
  thawSlot(owner: string, slot: DreamSlot): void {
    this.#updateSlotState(owner, slot, 'frozen_at = NULL, frozen_reason = NULL', []);
  }

  setSlotCooldown(owner: string, slot: DreamSlot, until: number): void {
    this.#updateSlotState(owner, slot, 'cooldown_until = ?', [until]);
  }

  /**
   * The row exists or it does not; every slot-state writer changes some of
   * its columns and would otherwise have to repeat the whole upsert. Kept as
   * INSERT OR IGNORE plus UPDATE rather than an upsert clause, which is what
   * the rest of the store does. `assignments` is a SQL fragment from the
   * callers above, never anything a request carried.
   */
  #updateSlotState(owner: string, slot: DreamSlot, assignments: string, values: unknown[]): void {
    this.#atomically(() => {
      this.db
        .prepare('INSERT OR IGNORE INTO dream_slot_state (owner, slot) VALUES (?, ?)')
        .run(owner, slot);
      this.db
        .prepare(`UPDATE dream_slot_state SET ${assignments} WHERE owner = ? AND slot = ?`)
        .run(...([...values, owner, slot] as never[]));
    });
  }

  /**
   * Record one candidate evaluation. Written whether or not it promoted:
   * the night that measures and does not promote is the common case, and
   * the record of it is what the calibration and the report stand on.
   */
  recordDreamEval(
    input: Omit<DreamEval, 'id' | 'createdAt'> & { id?: string; createdAt?: number },
  ): DreamEval {
    const evaluation: DreamEval = {
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: input.createdAt ?? Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO dream_evals
           (id, sleep_run_id, policy_id, slot, traces, closed, abstained, abstain_reasons,
            reachable_rate, label_coverage, cost_only_share, score, baseline, delta,
            ci_low, ci_high, audit_delta, audit_ci_low, delta_live, sign_agree, eval_ms,
            trace_set_hash, evidence_digest, promoted, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        evaluation.id,
        evaluation.sleepRunId,
        evaluation.policyId,
        evaluation.slot,
        evaluation.traces,
        evaluation.closed,
        evaluation.abstained,
        JSON.stringify(evaluation.abstainReasons),
        evaluation.reachableRate,
        evaluation.labelCoverage,
        evaluation.costOnlyShare,
        evaluation.score,
        evaluation.baseline,
        evaluation.delta,
        evaluation.ciLow,
        evaluation.ciHigh,
        evaluation.auditDelta ?? null,
        evaluation.auditCiLow ?? null,
        evaluation.deltaLive ?? null,
        // NULL is a value here, not a missing one: it means the freshness
        // check was undetermined because the delta sat inside the margin.
        evaluation.signAgree === null ? null : evaluation.signAgree ? 1 : 0,
        evaluation.evalMs,
        evaluation.traceSetHash,
        evaluation.evidenceDigest ?? null,
        evaluation.promoted ? 1 : 0,
        evaluation.detail ? JSON.stringify(evaluation.detail) : null,
        evaluation.createdAt,
      );
    return evaluation;
  }

  /**
   * Evaluations, newest first. `dream_evals` carries no owner of its own,
   * so the owner filter goes through the join to `policy_versions` - in SQL
   * and again in JS, because that is exactly the kind of join 10.5 is about.
   */
  listDreamEvals(
    filter: {
      owner?: string;
      slot?: DreamSlot;
      sleepRunId?: string;
      policyId?: string;
      promoted?: boolean;
      limit?: number;
    } = {},
  ): DreamEval[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.owner) {
      clauses.push('p.owner = ?');
      values.push(filter.owner);
    }
    if (filter.slot) {
      clauses.push('e.slot = ?');
      values.push(filter.slot);
    }
    if (filter.sleepRunId) {
      clauses.push('e.sleep_run_id = ?');
      values.push(filter.sleepRunId);
    }
    if (filter.policyId) {
      clauses.push('e.policy_id = ?');
      values.push(filter.policyId);
    }
    if (filter.promoted !== undefined) {
      clauses.push('e.promoted = ?');
      values.push(filter.promoted ? 1 : 0);
    }
    const sql =
      `SELECT e.*, p.owner AS p_owner FROM dream_evals e
         JOIN policy_versions p ON p.id = e.policy_id` +
      (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '') +
      ' ORDER BY e.created_at DESC, e.id LIMIT ?';
    values.push(filter.limit ?? 100);
    const rows = this.db.prepare(sql).all(...(values as never[])) as Row[];
    return rows
      .filter((row) => !filter.owner || row.p_owner === filter.owner)
      .map(mapDreamEval);
  }

  /**
   * The trace set the last promotion of this slot stood on. The promotion
   * gate requires the next one to be disjoint from it, so a candidate cannot
   * be promoted twice off the same evidence.
   */
  lastPromotedTraceSetHash(owner: string, slot: DreamSlot): string | null {
    const row = this.db
      .prepare(
        `SELECT e.trace_set_hash AS hash, p.owner AS p_owner FROM dream_evals e
           JOIN policy_versions p ON p.id = e.policy_id
          WHERE p.owner = ? AND e.slot = ? AND e.promoted = 1
          ORDER BY e.created_at DESC LIMIT 1`,
      )
      .get(owner, slot) as Row | undefined;
    if (!row || row.p_owner !== owner) return null;
    return (row.hash as string) ?? null;
  }

  /** Retention for the evaluation table (`dream.retainDays`). */
  sweepDreamEvals(before: number): number {
    return this.#sweepOlderThan('dream_evals', ['id'], before);
  }

  /**
   * Index one episode over the existing turn journal. `id` is the id of the
   * `turns` or `assignments` row it indexes, so re-indexing the same episode
   * replaces its row instead of doubling it - this table is an index, never
   * a second transcript store.
   */
  recordDreamEpisode(input: Omit<DreamEpisode, 'createdAt'> & { createdAt?: number }): DreamEpisode {
    const episode: DreamEpisode = { ...input, createdAt: input.createdAt ?? Date.now() };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO dream_episodes
           (id, owner, kind, session_id, slot, steps, outcome, holdout, audit,
            started_at, finished_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        episode.id,
        episode.owner,
        episode.kind,
        episode.sessionId ?? null,
        episode.slot,
        episode.steps,
        episode.outcome,
        episode.holdout ? 1 : 0,
        episode.audit ? 1 : 0,
        episode.startedAt,
        episode.finishedAt ?? null,
        episode.createdAt,
      );
    return episode;
  }

  /** Episodes of one owner, newest first; `holdout`/`audit` select a split. */
  dreamEpisodes(
    owner: string,
    options: { holdout?: boolean; audit?: boolean; limit?: number } = {},
  ): DreamEpisode[] {
    const sql =
      'SELECT * FROM dream_episodes WHERE owner = ?' +
      (options.holdout !== undefined ? ' AND holdout = ?' : '') +
      (options.audit !== undefined ? ' AND audit = ?' : '') +
      ' ORDER BY created_at DESC, id LIMIT ?';
    const values: unknown[] = [owner];
    if (options.holdout !== undefined) values.push(options.holdout ? 1 : 0);
    if (options.audit !== undefined) values.push(options.audit ? 1 : 0);
    values.push(options.limit ?? 200);
    const rows = this.db.prepare(sql).all(...(values as never[])) as Row[];
    return rows.map(mapDreamEpisode);
  }

  /**
   * Retention for the episode index. It follows `dream.frameRetainDays`, not
   * `dream.retainDays`: an episode points straight at journal rows that hold
   * verbatim text, and no wording outlives the memory it came from (S21).
   */
  sweepDreamEpisodes(before: number): number {
    return this.#sweepOlderThan('dream_episodes', ['id'], before);
  }

  /**
   * The batched sweep behind every `sweepDream*` retention method: one
   * transaction per batch, so a nightly sweep is never one long exclusive
   * write lock on the only connection, and a truncating checkpoint at the
   * end so the WAL actually gives its space back. `table` and `keyColumns`
   * are literals from the callers, never anything a request carried.
   * Night-side by design - the per-batch BEGIN must never run inside
   * another transaction.
   */
  #sweepOlderThan(table: string, keyColumns: readonly string[], before: number): number {
    const statement = this.db.prepare(batchedAgeDelete(table, keyColumns));
    let swept = 0;
    let batch: number;
    do {
      batch = this.#deleteBatch(statement, before);
      swept += batch;
    } while (batch >= SWEEP_BATCH);
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return swept;
  }

  #deleteBatch(statement: StatementSync, before: number): number {
    this.db.exec('BEGIN');
    try {
      const changes = changesOf(statement.run(before));
      this.db.exec('COMMIT');
      return changes;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Run `work` as one all-or-nothing unit. A SAVEPOINT rather than a
   * hand-rolled BEGIN, for the reason `recordDreamTurn` gives: it nests, so
   * a multi-statement write may call another one without asking whether a
   * transaction is already open.
   */
  #atomically<T>(work: () => T): T {
    this.db.exec('SAVEPOINT store_atomic');
    try {
      const result = work();
      this.db.exec('RELEASE store_atomic');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK TO store_atomic');
      this.db.exec('RELEASE store_atomic');
      throw error;
    }
  }

  #countRows(sql: string, ...values: unknown[]): number {
    const row = this.db.prepare(sql).get(...(values as never[])) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  #updateById(table: string, { sets, values }: Assignments, id: string): void {
    this.db
      .prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`)
      .run(...([...values, id] as never[]));
  }

  #ownerOf(memoryId: string): string | undefined {
    const row = this.db.prepare('SELECT owner FROM memories WHERE id = ?').get(memoryId) as Row | undefined;
    return row?.owner as string | undefined;
  }

  #memoriesById(ids: string[]): Map<string, MemoryRecord> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const rows = this.db
      .prepare('SELECT * FROM memories WHERE id IN (' + placeholders(unique) + ')')
      .all(...(unique as never[])) as Row[];
    const memories = rows.map(mapMemory);
    return new Map(memories.map((memory) => [memory.id, memory]));
  }

  /* ------------------------------- meta ------------------------------- */

  // Beyond the schema version, `meta` is a generic key/value store for small
  // mappings that don't warrant their own table, e.g. Telegram-chat-to-session.

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined;
    return row ? (row.value as string) : null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  deleteMeta(key: string): void {
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
  }
}

/**
 * Normalise a name to the key entities are deduplicated by, so "Rookery",
 * "rookery" and "Rookery-Agent " all land on the same node.
 */
export function entitySlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function mergeTags(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * When a night starts, taken so that the stamp falls strictly after every row
 * that already exists.
 *
 * `undoSleepRun` tells the rows a run wrote from the rows it merely touched by
 * comparing `created_at` against this stamp: a memory that carries the run's
 * id but predates it was revived by the run (see `upsertMemory`), a policy
 * version likewise re-promoted, and neither may be deleted when the night is
 * taken back. `Date.now()` moves in whole milliseconds, so a memory written in
 * the same tick a night starts compares equal and reads as the night's own -
 * that is an undo deleting a memory that is older than the night it undoes.
 * So the boundary is taken from the data rather than from the clock: one past
 * the newest row in the three tables the undo compares. Nothing is waited for,
 * and everything the run writes from here on still lands on or after it,
 * because those rows are stamped `Date.now()` and this is never below it.
 *
 * ponytail: the ceiling is that the boundary is a timestamp, not an identity.
 * A row inserted with a `created_at` in the future - a test fixture, a clock
 * that jumped and came back - pushes the start past rows the run then writes,
 * and the undo leaves them behind. The upgrade path is to record on the row
 * which run created it instead of inferring it from time.
 */
function sleepRunStart(db: Db): number {
  const row = db
    .prepare(
      `SELECT MAX(at) AS at FROM (
         SELECT MAX(created_at) AS at FROM memories
         UNION ALL SELECT MAX(created_at) FROM policy_versions
         UNION ALL SELECT MAX(created_at) FROM dream_evals
       )`,
    )
    .get() as { at: number | null } | undefined;
  return Math.max(Date.now(), Number(row?.at ?? 0) + 1);
}

/** `?, ?, ?` - one placeholder per value, for an `IN (...)` list. */
function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

/** How many rows a write changed. */
function changesOf(result: { changes: number | bigint }): number {
  return Number(result.changes ?? 0);
}

/**
 * The `column = ?` terms and their values for every key of `patch` that is
 * set. Booleans are stored as 0/1; `undefined` means "leave alone", while
 * `null` is a value and clears the column.
 */
function assignmentsFor(columns: Readonly<Record<string, string>>, patch: object): Assignments {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(columns)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    sets.push(column + ' = ?');
    values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }
  return { sets, values };
}

/**
 * One batch of an age sweep: delete at most `SWEEP_BATCH` rows older than the
 * `?` cutoff. A composite key is matched as a row value, so the batch deletes
 * exactly the rows its sub-select picked.
 */
function batchedAgeDelete(table: string, keyColumns: readonly string[]): string {
  const key = keyColumns.join(', ');
  const rowKey = keyColumns.length > 1 ? '(' + key + ')' : key;
  return `DELETE FROM ${table} WHERE ${rowKey} IN
    (SELECT ${key} FROM ${table} WHERE created_at < ? LIMIT ${SWEEP_BATCH})`;
}
