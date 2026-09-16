import { EventEmitter } from 'node:events';
import type { AgentEvent, CronJob, CronJobKind, CronScript, CronRun, CronTrigger, MailWho, PermissionLevel, RequesterKind } from '../types.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import type { Store } from '../memory/store.js';
import { clip } from '../util/queue.js';
import { CronSyntaxError, describeCron, nextCronRun, parseCron } from './parse.js';
import { validateCronScript } from './script.js';

/**
 * The clock of the company.
 *
 * A schedule is a standing order: a prompt that fires on a cron expression
 * while the server is up, run either by the assistant itself (a turn of its
 * own, in a conversation dedicated to the job) or by one agent (an
 * assignment). The scheduler owns the rules - when a job is due, that a job
 * never runs twice at once, what happens to a missed run after a restart -
 * and hands the actual execution to a runner the runtime supplies.
 *
 * Every outcome is recorded as a run and posted to the assistant's inbox, so
 * the next conversation knows what happened overnight.
 */

export interface CronRunOutcome {
  status: 'done' | 'failed';
  /** A script pre-check can suppress an uneventful inbox notification. */
  silent?: boolean;
  result?: string;
  error?: string;
  /** The conversation this one run happened in - recorded on the run, not kept on the job. */
  sessionId?: string;
  assignmentId?: string;
}

export type CronRunner = (job: CronJob, run: CronRun, signal: AbortSignal) => Promise<CronRunOutcome>;

export interface CronSchedulerOptions {
  store: Store;
  runner: CronRunner;
  logger?: Logger;
  /** A run missed by at most this long (the server was down) still fires on startup. */
  catchUpWindowMs?: number;
  /** Hard stop for one run. */
  timeoutMs?: number;
}

export interface CronJobInput {
  orgId: string;
  name: string;
  schedule: string;
  kind?: CronJobKind;
  script?: CronScript;
  remainingRuns?: number;
  prompt: string;
  agentId?: string;
  projectId?: string;
  /**
   * Pin the job to an existing conversation instead of letting the first run
   * create a dedicated one - the "reply in this same chat" case for a
   * one-off follow-up. Only meaningful for the assistant's own jobs.
   */
  sessionId?: string;
  permission?: PermissionLevel;
  enabled?: boolean;
  once?: boolean;
  createdBy: RequesterKind;
}

export interface CronJobPatch {
  name?: string;
  schedule?: string;
  kind?: CronJobKind;
  script?: CronScript | null;
  remainingRuns?: number | null;
  prompt?: string;
  agentId?: string | null;
  projectId?: string | null;
  permission?: PermissionLevel | null;
  enabled?: boolean;
  once?: boolean;
}

/** Never sleep longer than this between checks, whatever the timers say. */
const MAX_SLEEP_MS = 60_000;
const MIN_SLEEP_MS = 200;
const DEFAULT_CATCH_UP_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;
/** How much of a result goes into the inbox note. */
const INBOX_BUDGET = 1500;

export class CronScheduler extends EventEmitter {
  readonly #store: Store;
  readonly #runner: CronRunner;
  readonly #log: Logger;
  readonly #catchUpMs: number;
  readonly #timeoutMs: number;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  /** Abort controllers of runs in flight, by job id: one run per job at a time. */
  readonly #running = new Map<string, AbortController>();

