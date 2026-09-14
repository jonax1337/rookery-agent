import { randomUUID } from 'node:crypto';
import {
  ASSISTANT_MEMORY_OWNER,
  type CronTrigger,
  type EntityKind,
  type MemoryEdge,
  type MemoryEntity,
  type MemoryGraph,
  type MemoryKind,
  type MemoryNeighbourhood,
  type MemoryOrigin,
  type MemoryRecord,
  type MemoryRelation,
  type Message,
  type ProviderId,
  type Role,
  type Session,
  type SessionKind,
  type SleepRun,
  type SleepStatus,
  type StatsDay,
  type StatsSnapshot,
  type StatsTotals,
  type TurnUsage,
} from '../types.js';
import { openDatabase, type Db } from './db.js';
import { OrgStore } from '../org/store.js';
import { CronStore } from '../cron/store.js';

type Row = Record<string, unknown>;

/** All persistence for sessions, transcripts, long-term memories, the organisation and schedules. */
export class Store {
  readonly db: Db;
  /** Companies, teams, agents, assignments and messages. */
  readonly org: OrgStore;
  /** Schedules and their runs. */
  readonly cron: CronStore;

  constructor(pathOrDb: string | Db) {
    this.db = typeof pathOrDb === 'string' ? openDatabase(pathOrDb) : pathOrDb;
    this.org = new OrgStore(this.db);
    this.cron = new CronStore(this.db);
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
    if (options.agentId) values.push(options.agentId);
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
    const columns: Record<string, string> = {
      title: 'title',
      provider: 'provider',
      model: 'model',
      cwd: 'cwd',
      projectId: 'project_id',
      providerSessionId: 'provider_session_id',
      archived: 'archived',
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(columns)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value === undefined) continue;
      sets.push(column + ' = ?');
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    values.push(Date.now(), id);
    this.db.prepare('UPDATE sessions SET ' + sets.join(', ') + ' WHERE id = ?').run(...(values as never[]));
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
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
      createdAt: Date.now(),
    };

    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, provider, model, agent, usage, created_at, tool_calls)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );

    this.db
      .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run(message.createdAt, message.sessionId);

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
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?')
      .get(sessionId) as { n: number };
    return row.n;
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
      const base = Math.max(Number(existing.importance), input.importance ?? 0.5);
      const importance = base >= 0.8 ? Math.min(1, base) : Math.min(1, base + 0.02);
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
      importance: clamp01(input.importance ?? 0.5),
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
  ): MemoryRecord | null {
    const columns: Record<string, string> = {
      content: 'content',
      kind: 'kind',
      importance: 'importance',
      pinned: 'pinned',
      dormantAt: 'dormant_at',
      supersededBy: 'superseded_by',
      forgotten: 'forgotten',
      sleepRunId: 'sleep_run_id',
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(columns)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value === undefined) continue;
      sets.push(column + ' = ?');
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
    if (patch.tags) {
      sets.push('tags = ?');
      values.push(JSON.stringify([...new Set(patch.tags)]));
    }
    if (!sets.length) return this.getMemory(id);
    sets.push('updated_at = ?');
    values.push(Date.now(), id);
    this.db.prepare('UPDATE memories SET ' + sets.join(', ') + ' WHERE id = ?').run(...(values as never[]));
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
    const placeholders = kinds.map(() => '?').join(', ');
    const sql =
      'SELECT * FROM memories WHERE owner = ? AND (? = 1 OR forgotten = 0)' +
      (options.includeDormant === false ? ' AND dormant_at IS NULL' : '') +
      (options.since ? ' AND created_at >= ?' : '') +
      (kinds.length ? ' AND kind IN (' + placeholders + ')' : '') +
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

  /** Soft delete, so a wrong memory can be audited rather than vanishing. */
  forgetMemory(id: string): void {
    this.db
      .prepare('UPDATE memories SET forgotten = 1, updated_at = ? WHERE id = ?')
      .run(Date.now(), id);
  }

  deleteMemory(id: string): void {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  /**
   * Record that a memory was actually used. This is the only path that
   * raises `usefulness`, and it is damped so a single busy day cannot make
   * a memory permanent.
   */
  touchMemories(ids: string[]): void {
    if (!ids.length) return;
    const now = Date.now();
    const statement = this.db.prepare(
      `UPDATE memories
          SET last_accessed_at = ?,
              access_count = access_count + 1,
              usefulness = MIN(1.0, usefulness + 0.03)
        WHERE id = ?`,
    );
    for (const id of ids) statement.run(now, id);
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
    const count = (sql: string): number =>
      (this.db.prepare(sql).get(owner) as { n: number } | undefined)?.n ?? 0;
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
    const since = Math.min(options.since, until);

    const count = (sql: string, ...values: unknown[]): number =>
      (this.db.prepare(sql).get(...(values as never[])) as { n: number } | undefined)?.n ?? 0;

    // Reused rather than recounted, so the dashboard and the memory page can
    // never disagree about how many memories there are.
    const memory = this.memoryStats(owner);

    const totals: StatsTotals = {
      // Mail and cron transcripts are left out here for the same reason
      // `listSessions` hides them: they are not conversations. Counting them
      // would put a number on the conversations card that its own list
      // cannot produce.
      sessions: count("SELECT COUNT(*) AS n FROM sessions WHERE archived = 0 AND kind NOT IN ('mail', 'schedule')"),
      archivedSessions: count("SELECT COUNT(*) AS n FROM sessions WHERE archived = 1 AND kind NOT IN ('mail', 'schedule')"),
      messages: count(
        "SELECT COUNT(*) AS n FROM messages m WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = m.session_id AND s.kind IN ('mail', 'schedule'))",
      ),
      assignments: count('SELECT COUNT(*) AS n FROM assignments WHERE org_id = ?', options.orgId),
      runningAssignments: count(
        "SELECT COUNT(*) AS n FROM assignments WHERE org_id = ? AND status IN ('pending', 'running')",
        options.orgId,
      ),
      tasks: count('SELECT COUNT(*) AS n FROM tasks WHERE org_id = ?', options.orgId),
      openTasks: count(
        "SELECT COUNT(*) AS n FROM tasks WHERE org_id = ? AND status IN ('open', 'planned', 'running')",
        options.orgId,
      ),
      cronJobs: count('SELECT COUNT(*) AS n FROM cron_jobs WHERE org_id = ?', options.orgId),
      cronRuns: count('SELECT COUNT(*) AS n FROM cron_runs WHERE org_id = ?', options.orgId),
      memories: memory.total,
      agents: count('SELECT COUNT(*) AS n FROM agents WHERE org_id = ? AND archived = 0', options.orgId),
    };

    const buckets = new Map<string, StatsDay>();
    const bucket = (day: string): StatsDay => {
      const existing = buckets.get(day);
      if (existing) return existing;
      const created: StatsDay = {
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
      buckets.set(day, created);
      return created;
    };

    /**
     * One GROUP BY per table. Timestamps are milliseconds and SQLite's date
     * functions want seconds, hence the division; `localtime` is what turns
     * an instant into the day the user had. Table and column are literals
     * from the calls right below, never anything a request carried.
     */
    const perDay = (table: string, column: string, filter: string, values: unknown[]): Map<string, number> => {
      const rows = this.db
        .prepare(
          `SELECT strftime('%Y-%m-%d', ${column} / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS n
             FROM ${table}
            WHERE ${column} >= ? AND ${column} <= ?` +
            (filter ? ' AND ' + filter : '') +
            ' GROUP BY day',
        )
        .all(...([since, until, ...values] as never[])) as Row[];
      return new Map(rows.map((row) => [String(row.day), Number(row.n ?? 0)]));
    };

    for (const [day, n] of perDay('sessions', 'created_at', '', [])) bucket(day).sessions = n;
    for (const [day, n] of perDay('messages', 'created_at', '', [])) bucket(day).messages = n;
    for (const [day, n] of perDay('assignments', 'created_at', 'org_id = ?', [options.orgId]))
      bucket(day).assignments = n;
    for (const [day, n] of perDay('tasks', 'created_at', 'org_id = ?', [options.orgId])) bucket(day).tasks = n;
    // A run is dated by when it started; `finished_at` is null while it runs.
    for (const [day, n] of perDay('cron_runs', 'started_at', 'org_id = ?', [options.orgId])) bucket(day).cronRuns = n;
    for (const [day, n] of perDay('memories', 'created_at', 'owner = ?', [owner])) bucket(day).memories = n;

    // `messages.usage` is a JSON blob rather than columns, so the tokens can
    // only be summed with json_extract. That is the difference between one
    // query and one request per conversation, and worth the guard: json_valid
    // skips anything an older build may have written, and if the function is
    // missing altogether the two figures simply stay unknown.
    let tokensAvailable = false;
    try {
      const rows = this.db
        .prepare(
          `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day,
                  SUM(COALESCE(json_extract(usage, '$.inputTokens'), 0))  AS input_tokens,
                  SUM(COALESCE(json_extract(usage, '$.outputTokens'), 0)) AS output_tokens
             FROM messages
            WHERE created_at >= ? AND created_at <= ? AND usage IS NOT NULL AND json_valid(usage)
            GROUP BY day`,
        )
        .all(...([since, until] as never[])) as Row[];
      tokensAvailable = rows.length > 0;
      for (const row of rows) {
        const entry = bucket(String(row.day));
        entry.inputTokens = Number(row.input_tokens ?? 0);
        entry.outputTokens = Number(row.output_tokens ?? 0);
      }
    } catch {
      tokensAvailable = false;
    }

    const series = [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day));
    return { since, until, orgId: options.orgId, owner, totals, series, tokensAvailable };
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
    this.db
      .prepare('INSERT OR REPLACE INTO memory_entity_links (memory_id, entity_id, weight) VALUES (?, ?, ?)')
      .run(memoryId, entityId, weight);
    this.recountEntity(entityId);
  }

  unlinkEntity(memoryId: string, entityId: string): void {
    this.db
      .prepare('DELETE FROM memory_entity_links WHERE memory_id = ? AND entity_id = ?')
      .run(memoryId, entityId);
    this.recountEntity(entityId);
  }

  /** Recount live mentions of one entity, and drop it when nothing is left. */
  recountEntity(entityId: string): void {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM memory_entity_links l
           JOIN memories m ON m.id = l.memory_id
          WHERE l.entity_id = ? AND m.forgotten = 0 AND m.dormant_at IS NULL`,
      )
      .get(entityId) as { n: number };
    this.db.prepare('UPDATE memory_entities SET mentions = ? WHERE id = ?').run(row.n, entityId);
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

  entitiesFor(memoryId: string): MemoryEntity[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM memory_entities e
           JOIN memory_entity_links l ON l.entity_id = e.id
          WHERE l.memory_id = ?
          ORDER BY e.mentions DESC`,
      )
      .all(memoryId) as Row[];
    return rows.map(mapEntity);
  }

  /**
   * Live memories linked to any of these entities, excluding the ones given.
   * `owner` keeps the result inside one bank: the link table has no owner
   * column, so without the filter a cross-owner link would read across banks.
   */
  memoriesForEntities(
    entityIds: string[],
    options: { owner?: string; exclude?: string[]; limit?: number } = {},
  ): MemoryRecord[] {
    if (!entityIds.length) return [];
    const exclude = options.exclude ?? [];
    const sql =
      `SELECT DISTINCT m.* FROM memories m
         JOIN memory_entity_links l ON l.memory_id = m.id
        WHERE l.entity_id IN (` + entityIds.map(() => '?').join(', ') + `)
          AND m.forgotten = 0 AND m.dormant_at IS NULL` +
      (options.owner ? ' AND m.owner = ?' : '') +
      (exclude.length ? ' AND m.id NOT IN (' + exclude.map(() => '?').join(', ') + ')' : '') +
      ' ORDER BY m.importance DESC LIMIT ?';
    const rows = this.db
      .prepare(sql)
      .all(
        ...([...entityIds, ...(options.owner ? [options.owner] : []), ...exclude, options.limit ?? 40] as never[]),
      ) as Row[];
    return rows.map(mapMemory);
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
      const weight = Math.min(1, Math.max(Number(existing.weight), input.weight ?? 0.5));
      this.db.prepare('UPDATE memory_edges SET weight = ? WHERE id = ?').run(weight, existing.id as string);
      return mapEdge({ ...existing, weight });
    }
    const edge: MemoryEdge = {
      id: randomUUID(),
      owner: input.owner,
      srcId: input.srcId,
      dstId: input.dstId,
      relation: input.relation,
      weight: clamp01(input.weight ?? 0.5),
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
      'SELECT * FROM memory_edges WHERE src_id IN (' + ids.map(() => '?').join(', ') + ')' +
      (relations?.length ? ' AND relation IN (' + relations.map(() => '?').join(', ') + ')' : '');
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
    const outgoing = (this.db
      .prepare(
        `SELECT e.*, m.id AS o_id FROM memory_edges e JOIN memories m ON m.id = e.dst_id WHERE e.src_id = ? AND e.owner = ?`,
      )
      .all(id, memory.owner) as Row[])
      .map((row) => ({ ...mapEdge(row), other: this.getMemory(row.o_id as string)! }))
      .filter((edge) => Boolean(edge.other));
    const incoming = (this.db
      .prepare(
        `SELECT e.*, m.id AS o_id FROM memory_edges e JOIN memories m ON m.id = e.src_id WHERE e.dst_id = ? AND e.owner = ?`,
      )
      .all(id, memory.owner) as Row[])
      .map((row) => ({ ...mapEdge(row), other: this.getMemory(row.o_id as string)! }))
      .filter((edge) => Boolean(edge.other));
    return { memory, entities: this.entitiesFor(id), outgoing, incoming };
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
    const limit = Math.max(10, Math.min(options.limit ?? 300, 1000));
    const kinds = options.kinds ?? [];

    const filters =
      ' AND m.forgotten = 0' +
      (options.includeDormant ? '' : ' AND m.dormant_at IS NULL') +
      (options.since ? ' AND m.created_at >= ?' : '') +
      (kinds.length ? ' AND m.kind IN (' + kinds.map(() => '?').join(', ') + ')' : '');
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

    const placeholders = ids.map(() => '?').join(', ');
    const linkRows = this.db
      .prepare(
        'SELECT memory_id, entity_id FROM memory_entity_links WHERE memory_id IN (' + placeholders + ')',
      )
      .all(...(ids as never[])) as Row[];
    const links = linkRows.map((row) => ({
      memoryId: row.memory_id as string,
      entityId: row.entity_id as string,
    }));

    const entityIds = [...new Set(links.map((link) => link.entityId))];
    const entities = entityIds.length
      ? (this.db
          .prepare(
            'SELECT * FROM memory_entities WHERE id IN (' + entityIds.map(() => '?').join(', ') + ')',
          )
          .all(...(entityIds as never[])) as Row[]).map(mapEntity)
      : [];

    // Only edges with both ends inside the picture; a dangling line is noise.
    const edges = (this.db
      .prepare(
        'SELECT * FROM memory_edges WHERE src_id IN (' + placeholders + ') AND dst_id IN (' + placeholders + ')',
      )
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
   */
  addCorrection(input: { owner: string; text: string; quote: string; sessionId?: string }): void {
    this.db
      .prepare(
        'INSERT INTO corrections (id, owner, text, quote, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), input.owner, input.text.trim(), input.quote.trim(), input.sessionId ?? null, Date.now());
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
    for (const id of ids) mark.run(now, id);
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
    this.db.prepare('DELETE FROM skill_sources WHERE skill = ?').run(skill);
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO skill_sources (skill, memory_id, owner, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (const id of memoryIds) insert.run(skill, id, owner, now);
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
      owner: input.owner,
      trigger: input.trigger,
      status: 'running',
      startedAt: Date.now(),
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
    this.db
      .prepare('INSERT INTO sleep_runs (id, owner, trigger, status, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(run.id, run.owner, run.trigger, run.status, run.startedAt);
    return run;
  }

  updateSleepRun(
    id: string,
    patch: Partial<Omit<SleepRun, 'id' | 'owner' | 'trigger' | 'startedAt'>>,
  ): SleepRun | null {
    const columns: Record<string, string> = {
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
      modelCalls: 'model_calls',
      report: 'report',
      error: 'error',
      undoneAt: 'undone_at',
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(columns)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value === undefined) continue;
      sets.push(column + ' = ?');
      values.push(value);
    }
    if (!sets.length) return this.getSleepRun(id);
    values.push(id);
    this.db.prepare('UPDATE sleep_runs SET ' + sets.join(', ') + ' WHERE id = ?').run(...(values as never[]));
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
    const now = Date.now();
    const rows = this.db.prepare("SELECT * FROM sleep_runs WHERE status = 'running'").all() as Row[];
    if (!rows.length) return [];
    this.db
      .prepare("UPDATE sleep_runs SET status = 'failed', error = ?, finished_at = ? WHERE status = 'running'")
      .run(reason, now);
    return rows.map((row) => mapSleepRun({ ...row, status: 'failed', error: reason, finished_at: now }));
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
   * are deleted, everything it put to sleep wakes up, and its edges go. This
   * is what makes an unattended nightly process acceptable at all.
   */
  undoSleepRun(id: string): { woken: number; removed: number; edges: number } | null {
    const run = this.getSleepRun(id);
    if (!run || run.undoneAt) return null;

    const counts = { woken: 0, removed: 0, edges: 0 };
    // Counted up front: deleting a memory cascades its edges away, so a
    // count taken afterwards would report a fraction of what actually went.
    const edgesBefore = (this.db
      .prepare('SELECT COUNT(*) AS n FROM memory_edges WHERE run_id = ?')
      .get(id) as { n: number }).n;
    this.db.exec('BEGIN');
    try {
      // The two sets are kept disjoint: a memory this run wrote and a memory
      // it put to sleep are handled by different branches, never both.
      const written = this.db
        // `extract` belongs here as well as `sleep`: the replay phase harvests
        // memories out of the day's conversations, and those are as much a
        // product of the night as an insight is. Still disjoint from the
        // branch below, which takes the memories the run put to SLEEP - a row
        // the run wrote is never also a row the run retired. Nor can a run
        // have written a memory older than itself: a row that carries this
        // run's id but predates it is one the run revived (see `upsertMemory`)
        // or one somebody woke again, never one it created, so undo must not
        // delete it.
        .prepare(
          `SELECT id FROM memories
            WHERE sleep_run_id = ? AND origin IN ('sleep', 'extract') AND dormant_at IS NULL
              AND created_at >= ?`,
        )
        .all(id, run.startedAt) as Row[];
      // Anything that pointed at a memory this run created must let go first.
      for (const row of written) {
        this.db
          .prepare('UPDATE memories SET superseded_by = NULL WHERE superseded_by = ?')
          .run(row.id as string);
      }
      const asleep = this.db
        .prepare('SELECT id FROM memories WHERE sleep_run_id = ? AND dormant_at IS NOT NULL')
        .all(id) as Row[];
      for (const row of asleep) {
        this.db
          .prepare(
            'UPDATE memories SET dormant_at = NULL, superseded_by = NULL, sleep_run_id = NULL WHERE id = ?',
          )
          .run(row.id as string);
        counts.woken += 1;
      }
      for (const row of written) {
        this.db.prepare('DELETE FROM memories WHERE id = ?').run(row.id as string);
        counts.removed += 1;
      }
      this.db.prepare('DELETE FROM memory_edges WHERE run_id = ?').run(id);
      counts.edges = edgesBefore;
      this.db
        .prepare('UPDATE sleep_runs SET undone_at = ? WHERE id = ?')
        .run(Date.now(), id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.recountEntities(run.owner);
    return counts;
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

/* ------------------------------ mappers ------------------------------ */

function mapSession(row: Row): Session {
  return {
    id: row.id as string,
    title: row.title as string,
    // Anything the column does not know is a chat - that is what the default
    // was before `kind` existed, and what a stray value should degrade to.
    kind: (['voice', 'mail', 'schedule'].includes(row.kind as string) ? row.kind : 'chat') as SessionKind,
    provider: row.provider as ProviderId,
    model: (row.model as string) ?? undefined,
    cwd: row.cwd as string,
    projectId: (row.project_id as string) ?? undefined,
    agentId: (row.agent_id as string) ?? undefined,
    providerSessionId: (row.provider_session_id as string) ?? undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    archived: Number(row.archived) === 1,
    messageCount: Number(row.message_count ?? 0),
  };
}

function mapMessage(row: Row): Message {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    role: row.role as Role,
    content: row.content as string,
    provider: (row.provider as ProviderId) ?? undefined,
    model: (row.model as string) ?? undefined,
    agent: (row.agent as string) ?? undefined,
    toolCalls: parseJsonColumn<Message['toolCalls']>(row.tool_calls),
    usage: parseJsonColumn<TurnUsage>(row.usage),
    createdAt: Number(row.created_at),
  };
}

export function mapMemory(row: Row): MemoryRecord {
  return {
    id: row.id as string,
    kind: row.kind as MemoryKind,
    content: row.content as string,
    tags: parseTags(row.tags),
    importance: Number(row.importance),
    owner: (row.owner as string) ?? ASSISTANT_MEMORY_OWNER,
    evidence: (row.evidence as string) ?? undefined,
    sourceSessionId: (row.source_session_id as string) ?? undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastAccessedAt: row.last_accessed_at ? Number(row.last_accessed_at) : undefined,
    accessCount: Number(row.access_count ?? 0),
    forgotten: Number(row.forgotten) === 1,
    origin: ((row.origin as string) ?? 'extract') as MemoryOrigin,
    pinned: Number(row.pinned ?? 0) === 1,
    dormantAt: row.dormant_at ? Number(row.dormant_at) : undefined,
    supersededBy: (row.superseded_by as string) ?? undefined,
    sleepRunId: (row.sleep_run_id as string) ?? undefined,
    usefulness: Number(row.usefulness ?? 0),
  };
}

export function mapEntity(row: Row): MemoryEntity {
  return {
    id: row.id as string,
    owner: row.owner as string,
    name: row.name as string,
    slug: row.slug as string,
    kind: ((row.kind as string) ?? 'topic') as EntityKind,
    mentions: Number(row.mentions ?? 0),
    firstSeenAt: Number(row.first_seen_at),
    lastSeenAt: Number(row.last_seen_at),
  };
}

export function mapEdge(row: Row): MemoryEdge {
  return {
    id: row.id as string,
    owner: row.owner as string,
    srcId: row.src_id as string,
    dstId: row.dst_id as string,
    relation: row.relation as MemoryRelation,
    weight: Number(row.weight ?? 0.5),
    origin: ((row.origin as string) ?? 'sleep') as MemoryEdge['origin'],
    runId: (row.run_id as string) ?? undefined,
    createdAt: Number(row.created_at),
  };
}

export function mapSleepRun(row: Row): SleepRun {
  return {
    id: row.id as string,
    owner: row.owner as string,
    trigger: row.trigger as CronTrigger,
    status: row.status as SleepStatus,
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at ? Number(row.finished_at) : undefined,
    durationMs: row.duration_ms ? Number(row.duration_ms) : undefined,
    readCount: Number(row.read_count ?? 0),
    replayedCount: Number(row.replayed_count ?? 0),
    learnedCount: Number(row.learned_count ?? 0),
    mergedCount: Number(row.merged_count ?? 0),
    dormantCount: Number(row.dormant_count ?? 0),
    edgeCount: Number(row.edge_count ?? 0),
    insightCount: Number(row.insight_count ?? 0),
    skillCount: Number(row.skill_count ?? 0),
    skillRevisedCount: Number(row.skill_revised_count ?? 0),
    conflictCount: Number(row.conflict_count ?? 0),
    resolvedCount: Number(row.resolved_count ?? 0),
    modelCalls: Number(row.model_calls ?? 0),
    report: (row.report as string) ?? undefined,
    error: (row.error as string) ?? undefined,
    undoneAt: row.undone_at ? Number(row.undone_at) : undefined,
  };
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

/**
 * A JSON column an older build may have written differently, or not at all.
 * One malformed row must never cost the whole transcript: the field simply
 * reads as absent, the way `parseTags` already degrades.
 */
function parseJsonColumn<T>(value: unknown): T | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function parseTags(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function mergeTags(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
