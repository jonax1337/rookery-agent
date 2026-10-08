import { describeCron } from '../cron/parse.js';
import type { CronRunOutcome } from '../cron/scheduler.js';
import { runCronScript } from '../cron/script.js';
import type { Store } from '../memory/store.js';
import type { SleepRunner } from '../memory/sleep.js';
import type { AgentEvent, CronJob, RookeryConfig, Session } from '../types.js';
import { ASSISTANT_MEMORY_OWNER } from '../types.js';
import { formatNow } from '../util/time.js';
import type { BoardWatch } from './board-watch.js';
import type { NewSessionInput } from './sessions.js';
import type { AssignInput, ChatInput } from './types.js';

/**
 * The sentinel a run answers with when there is nothing to tell the user.
 *
 * An exact-match check on the whole reply is too brittle: the model
 * sometimes reasons out loud first and tacks the sentinel on as its
 * last line instead of replying with only it, which used to defeat the
 * match and let the explanation (sentinel and all) straight into the
 * outcome notification. Matching it as a trailing token - not anywhere in the
 * text - still catches that case without firing on a report that
 * merely quotes or explains the convention somewhere in its middle.
 */
const SILENT_REPLY = /\[SILENT\]\s*$/;

/** What a schedule's run needs from the runtime. */
export interface ScheduledRunHost {
  readonly config: RookeryConfig;
  readonly store: Store;
  readonly sleep: SleepRunner;
  readonly boardWatch: BoardWatch;
  chat(input: ChatInput): AsyncGenerator<AgentEvent, void, unknown>;
  assign(input: AssignInput): AsyncGenerator<AgentEvent, void, unknown>;
  createSession(input: NewSessionInput): Session;
}

/** A run's stream boiled down: the final text, and the fatal error if there was one. */
interface Reply {
  text: string;
  error: string | undefined;
}

async function collectReply(
  events: AsyncGenerator<AgentEvent, void, unknown>,
  onEvent?: (event: AgentEvent) => void,
): Promise<Reply> {
  const reply: Reply = { text: '', error: undefined };
  for await (const event of events) {
    onEvent?.(event);
    if (event.type === 'done') reply.text = event.text;
    else if (event.type === 'error' && event.fatal) reply.error = event.message;
  }
  return reply;
}

/**
 * The words an assistant job runs with. Same clock, same zone, same wording
 * as every other stamp a model reads.
 *
 * The watcher arrives knowing what it was woken for, so its turn is about
 * judging those findings rather than going to look for them. Everything in
 * `attention` is new since its last report by construction.
 */
function scheduledPrompt(job: CronJob, attention: string[]): string {
  return (
    'Automatic run of schedule “' + job.name + '” (' +
    (job.schedule ? describeCron(job.schedule) : 'fired by an event') + '), ' + formatNow() + '. ' +
    'Nobody is following live: carry out the assignment now and finish with a short report ' +
    'for the user to read later. If carrying it out already delivers the result to the user by ' +
    'itself (for example you notify them of the thing this job exists to send), that is the ' +
    'delivery - reply with exactly [SILENT] and nothing else, so a second "schedule completed" ' +
    'notification is not posted on top of it.\n\n' + job.prompt +
    (attention.length
      ? '\n\nThe board was checked before this run. These are new since you last reported, ' +
        'and they are the whole reason you were woken:\n- ' + attention.join('\n- ')
      : '')
  );
}

/**
 * Execute one schedule. The assistant's own jobs run as a turn in a fresh
 * conversation every firing - a clean rerun each time, not a diary the
 * assistant keeps adding to - unless the job was pinned to a specific
 * conversation when it was created (the "reply in this chat" case for a
 * one-off follow-up); an agent's jobs run as an ordinary assignment.
 */
export class ScheduledRuns {
  readonly #host: ScheduledRunHost;

  constructor(host: ScheduledRunHost) {
    this.#host = host;
  }

