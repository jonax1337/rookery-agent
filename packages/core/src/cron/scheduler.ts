import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  CronEventOutcome,
  CronJob,
  CronJobKind,
  CronScript,
  CronRun,
  CronTrigger,
  CronTriggerMode,
  PermissionLevel,
  RequesterKind,
} from '../types.js';
import type { NotifyUserInput } from '../org/controller.js';
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
 * Every outcome is recorded as a run and reaches the user as a `schedule`
 * notification, so what happened overnight is waiting for them in the morning.
 */

export interface CronRunOutcome {
  status: 'done' | 'failed';
  /** A script pre-check or a `[SILENT]` reply suppresses the outcome notification. */
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
  /**
   * Where a run's outcome goes - the controller's `notifyUser`, handed in as
   * a closure because the scheduler is built before the controller exists.
   * Left out, the scheduler stores the notification itself and emits it.
   */
  notify?: (input: NotifyUserInput) => void;
}

export interface CronJobInput {
  /** Fixed id for a job that must stay findable across restarts (e.g. the board watcher); random otherwise. */
  id?: string;
  orgId: string;
  name: string;
  /** May be empty when `triggerMode` is `event`: such a job has no clock. */
  schedule: string;
  triggerMode?: CronTriggerMode;
  /** Shortest gap between runs before an event starts another; the default otherwise. */
  eventCooldownMs?: number;
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
  triggerMode?: CronTriggerMode;
  eventCooldownMs?: number | null;
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
/** How much of a result goes into the outcome notification. */
const NOTICE_BUDGET = 1500;
/** How much of a job's prompt `describeCronJob` shows. */
const PROMPT_PREVIEW = 160;
/**
 * How long a job rests after a run before an event may start the next one.
 *
 * This is what keeps a chatty source honest: ten mails arriving in a minute
 * are one reason to look at the mailbox, not ten. Nothing is lost - the
 * events that arrive during the rest collapse into a single run at the end of
 * it - and a job that wants every single event sets its cooldown to 0.
 */
const DEFAULT_EVENT_COOLDOWN_MS = 60_000;

export class CronScheduler extends EventEmitter {
  readonly #store: Store;
  readonly #runner: CronRunner;
  readonly #log: Logger;
  readonly #catchUpMs: number;
  readonly #timeoutMs: number;
  readonly #notify: ((input: NotifyUserInput) => void) | undefined;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  /** Abort controllers of runs in flight, by job id: one run per job at a time. */
  readonly #running = new Map<string, AbortController>();
  /**
   * Events that arrived while their job was busy or resting, one entry per
   * job. Deliberately in memory: it says "something happened that this job has
   * not looked at yet", which a restart answers by looking anyway.
   */
  readonly #pending = new Map<string, { source: string; timer?: ReturnType<typeof setTimeout> }>();

  constructor(options: CronSchedulerOptions) {
    super();
    this.#store = options.store;
    this.#runner = options.runner;
    this.#log = options.logger ?? silentLogger;
    this.#catchUpMs = options.catchUpWindowMs ?? DEFAULT_CATCH_UP_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#notify = options.notify;
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
      // A job off the clock has no slot to miss and no expression to compute
      // one from. Without this, a single event-only schedule in the database
      // would take the whole server down on the next start.
      if (!this.#onTheClock(job)) continue;
      if (job.nextRunAt !== undefined && now - job.nextRunAt <= this.#catchUpWindow(job)) continue;
      const next = this.#next(job.schedule, now);
      this.#store.cron.updateJob(job.id, { nextRunAt: next }, false);
      if (job.nextRunAt !== undefined) {
        this.#log.info('Schedule missed while the server was down; skipping to the next run', {
          job: job.name,
          missedBy: now - job.nextRunAt,
        });
      }
    }
    this.#arm();
  }

