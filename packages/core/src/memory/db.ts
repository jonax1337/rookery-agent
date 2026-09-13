import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

/**
 * Storage uses node:sqlite, which ships with Node 22+ and bundles FTS5.
 * That keeps Rookery free of native build steps - no node-gyp, no prebuilds,
 * which matters a lot on Windows.
 */

export const SCHEMA_VERSION = 11;

export type Db = DatabaseSync;

export function openDatabase(path: string): Db {
  if (path !== ':memory:') {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  migrate(db);
  return db;
}

function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.prepare('PRAGMA table_info(' + table + ')').all() as { name: string }[];
  return rows.some((row) => row.name === column);
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id                  TEXT PRIMARY KEY,
      title               TEXT NOT NULL,
      provider            TEXT NOT NULL,
      model               TEXT,
      -- Legacy. A session no longer has an agent - there is one assistant and
      -- nothing switches it - but the column stays so an existing database
      -- keeps opening without a migration. Inserts rely on this default.
      agent               TEXT NOT NULL DEFAULT 'jarvis',
      cwd                 TEXT NOT NULL,
      provider_session_id TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      archived            INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_updated
      ON sessions(archived, updated_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      provider   TEXT,
      model      TEXT,
      agent      TEXT,
      usage      TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages(session_id, created_at);

    CREATE TABLE IF NOT EXISTS memories (
      id                TEXT PRIMARY KEY,
      kind              TEXT NOT NULL,
      content           TEXT NOT NULL,
      tags              TEXT NOT NULL DEFAULT '[]',
      importance        REAL NOT NULL DEFAULT 0.5,
      owner             TEXT NOT NULL DEFAULT 'assistant',
      source_session_id TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      last_accessed_at  INTEGER,
      access_count      INTEGER NOT NULL DEFAULT 0,
      forgotten         INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Schema 1 -> 2: memories gain an owner, sessions gain a project.
  if (!hasColumn(db, 'memories', 'owner')) {
    db.exec("ALTER TABLE memories ADD COLUMN owner TEXT NOT NULL DEFAULT 'assistant'");
  }
  if (!hasColumn(db, 'sessions', 'project_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN project_id TEXT');
  }
  if (!hasColumn(db, 'sessions', 'kind')) {
    db.exec("ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'");
  }
  if (!hasColumn(db, 'sessions', 'agent_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN agent_id TEXT');
  }

  // Schema 4 -> 5: the memory graph. Memories learn where they came from,
  // whether they are protected, and whether they are asleep.
  if (!hasColumn(db, 'memories', 'origin')) {
    db.exec("ALTER TABLE memories ADD COLUMN origin TEXT NOT NULL DEFAULT 'extract'");
  }
  if (!hasColumn(db, 'memories', 'pinned')) {
    db.exec('ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasColumn(db, 'memories', 'dormant_at')) {
    db.exec('ALTER TABLE memories ADD COLUMN dormant_at INTEGER');
  }
  if (!hasColumn(db, 'memories', 'superseded_by')) {
    db.exec('ALTER TABLE memories ADD COLUMN superseded_by TEXT');
  }
  if (!hasColumn(db, 'memories', 'sleep_run_id')) {
    db.exec('ALTER TABLE memories ADD COLUMN sleep_run_id TEXT');
  }
  if (!hasColumn(db, 'memories', 'usefulness')) {
    db.exec('ALTER TABLE memories ADD COLUMN usefulness REAL NOT NULL DEFAULT 0');
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_live
      ON memories(owner, forgotten, importance DESC, updated_at DESC);

    -- The recall path filters on all three of these together.
    CREATE INDEX IF NOT EXISTS idx_memories_awake
      ON memories(owner, forgotten, dormant_at, importance DESC);

    -- Duplicate guard: the same sentence is never stored twice for one owner.
    DROP INDEX IF EXISTS idx_memories_unique;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_unique_owner
      ON memories(owner, kind, content);
  `);

  // The graph over those memories: named things, and relations between
  // sentences. Both are written by the nightly run and by the write gate;
  // neither is ever required for the plain recall path to work.
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entities (
      id            TEXT PRIMARY KEY,
      owner         TEXT NOT NULL,
      name          TEXT NOT NULL,
      slug          TEXT NOT NULL,
      kind          TEXT NOT NULL DEFAULT 'topic',
      mentions      INTEGER NOT NULL DEFAULT 0,
      first_seen_at INTEGER NOT NULL,
      last_seen_at  INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_slug ON memory_entities(owner, slug);
    CREATE INDEX IF NOT EXISTS idx_entities_rank ON memory_entities(owner, mentions DESC);

    CREATE TABLE IF NOT EXISTS memory_entity_links (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
      weight    REAL NOT NULL DEFAULT 1,
      PRIMARY KEY (memory_id, entity_id)
    );

    CREATE INDEX IF NOT EXISTS idx_entity_links_entity ON memory_entity_links(entity_id);

    CREATE TABLE IF NOT EXISTS memory_edges (
      id         TEXT PRIMARY KEY,
      owner      TEXT NOT NULL,
      src_id     TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      dst_id     TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      relation   TEXT NOT NULL,
      weight     REAL NOT NULL DEFAULT 0.5,
      origin     TEXT NOT NULL DEFAULT 'sleep',
      run_id     TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_triple ON memory_edges(src_id, dst_id, relation);
    CREATE INDEX IF NOT EXISTS idx_edges_src ON memory_edges(owner, src_id);
    CREATE INDEX IF NOT EXISTS idx_edges_dst ON memory_edges(owner, dst_id);
    CREATE INDEX IF NOT EXISTS idx_edges_run ON memory_edges(run_id);

    CREATE TABLE IF NOT EXISTS sleep_runs (
      id             TEXT PRIMARY KEY,
      owner          TEXT NOT NULL,
      trigger        TEXT NOT NULL,
      status         TEXT NOT NULL,
      started_at     INTEGER NOT NULL,
      finished_at    INTEGER,
      duration_ms    INTEGER,
      read_count     INTEGER NOT NULL DEFAULT 0,
      merged_count   INTEGER NOT NULL DEFAULT 0,
      dormant_count  INTEGER NOT NULL DEFAULT 0,
      edge_count     INTEGER NOT NULL DEFAULT 0,
      insight_count  INTEGER NOT NULL DEFAULT 0,
      conflict_count INTEGER NOT NULL DEFAULT 0,
      model_calls    INTEGER NOT NULL DEFAULT 0,
      resolved_count INTEGER NOT NULL DEFAULT 0,
      report         TEXT,
      error          TEXT,
      undone_at      INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_sleep_runs_owner ON sleep_runs(owner, started_at DESC);
  `);

  // Schema 5 -> 6: the night decides contradictions instead of only counting
  // them, so a run records how many it actually settled.
  if (!hasColumn(db, 'sleep_runs', 'resolved_count')) {
    db.exec('ALTER TABLE sleep_runs ADD COLUMN resolved_count INTEGER NOT NULL DEFAULT 0');
  }

  // FTS index over memory content plus tags, kept in sync by triggers.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      tags,
      content='memories',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, tags)
        VALUES (new.rowid, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags)
        VALUES ('delete', old.rowid, old.content, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags)
        VALUES ('delete', old.rowid, old.content, old.tags);
      INSERT INTO memories_fts(rowid, content, tags)
        VALUES (new.rowid, new.content, new.tags);
    END;
  `);

  // The organisation: durable agents, their structure, and what they did.
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      mission    TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      description TEXT,
      path        TEXT,
      mcp_trust   TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      archived    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS teams (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      purpose    TEXT,
      lead_id    TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id           TEXT PRIMARY KEY,
      org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      slug         TEXT NOT NULL,
      name         TEXT NOT NULL,
      title        TEXT NOT NULL,
      instructions TEXT NOT NULL,
      team_id      TEXT REFERENCES teams(id) ON DELETE SET NULL,
      manager_id   TEXT REFERENCES agents(id) ON DELETE SET NULL,
      provider     TEXT,
      model        TEXT,
      permission   TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      archived     INTEGER NOT NULL DEFAULT 0
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_slug ON agents(org_id, slug);

    CREATE TABLE IF NOT EXISTS assignments (
      id                 TEXT PRIMARY KEY,
      org_id             TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      agent_id           TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      project_id         TEXT REFERENCES projects(id) ON DELETE SET NULL,
      session_id         TEXT,
      parent_id          TEXT,
      requester_kind     TEXT NOT NULL,
      requester_agent_id TEXT,
      task               TEXT NOT NULL,
      status             TEXT NOT NULL,
      result             TEXT,
      error              TEXT,
      provider           TEXT,
      model              TEXT,
      chars              INTEGER NOT NULL DEFAULT 0,
      depth              INTEGER NOT NULL DEFAULT 0,
      created_at         INTEGER NOT NULL,
      started_at         INTEGER,
      finished_at        INTEGER,
      duration_ms        INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_assignments_recent
      ON assignments(org_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_assignments_agent
      ON assignments(agent_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS agent_messages (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      from_agent_id TEXT,
      to_agent_id   TEXT,
      assignment_id TEXT,
      content       TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      read_at       INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_agent_messages_inbox
      ON agent_messages(org_id, to_agent_id, read_at, created_at DESC);

    CREATE TABLE IF NOT EXISTS tasks (
      id                  TEXT PRIMARY KEY,
      org_id              TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      project_id          TEXT REFERENCES projects(id) ON DELETE SET NULL,
      parent_id           TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      title               TEXT NOT NULL,
      description         TEXT NOT NULL DEFAULT '',
      status              TEXT NOT NULL DEFAULT 'open',
      priority            TEXT NOT NULL DEFAULT 'normal',
      assignee_id         TEXT REFERENCES agents(id) ON DELETE SET NULL,
      assignment_id       TEXT,
      created_by          TEXT NOT NULL,
      created_by_agent_id TEXT,
      depends_on          TEXT NOT NULL DEFAULT '[]',
      plan_note           TEXT,
      result              TEXT,
      error               TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      started_at          INTEGER,
      finished_at         INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_board
      ON tasks(org_id, parent_id, status, updated_at DESC);
  `);

  // Schema 9 -> 10: the board gains a manual order, and a task's runs get a
  // real history instead of a single overwritable pointer. `tasks.assignment_id`
  // stays as "the current run" for cheap reads; `task_assignments` is the
  // durable record that survives a rerun clobbering that pointer.
  if (!hasColumn(db, 'tasks', 'sort_order')) {
    db.exec('ALTER TABLE tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_assignments (
      task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (task_id, assignment_id)
    );

    CREATE INDEX IF NOT EXISTS idx_task_assignments_assignment
      ON task_assignments(assignment_id);
    CREATE INDEX IF NOT EXISTS idx_task_assignments_task
      ON task_assignments(task_id, created_at DESC);
  `);

  // Schedules: standing orders that fire on a cron expression, and their runs.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      schedule      TEXT NOT NULL,
      kind          TEXT NOT NULL DEFAULT 'assistant',
      prompt        TEXT NOT NULL,
      agent_id      TEXT REFERENCES agents(id) ON DELETE SET NULL,
      project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
      session_id    TEXT,
      permission    TEXT,
      enabled       INTEGER NOT NULL DEFAULT 1,
      once          INTEGER NOT NULL DEFAULT 0,
      created_by    TEXT NOT NULL DEFAULT 'user',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      next_run_at   INTEGER,
      last_run_at   INTEGER,
      last_status   TEXT,
      last_error    TEXT,
      run_count     INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_cron_jobs_due
      ON cron_jobs(enabled, next_run_at);

    CREATE TABLE IF NOT EXISTS cron_runs (
      id            TEXT PRIMARY KEY,
      job_id        TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
      org_id        TEXT NOT NULL,
      trigger       TEXT NOT NULL,
      status        TEXT NOT NULL,
      started_at    INTEGER NOT NULL,
      finished_at   INTEGER,
      duration_ms   INTEGER,
      result        TEXT,
      error         TEXT,
      session_id    TEXT,
      assignment_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_cron_runs_job
      ON cron_runs(job_id, started_at DESC);
  `);

  if (!hasColumn(db, 'cron_jobs', 'script_json')) {
    db.exec('ALTER TABLE cron_jobs ADD COLUMN script_json TEXT');
  }
  if (!hasColumn(db, 'cron_jobs', 'remaining_runs')) {
    db.exec('ALTER TABLE cron_jobs ADD COLUMN remaining_runs INTEGER');
  }

  if (!hasColumn(db, 'messages', 'tool_calls')) {
    db.exec('ALTER TABLE messages ADD COLUMN tool_calls TEXT');
  }

  // Schema 8 -> 9: a project remembers whether its own `.mcp.json` was approved.
  // Runs after the projects table exists (created above), so a fresh database
  // gets the column from CREATE TABLE and this is a no-op for it.
  if (!hasColumn(db, 'projects', 'mcp_trust')) {
    db.exec('ALTER TABLE projects ADD COLUMN mcp_trust TEXT');
  }

  // Schema 10 -> 11: mail replaces agent_messages. To + Cc, a subject, a
  // thread, and per-recipient read state - things one row per message
  // (agent_messages) cannot express. agent_messages stays untouched rather
  // than dropped; nothing reads or writes it once the org tools switch over.
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      from_kind     TEXT NOT NULL,
      from_agent_id TEXT,
      subject       TEXT NOT NULL,
      body          TEXT NOT NULL,
      thread_id     TEXT NOT NULL,
      in_reply_to   TEXT,
      depth         INTEGER NOT NULL DEFAULT 0,
      assignment_id TEXT,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mail_thread ON mail(org_id, thread_id, created_at);

    CREATE TABLE IF NOT EXISTS mail_recipients (
      id             TEXT PRIMARY KEY,
      mail_id        TEXT NOT NULL REFERENCES mail(id) ON DELETE CASCADE,
      recipient_kind TEXT NOT NULL,
      recipient_id   TEXT,
      box            TEXT NOT NULL,
      read_at        INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_mail_recipients_box
      ON mail_recipients(recipient_kind, recipient_id, read_at, mail_id);
  `);

  migrateAgentMessagesToMail(db);
  backfillMailSessionKind(db);

  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
    'schema_version',
    String(SCHEMA_VERSION),
  );
}

/**
 * Files the mail transcripts that predate `kind = 'mail'` under it.
 *
 * Answering a mail addressed to the assistant has always needed a session to
 * run the turn in, and before the kind existed that session was written as a
 * plain chat - so every answered mail left a "Mail: <subject>" thread sitting
 * in the conversations list that nobody had opened and nobody could continue.
 *
 * The title prefix is the only marker those rows carry, so this matches on it,
 * narrowed to the shape `#answerMail` actually produces: no agent, still a
 * chat. Nothing is deleted - a row caught by mistake is one `?kind=mail` away,
 * and still opens by its own id.
 */
function backfillMailSessionKind(db: Db): void {
  const done = db.prepare("SELECT value FROM meta WHERE key = 'mail_session_kind_v1'").get() as
    | { value: string }
    | undefined;
  if (done) return;

  db.prepare(
    "UPDATE sessions SET kind = 'mail' WHERE kind = 'chat' AND agent_id IS NULL AND title LIKE 'Mail: %'",
  ).run();

  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('mail_session_kind_v1', '1')").run();
}

/**
 * One-time copy of every `agent_messages` row into `mail` + `mail_recipients`,
 * guarded by a `meta` flag so a restart never duplicates it. Reuses each
 * message's own id as its mail id (both are already unique, and it makes the
 * migration trivially idempotent to reason about even without the flag).
 */
function migrateAgentMessagesToMail(db: Db): void {
  const done = db.prepare("SELECT value FROM meta WHERE key = 'mail_migrated_v1'").get() as
    | { value: string }
    | undefined;
  if (done) return;

  const rows = db.prepare('SELECT * FROM agent_messages').all() as Record<string, unknown>[];
  const insertMail = db.prepare(
    `INSERT INTO mail (id, org_id, from_kind, from_agent_id, subject, body, thread_id, in_reply_to, depth, assignment_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
  );
  const insertRecipient = db.prepare(
    `INSERT INTO mail_recipients (id, mail_id, recipient_kind, recipient_id, box, read_at)
     VALUES (?, ?, ?, ?, 'to', ?)`,
  );
  for (const row of rows) {
    const id = row.id as string;
    const orgId = row.org_id as string;
    const fromAgentId = (row.from_agent_id as string | null) ?? null;
    const toAgentId = (row.to_agent_id as string | null) ?? null;
    const assignmentId = (row.assignment_id as string | null) ?? null;
    const createdAt = row.created_at as number;
    const readAt = (row.read_at as number | null) ?? null;
    const content = String(row.content ?? '');
    const subject = content.slice(0, 60).trim() || '(no subject)';
    const fromKind = fromAgentId ? 'agent' : 'assistant';
    const recipientKind = toAgentId ? 'agent' : 'user';
    insertMail.run(id, orgId, fromKind, fromAgentId, subject, content, id, assignmentId, createdAt);
    insertRecipient.run(randomUUID(), id, recipientKind, toAgentId, readAt);
  }

  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('mail_migrated_v1', '1')").run();
}

/** Rebuild the FTS index. Used by the CLI after a bulk import. */
export function reindex(db: Db): void {
  db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')");
}
