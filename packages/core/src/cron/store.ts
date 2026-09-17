import { randomUUID } from 'node:crypto';
import type {
  CronJob,
  CronJobKind,
  CronScript,
  CronRun,
  CronRunStatus,
  CronTrigger,
  CronTriggerMode,
  PermissionLevel,
  RequesterKind,
} from '../types.js';
import type { Db } from '../memory/db.js';

type Row = Record<string, unknown>;

/**
 * Persistence for schedules and their runs. Pure CRUD: the parsing of the
 * expression, the computation of the next run and the execution live in
 * cron/scheduler.ts.
 */
export class CronStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /* ---------------------------------- jobs ---------------------------------- */

  createJob(input: {
    orgId: string;
    name: string;
    schedule: string;
    triggerMode?: CronTriggerMode;
    webhookToken?: string;
    eventCooldownMs?: number;
    kind: CronJobKind;
    script?: CronScript;
    remainingRuns?: number;
    prompt: string;
    agentId?: string;
    projectId?: string;
    /** Pin the job to an existing conversation from the start, instead of the first run creating one. */
    sessionId?: string;
    permission?: PermissionLevel;
    enabled?: boolean;
    once?: boolean;
    createdBy: RequesterKind;
    nextRunAt?: number;
  }): CronJob {
    const now = Date.now();
    const job: CronJob = {
      id: randomUUID(),
      orgId: input.orgId,
      name: input.name.trim() || 'Untitled schedule',
      schedule: input.schedule.trim(),
      triggerMode: input.triggerMode ?? 'schedule',
      webhookToken: blank(input.webhookToken),
      eventCooldownMs: input.eventCooldownMs,
      kind: input.kind,
      script: input.script,
      remainingRuns: input.remainingRuns,
      prompt: input.prompt.trim(),
      agentId: blank(input.agentId),
      projectId: blank(input.projectId),
      sessionId: blank(input.sessionId),
      permission: input.permission,
      enabled: input.enabled ?? true,
      once: input.once ?? false,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      nextRunAt: input.nextRunAt,
      runCount: 0,
    };
    this.#db
      .prepare(
        `INSERT INTO cron_jobs
           (id, org_id, name, schedule, kind, prompt, agent_id, project_id, session_id, permission, enabled, once,
            created_by, created_at, updated_at, next_run_at, run_count, script_json, remaining_runs,
            trigger_mode, webhook_token, event_cooldown_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.orgId,
        job.name,
        job.schedule,
        job.kind,
        job.prompt,
        job.agentId ?? null,
        job.projectId ?? null,
        job.sessionId ?? null,
        job.permission ?? null,
        job.enabled ? 1 : 0,
        job.once ? 1 : 0,
        job.createdBy,
        now,
        now,
        job.nextRunAt ?? null,
        job.script ? JSON.stringify(job.script) : null,
        job.remainingRuns ?? null,
        job.triggerMode,
        job.webhookToken ?? null,
        job.eventCooldownMs ?? null,
      );
    return job;
  }

  /**
   * The one job a webhook secret opens, or null.
   *
   * A blank secret never matches: the column is NULL for every job without a
   * webhook, and an empty string would otherwise equal an empty request.
   */
  findJobByWebhookToken(token: string): CronJob | null {
    const wanted = token.trim();
    if (!wanted) return null;
    const row = this.#db
      .prepare('SELECT * FROM cron_jobs WHERE webhook_token = ?')
      .get(wanted) as Row | undefined;
    return row ? mapJob(row) : null;
  }

  getJob(id: string): CronJob | null {
    const row = this.#db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id) as Row | undefined;
    return row ? mapJob(row) : null;
  }

  /** Find a job by id, unambiguous id prefix, or name (case-insensitive) within one company. */
  findJob(orgId: string, ref: string): CronJob | null {
    const wanted = ref.trim();
    if (!wanted) return null;
    const exact = this.getJob(wanted);
    if (exact && exact.orgId === orgId) return exact;
    const jobs = this.listJobs(orgId);
    const byName = jobs.filter((job) => job.name.toLowerCase() === wanted.toLowerCase());
    if (byName.length === 1) return byName[0]!;
    const byPrefix = jobs.filter((job) => job.id.startsWith(wanted));
    return byPrefix.length === 1 ? byPrefix[0]! : null;
  }

  listJobs(orgId: string): CronJob[] {
    const rows = this.#db
      .prepare('SELECT * FROM cron_jobs WHERE org_id = ? ORDER BY enabled DESC, next_run_at ASC, name ASC')
      .all(orgId) as Row[];
    return rows.map(mapJob);
  }

  /** Enabled jobs whose next run is at or before `now`, across every company. */
  dueJobs(now: number): CronJob[] {
    const rows = this.#db
      .prepare('SELECT * FROM cron_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC')
      .all(now) as Row[];
    return rows.map(mapJob);
  }

  /** Every enabled job, across every company; what the scheduler arms its timer from. */
  enabledJobs(): CronJob[] {
    const rows = this.#db.prepare('SELECT * FROM cron_jobs WHERE enabled = 1').all() as Row[];
    return rows.map(mapJob);
  }

  updateJob(
    id: string,
    patch: {
      name?: string;
      schedule?: string;
      triggerMode?: CronTriggerMode;
      webhookToken?: string | null;
      eventCooldownMs?: number | null;
      kind?: CronJobKind;
      script?: CronScript | null;
      remainingRuns?: number | null;
      prompt?: string;
      agentId?: string | null;
      projectId?: string | null;
      sessionId?: string | null;
      permission?: PermissionLevel | null;
      enabled?: boolean;
      once?: boolean;
      nextRunAt?: number | null;
      lastRunAt?: number;
      lastStatus?: CronRunStatus;
      lastError?: string | null;
      runCount?: number;
    },
    touch = true,
  ): void {
    this.#update(
      'cron_jobs',
      id,
      {
        name: patch.name?.trim(),
        schedule: patch.schedule?.trim(),
        trigger_mode: patch.triggerMode,
        webhook_token: patch.webhookToken,
        event_cooldown_ms: patch.eventCooldownMs,
        kind: patch.kind,
        script_json: patch.script === undefined ? undefined : patch.script === null ? null : JSON.stringify(patch.script),
        remaining_runs: patch.remainingRuns,
        prompt: patch.prompt?.trim(),
        agent_id: patch.agentId,
        project_id: patch.projectId,
        session_id: patch.sessionId,
        permission: patch.permission,
        enabled: patch.enabled === undefined ? undefined : patch.enabled ? 1 : 0,
        once: patch.once === undefined ? undefined : patch.once ? 1 : 0,
        next_run_at: patch.nextRunAt,
        last_run_at: patch.lastRunAt,
        last_status: patch.lastStatus,
        last_error: patch.lastError,
        run_count: patch.runCount,
      },
      touch,
    );
  }

  deleteJob(id: string): void {
    this.#db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(id);
  }

  /* ---------------------------------- runs ---------------------------------- */

  createRun(input: { jobId: string; orgId: string; trigger: CronTrigger; sessionId?: string; source?: string }): CronRun {
    const run: CronRun = {
      id: randomUUID(),
      jobId: input.jobId,
      orgId: input.orgId,
      trigger: input.trigger,
      status: 'running',
      startedAt: Date.now(),
      sessionId: blank(input.sessionId),
      source: blank(input.source),
    };
    this.#db
      .prepare(
        `INSERT INTO cron_runs (id, job_id, org_id, trigger, status, started_at, session_id, source)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(run.id, run.jobId, run.orgId, run.trigger, run.startedAt, run.sessionId ?? null, run.source ?? null);
    return run;
  }

  getRun(id: string): CronRun | null {
    const row = this.#db.prepare('SELECT * FROM cron_runs WHERE id = ?').get(id) as Row | undefined;
    return row ? mapRun(row) : null;
  }

  listRuns(jobId: string, limit = 30): CronRun[] {
    const rows = this.#db
      .prepare('SELECT * FROM cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(jobId, limit) as Row[];
    return rows.map(mapRun);
  }

  /** The newest runs of every job in one company, for the overview page. */
  listRecentRuns(orgId: string, limit = 50): CronRun[] {
    const rows = this.#db
      .prepare('SELECT * FROM cron_runs WHERE org_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(orgId, limit) as Row[];
    return rows.map(mapRun);
  }

  updateRun(
    id: string,
    patch: {
      status?: CronRunStatus;
      finishedAt?: number;
      durationMs?: number;
      result?: string;
      error?: string;
      sessionId?: string;
      assignmentId?: string;
    },
  ): void {
    this.#update(
      'cron_runs',
      id,
      {
        status: patch.status,
        finished_at: patch.finishedAt,
        duration_ms: patch.durationMs,
        result: patch.result,
        error: patch.error,
        session_id: patch.sessionId,
        assignment_id: patch.assignmentId,
      },
      false,
    );
  }

  /** Runs still marked running from a previous process are failed on startup. */
  failStaleRuns(reason: string): number {
    const now = Date.now();
    const result = this.#db
      .prepare("UPDATE cron_runs SET status = 'failed', error = ?, finished_at = ? WHERE status = 'running'")
      .run(reason, now);
    return Number(result.changes ?? 0);
  }

  /* -------------------------------- internals -------------------------------- */

  #update(table: string, id: string, patch: Record<string, unknown>, touch: boolean): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [column, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      sets.push(column + ' = ?');
      values.push(value);
    }
    if (!sets.length) return;
    if (touch) {
      sets.push('updated_at = ?');
      values.push(Date.now());
    }
    values.push(id);
    this.#db.prepare('UPDATE ' + table + ' SET ' + sets.join(', ') + ' WHERE id = ?').run(...(values as never[]));
  }
}