  /**
   * How late a job may still start when the server comes back. A night of
   * memory consolidation is never skipped for being late: one run covers
   * every slot missed while the machine was off, which on a machine that is
   * off at half past three is most of the nights (the dream's evidence
   * stood still for weeks while the nights it rests on kept being skipped).
   */
  #catchUpWindow(job: CronJob): number {
    return job.kind === 'sleep' ? Number.POSITIVE_INFINITY : this.#catchUpMs;
  }

  /** Stop the clock and abort whatever is running. */
  stop(): void {
    this.#started = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    for (const id of [...this.#pending.keys()]) this.#forget(id);
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

  /** How many runs are in flight right now, the nightly memory run included. */
  get runningCount(): number {
    return this.#running.size;
  }

  /** Create a job. Throws CronSyntaxError for a bad expression, Error for a bad kind. */
  create(input: CronJobInput): CronJob {
    const triggerMode = input.triggerMode ?? 'schedule';
    // An event-only job has no clock and so needs no expression. One given
    // anyway is still normalised, so putting the job back on the clock later
    // is a change of mode and nothing else.
    const schedule = normaliseSchedule(triggerMode, input.schedule);
    const kind = input.kind ?? (input.agentId ? 'agent' : 'assistant');
    if (kind === 'agent' && !input.agentId) throw new Error('An agent schedule needs an agent.');
    // A sleep job's `prompt` carries a scope, not an instruction. Default it
    // here rather than letting an empty one quietly mean "nothing sleeps".
    if (kind === 'sleep' && !input.prompt.trim()) input = { ...input, prompt: 'assistant' };
    const enabled = input.enabled ?? true;
    validateExecution({ kind, script: input.script, permission: input.permission, enabled, remainingRuns: input.remainingRuns });
    const onTheClock = triggerMode === 'schedule' && schedule !== '';
    const nextRunAt = enabled && onTheClock ? this.#nextOrThrow(schedule, Date.now()) : undefined;
    const job = this.#store.cron.createJob({
      ...input,
      schedule,
      triggerMode,
      kind,
      agentId: kind === 'agent' ? input.agentId : undefined,
      enabled,
      nextRunAt,
    });
    this.#announce(job);
    this.#arm();
    return job;
  }

  /** Change a job. Only the fields given change; a new schedule or switching on recomputes the next run. */
  update(id: string, patch: CronJobPatch): CronJob {
    const current = this.#store.cron.getJob(id);
    if (!current) throw new Error('No schedule ' + id + '.');
    const triggerMode = patch.triggerMode ?? current.triggerMode;
    const wanted = patch.schedule !== undefined ? patch.schedule : current.schedule;
    // Putting a job back on the clock without an expression is the one case
    // that must still fail loudly: parseCron says so in its own words.
    const schedule = normaliseSchedule(triggerMode, wanted);
    const kind = patch.kind ?? (patch.agentId ? 'agent' : patch.agentId === null ? 'assistant' : current.kind);
    const agentId = patch.agentId === undefined ? current.agentId : (patch.agentId ?? undefined);
    if (kind === 'agent' && !agentId) throw new Error('An agent schedule needs an agent.');
    const enabled = patch.enabled ?? current.enabled;
    const script = patch.script === undefined ? current.script : patch.script ?? undefined;
    const permission = patch.permission === undefined ? current.permission : patch.permission ?? undefined;
    const remainingRuns = patch.remainingRuns === undefined ? current.remainingRuns : patch.remainingRuns ?? undefined;
    validateExecution({ kind, script, permission, enabled, remainingRuns });

    const onTheClock = triggerMode === 'schedule' && schedule !== '';
    const reschedule =
      schedule !== current.schedule ||
      enabled !== current.enabled ||
      triggerMode !== current.triggerMode ||
      current.nextRunAt === undefined;
    // Off the clock, the next run is not "unknown" but "never": null clears it
    // so neither `dueJobs` nor the timer ever considers this job again.
    const nextRunAt = !enabled || !onTheClock ? null : reschedule ? this.#nextOrThrow(schedule, Date.now()) : undefined;

    this.#store.cron.updateJob(id, {
      name: patch.name,
      schedule,
      triggerMode,
      eventCooldownMs: patch.eventCooldownMs,
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
   * Offer an event to a schedule: a webhook call, or a listener that saw
   * something happen. `source` says who, in words that end up on the run.
   *
   * Nothing is dropped and nothing piles up. A job already running gets one
   * more run after this one; a job still resting fires when the rest is over;
   * and however many events arrive meanwhile, they collapse into that one
   * run. A switched-off job ignores events entirely - the switch is what a
   * person reaches for to make it stop, and it would be a nasty surprise if a
   * URL handed out weeks ago still woke it up.
   */
  async runEvent(id: string, source: string): Promise<CronEventOutcome> {
    const job = this.#store.cron.getJob(id);
    if (!job) return { status: 'ignored', reason: 'No schedule ' + id + '.' };
    if (!job.enabled) return { status: 'ignored', reason: 'The schedule is switched off.' };
    if (job.remainingRuns === 0) return { status: 'ignored', reason: 'This schedule has no remaining runs.' };
    try {
      // The same gate a manual run passes: an unreviewed script does not run
      // because something outside asked nicely.
      validateExecution({ ...job, enabled: true });
    } catch (error) {
      return { status: 'ignored', reason: (error as Error).message };
    }
    if (this.#running.has(id)) {
      this.#remember(id, source);
      return { status: 'coalesced' };
    }
    const waitMs = this.#restLeft(job);
    if (waitMs > 0) {
      this.#remember(id, source);
      this.#armEvent(id, waitMs);
      return { status: 'queued', waitMs };
    }
    // Detached on purpose. Whoever offered the event is answered as soon as the
    // run is booked, not when it finishes: a webhook sender that is made to
    // wait out a model run times out and sends again, and one event would
    // become several. The run row is written before `#execute` reaches its
    // first await, so the answer can still name the run it started.
    let booked: CronRun | undefined;
    void this.#execute(job, 'event', source, (run) => {
      booked = run;
    }).catch((error: unknown) => {
      this.#log.error('Event run crashed', { job: job.name, error: String(error) });
    });
    // Nothing was booked: the job went away between the checks above and the
    // booking, which only a concurrent delete can do.
    if (!booked) return { status: 'ignored', reason: 'The schedule went away before it could run.' };
    return { status: 'started', run: booked };
  }

  /**
   * Mint the secret that lets an outside caller fire this job, replacing
   * whatever it had. The previous URL stops working the moment this returns,
   * which is what makes it a rotation as well as a first issue.
   */
  enableWebhook(id: string): CronJob {
    const job = this.#store.cron.getJob(id);
    if (!job) throw new Error('No schedule ' + id + '.');
    this.#store.cron.updateJob(id, { webhookToken: randomUUID() });
    const updated = this.#store.cron.getJob(id) ?? job;
    this.#announce(updated);
    return updated;
  }

  /** Take the webhook away. The URL answers "no such hook" from here on. */
  disableWebhook(id: string): CronJob {
    const job = this.#store.cron.getJob(id);
    if (!job) throw new Error('No schedule ' + id + '.');
    this.#store.cron.updateJob(id, { webhookToken: null });
    const updated = this.#store.cron.getJob(id) ?? job;
    this.#announce(updated);
    return updated;
  }

  /** The job a webhook secret opens, or null. A blank secret opens nothing. */
  findByWebhookToken(token: string): CronJob | null {
    return this.#store.cron.findJobByWebhookToken(token);
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

  async #execute(
    job: CronJob,
    trigger: CronTrigger,
    source?: string,
    /** Called the moment the run is on the books, before any work starts. */
    onBooked?: (run: CronRun) => void,
  ): Promise<CronRun> {
    // One run per job at a time, whoever asks. Every caller checks first; this
    // is the invariant they all rely on, kept where the controller is stored.
    if (this.#running.has(job.id)) {
      const latest = this.#store.cron.listRuns(job.id, 1)[0];
      if (latest && latest.status === 'running') return latest;
    }
    validateExecution({ ...job, enabled: true });

    const started = Date.now();
    this.#bookNextSlot(job, started);
    const run = this.#store.cron.createRun({ jobId: job.id, orgId: job.orgId, trigger, sessionId: job.sessionId, source });
    onBooked?.(run);
    const outcome = await this.#runUnderTimeout(job, run, trigger);
    const finishedRun = this.#recordOutcome(job, run, outcome, started, source);
    // An event that arrived while this was running has not been looked at by
    // anything yet. Detached on purpose: whoever started this run is waiting
    // for this run, not for the one the next event earned.
    void this.#drain(job.id);
    return finishedRun;
  }

  /**
   * Book the next slot (or retire a one-shot) before the run, so a crash
   * mid-run cannot fire the same slot twice after a restart.
   */
  #bookNextSlot(job: CronJob, started: number): void {
    if (job.remainingRuns !== undefined) this.#store.cron.updateJob(job.id, { remainingRuns: job.remainingRuns - 1 }, false);
    if (job.once || job.remainingRuns === 1) {
      this.#store.cron.updateJob(job.id, { enabled: false, nextRunAt: null }, false);
    } else if (this.#onTheClock(job)) {
      // A run is a run whoever asked for it, so an event run restarts the
      // backstop too: the clock is there to catch the events that never
      // arrive, and one just did.
      this.#store.cron.updateJob(job.id, { nextRunAt: this.#next(job.schedule, started) }, false);
    }
  }

  /** Hand the run to the runner with an abort signal that also fires on the timeout. */
  async #runUnderTimeout(job: CronJob, run: CronRun, trigger: CronTrigger): Promise<CronRunOutcome> {
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
      return { ...outcome, status: 'failed', error: outcome.error ?? 'The run was cancelled.' };
    }
    return outcome;
  }

  /** Write the finished run and the job's last-run facts, tell the user, tell the listeners. */
  #recordOutcome(job: CronJob, run: CronRun, outcome: CronRunOutcome, started: number, source?: string): CronRun {
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
      if (!outcome.silent) this.#postOutcome(current, run.id, outcome, source);
    }

    const finishedRun = this.#store.cron.getRun(run.id) ?? run;
    this.#announce(this.#store.cron.getJob(job.id) ?? job, finishedRun);
    this.#log.info('Schedule run finished', { job: job.name, status: outcome.status, durationMs: finished - started });
    return finishedRun;
  }

  /* ---------------------------- pending events ---------------------------- */

  /** Note that something happened, keeping only the most recent reason. */
  #remember(id: string, source: string): void {
    const state = this.#pending.get(id);
    if (state) state.source = source;
    else this.#pending.set(id, { source });
  }

  #forget(id: string): void {
    const state = this.#pending.get(id);
    if (state?.timer) clearTimeout(state.timer);
    this.#pending.delete(id);
  }

  /** How much of the job's rest is still to come, in milliseconds. */
  #restLeft(job: CronJob): number {
    const cooldown = job.eventCooldownMs ?? DEFAULT_EVENT_COOLDOWN_MS;
    if (cooldown <= 0 || job.lastRunAt === undefined) return 0;
    return Math.max(0, job.lastRunAt + cooldown - Date.now());
  }

  /** Whether the clock has anything to say about this job. */
  #onTheClock(job: CronJob): boolean {
    return job.triggerMode === 'schedule' && job.schedule !== '';
  }

  #armEvent(id: string, waitMs: number): void {
    const state = this.#pending.get(id);
    if (!state || state.timer) return;
    const timer = setTimeout(() => {
      const current = this.#pending.get(id);
      if (current) current.timer = undefined;
      void this.#drain(id);
    }, waitMs);
    timer.unref?.();
    state.timer = timer;
  }

  /**
   * Act on an event that had to wait. Called when a run ends and when a rest
   * is over; either way it fires at most one run and drops the note, so a
   * burst of events can never become a burst of runs.
   */
  async #drain(id: string): Promise<void> {
    const state = this.#pending.get(id);
    if (!state || state.timer) return;
    const job = this.#store.cron.getJob(id);
    if (!job || !job.enabled || job.remainingRuns === 0) {
      this.#forget(id);
      return;
    }
    // Still busy: the run in flight calls this again when it finishes.
    if (this.#running.has(id)) return;
    const waitMs = this.#restLeft(job);
    if (waitMs > 0) {
      this.#armEvent(id, waitMs);
      return;
    }
    const { source } = state;
    this.#forget(id);
    try {
      await this.#execute(job, 'event', source);
    } catch (error) {
      this.#log.error('Event run crashed', { job: job.name, error: String(error) });
    }
  }

  /**
   * What the user reads about one run, from whoever ran the job: a
   * notification of kind `schedule` - the same title and text the inbox mail
   * used to carry, now pointing at the job, the run and the conversation it
   * ran in, so a reply to it can continue right there.
   *
   * Through the runtime's `notify` when there is one - the controller's
   * `notifyUser`, the one road to the user. A scheduler built on its own (a
   * test, a one-off command) writes the row itself and announces it on its
   * own emitter instead.
   */
  #postOutcome(job: CronJob, runId: string, outcome: CronRunOutcome, source?: string): void {
    const input = outcomeNotice(job, runId, outcome, source);
    try {
      if (this.#notify) {
        this.#notify(input);
        return;
      }
      const notification = this.#store.org.createNotification({ ...input, orgId: job.orgId });
      this.emit('notification', { type: 'notification', notification } satisfies AgentEvent);
    } catch (error) {
      this.#log.warn('Could not post the schedule outcome', { error: (error as Error).message });
    }
  }

  /* -------------------------------- internals ------------------------------ */

  #next(schedule: string, from: number): number | null {
    const next = nextCronRun(schedule, new Date(from));
    return next ? next.getTime() : null;
  }

  #nextOrThrow(schedule: string, from: number): number {
    const next = this.#next(schedule, from);
    if (next === null) throw new CronSyntaxError('The schedule "' + schedule + '" never matches a real date.');
    return next;
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

