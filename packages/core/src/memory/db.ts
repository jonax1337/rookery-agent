import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

/**
 * Storage uses node:sqlite, which ships with Node 22+ and bundles FTS5.
 * That keeps Rookery free of native build steps - no node-gyp, no prebuilds,
 * which matters a lot on Windows.
 */

export const SCHEMA_VERSION = 23;

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
  // The CLI opens the same file in its own process, so there are really two
  // writers. Until now that was harmless because the codebase had exactly two
  // short transactions; the dream adds one bracket per recorded turn plus a
  // nightly sweep, so a contended write should wait briefly instead of
  // failing the request outright.
  db.exec('PRAGMA busy_timeout = 5000');
  try {
    assertSchemaNotNewer(db);
  } catch (error) {
    // Refused, not broken: release the handle synchronously so the file is
    // not locked until garbage collection catches up with it.
    db.close();
    throw error;
  }
  migrate(db);
  return db;
}

function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.prepare('PRAGMA table_info(' + table + ')').all() as { name: string }[];
  return rows.some((row) => row.name === column);
}

/**
 * A file that a newer build has ever opened must not quietly continue under
 * this one. `schema_version` is written on every open but nothing ever read
 * it back, so an older build would keep writing `memories` rows beside dream
 * frames recorded against a schema it does not know. Read-only on purpose:
 * this guard never migrates and never writes, it only refuses.
 */