  async run(job: CronJob, signal: AbortSignal): Promise<CronRunOutcome> {
    if (job.kind === 'script') {
      const result = await runCronScript(this.#host.config.home, job, signal);
      if (result.silent) return { status: 'done', result: '', silent: true };
      if (job.script?.noAgent) return { status: 'done', result: result.output };
      const withData = job.prompt + '\n\nThe imported pre-check script produced this data:\n' + result.output;
      return this.#runAssistantJob({ ...job, prompt: withData }, signal);
    }
    if (job.kind === 'sleep') return this.#runSleepJob(job, signal);
    if (job.kind === 'agent') return this.#runAgentJob(job, signal);
    return this.#runAssistantJob(job, signal);
  }

  /**
   * The night shift. `prompt` carries the scope, not an instruction:
   * "assistant", "all", or one agent id.
   */
  async #runSleepJob(job: CronJob, signal: AbortSignal): Promise<CronRunOutcome> {
    const { sleep } = this.#host;
    const scope = job.prompt.trim() || 'assistant';
    const owners =
      scope === 'all' ? sleep.dueOwners() : scope === 'assistant' ? [ASSISTANT_MEMORY_OWNER] : [scope];
    const lines: string[] = [];
    let failed: string | undefined;
    for (const owner of owners) {
      const result = await sleep.run({ owner, trigger: 'schedule', signal });
      lines.push(this.#ownerLabel(owner) + ': ' + (result.report ?? '-'));
      if (result.status === 'failed') failed = result.error ?? 'The sleep run failed.';
    }
    if (failed && lines.length <= 1) return { status: 'failed', error: failed };
    return { status: 'done', result: lines.join('\n') };
  }

  /** "The assistant" or the agent's name, for the schedule's report line. */
  #ownerLabel(owner: string): string {
    if (owner === ASSISTANT_MEMORY_OWNER) return 'Assistant';
    return this.#host.store.org.getAgent(owner)?.name ?? owner.slice(0, 8);
  }

  /**
   * An agent's job runs as an ordinary assignment. `scheduled` keeps the run
   * from learning: the assignment's words are the job's own prompt, and no
   * memory should grow out of them.
   */
  async #runAgentJob(job: CronJob, signal: AbortSignal): Promise<CronRunOutcome> {
    const agent = job.agentId ? this.#host.store.org.getAgent(job.agentId) : null;
    if (!agent || agent.archived) return { status: 'failed', error: 'The agent for this schedule no longer exists.' };
    let assignmentId: string | undefined;
    const reply = await collectReply(
      this.#host.assign({
        agent: agent.id,
        // A recurring job is called the same thing every night, and that is
        // right: the schedule's name is the third source of a run's name.
        title: job.name,
        task: job.prompt,
        projectId: job.projectId,
        signal,
        scheduled: true,
        scheduleId: job.id,
      }),
      (event) => {
        if (event.type === 'assignment' && !assignmentId) assignmentId = event.assignment.id;
      },
    );
    return reply.error
      ? { status: 'failed', error: reply.error, assignmentId }
      : { status: 'done', result: reply.text, assignmentId };
  }

  /**
   * The assistant's own job: a turn in a conversation, with nobody following
   * live.
   *
   * The board watcher checks before it thinks. Nothing on the board that
   * needs saying means no session, no provider process and no model call -
   * which is what the overwhelming majority of its firings are.
   */
  async #runAssistantJob(job: CronJob, signal: AbortSignal): Promise<CronRunOutcome> {
    const { boardWatch } = this.#host;
    const watching = boardWatch.isWatcher(job);
    const attention = watching ? boardWatch.attention(job.orgId, job.id) : [];
    if (watching && !attention.length) return { status: 'done', result: '', silent: true };

    const sessionId = this.#sessionFor(job);
    const { text, error } = await collectReply(
      this.#host.chat({
        text: scheduledPrompt(job, attention),
        sessionId,
        projectId: job.projectId,
        permission: job.permission,
        signal,
        scheduled: true,
        // The board watcher is the one schedule that gets a cut-down toolset:
        // it looks and it mails, it does not act. Keyed off the job's fixed id
        // so a user-made job that merely happens to be named "Board watch" is
        // an ordinary assistant schedule with ordinary reach.
        watching,
      }),
    );
    if (error && !text) return { status: 'failed', error, sessionId };
    if (SILENT_REPLY.test(text)) return { status: 'done', result: '', silent: true, sessionId };
    return { status: 'done', result: text, sessionId };
  }

  /**
   * `job.sessionId` here only ever means "pinned at creation" - a one-off
   * follow-up the user asked to land in a chat they already had open.
   * Nothing writes it back after a run, so a recurring job gets a clean,
   * unlinked conversation every single firing.
   */
  #sessionFor(job: CronJob): string {
    const { store } = this.#host;
    const existing = job.sessionId ? store.getSession(job.sessionId) : null;
    if (!existing) {
      return this.#host.createSession({ title: 'Schedule: ' + job.name, kind: 'schedule', projectId: job.projectId }).id;
    }
    // The user may have archived the chat while this was pending; reusing
    // it silently would bury the reply where nobody looks for it.
    if (existing.archived) store.updateSession(existing.id, { archived: false });
    return existing.id;
  }
}