function outcomeNotice(job: CronJob, runId: string, outcome: CronRunOutcome, source?: string): NotifyUserInput {
  const when = new Date().toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
  // Why it ran at all: the expression when the clock asked, and the name of
  // whatever happened when something else did. An event-only job has no
  // expression to quote, so quoting one would be an invention.
  const because = source ? 'fired by ' + source : job.schedule ? describeCron(job.schedule) : 'on events';
  const body =
    outcome.status === 'done'
      ? 'Completed at ' + when + ' (' + because + '). Result: ' +
        (clip(outcome.result ?? '', NOTICE_BUDGET) || '(no text)')
      : 'Failed at ' + when + ' (' + because + '): ' + (outcome.error ?? 'unknown error');
  const byAgent = job.kind === 'agent' && Boolean(job.agentId);
  return {
    orgId: job.orgId,
    kind: 'schedule',
    title: 'Schedule "' + job.name + '" ' + (outcome.status === 'done' ? 'completed' : 'failed'),
    body,
    fromKind: byAgent ? 'agent' : 'assistant',
    fromAgentId: byAgent ? job.agentId : undefined,
    cronJobId: job.id,
    cronRunId: runId,
    sessionId: outcome.sessionId,
  };
}

/** An event-only job has no clock and needs no expression, so a blank one stays blank; anything else must parse. */
function normaliseSchedule(triggerMode: CronTriggerMode, expression: string): string {
  return triggerMode === 'event' && !expression.trim() ? '' : parseCron(expression).expression;
}

