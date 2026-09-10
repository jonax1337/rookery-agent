import { randomUUID } from 'node:crypto';
import {
  ASSISTANT_MEMORY_OWNER,
  type MemoryKind,
  type MemoryRecord,
  type Message,
  type ProviderId,
  type Role,
  type Session,
  type SessionKind,
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
      (options.kind ? ' AND s.kind = ?' : '');
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
      createdAt: Date.now(),
    };

    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, provider, model, agent, usage, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  }): MemoryRecord {
    const content = input.content.trim();
    if (!content) throw new Error('A memory needs content.');
    const owner = input.owner ?? ASSISTANT_MEMORY_OWNER;

    const now = Date.now();
    const existing = this.db
      .prepare('SELECT * FROM memories WHERE owner = ? AND kind = ? AND content = ?')
      .get(owner, input.kind, content) as Row | undefined;

    if (existing) {
      const importance = Math.min(
        1,
        Math.max(Number(existing.importance), input.importance ?? 0.5) + 0.05,
      );
      const tags = mergeTags(parseTags(existing.tags), input.tags ?? []);
      this.db
        .prepare('UPDATE memories SET importance = ?, tags = ?, updated_at = ?, forgotten = 0 WHERE id = ?')
        .run(importance, JSON.stringify(tags), now, existing.id as string);
      return this.getMemory(existing.id as string) as MemoryRecord;
    }

    const record: MemoryRecord = {
      id: randomUUID(),
      kind: input.kind,
      content,
      tags: input.tags ?? [],
      importance: clamp01(input.importance ?? 0.5),
      owner,
      sourceSessionId: input.sourceSessionId,
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
      forgotten: false,
    };

    this.db
      .prepare(
        `INSERT INTO memories
           (id, kind, content, tags, importance, owner, source_session_id, created_at, updated_at, access_count, forgotten)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      )
      .run(
        record.id,
        record.kind,
        record.content,
        JSON.stringify(record.tags),
        record.importance,
        record.owner,
        record.sourceSessionId ?? null,
        now,
        now,
      );

    return record;
  }

  getMemory(id: string): MemoryRecord | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Row | undefined;
    return row ? mapMemory(row) : null;
  }

  listMemories(
    options: { kinds?: MemoryKind[]; limit?: number; includeForgotten?: boolean; owner?: string } = {},
  ): MemoryRecord[] {
    const limit = options.limit ?? 200;
    const kinds = options.kinds ?? [];
    const owner = options.owner ?? ASSISTANT_MEMORY_OWNER;
    const placeholders = kinds.map(() => '?').join(', ');
    const sql =
      'SELECT * FROM memories WHERE owner = ? AND (? = 1 OR forgotten = 0)' +
      (kinds.length ? ' AND kind IN (' + placeholders + ')' : '') +
      ' ORDER BY importance DESC, updated_at DESC LIMIT ?';
    const rows = this.db
      .prepare(sql)
      .all(owner, options.includeForgotten ? 1 : 0, ...kinds, limit) as Row[];
    return rows.map(mapMemory);
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

  /** Record that a memory was actually used, which feeds recall scoring. */
  touchMemories(ids: string[]): void {
    if (!ids.length) return;
    const now = Date.now();
    const statement = this.db.prepare(
      'UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?',
    );
    for (const id of ids) statement.run(now, id);
  }

  memoryStats(owner = ASSISTANT_MEMORY_OWNER): {
    total: number;
    byKind: Record<string, number>;
    forgotten: number;
  } {
    const total = (this.db
      .prepare('SELECT COUNT(*) AS n FROM memories WHERE owner = ? AND forgotten = 0')
      .get(owner) as { n: number }).n;
    const forgotten = (this.db
      .prepare('SELECT COUNT(*) AS n FROM memories WHERE owner = ? AND forgotten = 1')
      .get(owner) as { n: number }).n;
    const rows = this.db
      .prepare('SELECT kind, COUNT(*) AS n FROM memories WHERE owner = ? AND forgotten = 0 GROUP BY kind')
      .all(owner) as { kind: string; n: number }[];
    const byKind: Record<string, number> = {};
    for (const row of rows) byKind[row.kind] = row.n;
    return { total, byKind, forgotten };
  }
}

/* ------------------------------ mappers ------------------------------ */

function mapSession(row: Row): Session {
  return {
    id: row.id as string,
    title: row.title as string,
    kind: ((row.kind as string) === 'voice' ? 'voice' : 'chat') as SessionKind,
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
    usage: row.usage ? (JSON.parse(row.usage as string) as TurnUsage) : undefined,
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
    sourceSessionId: (row.source_session_id as string) ?? undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastAccessedAt: row.last_accessed_at ? Number(row.last_accessed_at) : undefined,
    accessCount: Number(row.access_count ?? 0),
    forgotten: Number(row.forgotten) === 1,
  };
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