function assertSchemaNotNewer(db: Db): void {
  const meta = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
  ).get() as { name: string } | undefined;
  // A fresh file has no meta table yet; migrate() creates it below.
  if (!meta) return;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (!row) return;
  const version = Number(row.value);
  if (Number.isFinite(version) && version > SCHEMA_VERSION) {
    throw new Error(
      `Database schema ${version} is newer than this build supports (${SCHEMA_VERSION}). ` +
        'Update Rookery instead of opening the file with an older build.',
    );
  }
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

  // Schema 11 -> 12: a memory records the words it stands on. Extraction may
  // no longer write anything it cannot quote, and the quote is kept so the
  // claim stays auditable long after the conversation is gone. NULL on every
  // row that predates this, and on everything the user wrote by hand.
  if (!hasColumn(db, 'memories', 'evidence')) {
    db.exec('ALTER TABLE memories ADD COLUMN evidence TEXT');
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

  // Schema 11 -> 12: the night also writes skills now, so a run says how many.
  if (!hasColumn(db, 'sleep_runs', 'skill_count')) {
    db.exec('ALTER TABLE sleep_runs ADD COLUMN skill_count INTEGER NOT NULL DEFAULT 0');
  }

  // Schema 12 -> 13: repairing a skill is counted apart from writing one.
  if (!hasColumn(db, 'sleep_runs', 'skill_revised_count')) {
    db.exec('ALTER TABLE sleep_runs ADD COLUMN skill_revised_count INTEGER NOT NULL DEFAULT 0');
  }

  // Schema 13 -> 14: the night reads the day's conversations again, so a run
  // says how many it got through and what they yielded.
  if (!hasColumn(db, 'sleep_runs', 'replayed_count')) {
    db.exec('ALTER TABLE sleep_runs ADD COLUMN replayed_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasColumn(db, 'sleep_runs', 'learned_count')) {
    db.exec('ALTER TABLE sleep_runs ADD COLUMN learned_count INTEGER NOT NULL DEFAULT 0');
  }

  // Schema 20 -> 21: dream bookkeeping on the run - traces the nightly probe
  // looked at.
  if (!hasColumn(db, 'sleep_runs', 'dream_traces_seen')) {
    db.exec('ALTER TABLE sleep_runs ADD COLUMN dream_traces_seen INTEGER NOT NULL DEFAULT 0');
  }
  // Schema 20 -> 21: grid placements the nightly probe scored.
  if (!hasColumn(db, 'sleep_runs', 'dream_frames_scored')) {
    db.exec('ALTER TABLE sleep_runs ADD COLUMN dream_frames_scored INTEGER NOT NULL DEFAULT 0');
  }
  // Schema 20 -> 21: model-written candidates. Its writer arrives with
  // Phase 3; Stage 1 leaves it at 0 rather than borrowing the column for
  // something else in between. There is deliberately no dream_promoted -
  // nothing is promoted in Stage 1, so that counter would have no writer.
  if (!hasColumn(db, 'sleep_runs', 'dream_candidates')) {
    db.exec('ALTER TABLE sleep_runs ADD COLUMN dream_candidates INTEGER NOT NULL DEFAULT 0');
  }

  /* ------------------------------ corrections ------------------------------
     A correction is the strongest signal the system gets. When the user says
     "no, not like that", something written down is wrong - and until now
     nothing captured it: the per-turn extractor sees one exchange and writes
     facts, never "that was a correction of what you just did".

     Rows sit here until a revision pass has looked at them, then they are
     marked consumed rather than removed, so the same correction cannot drag
     the same skill in front of the model night after night. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS corrections (
      id          TEXT PRIMARY KEY,
      owner       TEXT NOT NULL,
      text        TEXT NOT NULL,
      quote       TEXT NOT NULL,
      session_id  TEXT,
      created_at  INTEGER NOT NULL,
      consumed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_corrections_open
      ON corrections(owner, consumed_at, created_at DESC);
  `);

  /* ---------------------------- skill bookkeeping ----------------------------
     A skill itself is a file on disk, editable by hand and deliberately not a
     database row. What a database can say about it is everything a file
     cannot: when it was opened, how the work that opened it turned out, which
     memories it was distilled from, and what it looked like before the last
     rewrite. Those three tables are what makes automatic improvement possible
     at all - without them nothing can tell a skill that still holds from one
     whose ground has moved.

     Rows are keyed by skill NAME, not by a foreign key: the file may be
     deleted from outside Rookery entirely, and an orphaned row is cheaper
     than a constraint that cannot be honoured. */
  db.exec(`
    -- Every use_skill call. The join to assignments is what turns "the skill
    -- was open" into "the run that had it open failed".
    CREATE TABLE IF NOT EXISTS skill_uses (
      id            TEXT PRIMARY KEY,
      skill         TEXT NOT NULL,
      owner         TEXT NOT NULL,
      assignment_id TEXT,
      session_id    TEXT,
      created_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_skill_uses_skill
      ON skill_uses(skill, created_at DESC);

    -- Which memories a distilled skill stands on. When one of them is
    -- superseded, put to sleep or edited, the skill above it is suspect.
    CREATE TABLE IF NOT EXISTS skill_sources (
      skill      TEXT NOT NULL,
      memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      owner      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (skill, memory_id)
    );

    CREATE INDEX IF NOT EXISTS idx_skill_sources_memory
      ON skill_sources(memory_id);

    -- The file as it read BEFORE an unattended write replaced it. NULL
    -- content means the skill did not exist yet, so undoing that write means
    -- deleting the folder rather than restoring text.
    CREATE TABLE IF NOT EXISTS skill_versions (
      id           TEXT PRIMARY KEY,
      skill        TEXT NOT NULL,
      content      TEXT,
      sleep_run_id TEXT,
      created_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_skill_versions_run
      ON skill_versions(sleep_run_id, created_at);
  `);

  /* -------------------------------- dream ---------------------------------
     docs/concepts/dream-and-recursive-self-improvement.md. A trace is one
     recall call - several calls share a turn_id - and a frame is the record
     that makes a turn replayable: everything a candidate policy could have
     needed, frozen at the permissive-most corner of the declared parameter
     box. Frames are a verbatim store (the literal query, full memory
     snapshots), which is why they carry owner and session columns of their
     own: the delete paths must reach them without parsing the payload.

     `dream_labels` is created as an empty table. Its writers arrive with
     Phase 2; creating the shape now keeps that stage free of another schema
     bump. `memory_touches` is append-only bookkeeping, never a label source:
     the monotone access/usefulness counters cannot be reconstructed later if
     the record is not kept from the start. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS dream_traces (
      id            TEXT PRIMARY KEY,
      turn_id       TEXT NOT NULL,              -- groups the calls of one turn
      owner         TEXT NOT NULL,
      kind          TEXT NOT NULL,              -- turn | assignment | night
      site          TEXT NOT NULL,              -- turn | extract | tool | inspect
      pipeline      TEXT NOT NULL,              -- assistant | agent
      session_id    TEXT,
      session_kind  TEXT,                       -- chat | voice | mail | schedule
      assignment_id TEXT,
      sleep_run_id  TEXT,
      turn_index    INTEGER NOT NULL DEFAULT 0,
      policy_set    TEXT NOT NULL,              -- JSON: effective parameter set per slot
      framed        INTEGER NOT NULL DEFAULT 0,
      holdout       INTEGER NOT NULL DEFAULT 0,
      audit         INTEGER NOT NULL DEFAULT 0, -- the frozen audit set
      degraded      TEXT,                       -- NULL | no-tokens | fts-threw
      started_at    INTEGER NOT NULL,
      finished_at   INTEGER,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dream_traces_owner   ON dream_traces(owner, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dream_traces_session ON dream_traces(session_id, turn_index);
    CREATE INDEX IF NOT EXISTS idx_dream_traces_turn    ON dream_traces(turn_id);
    CREATE INDEX IF NOT EXISTS idx_dream_traces_open    ON dream_traces(finished_at);
    -- The trace sweep cuts on created_at exactly like the frame sweep does
    -- (store.ts, sweepDreamTraces); without this index every LIMIT batch of
    -- the nightly sweep full-scans the table.
    CREATE INDEX IF NOT EXISTS idx_dream_traces_age    ON dream_traces(created_at);

    CREATE TABLE IF NOT EXISTS dream_frames (
      trace_id        TEXT NOT NULL REFERENCES dream_traces(id) ON DELETE CASCADE,
      slot            TEXT NOT NULL,            -- recall
      frame_v         INTEGER NOT NULL,
      owner           TEXT NOT NULL,            -- for the delete paths, without reading the payload
      session_id      TEXT,                     -- ditto
      box             TEXT NOT NULL,            -- JSON
      corpus_stamp_id TEXT NOT NULL,            -- points at the night's document-frequency stamp in meta
      payload         TEXT NOT NULL,            -- JSON: the whole frame
      bytes           INTEGER NOT NULL,
      created_at      INTEGER NOT NULL,
      PRIMARY KEY (trace_id, slot)
    );
    CREATE INDEX IF NOT EXISTS idx_dream_frames_age   ON dream_frames(created_at);
    CREATE INDEX IF NOT EXISTS idx_dream_frames_owner ON dream_frames(owner, session_id);

    CREATE TABLE IF NOT EXISTS dream_labels (
      turn_id    TEXT NOT NULL,
      target     TEXT NOT NULL,                 -- memory id, or '*' for a per-trace weight
      source     TEXT NOT NULL,                 -- correction | review | merge | user
      relevance  REAL NOT NULL,                 -- 1 = shown relevant, 0 = shown irrelevant
      scope      TEXT NOT NULL,                 -- turn | session
      evidence   TEXT,
      dead_at    INTEGER,                       -- target removed later; the row stays
      created_at INTEGER NOT NULL,
      PRIMARY KEY (turn_id, target, source)
    );
    CREATE INDEX IF NOT EXISTS idx_dream_labels_target ON dream_labels(target);

    CREATE TABLE IF NOT EXISTS memory_touches (
      id        TEXT PRIMARY KEY,
      owner     TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      turn_id   TEXT,
      trace_id  TEXT REFERENCES dream_traces(id) ON DELETE CASCADE,
      policy_id TEXT,                           -- policy_versions.id, NULL until Phase 3
      at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_touches_memory ON memory_touches(memory_id, at);
    CREATE INDEX IF NOT EXISTS idx_memory_touches_owner  ON memory_touches(owner, at);
    CREATE INDEX IF NOT EXISTS idx_memory_touches_trace  ON memory_touches(trace_id);
  `);

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

    -- The dream's corpus watch reads the document frequency of a frame's
    -- tokens from here, once per night - never inside a turn, because the
    -- vocabulary scan walks the whole index. It lives beside the index it
    -- reads so the two cannot drift apart.
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts_v
      USING fts5vocab(memories_fts, 'row');
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

  // Schema 21 -> 22: a run gets a name of its own. Nullable on purpose - a
  // row written before the name existed keeps reading, and the store names
  // it from its own first line rather than writing a guess back over it.
  if (!hasColumn(db, 'assignments', 'title')) {
    db.exec('ALTER TABLE assignments ADD COLUMN title TEXT');
  }

  // Schema 22 -> 23: an agent's mail gets a register of its own - two to
  // four sentences on HOW this person writes, colouring the output without
  // ever steering the work (that stays `instructions`). Nullable: a row
  // hired before this column existed reads back with a null voice and stays
  // silently neutral (decision E11, F5).
  if (!hasColumn(db, 'agents', 'voice')) {
    db.exec('ALTER TABLE agents ADD COLUMN voice TEXT');
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

  // Schema 17 -> 18: a schedule can also be fired by something that happened -
  // a webhook call or a heartbeat listener - instead of only by the clock.
  // `trigger_mode` decides whether the clock fires it at all; an event may
  // fire either kind, so a clock-backed job keeps its expression as the
  // backstop for events that never arrived. The webhook secret is its own
  // credential per job: handing one out never hands out the server's token,
  // and revoking one never touches another job.
  if (!hasColumn(db, 'cron_jobs', 'trigger_mode')) {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN trigger_mode TEXT NOT NULL DEFAULT 'schedule'");
  }
  if (!hasColumn(db, 'cron_jobs', 'webhook_token')) {
    db.exec('ALTER TABLE cron_jobs ADD COLUMN webhook_token TEXT');
  }
  if (!hasColumn(db, 'cron_jobs', 'event_cooldown_ms')) {
    db.exec('ALTER TABLE cron_jobs ADD COLUMN event_cooldown_ms INTEGER');
  }
  if (!hasColumn(db, 'cron_runs', 'source')) {
    db.exec('ALTER TABLE cron_runs ADD COLUMN source TEXT');
  }
  // One secret, one job. Partial, so the many jobs without a webhook do not
  // all collide on NULL.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_jobs_webhook
      ON cron_jobs(webhook_token) WHERE webhook_token IS NOT NULL;
  `);

  if (!hasColumn(db, 'messages', 'tool_calls')) {
    db.exec('ALTER TABLE messages ADD COLUMN tool_calls TEXT');
  }

  // Schema 15 -> 16: the ordered transcript. `tool_calls` keeps the flat
  // compatibility view, `blocks` stores text, thinking and tools interleaved
  // in the order they actually arrived (see `TurnBlocks`). NULL on every row
  // that predates this; readers fall back to `content` + `toolCalls`.
  if (!hasColumn(db, 'messages', 'blocks')) {
    db.exec('ALTER TABLE messages ADD COLUMN blocks TEXT');
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
  backfillScheduleSessionKind(db);

  /* ------------------------- agent performance reviews -------------------------
     docs/concepts/agent-performance-management.md. A review judges one
     assignment against the agent's own role, never against other agents -
     `agent_reviews` is organisation data, not a memory, so it never enters an
     agent's own prompt. An action is the personnel record behind a review
     trail: what actually changed about an agent, and why, so a later
     reconfig can be judged and rolled back instead of vanishing the way
     `updateAgent` silently overwrites `instructions` today. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_reviews (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      assignment_id TEXT REFERENCES assignments(id) ON DELETE CASCADE,
      task_id       TEXT,
      source        TEXT NOT NULL,
      overall       INTEGER NOT NULL,
      quality       INTEGER,
      completeness  INTEGER,
      reliability   INTEGER,
      communication INTEGER,
      efficiency    INTEGER,
      comment       TEXT,
      tags          TEXT NOT NULL DEFAULT '[]',
      failed_run    INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_reviews_agent
      ON agent_reviews(agent_id, created_at DESC);
    -- One effective review per source per assignment; a later user rating on
    -- the same assignment upserts instead of stacking beside the first.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_reviews_once
      ON agent_reviews(assignment_id, source);

    CREATE TABLE IF NOT EXISTS agent_actions (
      id                 TEXT PRIMARY KEY,
      org_id             TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      agent_id           TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      kind               TEXT NOT NULL,
      stage              INTEGER NOT NULL DEFAULT 0,
      reason             TEXT NOT NULL,
      before_text        TEXT,
      after_text         TEXT,
      agent_note         TEXT,
      handover_text      TEXT,
      review_ids         TEXT NOT NULL DEFAULT '[]',
      decided_by         TEXT NOT NULL,
      successor_agent_id TEXT,
      created_at         INTEGER NOT NULL,
      CHECK (kind <> 'reconfig' OR (before_text IS NOT NULL AND after_text IS NOT NULL))
    );

    CREATE INDEX IF NOT EXISTS idx_agent_actions_agent
      ON agent_actions(agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_actions_successor
      ON agent_actions(successor_agent_id);
  `);

  // Schema 14 -> 15: replacing an agent archives its memory bank instead of
  // deleting it - archived rows stay auditable on the retired agent's page
  // and, once the recall path is taught to filter them, out of reach for
  // anyone else.
  if (!hasColumn(db, 'memories', 'archived_at')) {
    db.exec('ALTER TABLE memories ADD COLUMN archived_at INTEGER');
  }

  // Schema 16 -> 17: one protocol row per mail thread. `kind` is what the
  // thread *is* - a chat, a work assignment, a run's report - and every mail
  // in the thread inherits it, so replies cannot drift a conversation from
  // one folder into another. `task_id` is the board side of the coupling: an
  // assignment thread names the task it created, which is what makes a task
  // traceable back through its mail. No FK on task_id, same reason
  // mail.assignment_id has none - the referenced row may be cleaned up
  // independently, and the mail trail should survive it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_threads (
      thread_id   TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL DEFAULT 'chat',
      task_id     TEXT,
      archived_at INTEGER,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mail_threads_org
      ON mail_threads(org_id, kind, archived_at);
    CREATE INDEX IF NOT EXISTS idx_mail_threads_task
      ON mail_threads(task_id);
  `);

  backfillMailThreads(db);

  // Schema 19: the running-turn journal. Every event a conversation turn
  // yields is a row the moment it is yielded, so any client - a reloaded
  // tab, another browser, whoever opens the conversation next - can rebuild
  // the turn exactly as it stood, and the live stream just continues on top.
  // Schema 20 widens the key: an assignment run has no conversation, so a
  // turn is owned by a session, an assignment, or both.
  db.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      id         TEXT PRIMARY KEY,
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      assignment_id TEXT,
      kind       TEXT NOT NULL DEFAULT 'chat',
      status     TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      ended_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_turns_session
      ON turns(session_id, started_at);
    CREATE TABLE IF NOT EXISTS turn_events (
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      seq     INTEGER NOT NULL,
      json    TEXT NOT NULL,
      PRIMARY KEY (turn_id, seq)
    );
  `);

  // Schema 19 -> 20: the session column loses its NOT NULL. A rebuild rather
  // than two ALTERs, because SQLite cannot drop a constraint in place. Both
  // tables move: a plain rename would leave `turn_events` pointing at the
  // discarded name, so it is recreated beside its parent, rows first - the
  // journal is the record, and none of it is dropped.
  const turnsShape = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'turns'",
  ).get() as { sql: string } | undefined;
  if (turnsShape && !turnsShape.sql.includes('assignment_id')) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`
      ALTER TABLE turns RENAME TO turns_v19;
      ALTER TABLE turn_events RENAME TO turn_events_v19;
      DROP INDEX IF EXISTS idx_turns_session;
      CREATE TABLE turns (
        id         TEXT PRIMARY KEY,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        assignment_id TEXT,
        kind       TEXT NOT NULL DEFAULT 'chat',
        status     TEXT NOT NULL DEFAULT 'running',
        started_at INTEGER NOT NULL,
        ended_at   INTEGER
      );
      CREATE TABLE turn_events (
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        seq     INTEGER NOT NULL,
        json    TEXT NOT NULL,
        PRIMARY KEY (turn_id, seq)
      );
      INSERT INTO turns (id, session_id, assignment_id, kind, status, started_at, ended_at)
        SELECT id, session_id, NULL, kind, status, started_at, ended_at FROM turns_v19;
      INSERT INTO turn_events (turn_id, seq, json)
        SELECT turn_id, seq, json FROM turn_events_v19;
      DROP TABLE turn_events_v19;
      DROP TABLE turns_v19;
      CREATE INDEX idx_turns_session ON turns(session_id, started_at);
      CREATE INDEX idx_turns_assignment ON turns(assignment_id, started_at);
    `);
    db.exec('PRAGMA foreign_keys = ON');
  }
  // For fresh installs and rebuilt ones alike: the assignment key's index.
  db.exec('CREATE INDEX IF NOT EXISTS idx_turns_assignment ON turns(assignment_id, started_at);');

  // Whatever still claims to be running was orphaned by the process that
  // wrote it: this database is single-writer and just opened, so nobody is
  // producing those turns any more. Marked here rather than in the journal
  // because every open is the startup for exactly one writer. The events
  // stay: they are the only record of an answer that never finished.
  db.prepare(
    "UPDATE turns SET status = 'interrupted', ended_at = ? WHERE status = 'running'",
  ).run(Date.now());

  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
    'schema_version',
    String(SCHEMA_VERSION),
  );
}

/**
 * One thread row for every thread that already exists as mail, guarded by a
 * `meta` flag like the other one-time backfills. Threads whose mail ever
 * carried an `assignment_id` read as reports - the run answered inside them;
 * everything else is a chat. No historical thread was created as an
 * assignment (that concept arrives with this schema), so `task_id` starts
 * NULL everywhere.
 */
function backfillMailThreads(db: Db): void {
  const done = db.prepare("SELECT value FROM meta WHERE key = 'mail_threads_v1'").get() as
    | { value: string }
    | undefined;
  if (done) return;

  db.prepare(
    `INSERT OR IGNORE INTO mail_threads (thread_id, org_id, kind, task_id, archived_at, created_at)
     SELECT m.thread_id, m.org_id,
            CASE WHEN SUM(CASE WHEN m.assignment_id IS NOT NULL THEN 1 ELSE 0 END) > 0
                 THEN 'report' ELSE 'chat' END,
            NULL, NULL, MIN(m.created_at)
     FROM mail m
     GROUP BY m.thread_id`,
  ).run();

  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('mail_threads_v1', '1')").run();
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
 * Files the cron-run transcripts that predate `kind = 'schedule'` under it.
 *
 * Same story as `backfillMailSessionKind`: a scheduled run has always needed
 * a session to run its turn in, and before the kind existed every one of
 * those runs left a "Schedule: <job name>" thread sitting in the
 * conversations list - and because a job used to keep and reuse one session
 * across every firing, that single thread just kept growing. Nothing is
 * deleted or merged; each row just stops pretending to be a chat to come
 * back to.
 */
function backfillScheduleSessionKind(db: Db): void {
  const done = db.prepare("SELECT value FROM meta WHERE key = 'schedule_session_kind_v1'").get() as
    | { value: string }
    | undefined;
  if (done) return;

  db.prepare(
    "UPDATE sessions SET kind = 'schedule' WHERE kind = 'chat' AND agent_id IS NULL AND title LIKE 'Schedule: %'",
  ).run();

  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schedule_session_kind_v1', '1')").run();
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
  // A rebuild replaces the corpus that every recorded frame was scored
  // against, so the dream must treat all frames from before this moment as
  // invalidated instead of rediscovering the drift night after night.
  db.prepare(
    "INSERT OR REPLACE INTO meta(key, value) VALUES ('dream.corpus_invalidated_at', ?)",
  ).run(String(Date.now()));
}