function describeRunner(job: CronJob, agentSlug?: string): string {
  if (job.kind === 'script') return 'imported ' + (job.script?.runtime ?? '') + ' script';
  if (job.kind === 'agent') return 'agent ' + (agentSlug ?? job.agentId ?? '?');
  if (job.kind === 'sleep') return 'the memory itself';
  return 'you';
}

function describeNextRun(job: CronJob): string {
  if (!job.enabled) return 'off';
  if (job.nextRunAt) return 'next ' + new Date(job.nextRunAt).toLocaleString('en-GB');
  // An event job is not "off" because it has no next time - it is waiting.
  // Saying "off" would read as broken and invite someone to fix what works.
  return job.triggerMode === 'event' ? 'waiting for events' : 'off';
}

/** One line per job, for the assistant's prompt and tool replies. */
export function describeCronJob(job: CronJob, agentSlug?: string): string {
  const last = job.lastRunAt
    ? ', last ' + new Date(job.lastRunAt).toLocaleString('en-GB') + ' ' + (job.lastStatus ?? '')
    : '';
  const timing = job.schedule ? job.schedule + ' (' + describeCron(job.schedule) + ')' : 'on events';
  const also = job.schedule && job.triggerMode === 'event' ? ', clock off' : '';
  return (
    '- ' + job.id.slice(0, 8) + ' "' + job.name + '": ' + timing + also +
    (job.webhookToken ? ', webhook' : '') +
    (job.once ? ', once' : '') + ', by ' + describeRunner(job, agentSlug) + ', ' + describeNextRun(job) + last +
    ' - ' + clip(job.prompt, PROMPT_PREVIEW)
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