  constructor(options: CronSchedulerOptions) {
    super();
    this.#store = options.store;
    this.#runner = options.runner;
    this.#log = options.logger ?? silentLogger;
    this.#catchUpMs = options.catchUpWindowMs ?? DEFAULT_CATCH_UP_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /* ------------------------------- lifecycle ------------------------------ */

  get started(): boolean {
    return this.#started;
  }

  /**
   * Start the clock. Runs left "running" by a previous process are failed,
   * and every enabled job gets a next run: kept when it is still ahead or
   * only just missed, recomputed from now when it is long gone.
   */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    const stale = this.#store.cron.failStaleRuns('The server stopped during the run.');
    if (stale) this.#log.warn('Failed stale schedule runs from a previous process', { count: stale });

    const now = Date.now();
    for (const job of this.#store.cron.enabledJobs()) {
      const missedBy = job.nextRunAt === undefined ? Infinity : now - job.nextRunAt;
      if (missedBy <= this.#catchUpMs) continue;
      const next = this.#next(job.schedule, now);
      this.#store.cron.updateJob(job.id, { nextRunAt: next }, false);
      if (job.nextRunAt !== undefined) {
        this.#log.info('Schedule missed while the server was down; skipping to the next run', {
          job: job.name,
          missedBy,
        });
      }
    }
    this.#arm();
  }

  /** Stop the clock and abort whatever is running. */
  stop(): void {
    this.#started = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    for (const controller of this.#running.values()) controller.abort();
  }

  /* --------------------------------- CRUD --------------------------------- */

  /**
   * The schedules a person can see. The nightly memory run is Rookery's own
   * clockwork, not one of them: it rides the same timer and ledger, but it
   * is shown, edited, switched off and fired from the memory page alone, so
   * every user-facing list leaves it out unless it is asked for by name.
   */
  list(orgId: string, options: { includeSystem?: boolean } = {}): CronJob[] {
    const jobs = this.#store.cron.listJobs(orgId);
    if (options.includeSystem) return jobs;
    return jobs.filter((job) => job.kind !== 'sleep');
  }

  get(id: string): CronJob | null {
    return this.#store.cron.getJob(id);
  }

  find(orgId: string, ref: string): CronJob | null {
    return this.#store.cron.findJob(orgId, ref);
  }

  runs(jobId: string, limit?: number): CronRun[] {
    return this.#store.cron.listRuns(jobId, limit);
  }

  recentRuns(orgId: string, limit?: number): CronRun[] {
    const runs = this.#store.cron.listRecentRuns(orgId, limit);
    const kinds = new Map(this.#store.cron.listJobs(orgId).map((job) => [job.id, job.kind]));
    return runs.filter((run) => kinds.get(run.jobId) !== 'sleep');
  }

  isRunning(jobId: string): boolean {
    return this.#running.has(jobId);
  }

  /** Create a job. Throws CronSyntaxError for a bad expression, Error for a bad kind. */
  create(input: CronJobInput): CronJob {
    const schedule = parseCron(input.schedule).expression;
    const kind = input.kind ?? (input.agentId ? 'agent' : 'assistant');
    if (kind === 'agent' && !input.agentId) throw new Error('An agent schedule needs an agent.');
    // A sleep job's `prompt` carries a scope, not an instruction. Default it
    // here rather than letting an empty one quietly mean "nothing sleeps".
    if (kind === 'sleep' && !input.prompt.trim()) input = { ...input, prompt: 'assistant' };
    const enabled = input.enabled ?? true;
    validateExecution({ kind, script: input.script, permission: input.permission, enabled, remainingRuns: input.remainingRuns });
    const nextRunAt = enabled ? this.#next(schedule, Date.now()) : null;
    if (enabled && nextRunAt === null) {
      throw new CronSyntaxError('The schedule "' + schedule + '" never matches a real date.');
    }
    const job = this.#store.cron.createJob({
      ...input,
      schedule,
      kind,
      agentId: kind === 'agent' ? input.agentId : undefined,
      enabled,
      nextRunAt: nextRunAt ?? undefined,
    });
    this.#announce(job);
    this.#arm();
    return job;
  }

  /** Change a job. Only the fields given change; a new schedule or switching on recomputes the next run. */
  update(id: string, patch: CronJobPatch): CronJob {
    const current = this.#store.cron.getJob(id);
    if (!current) throw new Error('No schedule ' + id + '.');
    const schedule = patch.schedule !== undefined ? parseCron(patch.schedule).expression : current.schedule;
    const kind = patch.kind ?? (patch.agentId ? 'agent' : patch.agentId === null ? 'assistant' : current.kind);
    const agentId = patch.agentId === undefined ? current.agentId : (patch.agentId ?? undefined);
    if (kind === 'agent' && !agentId) throw new Error('An agent schedule needs an agent.');
    const enabled = patch.enabled ?? current.enabled;
    const script = patch.script === undefined ? current.script : patch.script ?? undefined;
    const permission = patch.permission === undefined ? current.permission : patch.permission ?? undefined;
    const remainingRuns = patch.remainingRuns === undefined ? current.remainingRuns : patch.remainingRuns ?? undefined;
    validateExecution({ kind, script, permission, enabled, remainingRuns });

    const reschedule = schedule !== current.schedule || enabled !== current.enabled || current.nextRunAt === undefined;
    const nextRunAt = !enabled ? null : reschedule ? this.#next(schedule, Date.now()) : undefined;
    if (enabled && reschedule && nextRunAt === null) {
      throw new CronSyntaxError('The schedule "' + schedule + '" never matches a real date.');
    }

    this.#store.cron.updateJob(id, {
      name: patch.name,
      schedule,
      kind,
      prompt: patch.prompt,
      script: kind === 'script' ? script : null,
      remainingRuns: patch.remainingRuns,
      agentId: kind === 'agent' ? agentId : null,
      projectId: patch.projectId,
      permission: patch.permission,
      enabled,
      once: patch.once,
      nextRunAt,
    });
    const updated = this.#store.cron.getJob(id) ?? current;
    this.#announce(updated);
    this.#arm();
    return updated;
  }

  remove(id: string): boolean {
    const job = this.#store.cron.getJob(id);
    if (!job) return false;
    this.#running.get(id)?.abort();
    this.#store.cron.deleteJob(id);
    this.#announce(job, undefined, true);
    this.#arm();
    return true;
  }

  /* ------------------------------- execution ------------------------------ */

  /**
   * Run one job now, by hand. Resolves with the finished run. A job already
   * running is not started twice; the run in flight is what comes back.
   */
  async runNow(id: string): Promise<CronRun> {
    const job = this.#store.cron.getJob(id);
    if (!job) throw new Error('No schedule ' + id + '.');
    // Same guard as tick(): one run per job. A second execution would
    // overwrite the abort controller and leave the first run unabortable.
    if (this.#running.has(id)) {
      const latest = this.#store.cron.listRuns(id, 1)[0];
      if (latest) return latest;
    }
    return this.#execute(job, 'manual');
  }

  /**
   * Fire every job that is due. The timer calls this; tests call it with a
   * clock of their own. Resolves once the runs it started have finished.
   */
  async tick(now = Date.now()): Promise<void> {
    const due = this.#store.cron.dueJobs(now).filter((job) => !this.#running.has(job.id));
    const results = await Promise.allSettled(due.map((job) => this.#execute(job, 'schedule')));
    for (const result of results) {
      if (result.status === 'rejected') this.#log.error('Schedule run crashed', { error: String(result.reason) });
    }
    this.#arm();
  }

  async #execute(job: CronJob, trigger: CronTrigger): Promise<CronRun> {
    if (this.#running.has(job.id)) {
      // One run at a time. The clock moves on so the job is not re-armed for
      // the same minute again and again while a long run is under way.
      if (trigger === 'schedule') {
        this.#store.cron.updateJob(job.id, { nextRunAt: this.#next(job.schedule, Date.now()) }, false);
      }
      const latest = this.#store.cron.listRuns(job.id, 1)[0];
      if (latest && latest.status === 'running') return latest;
    }
    validateExecution({ ...job, enabled: true });

    // Book the next slot (or retire a one-shot) before the run, so a crash
    // mid-run cannot fire the same slot twice after a restart.
    const started = Date.now();
    if (job.remainingRuns !== undefined) this.#store.cron.updateJob(job.id, { remainingRuns: job.remainingRuns - 1 }, false);
    if (job.once || job.remainingRuns === 1) {
      this.#store.cron.updateJob(job.id, { enabled: false, nextRunAt: null }, false);
    } else {
      this.#store.cron.updateJob(job.id, { nextRunAt: this.#next(job.schedule, started) }, false);
    }

    const run = this.#store.cron.createRun({ jobId: job.id, orgId: job.orgId, trigger, sessionId: job.sessionId });
    const controller = new AbortController();
    this.#running.set(job.id, controller);
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref?.();
    this.#announce(this.#store.cron.getJob(job.id) ?? job, run);
    this.#log.info('Schedule run started', { job: job.name, trigger, run: run.id });

    let outcome: CronRunOutcome;
    try {
      outcome = await this.#runner(job, run, controller.signal);
    } catch (error) {
      outcome = { status: 'failed', error: (error as Error).message };
    } finally {
      clearTimeout(timer);
      this.#running.delete(job.id);
    }
    if (controller.signal.aborted && outcome.status === 'done' && !outcome.result) {
      outcome = { ...outcome, status: 'failed', error: outcome.error ?? 'The run was cancelled.' };
    }

    const finished = Date.now();
    this.#store.cron.updateRun(run.id, {
      status: outcome.status,
      finishedAt: finished,
      durationMs: finished - started,
      result: outcome.result,
      error: outcome.error,
      sessionId: outcome.sessionId,
      assignmentId: outcome.assignmentId,
    });
    // The job may have been deleted while running; then there is nothing to update.
    const current = this.#store.cron.getJob(job.id);
    if (current) {
      this.#store.cron.updateJob(
        job.id,
        {
          lastRunAt: started,
          lastStatus: outcome.status,
          lastError: outcome.error ?? null,
          runCount: current.runCount + 1,
        },
        false,
      );
      if (!outcome.silent) this.#postToInbox(current, outcome);
    }

    const finishedRun = this.#store.cron.getRun(run.id) ?? run;
    this.#announce(this.#store.cron.getJob(job.id) ?? job, finishedRun);
    this.#log.info('Schedule run finished', { job: job.name, status: outcome.status, durationMs: finished - started });
    return finishedRun;
  }

  /** What the user reads in their mailbox, from whoever ran the job. */
  #postToInbox(job: CronJob, outcome: CronRunOutcome): void {
    const when = new Date().toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
    const subject = 'Schedule "' + job.name + '" ' + (outcome.status === 'done' ? 'completed' : 'failed');
    const body =
      outcome.status === 'done'
        ? 'Completed at ' + when + ' (' + describeCron(job.schedule) + '). Result: ' +
          (clip(outcome.result ?? '', INBOX_BUDGET) || '(no text)')
        : 'Failed at ' + when + ' (' + describeCron(job.schedule) + '): ' + (outcome.error ?? 'unknown error');
    try {
      const from: MailWho = job.kind === 'agent' && job.agentId ? { kind: 'agent', id: job.agentId } : { kind: 'assistant' };
      // A schedule's outcome is a report even when the assistant sends it -
      // the agent-default in the store would file it as chat.
      const mail = this.#store.org.sendMail({ orgId: job.orgId, from, to: [{ kind: 'user' }], subject, body, kind: 'report' });
      this.emit('mail', { type: 'mail', mail } satisfies AgentEvent);
    } catch (error) {
      this.#log.warn('Could not post schedule outcome to mail', { error: (error as Error).message });
    }
  }

  /* -------------------------------- internals ------------------------------ */

  #next(schedule: string, from: number): number | null {
    const next = nextCronRun(schedule, new Date(from));
    return next ? next.getTime() : null;
  }

  /** Sleep until the earliest next run, capped so a job edited elsewhere is never missed for long. */
  #arm(): void {
    if (!this.#started) return;
    if (this.#timer) clearTimeout(this.#timer);
    const now = Date.now();
    let earliest = Infinity;
    for (const job of this.#store.cron.enabledJobs()) {
      if (job.nextRunAt !== undefined && !this.#running.has(job.id)) earliest = Math.min(earliest, job.nextRunAt);
    }
    const delay = Number.isFinite(earliest) ? Math.min(MAX_SLEEP_MS, Math.max(MIN_SLEEP_MS, earliest - now)) : MAX_SLEEP_MS;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.tick();
    }, delay);
    this.#timer.unref?.();
  }

  #announce(job: CronJob, run?: CronRun, deleted?: boolean): void {
    const event: AgentEvent = { type: 'cron', job, ...(run ? { run } : {}), ...(deleted ? { deleted: true } : {}) };
    this.emit('cron', event);
  }
}

