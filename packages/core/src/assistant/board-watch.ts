import type { CronScheduler } from '../cron/scheduler.js';
import type { Logger } from '../logger.js';
import type { Store } from '../memory/store.js';
import type { OrgController } from '../org/controller.js';
import type { AgentEvent, CronJob, RookeryConfig, Task } from '../types.js';
import { formatAge } from '../util/time.js';

/**
 * The board watcher's schedule id, deterministic so it stays findable across a
 * restart - every other schedule id is a random uuid. One per organisation.
 */
export function boardWatchJobId(orgId: string): string {
  return 'board-watch:' + orgId;
}

/** Wide enough that the clock rarely fires it: the event path is the fast one, this is its backstop. */
const BOARD_WATCH_SCHEDULE = '*/30 * * * *';

/**
 * A minute keeps ten failures or blocks in one burst to one run, exactly like
 * every other event-fed schedule.
 */
const BOARD_WATCH_EVENT_COOLDOWN_MS = 60_000;

/**
 * An explicit ceiling, and a high one. `listTasks` defaults to 100
 * ordered by priority then oldest-first, so on a board that has built up
 * history the newest failure - the one that matters - is exactly the row
 * that falls off the end and is never seen.
 */
const BOARD_SCAN_LIMIT = 5000;

/** A run that has outlived this many of its own hard stops is not slow: its timer never fired or a crash orphaned the row. */
const STUCK_AFTER_TIMEOUTS = 2;

/**
 * What the watcher is told to look at (E8, F3). It reports; it does not act.
 *
 * The earlier wording told it to "do whatever actually helps - reassign it,
 * follow up with a fresh run on the same task, or restart it". That made the
 * watcher the unattended caller with the widest reach in the system, and it
 * fired hardest on `blocked` - the one status that means a person was asked
 * something. The right answer to an open question is to wait for it, so the
 * watcher now only says what it found. `WATCH_TOOLS` in org/tools.ts is what
 * enforces that; this prompt only explains it.
 */
const BOARD_WATCH_PROMPT =
  'Watch the board and report what needs a person. Check list_tasks for anything failed, and for ' +
  'anything running far longer than it should. You are a backstop, not a worker: you cannot start, ' +
  'reassign, restart or close anything, and that is deliberate - deciding what to do about what you ' +
  'find belongs to the user. Leave the user one report with report_to_user at most once per pass, ' +
  'and only when something truly needs a human decision: say what you saw, how long it has been ' +
  'that way, and what you would suggest. Once you have, answer with exactly [SILENT], so the same ' +
  'thing does not reach them a second time as this run\'s outcome. A task waiting on an answer is ' +
  'working as intended, not a fault, and never a reason to write. If none of what you were shown ' +
  'is worth interrupting somebody over, do not report that everything is fine - answer with ' +
  'exactly [SILENT] instead.';

/** What the watcher needs from the runtime. */
export interface BoardWatchContext {
  store: Store;
  cron: CronScheduler;
  org: OrgController;
  config: RookeryConfig;
  log: Logger;
}

/** The board watcher: its schedule, its edge-triggered fast path and its SQL-first check. */
export class BoardWatch {
  readonly #context: BoardWatchContext;
  /**
   * The tasks last seen in `failed` - only so the subscriber can tell a
   * fresh landing there apart from an unrelated edit to a task that was
   * already sitting there. Never read for anything else, and it holds only
   * what is failed right now, so it cannot outgrow the board's failures.
   *
   * Filled from the board when the clock starts, not left empty: an empty
   * set makes every already-failed task look like a fresh landing, so the
   * first harmless edit to any of them after a restart - a priority, a
   * title - would wake the watcher for a state it had already reported.
   * Edge-triggered has to mean edge-triggered across a restart as well.
   */
  readonly #failedTasks = new Set<string>();

  constructor(context: BoardWatchContext) {
    this.#context = context;
  }

  /** Whether this schedule is the board watcher, by its fixed id rather than its name. */
  isWatcher(job: CronJob): boolean {
    return job.id === boardWatchJobId(job.orgId);
  }

  /**
   * Make sure the board has a watcher. Called once when the clock starts.
   *
   * Unlike the nightly memory schedule, this row is an ordinary, visible
   * `cron_jobs` entry - E8 wants it editable and switchable in the same UI as
   * every other job, not hidden system clockwork. Seeding is idempotent by
   * id: a second call, on a later start, finds the same row and returns it
   * untouched, whatever a person did to it since - edited the schedule,
   * rewritten the prompt, switched it off. Only a row that does not exist yet
   * gets created.
   */
  ensureSchedule(): CronJob | null {
    const { org, cron, log } = this.#context;
    try {
      const organization = org.activeOrganization();
      this.#seedFailedTasks(organization.id);
      const id = boardWatchJobId(organization.id);
      const existing = cron.get(id);
      if (existing && existing.orgId === organization.id) return existing;
      return cron.create({
        id,
        orgId: organization.id,
        name: 'Board watch',
        schedule: BOARD_WATCH_SCHEDULE,
        triggerMode: 'schedule',
        // The clock is the backstop; the fast path is the task-event
        // subscriber below.
        eventCooldownMs: BOARD_WATCH_EVENT_COOLDOWN_MS,
        kind: 'assistant',
        prompt: BOARD_WATCH_PROMPT,
        createdBy: 'assistant',
      });
    } catch (error) {
      log.warn('Could not set up the board watcher', { error: (error as Error).message });
      return null;
    }
  }