function blank(value: string | undefined | null): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function mapJob(row: Row): CronJob {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    name: row.name as string,
    schedule: row.schedule as string,
    triggerMode: (optional(row.trigger_mode) as CronTriggerMode | undefined) ?? 'schedule',
    webhookToken: optional(row.webhook_token),
    eventCooldownMs: optionalNumber(row.event_cooldown_ms),
    kind: (row.kind as CronJobKind) ?? 'assistant',
    script: row.script_json ? JSON.parse(String(row.script_json)) as CronScript : undefined,
    remainingRuns: optionalNumber(row.remaining_runs),
    prompt: row.prompt as string,
    agentId: optional(row.agent_id),
    projectId: optional(row.project_id),
    sessionId: optional(row.session_id),
    permission: optional(row.permission) as PermissionLevel | undefined,
    enabled: Number(row.enabled) === 1,
    once: Number(row.once) === 1,
    createdBy: (row.created_by as RequesterKind) ?? 'user',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    nextRunAt: optionalNumber(row.next_run_at),
    lastRunAt: optionalNumber(row.last_run_at),
    lastStatus: optional(row.last_status) as CronRunStatus | undefined,
    lastError: optional(row.last_error),
    runCount: Number(row.run_count ?? 0),
  };
}

function mapRun(row: Row): CronRun {
  return {
    id: row.id as string,
    jobId: row.job_id as string,
    orgId: row.org_id as string,
    trigger: row.trigger as CronTrigger,
    status: row.status as CronRunStatus,
    startedAt: Number(row.started_at),
    finishedAt: optionalNumber(row.finished_at),
    durationMs: optionalNumber(row.duration_ms),
    result: optional(row.result),
    error: optional(row.error),
    sessionId: optional(row.session_id),
    assignmentId: optional(row.assignment_id),
    source: optional(row.source),
  };
}