/** One line per job, for the assistant's prompt and tool replies. */
export function describeCronJob(job: CronJob, agentSlug?: string): string {
  const who =
    job.kind === 'script' ? 'imported ' + (job.script?.runtime ?? '') + ' script' : job.kind === 'agent'
      ? 'agent ' + (agentSlug ?? job.agentId ?? '?')
      : job.kind === 'sleep'
        ? 'the memory itself'
        : 'you';
  const next = job.enabled && job.nextRunAt ? 'next ' + new Date(job.nextRunAt).toLocaleString('en-GB') : 'off';
  const last = job.lastRunAt
    ? ', last ' + new Date(job.lastRunAt).toLocaleString('en-GB') + ' ' + (job.lastStatus ?? '')
    : '';
  return (
    '- ' + job.id.slice(0, 8) + ' "' + job.name + '": ' + job.schedule + ' (' + describeCron(job.schedule) + ')' +
    (job.once ? ', once' : '') + ', by ' + who + ', ' + next + last + ' - ' + clip(job.prompt, 160)
  );
}

function validateExecution(job: Pick<CronJob, 'kind' | 'script' | 'permission' | 'enabled' | 'remainingRuns'>): void {
  if (job.remainingRuns !== undefined && (!Number.isSafeInteger(job.remainingRuns) || job.remainingRuns < 0)) {
    throw new Error('Remaining runs must be a non-negative whole number.');
  }
  if (job.enabled && job.remainingRuns === 0) throw new Error('This schedule has no remaining runs.');
  if (job.kind !== 'script') return;
  validateCronScript(job.script);
  if (job.enabled && job.permission !== 'full') throw new Error('Review the imported script and grant Full access before running it.');
}