  /**
   * What the board watcher would have something to say about, decided in
   * SQL rather than by a model.
   *
   * The watcher used to be a full turn every thirty minutes plus one per
   * event - roughly fifty model runs a day whose usual answer was
   * `[SILENT]`. "Is anything wrong" is a query; only "is this worth
   * interrupting somebody over, and how do I put it" needs judgment. So the
   * clock runs this first, the model is never started unless this finds
   * something, and when it does the findings go into the prompt: the turn
   * begins already knowing what it is there for.
   *
   * Nothing is reported twice. Everything that went wrong before the
   * watcher last actually said something was covered by that report, so
   * only what became true since then is news. That is what stops a board
   * with one permanently broken task on it from mailing about it
   * forty-eight times a day.
   */
  attention(orgId: string, jobId: string): string[] {
    const { store, config } = this.#context;
    const now = Date.now();
    // The mark is stored, not reconstructed from the run history.
    //
    // Reading "the newest run that produced a result" out of the last N
    // runs looked equivalent and was not, in three ways. A quiet board
    // writes a silent run every half hour, so after ten hours the speaking
    // run had fallen out of any fixed window and every old failure became
    // news again. A pass the model ended with `[SILENT]` left no result at
    // all, so a finding it had deliberately judged not worth reporting came
    // back every thirty minutes for ever. And both readings confused two
    // different questions: what the model chose to say, and what it was
    // shown. This answers the second - the mark moves when the findings are
    // handed over, whatever the model then decides to do with them.
    const markKey = 'board-watch:seen:' + jobId;
    const since = Number(store.getMeta(markKey) ?? 0);
    const stuckAfter = config.org.assignmentTimeoutMs * STUCK_AFTER_TIMEOUTS;
    const lines: string[] = [];
    for (const task of store.org.listTasks(orgId, {
      anyLevel: true,
      status: ['failed', 'running'],
      limit: BOARD_SCAN_LIMIT,
    })) {
      const note =
        task.status === 'failed' ? this.#failureNote(task, since, now) : this.#stuckNote(task, since, now, stuckAfter);
      if (note) lines.push('[' + task.id.slice(0, 8) + '] ' + task.title + note);
    }
    // Only a pass that actually found something moves the mark: a quiet
    // look must not silently swallow a failure that lands a second later.
    if (lines.length) store.setMeta(markKey, String(now));
    return lines;
  }

  /**
   * A task crossed into `failed` - the one transition the watcher cares
   * about (E8, section 5). The clock behind it fires every thirty minutes
   * regardless; this is only the fast path, and it is edge-triggered on
   * purpose: a task that merely stays failed while its title or priority
   * changes must not re-fire the watcher on every one of those unrelated
   * edits, only on actually landing in the state.
   *
   * `blocked` used to wake it too, and that was backwards. Blocked means an
   * agent asked a person something and the board is correctly waiting for
   * the answer. Waking a watcher on it meant the system's reaction to being
   * asked a question was to go and do something instead - within a minute,
   * while the person was still reading it.
   */
  onTaskEvent(event: AgentEvent): void {
    if (event.type !== 'task') return;
    const { task } = event;
    const wasFailed = this.#failedTasks.has(task.id);
    if (task.status === 'failed') this.#failedTasks.add(task.id);
    else this.#failedTasks.delete(task.id);
    if (task.status !== 'failed' || wasFailed) return;
    const { cron, log } = this.#context;
    void cron.runEvent(boardWatchJobId(task.orgId), 'task ' + task.id.slice(0, 8) + ' turned ' + task.status).catch((error: unknown) => {
      log.warn('Could not wake the board watcher', { error: String(error) });
    });
  }

  /**
   * Seed the edge detector before the subscriber can fire: every failed task
   * already on the board counts as "seen in this state", so only a real
   * transition from here on wakes the watcher. Without this the first
   * unrelated edit to an old failed task would look like a new failure.
   */
  #seedFailedTasks(orgId: string): void {
    for (const task of this.#context.store.org.listTasks(orgId, { anyLevel: true, limit: BOARD_SCAN_LIMIT })) {
      if (task.status === 'failed') this.#failedTasks.add(task.id);
      else this.#failedTasks.delete(task.id);
    }
  }

  /** News about a failed task: only what landed after the last report. */
  #failureNote(task: Task, since: number, now: number): string | null {
    const landed = task.finishedAt ?? task.updatedAt;
    if (landed <= since) return null;
    const runs = this.#context.store.org.taskRunCount(task.id);
    return (
      ' failed' + (runs > 1 ? ' on run ' + runs : '') +
      (task.error ? ': ' + task.error : '') + ' (' + formatAge(landed, now, 'minute') + ' ago)'
    );
  }

  /** News about a running task: only if it became stuck after the last report. */
  #stuckNote(task: Task, since: number, now: number, stuckAfter: number): string | null {
    const started = task.startedAt ?? task.updatedAt;
    // The moment it became stuck, not the moment we noticed: a task that
    // crossed that line before the last report was in that report.
    const crossed = started + stuckAfter;
    if (crossed > now || crossed <= since) return null;
    return ' has been running ' + formatAge(started, now, 'minute') + ' with no end';
  }
}
