import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { readProfileExcerpt, searchProfile } from '../profile.js';
import type {
  Agent,
  AgentEvent,
  AgentReview,
  Assignment,
  AssignmentLogEntry,
  AssignmentLogFrame,
  AssignmentLogSnapshot,
  AssignmentStatus,
  AssignmentView,
  EffortLevel,
  ImapListenerConfig,
  McpServerSpec,
  Notification,
  NotificationKind,
  NotifyEvent,
  Organization,
  Project,
  Provider,
  ProviderId,
  ProviderTurnOptions,
  QuestionAnswer,
  QuestionOption,
  RequesterKind,
  RookeryConfig,
  Task,
  TaskEvent,
  TaskEventActor,
  TaskEventKind,
  TaskStatus,
  ToolServerAudience,
} from '../types.js';
import { ASSISTANT_MEMORY_OWNER, EFFORT_LEVELS } from '../types.js';
import { agentWorkspace, applyConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { remapModel } from '../providers/provider-catalog.js';
import { isUsageLimitError, providerBlocked, rememberUsageFailure } from '../providers/quota.js';
import type { Store } from '../memory/store.js';
import type { OrgStore } from './store.js';
import { byScoreThenId, coreProfile, recall } from '../memory/recall.js';
import { resolvePolicy } from '../memory/dream/policy.js';
import { extractMemories, smallModelFor } from '../memory/extractor.js';
import { admitCandidates, linkEntities } from '../memory/gate.js';
import type { SleepRunner } from '../memory/sleep.js';
import { clip, shorten, tail, titleFromBrief } from '../util/queue.js';
import { formatAge, formatDay, formatWhen } from '../util/time.js';
import type { BridgeServer, ToolCallResult, ToolHandler } from './bridge.js';
import {
  buildAgentPrompt,
  renderBoard,
  renderOrgOverview,
  renderSchedules,
  renderTaskActivity,
  type AgentPromptInput,
  type OrgSnapshot,
} from './prompts.js';
import {
  draftHandover,
  draftNote,
  draftReconfig,
  draftReplacementProposal,
  judgeAssignment,
  type WeakReview,
} from './review.js';
import { buildTaskWaves, planTask, type TaskPlan } from './planner.js';
import { AssignmentLogBuffer } from './assignment-log.js';
import {
  ToolArgs,
  asMemoryKind,
  asPermission,
  asPriority,
  asQuestionOptions,
  resolveClearable,
  resolveOptional,
  toolError,
  type Resolved,
} from './tool-args.js';
import { toolsFor, type ToolAudience } from './tools.js';
import type { QuestionCloseReason, QuestionRegistry } from './questions.js';
import {
  externalTurnExtras,
  renderToolServers,
  toolServerStates,
  toolServersFor,
  withToolServer,
} from '../tools/hub.js';
import {
  SkillStore,
  projectSkillsDir,
  renderSkill,
  renderSkillsIndex,
  skillSlug,
  type Skill,
} from '../skills/store.js';
import {
  findExternalSkills,
  openExternalSkill,
  renderExternalSkillsHint,
  renderSkillHits,
} from '../skills/shelf.js';
import { matchSkills, renderSkillMatches } from '../skills/suggest.js';
import { describeCronJob, type CronJobPatch, type CronScheduler } from '../cron/scheduler.js';
import { describeCron } from '../cron/parse.js';
import {
  fingerprintMcpFile,
  projectMcpStatus,
  readProjectMcpFile,
  renderProjectMcpServers,
} from './project-mcp.js';

/**
 * The rules of the company, and the machinery that runs an assignment.
 *
 * Everything a provider process does through the rookery tools ends up in
 * `handle`: who may assign to whom, how deep delegation may nest, who may
 * message whom. Everything that turns an assignment into a running provider
 * process is in `run`. Both are here rather than split, because an agent's
 * process gets its own tool handler, and that handler starts assignments -
 * the two halves call each other.
 */

/** Who is calling a tool, and where its events should go. */
export interface ToolContext {
  orgId: string;
  audience: ToolAudience;
  /** The calling agent, for the `agent` audience. */
  agentId?: string;
  sessionId?: string;
  /** Default project for assignments started from this context. */
  projectId?: string;
  /** The assignment whose process is calling, for delegation chains. */
  parentAssignmentId?: string;
  /**
   * The task this context is working on, set by `#runTaskLeaf`. It is what
   * makes a delegation chain a tree on the board: work handed on from inside
   * a task becomes a child of that task rather than a card of its own
   * (decision E9).
   */
  taskId?: string;
  /** Depth of the caller; the assistant is -1, its direct assignments are 0. */
  depth: number;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
  /**
   * Appended to the brief of the task leaf this context runs. It carries the
   * answer that continued a waiting task, or the results of work handed off
   * in the background: neither is in the task's own description, and without
   * it a continued run would read the original work order again and answer
   * it twice.
   */
  taskNote?: string;
  /**
   * Set when the caller is a scheduled run rather than a person's
   * conversation. Automated runs work, but they write nothing back: no
   * memories are extracted from them and `write_skill` refuses, so a cron
   * job cannot quietly author its own job description into permanent
   * storage.
   */
  scheduled?: boolean;
  /**
   * Set for the board watcher's own run. It is the strictest context there
   * is: the watcher may read the board and leave one report, nothing else. A
   * watcher that could reassign, restart or close what it finds would answer
   * a person's open question by guessing at it, which is the one thing a
   * backstop must never do.
   */
  watching?: boolean;
  /**
   * The bridge token of the calling turn, stamped in by `register`. `ask_user`
   * files it with the question so the turn can take its questions with it on
   * every exit, not only on an abort.
   */
  questionOwner?: string;
}

export interface RunAssignmentInput {
  orgId: string;
  agent: Agent;
  /**
   * What this run is called in lists. A run that carries out a task takes
   * that task's name (decision E17); everything else is named by whoever
   * started it, and only as a last resort by the brief's own first line.
   */
  title: string;
  task: string;
  /** The task being carried out, when there is one; reaches the run's tools. */
  taskId?: string;
  projectId?: string;
  sessionId?: string;
  parentId?: string;
  requesterKind: RequesterKind;
  requesterAgentId?: string;
  depth: number;
  /** A schedule fired this assignment; it works, but it does not learn. */
  scheduled?: boolean;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
  /**
   * Told, when the run ends, whether the agent called `ask_requester` while
   * it was running - the signal that turns a finished task leaf into
   * `blocked` instead of `done` (decision E6). It used to be read off the
   * agent's outbox (a mail to whoever asked, on To); now the tool itself sets
   * a flag on the run, which cannot be mistaken for anything else.
   */
  onAskedRequester?: (asked: boolean) => void;
  /** Told the run's record the moment it exists, before it is queued. */
  onStarted?: (assignment: Assignment) => void;
}

export interface OrgControllerOptions {
  store: Store;
  registry: ProviderRegistry;
  config: RookeryConfig;
  bridge: BridgeServer;
  logger?: Logger;
  /** The clock, when the runtime has one; the schedule tools need it. */
  cron?: CronScheduler;
  /** The night shift, when the runtime has one; `sleep_now` needs it. */
  sleep?: SleepRunner;
  /**
   * The open questions, when the runtime has one; `ask_user` needs it. Left
   * unset - a controller built for a one-off command, say - the tool says it
   * cannot reach anybody instead of hanging on a promise nobody can settle.
   */
  questions?: QuestionRegistry;
  /**
   * Whether an outgoing channel could deliver a notification *right now* -
   * not merely whether one is registered. A Telegram push service that is
   * attached but switched off, or has nobody left to send to, answers no, so
   * `notify` fails cleanly instead of claiming success into the void. The
   * controller has no notion of transport, so it asks rather than looks.
   */
  canNotify?: () => boolean;
}

/** Everything `notifyUser` takes: the notification minus what the store stamps. */
export interface NotifyUserInput {
  /** The company it belongs to; the active one when left out. */
  orgId?: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  fromKind?: Notification['fromKind'];
  fromAgentId?: string;
  taskId?: string;
  cronJobId?: string;
  cronRunId?: string;
  sessionId?: string;
}

/** Who answers a task: the user, the assistant, or one agent (`agentId`). */
export interface TaskAnswerer {
  kind: 'user' | 'assistant' | 'agent';
  agentId?: string;
}

/** Emit a progress line roughly every this many characters of agent output. */
const PROGRESS_EVERY = 700;
/** How much of a result travels back into the caller's tool response. */
const RESULT_BUDGET = 24000;
/** How much of a result a task's note, a card line or a notification carries. */
const NOTE_RESULT_BUDGET = 4000;
/** The same for a failure notification, which also states the error. */
const NOTIFICATION_PARTIAL_BUDGET = 2000;
/** How much of one child's report a handed-off task's parent reads back. */
const CHILD_REPORT_BUDGET = 6000;
/** The port a watched mailbox gets when none is given: IMAP over TLS. */
const DEFAULT_IMAP_PORT = 993;

/**
 * How many providers one assignment may run on. The second only happens when
 * the first died on its usage limit before producing anything, so a switch
 * costs one provider process, never the assignment's place in the queue.
 */
const MAX_PROVIDER_ATTEMPTS = 2;

/**
 * How often a task run picks its own work back up because work it handed off
 * in the background came back (R4). Each round is a full run of the leaf, so
 * this is a ceiling on cost as much as on nesting; `org.maxTaskRuns` still
 * applies on top of it.
 */
const MAX_DELEGATION_ROUNDS = 2;

/** How many recent records a lookup by id prefix, or by project, looks through. */
const LOOKUP_SCAN_LIMIT = 500;
/** How many of the assistant's memories `forget` searches for an id prefix. */
const MEMORY_PREFIX_SCAN_LIMIT = 1000;
/** How much of a profile document one `read_profile` call returns unless asked otherwise. */
const PROFILE_EXCERPT_CHARS = 12000;
/** What fits an `ask_user` card on a phone. */
const MIN_QUESTION_OPTIONS = 2;
const MAX_QUESTION_OPTIONS = 4;
/** How many core-profile memories an agent's turn always carries. */
const AGENT_PROFILE_LIMIT = 3;
/** What `#learn` recalls to tell the extractor what the agent already knows. */
const KNOWN_MEMORIES_LIMIT = 20;
const KNOWN_MEMORIES_THRESHOLD = 0.05;

const NO_SUCH_RUN = 'No run with that id.';
const NO_PROJECT_MCP_SERVERS = "No MCP servers in this project's .mcp.json.";

/** How one leaf run of a task ended - what `#runTaskLeaf` hands back. */
interface LeafOutcome {
  status: Assignment['status'];
  result?: string;
  error?: string;
  assignmentId: string;
  /** The agent asked its requester something while running (decision E6). */
  askedRequester: boolean;
}

/** One assignment run in flight: its record, what ends it, and how to tell who asked for the end. */
interface RunState {
  input: RunAssignmentInput;
  project: Project | null;
  record: AssignmentRecord;
  abort: AbortController;
  onAbort: () => void;
  /** Whether the caller or a `cancel` by id asked for the end; the timeout is not a cancellation. */
  cancelled: () => boolean;
}

/** The servers of a project's `.mcp.json` that start for a run, and what the agent is told about the ones that do not. */
interface ProjectMcpSetup {
  specs: McpServerSpec[];
  hints: string[];
}

/** What every provider attempt of one assignment shares. */
interface SharedRunSetup {
  project: Project | null;
  cwd: string;
  preferred: ProviderId;
  projectMcp: ProjectMcpSetup;
  /** The system prompt as far as it does not depend on the provider attempt. */
  promptBase: Omit<AgentPromptInput, 'toolHints' | 'agentNotes' | 'handoverFrom'>;
}

interface RunSetup extends SharedRunSetup {
  /** The bridge token of the run, valid for every attempt. */
  token: string;
  started: number;
  firstProvider: ProviderId;
}

/** How the provider attempts of a run ended: the last attempt's result, and the provider it ran on. */
interface AttemptsOutcome {
  text: string;
  fatal: string | null;
  provider: ProviderId;
}

/** Everything `#develop` needs to file one personnel action for an agent whose stage rose. */
interface DevelopmentSubject {
  agent: Agent;
  orgId: string;
  provider: Provider;
  /** Effective reviews that are not technical failures, newest first. */
  reviews: AgentReview[];
  /** The latest of them, as the drafting prompts read them. */
  weak: WeakReview[];
}

type EndingStatus = 'done' | 'failed' | 'cancelled' | 'blocked';

/** Ends a task run's card through `setTaskStatus` and hands back the card as it stands. */
type TaskFinisher = (status: TaskStatus, patch: { result?: string; error?: string }) => Promise<Task>;

/** One request to move a task's card to another status; see `setTaskStatus`. */
export interface TaskStatusChange {
  task: Task;
  to: TaskStatus;
  /** Who is asking. The run loop passes `fromRun` instead. */
  by: RequesterKind;
  result?: string;
  error?: string;
  /**
   * The run loop writing its own outcome. It owns the task for the
   * duration of the run, so it is the one writer allowed to move a
   * `running` card - everybody else has to cancel it first.
   */
  fromRun?: boolean;
  emit?: (event: AgentEvent) => void;
}

type ProjectPatch = Parameters<OrgStore['updateProject']>[1];
type AgentPatch = Parameters<OrgStore['updateAgent']>[1];
type TeamPatch = Parameters<OrgStore['updateTeam']>[1];
type TaskPatch = Parameters<OrgStore['updateTask']>[1];
type ConfigPatch = Omit<Partial<RookeryConfig>, 'org'> & { org?: Partial<RookeryConfig['org']> };
type ScheduledJob = Parameters<typeof describeCronJob>[0];

/** What the schedule tools share: who calls, the clock, the arguments, and how a job is shown back. */
interface ScheduleCall {
  context: ToolContext;
  cron: CronScheduler;
  args: ToolArgs;
  describe: (job: ScheduledJob) => string;
}

/**
 * What a conversation is told when work it handed off in the background has
 * ended (docs/concepts/delegation-report-back-and-chat-terminal.md, R3). It
 * arrives as a turn of its own, marked as coming from the system, and the
 * assistant answers the user from it - which is what makes "I will let you
 * know" a promise the code keeps rather than one the model makes.
 */
export interface ReportBackEvent {
  sessionId: string;
  taskId: string;
  status: TaskStatus;
  notice: string;
}

/**
 * The notice for one ended task, in the words the assistant reads. `question`
 * is what the agent asked with `ask_requester`, for a task that is waiting.
 */
export function reportBackNotice(task: Task, agent: Agent | null, question?: string): string {
  const who = agent ? agent.name + ' (' + agent.slug + ')' : 'the agent';
  const ended = task.finishedAt ?? task.updatedAt;
  const took = task.startedAt && ended > task.startedAt ? ' after ' + formatAge(task.startedAt, ended, 'second') : '';
  const head = '[Rookery] Background task ' + shortId(task.id) + ' "' + task.title + '", handed to ' + who + ', ';
  const system =
    'This message comes from the system, not from your user - do not answer it as if they wrote it. ' +
    'You handed this work off earlier in this conversation; this is the follow-up you owe them.';
  switch (task.status) {
    case 'done':
      return (
        head + 'is done' + took + '.' + (task.error ? ' Note: ' + task.error : '') + '\n\n' +
        'Report:\n' + clip(task.result ?? '(no output)', RESULT_BUDGET) + '\n\n' + system + ' ' +
        'Tell the user what came of it now, in your own words: the outcome, and anything they need to decide or do. ' +
        'Keep it as short as the report allows.'
      );
    case 'blocked':
      return (
        head + 'stopped with a question and is waiting for an answer.\n\n' +
        (question ? 'The question:\n' + clip(question, RESULT_BUDGET) + '\n\n' : '') +
        (task.result ? 'What it said:\n' + clip(task.result, RESULT_BUDGET) + '\n\n' : '') + system + ' ' +
        'Put the question to the user. Once they answer, pass the answer on with answer_task("' +
        shortId(task.id) + '", ...) and the task picks up again, as the same task. Answer it yourself only ' +
        'if you know the answer for certain.'
      );
    case 'cancelled':
      return head + 'was cancelled' + took + '.\n\n' + system + ' Tell the user briefly, unless they cancelled it themselves just now.';
    default:
      return (
        head + 'failed' + took + ': ' + (task.error ?? 'no reason given').replace(/[.\s]+$/, '') + '.' +
        (task.result ? '\n\nWhat it had so far:\n' + clip(task.result, NOTE_RESULT_BUDGET) : '') + '\n\n' + system + ' ' +
        'Tell the user what went wrong and what you suggest - retrying, handing it to someone else, or dropping it.'
      );
  }
}

/**
 * What the user is told when one of their cards ends or waits on them - the
 * notification that replaced the status note mail. A task that is waiting
 * becomes a `question` in the agent's own name; every other ending is a
 * `task` notification from Rookery, carrying the result rather than a
 * pointer to it (the rule `statusNote` was written for).
 */
export function taskNotification(
  task: Task,
  agent: Agent | null,
  question?: string,
): Pick<NotifyUserInput, 'kind' | 'title' | 'body' | 'fromKind' | 'fromAgentId' | 'taskId'> {
  const name = '"' + task.title + '"';
  if (task.status === 'blocked') {
    return {
      kind: 'question',
      title: (agent ? agent.name : 'An agent') + ' has a question about ' + name,
      body: clip(question ?? task.result ?? 'The task is waiting for an answer.', NOTE_RESULT_BUDGET),
      fromKind: agent ? 'agent' : 'system',
      fromAgentId: agent?.id,
      taskId: task.id,
    };
  }
  const title =
    task.status === 'done'
      ? 'Task ' + name + ' is done'
      : task.status === 'cancelled'
        ? 'Task ' + name + ' was cancelled'
        : 'Task ' + name + ' failed';
  const body =
    task.status === 'done'
      ? clip(task.result?.trim() || '', NOTE_RESULT_BUDGET) + (task.error ? (task.result ? '\n\n' : '') + 'Note: ' + task.error : '')
      : task.status === 'cancelled'
        ? ''
        : (task.error ?? 'No reason given.') +
          (task.result ? '\n\nWhat it had so far:\n' + clip(task.result, NOTIFICATION_PARTIAL_BUDGET) : '');
  return { kind: 'task', title, body, fromKind: 'system', taskId: task.id };
}

/**
 * What one provider attempt produced so far: the report text, and the fatal
 * error that ended it, if one did.
 */
class AttemptOutput {
  text = '';
  fatal: string | null = null;
  #sinceProgress = 0;

  /** Take in a streamed delta; true when enough has come in since the last progress line. */
  append(delta: string): boolean {
    this.text += delta;
    this.#sinceProgress += delta.length;
    if (this.#sinceProgress < PROGRESS_EVERY) return false;
    this.#sinceProgress = 0;
    return true;
  }
}

/**
 * The row of one running assignment, kept honest: every change is written,
 * read back and announced in one step.
 */
class AssignmentRecord {
  #assignment: Assignment;
  readonly #org: OrgStore;
  readonly #agent: Agent;
  readonly #publish: (event: Extract<AgentEvent, { type: 'assignment' }>) => void;
  readonly #log: Logger;

  constructor(
    org: OrgStore,
    agent: Agent,
    assignment: Assignment,
    publish: (event: Extract<AgentEvent, { type: 'assignment' }>) => void,
    log: Logger,
  ) {
    this.#org = org;
    this.#agent = agent;
    this.#assignment = assignment;
    this.#publish = publish;
    this.#log = log;
  }

  get id(): string {
    return this.#assignment.id;
  }

  /** The row as last read back. */
  get assignment(): Assignment {
    return this.#assignment;
  }

  /** Say how the run stands, to the turn that started it and to everyone listening; `extra` carries live-only fields. */
  announce(extra: Partial<AssignmentView> = {}): void {
    this.#publish({ type: 'assignment', assignment: toView(this.#assignment, this.#agent, extra) });
  }

  finish(patch: Parameters<OrgStore['updateAssignment']>[1], extra: Partial<AssignmentView> = {}): Assignment {
    this.#org.updateAssignment(this.id, patch);
    this.#assignment = this.#org.getAssignment(this.id) ?? this.#assignment;
    this.announce(extra);
    return this.#assignment;
  }

  fail(error: string, started: number): Assignment {
    const failed = this.finish(
      { status: 'failed', error, finishedAt: Date.now(), durationMs: Date.now() - started },
      { error },
    );
    // Every fail() path is a hard signal (timeout, no provider, empty
    // output, a fatal provider error) - no model call, and it marks the run
    // as a technical failure rather than a quality judgement (see
    // docs/concepts/agent-performance-management.md). A write that cannot
    // land must never take the assignment result down with it.
    try {
      this.#org.upsertReview({
        orgId: failed.orgId,
        agentId: this.#agent.id,
        assignmentId: failed.id,
        source: 'system',
        overall: 1,
        failedRun: true,
      });
    } catch (reviewError) {
      this.#log.warn('System review failed to write', {
        assignment: failed.id,
        error: (reviewError as Error).message,
      });
    }
    return failed;
  }
}

export class OrgController extends EventEmitter {
  readonly #store: Store;
  readonly #registry: ProviderRegistry;
  readonly #config: RookeryConfig;
  readonly #bridge: BridgeServer;
  readonly #log: Logger;
  readonly #skills: SkillStore;
  readonly #cron: CronScheduler | undefined;
  readonly #sleep: SleepRunner | undefined;
  readonly #questions: QuestionRegistry | undefined;
  readonly #canNotify: (() => boolean) | undefined;
  /**
   * Runs whose agent called `ask_requester`, by assignment id. Read once when
   * the run ends (`onAskedRequester`) and dropped there; in memory because a
   * run that did not survive a restart has no ending left to decide.
   */
  readonly #askedRequester = new Set<string>();
  #running = 0;
  #waiting: (() => void)[] = [];
  /** Cancel hooks of assignments that are queued or running, by assignment id. */
  readonly #active = new Map<string, (by: string) => void>();
  /** Live logs of assignments that are queued or running, by assignment id. */
  readonly #logs = new Map<string, AssignmentLogBuffer>();
  /** Abort controllers of tasks being run from the board, by task id. */
  readonly #activeTasks = new Map<string, AbortController>();
  /**
   * Tasks somebody is blocked on right now - an `assign` or `run_task` with
   * the caller waiting for its return value. Their ending travels back as that
   * return value, so a report-back on top would say it twice. In memory on
   * purpose: after a restart nobody is waiting any more, and then every run
   * reports back on its own.
   */
  readonly #awaited = new Set<string>();
  /**
   * Work an agent handed off with `wait=false` from inside a task, by that
   * task's id. The task does not end while any of it is still out (R4): its
   * run waits, then picks its own work back up with the results.
   */
  readonly #detached = new Map<string, Map<string, Promise<Task>>>();

  constructor(options: OrgControllerOptions) {
    super();
    this.#store = options.store;
    this.#registry = options.registry;
    this.#config = options.config;
    this.#bridge = options.bridge;
    this.#log = options.logger ?? silentLogger;
    this.#skills = new SkillStore(options.config.skillsDir);
    this.#cron = options.cron;
    this.#sleep = options.sleep;
    this.#questions = options.questions;
    this.#canNotify = options.canNotify;
  }

  get bridge(): BridgeServer {
    return this.#bridge;
  }

  /** Assignments and tasks queued or running in this process. */
  get activeCount(): number {
    return this.#active.size + this.#activeTasks.size;
  }

  /* ------------------------------ structure ------------------------------ */

  /** The company the assistant runs. Created on first use so there is always one. */
  activeOrganization(): Organization {
    const wanted = this.#config.org.activeOrganizationId;
    if (wanted) {
      const chosen = this.#store.org.getOrganization(wanted);
      if (chosen) return chosen;
    }
    const existing = this.#store.org.listOrganizations()[0];
    if (existing) return existing;
    return this.#store.org.createOrganization({
      name: (this.#config.assistantName || 'Rookery') + ' & Co.',
      mission: 'The personal assistant company.',
    });
  }

  snapshot(orgId: string): OrgSnapshot {
    const organization = this.#store.org.getOrganization(orgId);
    if (!organization) throw new Error('Unknown organization ' + orgId);
    return {
      organization,
      teams: this.#store.org.listTeams(orgId),
      agents: this.#store.org.listAgents(orgId),
      projects: this.#store.org.listProjects(orgId),
      active: this.#store.org.listAssignments(orgId, { status: ['pending', 'running'], limit: 50 }),
    };
  }

  /**
   * Register a provider process with the bridge and hand back its token. The
   * tool list is cut to the caller twice over: by audience, and by whether
   * anybody is in front of a screen - a scheduled run is never even shown
   * `ask_user`.
   */
  register(context: ToolContext): string {
    // The handler closes over the context, so the token is stamped in rather
    // than passed: it is what `ask_user` files with a question and what the
    // runtime retires when the turn ends, on every exit.
    const token = this.#bridge.register(
      toolsFor(context.audience, { scheduled: context.scheduled, watching: context.watching }),
      this.handler(context),
    );
    context.questionOwner = token;
    return token;
  }

  unregister(token: string): void {
    this.#bridge.unregister(token);
  }

  handler(context: ToolContext): ToolHandler {
    return (name, args) => this.handle(context, name, args);
  }

  /* -------------------------------- tools -------------------------------- */

  async handle(context: ToolContext, name: string, rawArgs: Record<string, unknown>): Promise<ToolCallResult> {
    const args = new ToolArgs(rawArgs);
    switch (name) {
      case 'org_overview':
        return { text: renderOrgOverview(this.snapshot(context.orgId), this.#store.org) };
      case 'assign':
        return this.#toolAssign(context, args);
      case 'assignment_status':
        return this.#toolAssignmentStatus(context, args);
      case 'review_assignment':
        return this.#toolReviewAssignment(context, args);
      case 'agent_performance':
        return this.#toolAgentPerformance(context, args);
      case 'cancel_assignment':
        return this.#toolCancelAssignment(context, args);
      case 'list_assignments':
        return this.#toolListAssignments(context, args);
      case 'update_project':
        return this.#toolUpdateProject(context, args);
      case 'sleep_now':
        return this.#toolSleepNow(context);
      case 'read_profile':
        return this.#toolReadProfile(context, args);
      case 'search_profile':
        return this.#toolSearchProfile(context, args);
      case 'remember':
        return this.#toolRemember(context, args);
      case 'forget':
        return this.#toolForget(context, args);
      case 'search_memory':
        return this.#toolSearchMemory(context, args);
      case 'get_settings':
        if (context.audience !== 'assistant') return toolError('Only the assistant can read settings.');
        return { text: describeSettings(this.#config) };
      case 'update_settings':
        return this.#toolUpdateSettings(context, args);
      case 'ask_requester':
        return this.#toolAskRequester(context, args.text('question'));
      case 'answer_task':
        return this.#toolAnswerTask(context, args);
      case 'report_to_user':
        return this.#toolReportToUser(context, args);
      case 'task_activity':
        return this.#toolTaskActivity(context, args);
      case 'notify':
        return this.#toolNotify(context, args);
      case 'ask_user':
        return this.#toolAskUser(context, args);
      case 'use_skill':
        return this.#toolUseSkill(context, args);
      case 'find_skill':
        return { text: renderSkillHits(findExternalSkills(this.#config, callerKind(context), args.text('query'))) };
      case 'write_skill':
        return this.#toolWriteSkill(context, args);
      case 'project_mcp_servers':
        return this.#toolProjectMcpServers(context, args);
      case 'trust_project_mcp':
        return this.#toolTrustProjectMcp(context, args);
      case 'tool_servers':
        if (context.audience !== 'assistant') return toolError('Only the assistant sees the hub.');
        return { text: renderToolServers(toolServerStates(this.#config)) };
      case 'set_tool_server':
        return this.#toolSetToolServer(context, args);
      case 'hire_agent':
        return this.#toolHireAgent(context, args);
      case 'create_team':
        return this.#toolCreateTeam(context, args);
      case 'create_project':
        return this.#toolCreateProject(context, args);
      case 'update_agent':
        return this.#toolUpdateAgent(context, args);
      case 'update_team':
        return this.#toolUpdateTeam(context, args);
      case 'create_task':
        return this.#toolCreateTask(context, args);
      case 'list_tasks':
        return this.#toolListTasks(context, args);
      case 'update_task':
        return this.#toolUpdateTask(context, args);
      case 'plan_task':
        return this.#toolPlanTask(context, args);
      case 'run_task':
        return this.#toolRunTask(context, args);
      case 'list_schedules':
      case 'create_schedule':
      case 'update_schedule':
      case 'delete_schedule':
      case 'run_schedule':
      case 'set_webhook':
        return this.#toolSchedules(context, name, args);
      case 'list_listeners':
      case 'set_listener':
      case 'remove_listener':
        return this.#toolListeners(context, name, args);
      default:
        return toolError('Unknown tool ' + name + '.');
    }
  }

  #toolAssignmentStatus(context: ToolContext, args: ToolArgs): ToolCallResult {
    const assignment = this.findAssignment(context.orgId, args.text('id'));
    if (!assignment) return toolError(NO_SUCH_RUN);
    return {
      text: describeAssignment(
        assignment,
        this.#store.org.getAgent(assignment.agentId),
        this.#store.org.taskRunNumber(assignment.id),
      ),
    };
  }

  #toolReviewAssignment(context: ToolContext, args: ToolArgs): ToolCallResult {
    if (context.audience !== 'assistant') return toolError('Only the assistant records reviews.');
    const assignment = this.findAssignment(context.orgId, args.text('id'));
    if (!assignment) return toolError(NO_SUCH_RUN);
    const review = this.#store.org.upsertReview({
      orgId: context.orgId,
      agentId: assignment.agentId,
      assignmentId: assignment.id,
      taskId: this.#store.org.getTaskIdForAssignment(assignment.id) ?? undefined,
      source: 'assistant',
      overall: args.number('overall', 1, 5, 3),
      comment: args.text('comment') || undefined,
    });
    this.emit('changed', { kind: 'agent', id: assignment.agentId });
    return { text: 'Review recorded (overall ' + review.overall + ').' };
  }

  #toolAgentPerformance(context: ToolContext, args: ToolArgs): ToolCallResult {
    if (context.audience !== 'assistant') return toolError('Only the assistant sees the personnel record.');
    const agent = this.#store.org.findAgent(context.orgId, args.text('agent'));
    if (!agent) return toolError(noAgent(args.text('agent')));
    return { text: describeAgentPerformance(agent, this.#store.org) };
  }

  #toolCancelAssignment(context: ToolContext, args: ToolArgs): ToolCallResult {
    if (context.audience !== 'assistant') return toolError('Only the assistant can call off a running task.');
    const assignment = this.findAssignment(context.orgId, args.text('id'));
    if (!assignment) return toolError(NO_SUCH_RUN);
    if (!this.cancel(assignment.id, 'the assistant')) {
      return toolError('Run ' + shortId(assignment.id) + ' is not running; it is ' + assignment.status + '.');
    }
    return { text: 'Calling off run ' + shortId(assignment.id) + '. It ends as cancelled within a moment.' };
  }

  #toolListAssignments(context: ToolContext, args: ToolArgs): ToolCallResult {
    if (context.audience !== 'assistant') return toolError('Only the assistant can read the history.');
    const org = this.#store.org;
    const agent = resolveOptional(args.text('agent'), (ref) => org.findAgent(context.orgId, ref), noAgent);
    if (!agent.ok) return agent.error;
    const project = resolveOptional(args.text('project'), (ref) => org.findProject(context.orgId, ref), noProject);
    if (!project.ok) return project.error;
    const wanted = args.list('status') as AssignmentStatus[];
    const limit = args.number('limit', 1, 200, 20);
    // The store cannot filter by project, so a project filter scans further
    // back and cuts afterwards.
    const rows = org
      .listAssignments(context.orgId, {
        agentId: agent.value?.id,
        status: wanted.length ? wanted : undefined,
        limit: project.value ? LOOKUP_SCAN_LIMIT : limit,
      })
      .filter((entry) => !project.value || entry.projectId === project.value.id)
      .slice(0, limit);
    if (!rows.length) return { text: 'No runs match.' };
    const slugs = new Map(org.listAgents(context.orgId, { includeArchived: true }).map((entry) => [entry.id, entry.slug]));
    return { text: rows.map((entry) => this.#assignmentListLine(entry, slugs.get(entry.agentId) ?? '?')).join('\n') };
  }

  #assignmentListLine(entry: Assignment, agentSlug: string): string {
    // Local wall clock, and for anything still going the elapsed
    // span as well: "has this run too long" is the question the
    // board watcher asks, and a span cannot be read in the wrong
    // timezone the way a stamp can.
    const took = entry.durationMs
      ? ' ' + toSeconds(entry.durationMs) + 's'
      : entry.status === 'running'
        ? ' running ' + formatAge(entry.createdAt)
        : '';
    // The name, never the brief: three runs of the same errand open
    // with the same twenty words, and a list of those tells nobody
    // which is which (concept 7.1).
    const run = this.#store.org.taskRunNumber(entry.id);
    return '- ' + shortId(entry.id) + ' ' + formatWhen(entry.createdAt) + ' ' + entry.status + took + ' ' + agentSlug + ': ' +
      shorten(entry.title, 100) + (run && run > 1 ? ' (run ' + run + ')' : '') +
      (entry.error ? ' [' + shorten(entry.error, 60) + ']' : '');
  }

  #toolUpdateProject(context: ToolContext, args: ToolArgs): ToolCallResult {
    if (context.audience !== 'assistant') return toolError('Only the assistant can change projects.');
    const project = this.#store.org.findProject(context.orgId, args.text('project'));
    if (!project) return toolError(noProject(args.text('project')));
    const patch: ProjectPatch = {};
    if (args.text('name')) patch.name = args.text('name');
    if (args.text('description')) patch.description = args.text('description');
    const path = args.text('path');
    if (path) {
      if (path.toLowerCase() === 'none') patch.path = null;
      else if (!existsSync(path)) return toolError('The directory ' + path + ' does not exist.');
      else patch.path = path;
    }
    const archived = args.flag('archived');
    if (archived !== undefined) patch.archived = archived;
    if (!Object.keys(patch).length) return toolError('Nothing to change.');
    this.#store.org.updateProject(project.id, patch);
    this.emit('changed', { kind: 'project', id: project.id });
    return { text: 'Updated project "' + (patch.name ?? project.name) + '": ' + Object.keys(patch).join(', ') + '.' };
  }

  #toolSleepNow(context: ToolContext): ToolCallResult {
    if (context.audience !== 'assistant') return toolError('Only the assistant has this memory.');
    if (!this.#sleep) return toolError('The nightly memory run is not available here.');
    if (this.#sleep.isRunning(ASSISTANT_MEMORY_OWNER)) return { text: 'The memory is already asleep.' };
    // Started, not awaited: a night takes minutes and the turn must not
    // sit and wait for it. The memory page follows it live.
    void this.#sleep.run({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'manual' });
    return {
      text:
        'The memory is going to sleep now. It condenses, files and connects; nothing is deleted, ' +
        'and the run can be undone on the memory page.',
    };
  }

  #toolReadProfile(context: ToolContext, args: ToolArgs): ToolCallResult {
    if (context.audience !== 'assistant') return toolError('Only the assistant has this profile.');
    const offset = args.has('offset') ? Number(args.raw('offset')) : 0;
    const limit = args.has('limit') ? Number(args.raw('limit')) : PROFILE_EXCERPT_CHARS;
    return { text: readProfileExcerpt(this.#config, args.text('name'), offset, limit) };
  }

  #toolSearchProfile(context: ToolContext, args: ToolArgs): ToolCallResult {
    if (context.audience !== 'assistant') return toolError('Only the assistant has this profile.');
    return { text: searchProfile(this.#config, args.text('query')) };
  }

  #toolRemember(context: ToolContext, args: ToolArgs): ToolCallResult {
    // The assistant keeps facts about the user; an agent keeps facts
    // about its own work. Either way the write lands in the caller's own
    // bank and nowhere else - there is no path here that writes across
    // the owner boundary.
    const owner = memoryOwnerOf(context);
    // Same rule as write_skill below: a scheduled run has nobody present
    // to confirm anything, and a memory it pinned would even carry
    // origin 'user' - protected from the very night that should weigh it.
    if (context.scheduled) {
      return toolError(
        'This run was started by a schedule. Automated runs leave no memories - if this ' +
          'belongs in memory, bring it up in a conversation.',
      );
    }
    if (!args.text('content')) return toolError('A memory needs content.');
    const tags = args.list('tags');
    const record = this.#store.upsertMemory({
      kind: asMemoryKind(args.text('kind')),
      content: args.text('content'),
      tags,
      importance: args.number('importance', 0, 1, 0.7),
      owner,
      sourceSessionId: context.sessionId,
      // Asked for explicitly, so the night never merges it away.
      origin: 'user',
    });
    linkEntities(this.#store, owner, record.id, tags);
    this.emit('changed', { kind: 'memory', id: record.id });
    return { text: 'Remembered (' + shortId(record.id) + '): ' + record.content };
  }

  #toolForget(context: ToolContext, args: ToolArgs): ToolCallResult {
    if (context.audience !== 'assistant') return toolError('Only the assistant has this memory.');
    // Forgetting is a deletion, and E1 of the memory concept says a
    // deletion happens only on the user's explicit word - a schedule has
    // nobody behind it to give that word.
    if (context.scheduled) {
      return toolError(
        'This run was started by a schedule. Nothing is forgotten on an automated run - ask ' +
          'in a conversation instead.',
      );
    }
    const ref = args.text('id');
    if (!ref) return toolError('Which memory? Give its id.');
    const record =
      this.#store.getMemory(ref) ??
      this.#store
        .listMemories({ owner: ASSISTANT_MEMORY_OWNER, limit: MEMORY_PREFIX_SCAN_LIMIT })
        .find((memory) => memory.id.startsWith(ref));
    if (!record || record.owner !== ASSISTANT_MEMORY_OWNER) return toolError('No memory ' + ref + '.');
    this.#store.forgetMemory(record.id);
    this.emit('changed', { kind: 'memory', id: record.id });
    return { text: 'Forgotten: ' + record.content };
  }

  #toolSearchMemory(context: ToolContext, args: ToolArgs): ToolCallResult {
    // Read-only, and strictly inside the caller's own bank: the
    // assistant searches what it knows about the user, an agent searches
    // its own working memory. One owner in, one owner out.
    const owner = memoryOwnerOf(context);
    const limit = args.number('limit', 1, 100, 20);
    const query = args.text('query');
    const rows = query
      ? recall(this.#store, { text: query, limit, owner, touch: false })
      : this.#store.listMemories({ owner, limit });
    if (!rows.length) return { text: query ? 'Nothing in memory matches.' : 'Memory is empty.' };
    return {
      text: rows
        .map((memory) => '- ' + shortId(memory.id) + ' [' + memory.kind + ', ' + memory.importance.toFixed(2) + '] ' + memory.content)
        .join('\n'),
    };
  }

  async #toolAnswerTask(context: ToolContext, args: ToolArgs): Promise<ToolCallResult> {
    const task = this.findTask(context.orgId, args.text('id'));
    if (!task) return toolError('No task ' + args.text('id') + '.');
    const answerer: TaskAnswerer =
      context.audience === 'agent' ? { kind: 'agent', agentId: context.agentId } : { kind: 'assistant' };
    const answered = await this.#answer(task, args.text('answer'), answerer, context);
    if (!answered.ok) return toolError(answered.reason);
    const where = context.taskId && task.parentId === context.taskId
      ? 'Your own task stays open until it is back: when your run ends, you are started again with its result.'
      : task.requesterSessionId && !task.parentId
        ? 'When it ends, a message arrives in the conversation it came from.'
        : 'How it ends is recorded on its card.';
    return {
      text: 'Answered task ' + shortId(task.id) + ' "' + task.title + '"; it runs again with your answer. ' + where,
    };
  }

  #toolReportToUser(context: ToolContext, args: ToolArgs): ToolCallResult {
    // Agents, and the one assistant run that has no conversation to speak
    // in: the board watcher. An ordinary assistant turn answers the user
    // directly, and `notify` is its line for what cannot wait.
    if (context.audience !== 'agent' && !context.watching) {
      return toolError('Reach the user through your answer, or with notify for something that has to arrive now.');
    }
    if (!args.text('title') || !args.text('body')) return toolError('A report needs a title and a body.');
    const isAgent = context.audience === 'agent';
    const notification = this.notifyUser({
      orgId: context.orgId,
      kind: context.watching ? 'watch' : 'agent',
      title: args.text('title'),
      body: args.text('body'),
      fromKind: callerKind(context),
      fromAgentId: isAgent ? context.agentId : undefined,
      taskId: context.taskId,
      // The watcher's own run is where a reply to its report continues;
      // an agent's run has no conversation of its own to point at.
      sessionId: context.watching ? context.sessionId : undefined,
    });
    if (context.taskId && this.#store.org.getTask(context.taskId)) {
      this.#taskEvent({
        taskId: context.taskId,
        kind: 'note',
        actorKind: callerKind(context),
        actorAgentId: context.agentId,
        text: 'Reported to the user: ' + notification.title + '\n\n' + notification.body,
        assignmentId: context.parentAssignmentId,
      });
    }
    return { text: 'Left the user a notification: "' + notification.title + '".' };
  }

  #toolTaskActivity(context: ToolContext, args: ToolArgs): ToolCallResult {
    const task = this.findTask(context.orgId, args.text('id'));
    if (!task) return toolError('No task ' + args.text('id') + '.');
    return {
      text: clip(
        renderTaskActivity(task, this.#store.org.listTaskEvents(task.id), this.snapshot(context.orgId)),
        RESULT_BUDGET,
      ),
    };
  }

  #toolNotify(context: ToolContext, args: ToolArgs): ToolCallResult {
    if (context.audience !== 'assistant') return toolError('Only the assistant can send notifications.');
    const text = args.text('text');
    if (!text) return toolError('A notification needs text.');
    const urgency = args.raw('urgency') === 'high' ? 'high' : 'normal';
    // Kept as well as pushed: a push is gone once it is swiped away, and
    // the web should be able to show what the assistant said on its own.
    // The push itself still travels on the `notify` event - the
    // notification is the record, so a channel must not push it twice.
    this.notifyUser({
      orgId: context.orgId,
      kind: 'system',
      title: shorten(text.split('\n', 1)[0] ?? '', 80),
      body: text,
      fromKind: 'assistant',
      sessionId: context.sessionId,
    });
    if (!this.#canNotify || !this.#canNotify()) {
      return {
        text:
          'No push channel can reach the user right now - none is set up, it is switched off, or it has ' +
          'no recipient. The message is saved in their notifications and waits there.',
      };
    }
    const event: NotifyEvent = { text, urgency, at: Date.now() };
    this.emit('notify', event);
    return { text: 'Sent' + (urgency === 'high' ? ' (high urgency)' : '') + ': ' + event.text };
  }

  async #toolAskUser(context: ToolContext, args: ToolArgs): Promise<ToolCallResult> {
    // Only the assistant asks. An agent runs unattended by design and
    // asks whoever gave it the work (`ask_requester`); letting one block
    // on a person would stall a whole delegation chain behind them.
    if (context.audience !== 'assistant') {
      return toolError(
        'Only the assistant can ask the user. Inside a task, ask whoever gave you the work with ' +
          'ask_requester; otherwise say what you need in your result.',
      );
    }
    // Belt and braces: a scheduled run is not offered the tool at all
    // (see `register`), so getting here means the list was built for a
    // conversation and the run turned out to be automated.
    if (context.scheduled) {
      return toolError(
        'This run was started by a schedule and nobody is there to answer. Decide it yourself ' +
          'and say in your result what you assumed.',
      );
    }
    if (!this.#questions) return toolError('Asking the user is not available here.');
    const question = args.text('question');
    if (!question) return toolError('A question needs its text.');
    const options = asQuestionOptions(args.raw('options'));
    if (options.length < MIN_QUESTION_OPTIONS) return toolError('Offer at least two options to choose from.');
    if (options.length > MAX_QUESTION_OPTIONS) return toolError('Offer at most four options; more does not fit a phone.');

    const timeoutMs = this.#config.questions.timeoutMs;
    // The close event carries why it closed, and the turn wants to know:
    // "nobody was there" and "somebody waved it away" are different
    // things to carry on from.
    let closedBecause: QuestionCloseReason | undefined;
    const emit = (event: AgentEvent): void => {
      if (event.type === 'question-closed') closedBecause = event.reason;
      context.emit(event);
    };
    const answer = await this.#questions.ask(
      {
        header: args.text('header') || 'Question',
        question,
        options,
        multiSelect: args.raw('multiSelect') === true,
        sessionId: context.sessionId,
      },
      // `emit` puts the card on the asking turn's own stream; `signal` is
      // the half no other tool handler has: an aborted turn kills the
      // provider process, and without this the question would stay open
      // for its full timeout with nobody left to receive the answer.
      // `owner` widens that to every way a turn can end.
      { signal: context.signal, timeoutMs, emit, ...(context.questionOwner ? { owner: context.questionOwner } : {}) },
    );

    if (!answer) {
      const cancelled = closedBecause === 'cancelled' || context.signal?.aborted;
      return { text: cancelled ? 'The question was cancelled before anybody answered it.' : noAnswerText(timeoutMs) };
    }
    return { text: answerText(answer, options) };
  }

  #toolUseSkill(context: ToolContext, args: ToolArgs): ToolCallResult {
    // An agent's own instructions carry its project's skills too (Befund
    // 4 in the concept doc): the tool must resolve against the running
    // assignment's project, not only the one long-lived home store.
    const isAgent = context.audience === 'agent';
    const project = isAgent && context.projectId ? this.#store.org.getProject(context.projectId) : null;
    const skills = isAgent ? this.#agentSkills(project) : this.#skills.for('assistant');
    const name = args.text('name');
    // Rookery's own shelf first, then the one installed in Claude Code -
    // a skill a person wrote here outranks a plugin's.
    const skill =
      skills.find((entry) => entry.name === name.toLowerCase()) ?? openExternalSkill(this.#config, callerKind(context), name);
    if (!skill) {
      return toolError(
        'No skill "' + name + '". The list in your instructions is authoritative for ' +
          "Rookery's own skills; for the ones installed on this machine, search with find_skill first.",
      );
    }
    // Noted, not just answered. Which run had a skill open is the only
    // way the night can later tell a procedure that still holds from one
    // that is quietly sending every run that follows it into a wall.
    this.#store.recordSkillUse({
      skill: skill.name,
      owner: memoryOwnerOf(context),
      assignmentId: isAgent ? context.parentAssignmentId : undefined,
      sessionId: context.sessionId,
    });
    return { text: renderSkill(skill) };
  }

  #toolWriteSkill(context: ToolContext, args: ToolArgs): ToolCallResult {
    // A scheduled run has a person's trust but not a person present:
    // what it writes down would echo its own job prompt, and nothing
    // standing behind it would ever be read by anyone. It says so and
    // carries on without the skill.
    if (context.scheduled) {
      return toolError(
        'This run was started by a schedule. Automated runs leave no memories and write no ' +
          'skills - if this procedure matters, ask for it in a conversation or write it yourself.',
      );
    }
    // Always the home store, never the project one: a skill written in
    // the middle of an assignment must not land in somebody's repository.
    const audience = asServerAudience(args.raw('audience')) ?? 'both';
    try {
      // Keep the previous wording before replacing it. Revising a skill
      // is the point of this tool, and a revision that turns out worse
      // than what it replaced has to leave a way back.
      const name = skillSlug(args.text('name'));
      this.#store.snapshotSkill({ skill: name, content: this.#skills.raw(name) });
      const skill = this.#skills.save({
        name: args.text('name'),
        description: args.text('description'),
        body: args.text('body'),
        audience,
        origin: 'agent',
      });
      this.emit('changed', { kind: 'skill', id: skill.name });
      return {
        text:
          'Skill "' + skill.name + '" written to ' + skill.path + '. It is in the index from ' +
          'the next turn on; open it with use_skill.',
      };
    } catch (cause) {
      return toolError((cause as Error).message);
    }
  }

  #toolProjectMcpServers(context: ToolContext, args: ToolArgs): ToolCallResult {
    if (context.audience !== 'assistant') return toolError('Only the assistant reviews project MCP servers.');
    const project = this.#store.org.findProject(context.orgId, args.text('project'));
    if (!project) return toolError(noProject(args.text('project')));
    if (!project.path) return toolError('Project "' + project.name + '" has no directory.');
    const file = readProjectMcpFile(project.path);
    if (!file || !file.servers.length) return { text: NO_PROJECT_MCP_SERVERS };
    const status = projectMcpStatus(file, project.mcpTrust);
    return {
      text:
        'Status: ' + status + '.\n' +
        renderProjectMcpServers(file.servers) +
        (status === 'trusted' ? '' : '\nUse trust_project_mcp to approve before these start for a run.'),
    };
  }

  #toolTrustProjectMcp(context: ToolContext, args: ToolArgs): ToolCallResult {
    if (context.audience !== 'assistant') return toolError('Only the assistant decides project trust.');
    const project = this.#store.org.findProject(context.orgId, args.text('project'));
    if (!project) return toolError(noProject(args.text('project')));
    const decision = args.text('decision');
    if (decision !== 'approve' && decision !== 'revoke') return toolError('decision must be approve or revoke.');
    if (decision === 'revoke') {
      this.#store.org.updateProject(project.id, { mcpTrust: null });
      this.emit('changed', { kind: 'project', id: project.id });
      return { text: 'Revoked trust for "' + project.name + '"; its MCP servers no longer start for its runs.' };
    }
    if (!project.path) return toolError('Project "' + project.name + '" has no directory.');
    const file = readProjectMcpFile(project.path);
    if (!file || !file.servers.length) return toolError(NO_PROJECT_MCP_SERVERS);
    this.#store.org.updateProject(project.id, {
      mcpTrust: { fingerprint: fingerprintMcpFile(file.raw), approvedAt: Date.now() },
    });
    this.emit('changed', { kind: 'project', id: project.id });
    return {
      text:
        'Trusted "' + project.name + '": ' + file.servers.length +
        ' MCP server(s) start for its runs from now on.',
    };
  }

  #toolSetToolServer(context: ToolContext, args: ToolArgs): ToolCallResult {
    if (context.audience !== 'assistant') return toolError('Only the assistant can switch tools.');
    const state = toolServerStates(this.#config).find((entry) => entry.id === args.text('id'));
    if (!state) return toolError('No tool server "' + args.text('id') + '".');
    const enabled = args.flag('enabled');
    if (enabled === undefined) return toolError('enabled must be true or false.');
    // A server read out of Claude Code belongs to somebody else's
    // installation. Starting it is the user's call, made on the Tools page.
    if (state.approvalRequired) {
      return toolError(
        state.name + ' comes from ' + (state.source || 'another installation') + ' and only the user can ' +
          'switch it on, on the Tools page. Say that you need it and why.',
      );
    }
    if (enabled && !state.installed) return toolError(state.name + ' is not installed on this machine.');
    if (enabled && state.missingEnv.length) {
      return toolError(state.name + ' needs ' + state.missingEnv.join(', ') + ' first; the user sets that on the Tools page.');
    }
    const audienceText = args.text('audience');
    const audience = asServerAudience(audienceText);
    applyConfig(
      this.#config,
      withToolServer(this.#config, state.id, { enabled, ...(audience ? { audience } : {}) }),
    );
    this.emit('changed', { kind: 'tools', id: state.id });
    return {
      text: state.name + ' is now ' + (enabled ? 'on' : 'off') + ' for ' + (audienceText || state.audience) + '. ' +
        (enabled
          ? 'Finish this answer and it is attached; the turn then carries on and you can use it.'
          : 'It is gone from the next turn on.'),
    };
  }

  async #toolHireAgent(context: ToolContext, args: ToolArgs): Promise<ToolCallResult> {
    if (context.audience !== 'assistant') return toolError('Only the assistant can hire.');
    const org = this.#store.org;
    const replaces = resolveOptional(
      args.text('replaces'),
      (ref) => org.findAgent(context.orgId, ref),
      (ref) => 'No agent "' + ref + '" to replace.',
    );
    if (!replaces.ok) return replaces.error;
    // Stage 4 (docs/concepts/agent-performance-management.md, section
    // 4): archiving, the handover and the hire happen together in
    // #replaceAgent, never as three separate steps a half-finished
    // call could leave inconsistent.
    if (replaces.value) return this.#replaceAgentViaTool(context, replaces.value, args);

    const team = resolveOptional(
      args.text('team'),
      (ref) => org.findTeam(context.orgId, ref),
      (ref) => 'No team "' + ref + '". Create it first.',
    );
    if (!team.ok) return team.error;
    const manager = resolveOptional(
      args.text('manager'),
      (ref) => org.findAgent(context.orgId, ref),
      (ref) => 'No agent "' + ref + '" to report to.',
    );
    if (!manager.ok) return manager.error;
    const agent = org.createAgent({
      orgId: context.orgId,
      slug: args.text('slug') || undefined,
      name: args.text('name'),
      title: args.text('title'),
      instructions: args.text('instructions'),
      voice: args.text('voice') || undefined,
      teamId: team.value?.id,
      managerId: manager.value?.id,
      provider: this.#asProvider(args.text('provider')),
      model: args.text('model') || undefined,
      permission: asPermission(args.text('permission')),
    });
    this.emit('changed', { kind: 'agent', id: agent.id });
    return { text: 'Hired ' + agent.name + ' as ' + agent.title + ' (slug: ' + agent.slug + ').' };
  }

  async #replaceAgentViaTool(context: ToolContext, replaces: Agent, args: ToolArgs): Promise<ToolCallResult> {
    if (!args.text('name') || !args.text('title') || !args.text('instructions')) {
      return toolError('Replacing an agent still needs a name, a title and instructions for the successor.');
    }
    if (args.text('name').toLowerCase() === replaces.name.trim().toLowerCase()) {
      return toolError('The successor needs a different name from ' + replaces.name + " - decision E4: a new identity, not a reused one.");
    }
    const successor = await this.replaceAgent(
      context.orgId,
      replaces.id,
      {
        name: args.text('name'),
        slug: args.text('slug') || undefined,
        title: args.text('title'),
        instructions: args.text('instructions'),
        voice: args.text('voice') || undefined,
        handover: args.text('handover') || undefined,
      },
      this.#asProvider(args.text('provider')) ?? replaces.provider,
    );
    return {
      text:
        'Archived ' + replaces.name + ' (' + replaces.slug + ') and hired ' + successor.name + ' as ' +
        successor.title + ' (slug: ' + successor.slug + ') in their place.',
    };
  }

  #toolCreateTeam(context: ToolContext, args: ToolArgs): ToolCallResult {
    if (context.audience !== 'assistant') return toolError('Only the assistant can create teams.');
    const lead = resolveOptional(
      args.text('lead'),
      (ref) => this.#store.org.findAgent(context.orgId, ref),
      (ref) => 'No agent "' + ref + '" to lead the team.',
    );
    if (!lead.ok) return lead.error;
    const team = this.#store.org.createTeam({
      orgId: context.orgId,
      name: args.text('name'),
      purpose: args.text('purpose') || undefined,
      leadId: lead.value?.id,
    });
    this.emit('changed', { kind: 'team', id: team.id });
    return { text: 'Created team "' + team.name + '" (id: ' + team.id + ').' };
  }

  #toolCreateProject(context: ToolContext, args: ToolArgs): ToolCallResult {
    if (context.audience !== 'assistant') return toolError('Only the assistant can create projects.');
    const path = args.text('path') || undefined;
    if (path && !existsSync(path)) return toolError('The directory ' + path + ' does not exist.');
    const project = this.#store.org.createProject({
      orgId: context.orgId,
      name: args.text('name'),
      description: args.text('description') || undefined,
      path,
    });
    this.emit('changed', { kind: 'project', id: project.id });
    return { text: 'Created project "' + project.name + '" (id: ' + project.id + ').' };
  }

  #toolCreateTask(context: ToolContext, args: ToolArgs): ToolCallResult {
    if (!args.text('title') || !args.text('description')) return toolError('A task needs a title and a description.');
    const project = resolveOptional(args.text('project'), (ref) => this.#store.org.findProject(context.orgId, ref), noProject);
    if (!project.ok) return project.error;
    const assignee = resolveOptional(args.text('assignee'), (ref) => this.#store.org.findAgent(context.orgId, ref), noAgent);
    if (!assignee.ok) return assignee.error;
    const task = this.#store.org.createTask({
      orgId: context.orgId,
      title: args.text('title'),
      description: args.text('description'),
      projectId: project.value?.id ?? context.projectId,
      priority: asPriority(args.text('priority')),
      assigneeId: assignee.value?.id,
      createdBy: callerKind(context),
      createdByAgentId: context.agentId,
      // Whenever it runs, the conversation that asked for it hears how it
      // ended. Inside a task there is a parent to report to instead.
      requesterSessionId: context.taskId ? undefined : context.sessionId,
    });
    // The card opens its own activity with the brief (`createTask`), so
    // there is nothing more to write before anybody presses start.
    this.#announceTask(task, context.emit);
    return { text: 'Task ' + shortId(task.id) + ' "' + task.title + '" is on the board.' };
  }

  #toolListTasks(context: ToolContext, args: ToolArgs): ToolCallResult {
    const wanted = args.list('status') as TaskStatus[];
    // Without a filter this is the board, and the board is its top row.
    // With one it is a search, and delegated work sits under a parent
    // (decision E9) - a blocked subtask under a finished parent is
    // exactly what the board watcher is woken for.
    const tasks = this.#store.org.listTasks(
      context.orgId,
      wanted.length ? { status: wanted, anyLevel: true } : {},
    );
    return { text: renderBoard(tasks, this.snapshot(context.orgId), this.#store.org) };
  }

  async #toolPlanTask(context: ToolContext, args: ToolArgs): Promise<ToolCallResult> {
    const task = this.findTask(context.orgId, args.text('id'));
    if (!task) return toolError('No task ' + args.text('id') + '.');
    const plan = await this.planTask(context, task, args.text('hint') || undefined);
    return { text: describePlan(plan, this.#store.org.listTasks(context.orgId, { parentId: task.id })) };
  }

  async #toolRunTask(context: ToolContext, args: ToolArgs): Promise<ToolCallResult> {
    const task = this.findTask(context.orgId, args.text('id'));
    if (!task) return toolError('No task ' + args.text('id') + '.');
    const finished = await this.#runAwaited(context, task);
    if (finished.status === 'blocked') return { text: this.#waitingText(finished) };
    if (finished.status !== 'done') {
      return toolError('Task "' + finished.title + '" ' + finished.status + (finished.error ? ': ' + finished.error : '.'));
    }
    return { text: 'Task "' + finished.title + '" is done.\n\n' + clip(finished.result ?? '', RESULT_BUDGET) };
  }

  /* ------------------------------- schedules ------------------------------ */

  #toolSchedules(context: ToolContext, name: string, args: ToolArgs): ToolCallResult {
    const cron = this.#cron;
    if (!cron) return toolError('Schedules are not available in this session.');
    const snapshot = this.snapshot(context.orgId);
    if (name === 'list_schedules') return { text: renderSchedules(cron.list(context.orgId), snapshot) };

    const bySlug = new Map(snapshot.agents.map((agent) => [agent.id, agent.slug]));
    const call: ScheduleCall = {
      context,
      cron,
      args,
      describe: (job) => describeCronJob(job, job.agentId ? bySlug.get(job.agentId) : undefined),
    };
    if (name === 'create_schedule') return this.#createSchedule(call);

    const job = cron.find(context.orgId, args.text('id'));
    if (!job) return toolError('No schedule "' + args.text('id') + '". list_schedules shows the ids.');
    // The nightly memory run is Rookery's internal clockwork: it is not on
    // the list, and it is not the assistant's to delete, fire or reschedule.
    // The memory page owns it.
    if (job.kind === 'sleep') {
      return toolError('"' + job.name + '" is the memory\'s own nightly run, not a schedule of yours. It is managed on the memory page.');
    }

    switch (name) {
      case 'set_webhook':
        return this.#setWebhook(call, job);
      case 'delete_schedule':
        cron.remove(job.id);
        return { text: 'Deleted schedule "' + job.name + '".' };
      case 'run_schedule':
        return this.#runScheduleNow(cron, job);
      default:
        return this.#updateSchedule(call, job);
    }
  }

  #createSchedule({ context, cron, args, describe }: ScheduleCall): ToolCallResult {
    const triggerMode = triggerModeArg(args);
    if (!args.text('name') || !args.text('prompt')) return toolError('A schedule needs a name and a prompt.');
    if (!args.text('schedule') && triggerMode !== 'event') {
      return toolError('A schedule needs a cron expression, or triggerMode "event" to take it off the clock.');
    }
    const agent = resolveOptional(args.text('agent'), (ref) => this.#store.org.findAgent(context.orgId, ref), noAgent);
    if (!agent.ok) return agent.error;
    const project = resolveOptional(args.text('project'), (ref) => this.#store.org.findProject(context.orgId, ref), noProject);
    if (!project.ok) return project.error;
    // A one-off follow-up ("I'll get back to you here") should land back
    // in the conversation it was promised in, not in a brand-new one.
    // Only for the assistant's own runs - a recurring job, or one handed
    // to an agent, keeps creating its own dedicated conversation.
    const once = args.flag('once');
    const replyHere = !agent.value && once === true ? context.sessionId : undefined;
    try {
      const job = cron.create({
        orgId: context.orgId,
        name: args.text('name'),
        schedule: args.text('schedule'),
        triggerMode,
        eventCooldownMs: cooldownMsArg(args),
        prompt: args.text('prompt'),
        kind: agent.value ? 'agent' : 'assistant',
        agentId: agent.value?.id,
        projectId: project.value?.id ?? context.projectId,
        sessionId: replyHere,
        once,
        enabled: args.flag('enabled'),
        createdBy: 'assistant',
      });
      const when = job.schedule ? describeCron(job.schedule) : 'on events only, no timetable';
      return { text: 'Schedule created: ' + when + '.\n' + describe(job) };
    } catch (error) {
      return toolError((error as Error).message);
    }
  }

  #setWebhook({ cron, args }: ScheduleCall, job: ScheduledJob): ToolCallResult {
    if (args.text('action').toLowerCase() === 'remove') {
      cron.disableWebhook(job.id);
      return { text: 'The webhook for "' + job.name + '" is gone; the URL opens nothing now.' };
    }
    const rotated = Boolean(job.webhookToken);
    const updated = cron.enableWebhook(job.id);
    const url = 'http://' + this.#config.host + ':' + this.#config.port + '/hooks/' + updated.webhookToken;
    return {
      text:
        (rotated ? 'Rotated the webhook for "' : 'Webhook for "') + job.name +
        '": ' + url + '\n' +
        (rotated ? 'The previous URL stopped working just now. ' : '') +
        'Anything that can send an HTTP POST to it starts this schedule.',
    };
  }

  #runScheduleNow(cron: CronScheduler, job: ScheduledJob): ToolCallResult {
    if (cron.isRunning(job.id)) return { text: 'Schedule "' + job.name + '" is already running.' };
    void cron.runNow(job.id).catch((error: Error) => this.#log.warn('Manual schedule run failed', { error: error.message }));
    return { text: 'Schedule "' + job.name + '" is running now; the result reaches the user as a notification.' };
  }

  #updateSchedule(call: ScheduleCall, job: ScheduledJob): ToolCallResult {
    const patch = this.#schedulePatch(call);
    if (!patch.ok) return patch.error;
    if (!Object.keys(patch.value).length) return toolError('Nothing to change; pass at least one field.');
    try {
      const updated = call.cron.update(job.id, patch.value);
      return {
        text: 'Updated schedule "' + updated.name + '": ' + Object.keys(patch.value).join(', ') + '.\n' + call.describe(updated),
      };
    } catch (error) {
      return toolError((error as Error).message);
    }
  }

  #schedulePatch({ context, args }: ScheduleCall): Resolved<CronJobPatch> {
    const orgId = context.orgId;
    const patch: CronJobPatch = {};
    if (args.text('name')) patch.name = args.text('name');
    if (args.text('schedule')) patch.schedule = args.text('schedule');
    if (args.text('prompt')) patch.prompt = args.text('prompt');
    if (args.text('agent')) {
      const agent = resolveClearable(
        args.text('agent'),
        ['assistant', 'me', 'none'],
        (ref) => this.#store.org.findAgent(orgId, ref),
        noAgent,
      );
      if (!agent.ok) return agent;
      patch.agentId = agent.value;
    }
    if (args.text('project')) {
      const project = resolveClearable(args.text('project'), ['none'], (ref) => this.#store.org.findProject(orgId, ref), noProject);
      if (!project.ok) return project;
      patch.projectId = project.value;
    }
    const triggerMode = triggerModeArg(args);
    if (triggerMode) patch.triggerMode = triggerMode;
    const cooldownMs = cooldownMsArg(args);
    if (cooldownMs !== undefined) patch.eventCooldownMs = cooldownMs;
    const enabled = args.flag('enabled');
    if (enabled !== undefined) patch.enabled = enabled;
    const once = args.flag('once');
    if (once !== undefined) patch.once = once;
    return { ok: true, value: patch };
  }

  /* ------------------------------- listeners ------------------------------ */

  /**
   * The watched mailboxes.
   *
   * A listener is settings, not a row: it lives in `~/.rookery/config.json`
   * beside everything else, and the connection itself belongs to the server.
   * Core does not reach into it - it writes the config and says so, and the
   * registry follows on the `changed` event. Same split as everywhere: the
   * decision here, the socket there.
   */
  #toolListeners(context: ToolContext, name: string, args: ToolArgs): ToolCallResult {
    if (context.audience !== 'assistant') return toolError('Only the assistant can change listeners.');
    if (name === 'list_listeners') return this.#listListeners();

    const id = args.text('id');
    if (!id) return toolError('Name the listener.');
    // It ends up in `imap:<id>` on every run this mailbox causes, so it has to
    // stay a plain word.
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return toolError('A listener id is letters, digits, dot, dash or underscore.');
    const existing = this.#config.listeners.imap.find((entry) => entry.id === id) ?? null;

    if (name === 'remove_listener') return this.#removeListener(id, existing);
    return this.#setListener(context, id, existing, args);
  }

  #listListeners(): ToolCallResult {
    const entries = this.#config.listeners.imap;
    if (!entries.length) return { text: 'No mailbox is being watched.' };
    return {
      text: entries
        .map(
          (entry) =>
            '- ' + entry.id + ': ' + entry.user + ' / ' + entry.mailbox + ' on ' + entry.host + ':' + entry.port +
            ', fires "' + this.#listenerJobName(entry.jobId) + '", ' + (entry.enabled ? 'on' : 'off') +
            ', password ' + (entry.password ? 'set' : 'missing'),
        )
        .join('\n'),
    };
  }

  #removeListener(id: string, existing: ImapListenerConfig | null): ToolCallResult {
    if (!existing) return toolError('No listener "' + id + '".');
    this.#writeListeners(this.#config.listeners.imap.filter((entry) => entry.id !== id));
    return { text: 'Stopped watching "' + id + '" and forgot its settings, the password included.' };
  }

  #setListener(context: ToolContext, id: string, existing: ImapListenerConfig | null, args: ToolArgs): ToolCallResult {
    const wantedJob = resolveOptional(
      args.text('schedule'),
      (ref) => this.#cron?.find(context.orgId, ref) ?? null,
      (ref) => 'No schedule "' + ref + '". list_schedules shows the names.',
    );
    if (!wantedJob.ok) return wantedJob.error;
    const merged = mergeListener(id, existing, args, wantedJob.value?.id);
    const missing: string[] = [];
    if (!merged.host) missing.push('a server');
    if (!merged.user) missing.push('a user');
    if (!merged.jobId) missing.push('a schedule to fire');
    if (missing.length) return toolError('This mailbox still needs ' + missing.join(', ') + '.');
    // Switched on without a password it would only produce a rejected login
    // and a stopped listener, which reads like a bug rather than a blank field.
    if (merged.enabled && !merged.password) return toolError('Set the password before switching "' + id + '" on.');

    const entries = this.#config.listeners.imap;
    this.#writeListeners(existing ? entries.map((entry) => (entry.id === id ? merged : entry)) : [...entries, merged]);
    // The password is never repeated back, not even to the person who just
    // said it: a tool result is transcript too, and one copy is enough.
    return {
      text:
        (existing ? 'Updated mailbox "' : 'Now watching "') + id + '": ' + merged.user + ' / ' + merged.mailbox +
        ' on ' + merged.host + ':' + merged.port + ', firing "' + this.#listenerJobName(merged.jobId) + '", ' +
        (merged.enabled ? 'on.' : 'off - switch it on once the details are right.'),
    };
  }

  #listenerJobName(jobId: string): string {
    return this.#cron?.get(jobId)?.name ?? '(no schedule)';
  }

  /** Write the list back; the server's registry follows on the event. */
  #writeListeners(imap: ImapListenerConfig[]): void {
    applyConfig(this.#config, { listeners: { imap } });
    this.emit('changed', { kind: 'listeners', id: 'listeners' });
  }

  async #toolAssign(context: ToolContext, args: ToolArgs): Promise<ToolCallResult> {
    const agentRef = args.text('agent');
    const task = args.text('task');
    const wait = args.raw('wait') !== false;
    if (!agentRef) return toolError('Name the agent to assign to.');
    if (!task) return toolError('The task is empty.');

    const agent = this.#store.org.findAgent(context.orgId, agentRef);
    if (!agent) {
      const known = this.#store.org.listAgents(context.orgId).map((entry) => entry.slug);
      return toolError(
        noAgent(agentRef) + ' ' + (known.length ? 'Known agents: ' + known.join(', ') + '.' : 'Nobody is hired yet.'),
      );
    }
    const refusal = this.#assignmentRefusal(context, agent, wait);
    if (refusal) return toolError(refusal);

    let projectId = context.projectId;
    if (args.text('project')) {
      const project = this.#store.org.findProject(context.orgId, args.text('project'));
      if (!project) return toolError(noProject(args.text('project')));
      projectId = project.id;
    }

    // Handing work to somebody puts it on the board like every other way in
    // (decision E9). This was the fourth entrance, and the only one that left
    // a run nobody could find on a card. Inside a task, the new one becomes a
    // child of it, so a delegation chain reads as a tree.
    const card = this.#store.org.createTask({
      orgId: context.orgId,
      parentId: context.taskId,
      title: args.text('title') || titleFromBrief(task),
      description: task,
      projectId,
      assigneeId: agent.id,
      createdBy: callerKind(context),
      createdByAgentId: context.agentId,
      // Where the ending is reported (R1): the conversation for top-level
      // work, the parent task for work handed on from inside one.
      requesterSessionId: context.taskId ? undefined : context.sessionId,
    });
    this.#announceTask(card, context.emit);

    // The new task is its own errand: the note that continued the caller's
    // task is not part of this brief.
    const runContext: ToolContext = {
      ...context,
      projectId,
      taskId: card.id,
      taskNote: undefined,
      emit: wait ? context.emit : ignoreEvent,
      signal: wait ? context.signal : undefined,
    };
    return wait
      ? this.#assignAndWait(runContext, card, agent)
      : this.#assignDetached(context, runContext, card, agent);
  }

  /** Why the caller may not hand work to this agent now, or null when it may. */
  #assignmentRefusal(context: ToolContext, agent: Agent, wait: boolean): string | null {
    if (context.audience === 'agent') {
      if (agent.id === context.agentId) {
        // A self-assignment only makes sense detached: waiting on it would
        // just be the same process blocking on itself for no reason, and in
        // a chat turn there is no coding tool to do the work with anyway.
        if (wait) return 'Taking work on yourself has to run in the background - call assign with wait=false.';
      } else if (agent.managerId !== context.agentId) {
        const reports = this.#store.org.listAgents(context.orgId, { managerId: context.agentId }).map((r) => r.slug);
        return 'You may only assign work to your direct reports' +
          (reports.length ? ': ' + reports.join(', ') : ', and you have none') + '.';
      }
    }
    if (context.depth + 1 >= this.#config.org.maxDelegationDepth) {
      return 'Delegation is nested too deep already. Do this part of the work yourself.';
    }
    return null;
  }

  /**
   * Detached: the turn ends while the agent works. Its progress reaches
   * every socket through the org-level run events; the turn's own stream
   * and abort signal must not be tied to it.
   *
   * Nobody waits on the promise here, and nobody has to: how the task
   * ends is reported back by `runTask` itself - to the conversation for
   * top-level work, to the parent task (which waits for it, R4) for work
   * handed on from inside one. It used to be dropped on the floor unless
   * an agent had assigned itself, while the tool text promised otherwise.
   */
  #assignDetached(context: ToolContext, runContext: ToolContext, card: Task, agent: Agent): ToolCallResult {
    const running = this.runTask(runContext, card).catch((error: unknown) => {
      this.#log.warn('Detached task failed', { agent: agent.slug, error: String(error) });
      return this.#current(card);
    });
    if (context.taskId) this.#trackDetached(context.taskId, card.id, running);
    const whereBack = context.taskId
      ? 'Your own task stays open until it is finished: when your run ends, you are started again with its result.'
      : context.sessionId
        ? 'When it ends - done, failed or with a question - a message arrives in this conversation, and you tell the user then.'
        : 'It is on the board; how it ends is recorded on its card.';
    return {
      text:
        (agent.id === context.agentId ? 'Started in the background' : 'Handed to ' + agent.name + ' (' + agent.slug + ')') +
        ' as task ' + shortId(card.id) + ' "' + card.title + '". ' + whereBack,
    };
  }

  async #assignAndWait(runContext: ToolContext, card: Task, agent: Agent): Promise<ToolCallResult> {
    const finished = await this.#runAwaited(runContext, card);
    const label = 'task ' + shortId(card.id) + ' "' + card.title + '"';
    if (finished.status === 'blocked') {
      // Not a failure: the agent asked whoever wanted the work a question,
      // and the card stays open until it is answered.
      return { text: this.#waitingText(finished) };
    }
    if (finished.status !== 'done') {
      return toolError(
        'Task ' + shortId(card.id) + ' "' + card.title + '" with ' + agent.slug + ' ' + finished.status +
          (finished.error ? ': ' + finished.error : '.'),
      );
    }
    const duration =
      finished.startedAt && finished.finishedAt ? ', ' + toSeconds(finished.finishedAt - finished.startedAt) + ' s' : '';
    return {
      text:
        'Report from ' + agent.name + ' (' + agent.slug + ') on ' + label + duration + ':\n\n' +
        clip(finished.result ?? '', RESULT_BUDGET),
    };
  }

  /** Note work a task handed off in the background: the task does not end while any of it is out (R4). */
  #trackDetached(parentTaskId: string, taskId: string, running: Promise<Task>): void {
    let pending = this.#detached.get(parentTaskId);
    if (!pending) {
      pending = new Map();
      this.#detached.set(parentTaskId, pending);
    }
    pending.set(taskId, running);
  }

  /* ------------------------ questions, answers, notices ----------------------- */

  /**
   * What a caller that waited on a task hears when the task stopped on a
   * question: the question itself, and how to answer it. The agent's run is
   * over; the card waits, and `answer_task` is what carries it on.
   */
  #waitingText(task: Task): string {
    const agent = task.assigneeId ? this.#store.org.getAgent(task.assigneeId) : null;
    const who = agent ? agent.name + ' (' + agent.slug + ')' : 'The agent';
    const question = this.#questionFor(task);
    return (
      who + ' has a question about task ' + shortId(task.id) + ' "' + task.title + '" and the task waits for ' +
      'the answer.' +
      (question ? '\n\nThe question:\n' + clip(question, RESULT_BUDGET) : '') +
      (task.result ? '\n\nWhat it said:\n' + clip(task.result, RESULT_BUDGET) : '') +
      '\n\nAnswer it with answer_task("' + shortId(task.id) + '", ...) once you know the answer; the task ' +
      'then runs again with it.'
    );
  }

  /** The last question asked on a card, if any - what a waiting task waits on. */
  #questionFor(task: Task): string | undefined {
    return this.#store.org.lastTaskEvent(task.id, 'question')?.text || undefined;
  }

  /**
   * `ask_requester`: an agent inside a task asks whoever gave it the work.
   *
   * The question is written on the card, and the run is marked as having
   * asked - which is all it takes: when the run ends, its leaf reads the mark
   * and the card goes `blocked` instead of `done`, and the ending travels to
   * whoever asked like every other ending does (report-back, the parent task,
   * or a notification). This replaces a mail on the requester's To line, and
   * the outbox scan that used to recognise one.
   */
  #toolAskRequester(context: ToolContext, question: string): ToolCallResult {
    if (context.audience !== 'agent') {
      return toolError('Only an agent working on a task asks its requester. You can ask the user with ask_user.');
    }
    if (!context.taskId) {
      return toolError(
        'You are not working on a task, so nobody is waiting to be asked. Put the question in your result, ' +
          'with what you assumed in the meantime.',
      );
    }
    const task = this.#store.org.getTask(context.taskId);
    if (!task) return toolError('The task you are working on no longer exists.');
    if (!question) return toolError('A question needs its text.');
    this.#taskEvent({
      taskId: task.id,
      kind: 'question',
      actorKind: 'agent',
      actorAgentId: context.agentId,
      text: question,
      assignmentId: context.parentAssignmentId,
    });
    if (context.parentAssignmentId) this.#askedRequester.add(context.parentAssignmentId);
    return {
      text:
        'Your question is on the card of task ' + shortId(task.id) + '. End your run now with a short ' +
        'summary of where the work stands and what you would do with each likely answer. The task waits ' +
        'for the answer, and you are started again with it.',
    };
  }

  /**
   * The one way anything reaches the user outside a conversation
   * (docs/concepts/mail-removal-notifications-and-task-activity.md). Stored,
   * so the web can show it later and mark it read; announced as a
   * `notification` event, which is what a push channel listens for. Never
   * throws: a notification that cannot be written costs the notification,
   * never the run or the status change that produced it - the returned
   * record then lives only in this one event.
   */
  notifyUser(input: NotifyUserInput): Notification {
    const orgId = input.orgId ?? this.activeOrganization().id;
    let notification: Notification;
    try {
      notification = this.#store.org.createNotification({ ...input, orgId });
    } catch (error) {
      this.#log.warn('Notification could not be stored', { kind: input.kind, error: (error as Error).message });
      notification = {
        id: 'unsaved-' + Date.now().toString(36),
        orgId,
        kind: input.kind,
        title: input.title,
        body: input.body ?? '',
        fromKind: input.fromKind ?? 'system',
        fromAgentId: input.fromAgentId,
        taskId: input.taskId,
        cronJobId: input.cronJobId,
        cronRunId: input.cronRunId,
        sessionId: input.sessionId,
        createdAt: Date.now(),
      };
    }
    const event: AgentEvent = { type: 'notification', notification };
    this.emit('notification', event);
    return notification;
  }

  /**
   * The user answers a task that is waiting on them - the entrance behind
   * `POST /api/org/tasks/:id/answer` and a Telegram reply to a `question`
   * notification. Same path as the `answer_task` tool, and like every answer
   * from a person, uncapped: they can see what came back and are deciding to
   * go again. The assistant or an agent may be named as `by` for a caller
   * that answers on their behalf; the chain of command still applies then.
   */
  async answerTask(input: {
    taskId: string;
    answer: string;
    by?: TaskAnswerer;
    /** Narrows a prefix lookup to one company; the task's own otherwise. */
    orgId?: string;
  }): Promise<{ ok: true; task: Task } | { ok: false; reason: string }> {
    const task = input.orgId
      ? this.findTask(input.orgId, input.taskId)
      : this.#store.org.getTask(input.taskId.trim());
    if (!task) return { ok: false, reason: 'No task ' + input.taskId + '.' };
    const answered = await this.#answer(task, input.answer.trim(), input.by ?? { kind: 'user' });
    if (!answered.ok) return answered;
    return { ok: true, task: this.#current(task) };
  }

  /**
   * Answer a task and carry it on. The answer goes on the card first, whatever
   * happens next - an answer that could not start a run is still the answer,
   * and the next run finds it on the card.
   *
   * Who may answer is the chain of command: the user and the assistant any
   * task, an agent only the tasks it handed out itself. A running task is not
   * answered - its run has its prompt already, and aborting it would burn
   * work started in good faith (F1).
   */
  async #answer(
    task: Task,
    answer: string,
    by: TaskAnswerer,
    context?: ToolContext,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!answer) return { ok: false, reason: 'An answer needs text.' };
    if (by.kind === 'agent' && (task.createdBy !== 'agent' || task.createdByAgentId !== by.agentId)) {
      return {
        ok: false,
        reason: 'Only whoever handed this task out may answer it. Tell whoever gave you your own work instead.',
      };
    }
    if (task.status === 'running') {
      return { ok: false, reason: 'The task is running right now. Answer it once its run has stopped.' };
    }
    this.#taskEvent({
      taskId: task.id,
      kind: 'answer',
      actorKind: by.kind,
      actorAgentId: by.agentId,
      text: answer,
    });
    const label =
      by.kind === 'agent'
        ? ((by.agentId ? this.#store.org.getAgent(by.agentId)?.slug : undefined) ?? 'an agent')
        : by.kind === 'user'
          ? 'The user'
          : 'The assistant';
    const question = this.#questionFor(task);
    const note =
      (question ? 'You asked:\n' + clip(question, NOTE_RESULT_BUDGET) + '\n\n' : '') +
      label + ' answered:\n\n' + answer;
    return this.#continueTask(task, by, note, context);
  }

  /**
   * An answered task runs again, as the same task (decision E5): the new run
   * hangs on the same card through `linkTaskAssignment`, so the card keeps
   * its whole chain, and the old result stands until the new run has a
   * better one.
   *
   * A person answering always gets their run. A machine answering cannot see
   * what came back, so it gets a ceiling - without one, two agents answering
   * each other re-run the same task until something else stops them, and a
   * task that fails the same way every time costs a full model run per
   * repetition.
   *
   * Answered from inside a task - a lead answering the question its own
   * report's card is waiting on (R4) - the continuation is work that lead
   * handed off, and its own task waits for it exactly as for an `assign`
   * with wait=false.
   */
  #continueTask(
    task: Task,
    by: TaskAnswerer,
    note: string,
    context?: ToolContext,
  ): { ok: true } | { ok: false; reason: string } {
    const agent = task.assigneeId ? this.#store.org.getAgent(task.assigneeId) : null;
    if (!agent && !this.#store.org.listTasks(task.orgId, { parentId: task.id }).length) {
      return { ok: false, reason: 'The answer is on the card, but nobody is assigned to carry the task on.' };
    }
    const runs = this.#store.org.taskRunCount(task.id);
    if (by.kind !== 'user' && runs >= this.#config.org.maxTaskRuns) {
      this.#log.warn('Task continuation refused: run ceiling reached', { task: task.id, runs });
      return {
        ok: false,
        reason:
          'The answer is on the card, but the task has already run ' + runs + ' times - the most it may run ' +
          'without the user. It stays as it is until they pick it up.',
      };
    }
    const depth = context?.depth ?? -1;
    if (depth + 1 >= this.#config.org.maxDelegationDepth) {
      return { ok: false, reason: 'The answer is on the card, but delegation is nested too deep to run it from here.' };
    }
    const running = this.runTask(
      {
        orgId: task.orgId,
        audience: context?.audience ?? 'assistant',
        agentId: context?.agentId,
        depth,
        projectId: task.projectId,
        parentAssignmentId: context?.parentAssignmentId,
        emit: ignoreEvent,
        taskNote: note,
      },
      task,
    ).catch((error: unknown) => {
      this.#log.warn('Task continuation failed', { task: task.id, error: String(error) });
      return this.#current(task);
    });
    if (context?.taskId && task.parentId === context.taskId) this.#trackDetached(context.taskId, task.id, running);
    return { ok: true };
  }

  /** Append one line to a card's activity and tell everyone listening. Never throws. */
  #taskEvent(input: {
    taskId: string;
    kind: TaskEventKind;
    actorKind: TaskEventActor;
    actorAgentId?: string;
    text: string;
    assignmentId?: string;
  }): TaskEvent | null {
    try {
      const event = this.#store.org.addTaskEvent(input);
      const announced: AgentEvent = { type: 'task-event', event };
      this.emit('task-event', announced);
      return event;
    } catch (error) {
      this.#log.warn('Task activity could not be written', { task: input.taskId, error: (error as Error).message });
      return null;
    }
  }

  /**
   * Who hears how a task ended, once the card itself has moved - the half of
   * the old `notifyTaskStatus` that is about people rather than the thread.
   *
   * A conversation that handed the work off hears it as a turn of its own
   * (`#reportBack`), a caller blocked on the run gets it as its return value,
   * and a parent task collects its children itself. What is left is the user
   * - a card they put up, or one the assistant made with no conversation to
   * report into - and they get a notification. An agent's own errand with no
   * parent is its own business and stays on the card.
   *
   * A question is never silent. A card waiting on an answer that none of the
   * above will carry to anybody goes to the user as a `question`, schedule
   * cards included: the job fired at three in the morning, but the person it
   * works for is who can answer. The other endings keep the old silences: a
   * schedule's card (its own notification is the delivery) and a
   * cancellation the person just performed themselves.
   */
  #deliverEnding(task: Task, status: EndingStatus, how: { by: RequesterKind; fromRun: boolean }): void {
    if (status === 'blocked') {
      // Only a run's own ending asks anything; a card set to `blocked` by
      // hand carries no new question.
      if (how.fromRun && this.#questionFallsToUser(task)) this.#escalateQuestion(task);
      return;
    }
    if (!this.#userHearsEnding(task, status, how)) return;
    const agent = task.assigneeId ? this.#store.org.getAgent(task.assigneeId) : null;
    this.notifyUser({ orgId: task.orgId, ...taskNotification(task, agent) });
  }

  /** Whether a waiting card's question falls to the user: nobody else in the chain will carry it. */
  #questionFallsToUser(task: Task): boolean {
    if (isUserCard(task)) return true;
    if (this.#awaited.has(task.id) || reportsBackToConversation(task)) return false;
    // A lead's own report asked it: the lead's task waits for its
    // children and is started again with the question (R4), and
    // `#awaitDelegated` escalates it when it cannot be.
    return !(task.createdBy === 'agent' && task.parentId);
  }

  /** Whether the user is owed a notification for an ending that is not a question. */
  #userHearsEnding(task: Task, status: EndingStatus, how: { by: RequesterKind; fromRun: boolean }): boolean {
    if (task.scheduleId) return false;
    if (status === 'cancelled' && how.by === 'user' && !how.fromRun) return false;
    // The user's own card tells them, even when the assistant happened to be
    // waiting on the run: they put it up, and the card is theirs to follow.
    if (isUserCard(task)) return true;
    if (this.#awaited.has(task.id) || reportsBackToConversation(task) || task.parentId) return false;
    return task.createdBy === 'assistant';
  }

  /** Put a waiting card's question to the user, in the asking agent's name. */
  #escalateQuestion(task: Task): void {
    const current = this.#current(task);
    const asked = this.#store.org.lastTaskEvent(current.id, 'question');
    const agentId = asked?.actorAgentId ?? current.assigneeId;
    const agent = agentId ? this.#store.org.getAgent(agentId) : null;
    this.notifyUser({ orgId: current.orgId, ...taskNotification({ ...current, status: 'blocked' }, agent, asked?.text) });
  }

  /** Emit into the turn that caused an event, and to everyone listening on the controller. */
  #announce(event: Extract<AgentEvent, { type: 'assignment' | 'message' }>, emit: (event: AgentEvent) => void): void {
    emit(event);
    this.emit(event.type, event);
  }

  /**
   * Append one event to a running assignment's live log: the buffer keeps
   * it for later snapshots and generators, its listeners get it now, and the
   * `assignment-log` event carries it to whoever fans frames out (the
   * runtime, then the server's watching sockets). The journal gets it too,
   * in the same breath and unconditionally - it has no byte cap to respect,
   * because it is the record rather than the wire.
   */
  #logPush(assignmentId: string, event: AgentEvent): void {
    const buffer = this.#logs.get(assignmentId);
    if (!buffer) return;
    const frame: AssignmentLogFrame = { assignmentId, entry: buffer.push(event) };
    this.emit('assignment-log', frame);
    this.#store.turns.append(assignmentId, event as unknown as Record<string, unknown>);
  }

  /** A provider switch starts the live transcript over; `seq` keeps counting. */
  #logReset(assignmentId: string): void {
    this.#logs.get(assignmentId)?.reset();
  }

  /* ------------------------------ execution ------------------------------ */

  /**
   * Run one assignment to completion: a fresh provider process with the
   * agent's own prompt, memory and tools. Never throws; the returned
   * record says how it ended. Events flow to `input.emit` as they happen.
   */
  async run(input: RunAssignmentInput): Promise<Assignment> {
    const run = this.#openRun(input);
    run.record.announce();
    await this.#acquire(run.abort.signal);
    const started = Date.now();

    try {
      return await this.#execute(run, started);
    } catch (error) {
      this.#log.warn('Assignment failed', { id: run.record.id, error: (error as Error).message });
      return run.record.fail((error as Error).message, started);
    } finally {
      this.#closeRun(run);
    }
  }

  /** Create the assignment's record and everything that lives from the moment it is queued. */
  #openRun(input: RunAssignmentInput): RunState {
    const org = this.#store.org;
    const project = input.projectId ? org.getProject(input.projectId) : null;
    const assignment = org.createAssignment({
      orgId: input.orgId,
      agentId: input.agent.id,
      title: input.title,
      task: input.task,
      projectId: project?.id,
      sessionId: input.sessionId,
      parentId: input.parentId,
      requesterKind: input.requesterKind,
      requesterAgentId: input.requesterAgentId,
      depth: input.depth,
    });
    input.onStarted?.(assignment);
    const record = new AssignmentRecord(
      org,
      input.agent,
      assignment,
      (event) => this.#announce(event, input.emit),
      this.#log,
    );

    // One abort controller per assignment, live from the moment it is queued:
    // the caller going away, a cancel() by id and the timeout all end in it.
    const abort = new AbortController();
    const onAbort = (): void => abort.abort();
    input.signal?.addEventListener('abort', onAbort, { once: true });
    let cancelledBy: string | null = null;
    this.#active.set(assignment.id, (by) => {
      cancelledBy = by;
      abort.abort();
    });
    // The live log lives from the moment the run is queued: watching a
    // pending assignment is legal, it simply has nothing to show yet. Its
    // journal opens here too, under the assignment's own id - the buffer is
    // the transport's convenience, the journal is the record, and one without
    // the other is exactly the half that does not survive a reload.
    this.#logs.set(assignment.id, new AssignmentLogBuffer());
    // The assignment id IS the journal's turn id here, so this path needs no
    // threading of the kind `chat()` does (concept 9.4): it stores no
    // messages of its own and opens no recall trace, and the one label its
    // runs can earn - the review (4.2d) - is keyed on this same id.
    this.#store.turns.beginAssignment(assignment.id, input.sessionId, Date.now());
    return {
      input,
      project,
      record,
      abort,
      onAbort,
      cancelled: () => cancelledBy !== null || Boolean(input.signal?.aborted),
    };
  }

  /** Everything between being granted a slot and having an ending to write. */
  async #execute(run: RunState, started: number): Promise<Assignment> {
    const { input, project, record, abort } = run;
    const { agent } = input;
    if (abort.signal.aborted) return record.finish({ status: 'cancelled', finishedAt: started, durationMs: 0 });

    const preferred = agent.provider ?? this.#config.defaultProvider;
    const providerId = await this.#registry.resolveUsable(preferred);
    if (!providerId) return record.fail(await this.#noProviderReason(), started);

    const cwd = project?.path || agentWorkspace(this.#config, agent.id);
    if (!existsSync(cwd)) return record.fail('The project directory ' + cwd + ' does not exist.', started);

    const shared = this.#prepareRun(run, cwd, preferred);
    // The timeout and the bridge token span every provider attempt: a
    // switch does not buy a second timeout, and the bridge serves whichever
    // process is currently running.
    const timer = setTimeout(() => abort.abort(), this.#config.org.assignmentTimeoutMs);
    timer.unref?.();
    const token = this.register({
      orgId: input.orgId,
      audience: 'agent',
      agentId: agent.id,
      sessionId: input.sessionId,
      projectId: project?.id,
      parentAssignmentId: record.id,
      // What this run is carrying out, so anything it hands on lands under
      // the same card instead of starting a second one (decision E9).
      taskId: input.taskId,
      depth: input.depth,
      emit: input.emit,
      signal: abort.signal,
      scheduled: input.scheduled,
    });

    let outcome: AttemptsOutcome;
    try {
      outcome = await this.#runAttempts(run, { ...shared, token, started, firstProvider: providerId });
    } finally {
      clearTimeout(timer);
      this.unregister(token);
    }

    if (run.cancelled()) {
      return record.finish({ status: 'cancelled', finishedAt: Date.now(), durationMs: Date.now() - started });
    }
    if (abort.signal.aborted) return record.fail('Timed out.', started);
    if (outcome.fatal) return record.fail(outcome.fatal, started);
    if (!outcome.text.trim()) return record.fail('The agent produced no output.', started);
    return this.#complete(run, outcome, started);
  }

  /**
   * Why no provider could take the run. A company parked entirely for quota
   * says so: there is nothing to log in to, only windows to wait out.
   */
  async #noProviderReason(): Promise<string> {
    const ready = (await this.#registry.statuses()).filter((status) => status.available && status.authenticated);
    return ready.length > 0 && ready.every((status) => providerBlocked(status.id))
      ? 'Every provider is out of quota.'
      : 'No provider is logged in.';
  }

  /**
   * Everything shared by every provider attempt of this assignment: the
   * company, the memory and the skills are the agent's, not the backend's.
   */
  #prepareRun(run: RunState, cwd: string, preferred: ProviderId): SharedRunSetup {
    const { input, project, record } = run;
    return {
      project,
      cwd,
      preferred,
      projectMcp: this.#projectMcpSetup(project),
      promptBase: {
        config: this.#config,
        agent: input.agent,
        snapshot: this.snapshot(input.orgId),
        project: project ?? undefined,
        memories: this.#memoriesFor(input.agent.id, input.task),
        assignmentId: record.id,
        requestedBy: this.#requesterLabel(input),
        taskId: input.taskId,
        skillsIndex: this.#skillsIndexFor(project, input.task),
      },
    };
  }

  /** Who asked for the work, in the words the agent's prompt uses. */
  #requesterLabel(input: RunAssignmentInput): string {
    if (input.requesterKind === 'agent') {
      return this.#store.org.getAgent(input.requesterAgentId ?? '')?.name ?? 'your manager';
    }
    return input.requesterKind === 'user' ? 'the user, directly' : 'the assistant';
  }

  /**
   * The project's own MCP servers - read from its `.mcp.json`, the same
   * file a person's own session in that folder would read - only start
   * once the assistant has approved this exact file (see
   * trust_project_mcp). Untrusted or changed, they stay off and the
   * agent is told why instead of silently missing tools it expects.
   */
  #projectMcpSetup(project: Project | null): ProjectMcpSetup {
    const file = project?.path ? readProjectMcpFile(project.path) : null;
    const state = projectMcpStatus(file, project?.mcpTrust);
    if (state === 'trusted' && file) return { specs: file.servers, hints: [] };
    if (!file?.servers.length) return { specs: [], hints: [] };
    const changed = state === 'changed' ? ' (the file changed since it was approved)' : '';
    return {
      specs: [],
      hints: [
        "This project's .mcp.json lists " + file.servers.length + ' MCP server(s) not yet trusted' + changed +
          '; the assistant can review them with project_mcp_servers and trust_project_mcp.',
      ],
    };
  }

  /**
   * Rookery searches its own shelf rather than trusting the agent to
   * remember: the index says what exists, the hint says how much more is
   * installed, and the third line is the two or three that look like this
   * assignment - put there the way a recalled memory is, not left to a
   * tool call somebody has to think of.
   */
  #skillsIndexFor(project: Project | null, task: string): string {
    const skills = this.#agentSkills(project);
    return [
      renderSkillsIndex(skills),
      renderExternalSkillsHint(this.#config, 'agent'),
      renderSkillMatches(matchSkills(this.#config, 'agent', skills, task)),
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /** Run the provider attempts: the first on the chosen backend, and at most one more after a usage-limit death. */
  async #runAttempts(run: RunState, setup: RunSetup): Promise<AttemptsOutcome> {
    const { agent } = run.input;
    let provider = setup.firstProvider;
    const tried = new Set<ProviderId>([provider]);
    let output = new AttemptOutput();

    for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
      // A different backend serves different names; the fallback
      // provider's own default stands in for a model it has never
      // heard of.
      const model = attempt === 1 && provider === setup.preferred ? agent.model : remapModel(provider, agent.model);
      run.record.finish({ status: 'running', provider, model, startedAt: setup.started });

      // A switch discards the dead attempt's partial text: an assignment
      // has no resume, so it starts over rather than stitching. The live
      // log is cleared at the switch itself, below, so the switch notice
      // is pushed after the reset and no watcher can lose it.
      output = await this.#streamAttempt(run, setup, provider, model);

      const alternate = await this.#alternateProvider(run, setup, { attempt, provider, tried, fatal: output.fatal });
      if (!alternate) break;
      this.#announceProviderSwitch(run, provider, alternate);
      provider = alternate;
      tried.add(alternate);
    }
    return { text: output.text, fatal: output.fatal, provider };
  }

  /**
   * Only a usage-limit death goes around once more, on a provider
   * that has not been tried yet; anything else falls through to the
   * ordinary ending. Cancelled and timed-out runs are never
   * retried on another backend.
   */
  async #alternateProvider(
    run: RunState,
    setup: RunSetup,
    failed: { attempt: number; provider: ProviderId; tried: ReadonlySet<ProviderId>; fatal: string | null },
  ): Promise<ProviderId | undefined> {
    const retryable =
      failed.fatal !== null &&
      isUsageLimitError(failed.fatal) &&
      failed.attempt < MAX_PROVIDER_ATTEMPTS &&
      !run.cancelled() &&
      !run.abort.signal.aborted &&
      this.#config.providerFallback.enabled;
    if (!retryable) return undefined;
    rememberUsageFailure(failed.provider);
    return (await this.#registry.resolveUsable(setup.preferred, { exclude: [...failed.tried] })) ?? undefined;
  }

  #announceProviderSwitch(run: RunState, from: ProviderId, to: ProviderId): void {
    const id = run.record.id;
    const switchEvent: Extract<AgentEvent, { type: 'status' }> = {
      type: 'status',
      label: 'provider',
      detail: from + ' hit its usage limit, continuing on ' + to,
    };
    this.#logReset(id);
    this.#logPush(id, switchEvent);
    run.input.emit(switchEvent);
    run.record.announce({ lastActivity: { kind: 'status', label: 'provider', at: Date.now() } });
  }

  /** One provider process, from prompt to last event; never throws, a failure ends in `fatal`. */
  async #streamAttempt(run: RunState, setup: RunSetup, provider: ProviderId, model: string | undefined): Promise<AttemptOutput> {
    const { input, record, abort } = run;
    const { agent } = input;
    const output = new AttemptOutput();
    const extra = toolServersFor(this.#config, 'agent', provider, setup.project?.id, agent.id);
    const systemPrompt = buildAgentPrompt({
      ...setup.promptBase,
      toolHints: [...extra.hints, ...setup.projectMcp.hints],
      agentNotes: this.#store.org.agentNotesSince(agent.id).slice(0, 2),
      handoverFrom: this.#handoverFor(agent),
    });

    try {
      const mcp = await this.#bridge.spec(setup.token);
      const mcpExtra = [...extra.specs, ...setup.projectMcp.specs];
      for await (const event of this.#registry.get(provider).run({
        prompt: input.task,
        systemPrompt,
        model,
        effort: this.#config.defaultEffort,
        cwd: setup.cwd,
        permission: agent.permission ?? this.#config.defaultPermission,
        mcp,
        mcpExtra: mcpExtra.length ? mcpExtra : undefined,
        // Approved subagents and hooks out of the Claude Code
        // installation, plus Rookery's own permission floor.
        ...externalTurnExtras(this.#config, 'agent'),
        ...this.#interactiveRunOptions(record.id),
        signal: abort.signal,
      })) {
        this.#absorbProviderEvent(run, event, output);
      }
    } catch (error) {
      output.fatal = (error as Error).message;
    }
    return output;
  }

  /**
   * A visible Claude Code terminal per run, keyed by the run so the server
   * can stream it to whoever opens the run's page.
   */
  #interactiveRunOptions(assignmentId: string): Pick<ProviderTurnOptions, 'tui'> {
    if (!this.#config.org.interactiveRuns) return {};
    return {
      tui: {
        key: assignmentId,
        // A person typing into the finished run's terminal
        // belongs in its transcript, not only on the screen.
        // The live buffer is gone once the run finished, so
        // these go straight into the journal the transcript
        // is read from.
        onLateEvent: (event: AgentEvent) =>
          this.#store.turns.append(assignmentId, event as unknown as Record<string, unknown>),
      },
    };
  }

  /** Route one provider event: into the live log, the parent turn's stream, the progress line, or the attempt's result. */
  #absorbProviderEvent(run: RunState, event: AgentEvent, output: AttemptOutput): void {
    const { input, record } = run;
    switch (event.type) {
      case 'text':
        this.#logPush(record.id, event);
        if (output.append(event.delta)) {
          this.#store.org.updateAssignment(record.id, { chars: output.text.length });
          record.announce({ chars: output.text.length, preview: shorten(tail(output.text, 160), 110) });
        }
        break;
      case 'thinking':
        this.#logPush(record.id, event);
        break;
      case 'tool':
        // The live log keeps the raw event: the `[slug]` prefix below
        // is for the parent turn's stream, not this run's own log.
        this.#logPush(record.id, event);
        input.emit({ ...event, detail: '[' + input.agent.slug + '] ' + (event.detail ?? '') });
        // A tool starting is the one moment worth telling everyone about,
        // not just the turn that started this run - the same `announce`
        // that already carries `chars`/`preview` org-wide, extended with
        // what the run is doing right now. Not persisted, same as
        // `preview`: a live-only field, gone once the run finishes.
        if (event.status === 'start') {
          record.announce({ lastActivity: { kind: 'tool', label: event.name, at: Date.now() } });
        }
        break;
      case 'done':
        output.text = event.text || output.text;
        break;
      case 'error':
        if (event.fatal) {
          this.#logPush(record.id, event);
          output.fatal = event.message;
        }
        break;
    }
  }

  /** A run that produced a report: record it, and let the agent learn from it and be judged on it. */
  #complete(run: RunState, outcome: AttemptsOutcome, started: number): Assignment {
    const { input, record } = run;
    const { text } = outcome;
    const done = record.finish(
      { status: 'done', result: text, chars: text.length, finishedAt: Date.now(), durationMs: Date.now() - started },
      { chars: text.length, preview: shorten(tail(text, 160), 110) },
    );
    // A scheduled assignment does not learn: its "task" is the job's own
    // prompt, written once when the schedule was created, and every firing
    // would otherwise quote it back into the bank as if it were news.
    if (this.#config.memory.enabled && this.#config.memory.autoExtract && !input.scheduled) {
      void this.#learn(input.agent, input.task, text, outcome.provider);
    }
    if (this.#config.org.autoReview) void this.#review(input.agent, done, input.task, text, outcome.provider);
    // Asked by the run itself, through `ask_requester` - nothing to infer.
    input.onAskedRequester?.(this.#askedRequester.has(record.id));
    return done;
  }

  /**
   * How it ended, written into the transcript itself.
   *
   * The journal used to stop at the last streamed line, so a run that
   * timed out, found no provider, produced nothing or died on an
   * exception left a transcript that simply broke off - and the reason
   * existed only in `assignments.error`, which the log view does not
   * read. Anyone opening the transcript afterwards saw an account that
   * ends mid-sentence with no explanation. Now the last thing in the
   * record is what happened.
   */
  #closeRun(run: RunState): void {
    const { input, record } = run;
    const id = record.id;
    const outcome = this.#store.org.getAssignment(id) ?? record.assignment;
    this.#logPush(
      id,
      outcome.status === 'done'
        ? {
            type: 'status',
            label: 'Done',
            ...(outcome.durationMs ? { detail: toSeconds(outcome.durationMs) + ' s' } : {}),
          }
        : { type: 'error', message: outcome.status + (outcome.error ? ': ' + outcome.error : ''), fatal: true },
    );
    const log = this.#logs.get(id);
    if (log) {
      // The run is over: live watchers hear it from the `assignment`
      // broadcast `finish()` already sent, generators end here, and the
      // buffer itself is gone. The journal stays - after a run, its
      // transcript remains readable instead of only the result.
      log.end();
      this.#logs.delete(id);
    }
    // What the journal says has to match what happened. It used to write
    // `done` for every run that reached this line - a run that timed out,
    // was cancelled or died on a fatal provider error settled as an
    // orderly end, so a client rebuilding the run from the journal after
    // a reload saw a clean finish where the assignment row said `failed`.
    // `done` is reserved for a run that actually ended in `done`.
    this.#store.turns.settle(id, outcome.status === 'done' ? 'done' : 'interrupted', Date.now());
    this.#askedRequester.delete(id);
    this.#active.delete(id);
    input.signal?.removeEventListener('abort', run.onAbort);
    this.#release();
  }

  /**
   * Stop a queued or running assignment. Returns false when nothing by that
   * id is in flight; the record then already says how it ended.
   */
  cancel(assignmentId: string, by = 'the user'): boolean {
    const hook = this.#active.get(assignmentId);
    if (!hook) return false;
    this.#log.info('Assignment cancelled', { id: assignmentId, by });
    hook(by);
    return true;
  }

  /** Stop a task being run from the board, including every assignment it started. */
  cancelTask(taskId: string): boolean {
    const controller = this.#activeTasks.get(taskId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** An assignment by full id or unique prefix, within one company. */
  findAssignment(orgId: string, ref: string): Assignment | null {
    const exact = this.#store.org.getAssignment(ref);
    if (exact && exact.orgId === orgId) return exact;
    if (ref.length < 4) return null;
    const matches = this.#store.org
      .listAssignments(orgId, { limit: LOOKUP_SCAN_LIMIT })
      .filter((entry) => entry.id.startsWith(ref));
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }

  /* ------------------------------- live log ------------------------------- */

  /**
   * The live log of one assignment as it stands right now.
   *
   * The journal answers first: it holds every event of the run, uncut by any
   * byte cap, and it outlives the run - a reload after the end, or after the
   * whole server went down mid-run, still reads what stood. `active` says
   * whether more is coming. Only a run from before the journal existed falls
   * back to the in-memory buffer, which is live-only by design; an id nobody
   * knows reads back null and the caller says so.
   */
  snapshotAssignmentLog(assignmentId: string): AssignmentLogSnapshot | null {
    const turn = this.#store.turns.ofAssignment(assignmentId);
    if (turn) {
      const events = this.#store.turns
        .events(assignmentId)
        .map((entry) => entry as unknown as AssignmentLogEntry);
      return { events, overflowed: false, active: turn.status === 'running' };
    }
    const buffer = this.#logs.get(assignmentId);
    if (!buffer) return null;
    return { events: [...buffer.entries], overflowed: buffer.overflowed, active: true };
  }

  /**
   * Follow one running assignment's live log; the returned unsub stops the
   * listener and is a no-op for an id with no run behind it. Watching never
   * affects the run - a watcher going away ends nothing but the watching.
   */
  watchAssignmentLog(assignmentId: string, listener: (entry: AssignmentLogEntry) => void): () => void {
    const buffer = this.#logs.get(assignmentId);
    if (!buffer) return () => undefined;
    buffer.listeners.add(listener);
    return () => {
      buffer.listeners.delete(listener);
    };
  }

  /**
   * Replay a running assignment's buffered log, then follow it live; the
   * generator ends when the run does (clients learn the outcome itself from
   * the `assignment` broadcast).
   */
  async *assignmentLog(assignmentId: string): AsyncGenerator<AssignmentLogEntry, void, unknown> {
    const buffer = this.#logs.get(assignmentId);
    if (!buffer) return;
    yield* buffer.stream();
  }

  /* ------------------------------- settings ------------------------------- */

  #toolUpdateSettings(context: ToolContext, args: ToolArgs): ToolCallResult {
    if (context.audience !== 'assistant') return toolError('Only the assistant can change settings.');

    const patch: ConfigPatch = {};
    const defaultProvider = args.text('defaultProvider');
    if (defaultProvider) {
      const provider = this.#asProvider(defaultProvider);
      if (!provider) return toolError('No provider "' + defaultProvider + '". Configured: ' + this.#providerIds() + '.');
      patch.defaultProvider = provider;
    }
    // An empty string clears a setting: the merge skips undefined, and
    // loadConfig turns '' back into "unset".
    const defaultModel = args.text('defaultModel');
    if (defaultModel) patch.defaultModel = defaultModel === 'default' ? '' : defaultModel;
    const effort = args.text('defaultEffort');
    if (effort) {
      if (effort === 'default') patch.defaultEffort = '' as EffortLevel;
      else if ((EFFORT_LEVELS as readonly string[]).includes(effort)) patch.defaultEffort = effort as EffortLevel;
      else return toolError('Effort must be one of ' + EFFORT_LEVELS.join(', ') + ', or default.');
    }
    const org = orgSettingsPatch(args);
    if (Object.keys(org).length) patch.org = org;
    if (!Object.keys(patch).length) return toolError('Nothing to change.');

    // applyConfig writes ~/.rookery/config.json and refreshes the one config
    // object the runtime and the server share, dropping the keys a cleared
    // setting leaves behind.
    applyConfig(this.#config, patch as Partial<RookeryConfig>);
    this.emit('changed', { kind: 'config', id: 'config' });
    return { text: 'Settings updated.\n' + describeSettings(this.#config) };
  }

  /* ------------------------------- structure ------------------------------ */

  #toolUpdateAgent(context: ToolContext, args: ToolArgs): ToolCallResult {
    if (context.audience !== 'assistant') return toolError('Only the assistant can change staff.');
    const agent = this.#store.org.findAgent(context.orgId, args.text('agent'));
    if (!agent) return toolError(noAgent(args.text('agent')));

    const newInstructions = args.text('instructions');
    const reason = args.text('reason');
    // Once an agent is flagged (stage >= 1), a silent instruction change is
    // the exact failure `agent_actions` exists to prevent - "protocol before
    // effect", decision E1. Below stage 1 this is unchanged: a free
    // restructuring of the company is not a personnel action.
    if (newInstructions && newInstructions !== agent.instructions) {
      const stage = this.#store.org.performance(agent.id).stage;
      if (stage >= 1 && !reason) {
        return toolError(
          agent.name + ' is at escalation stage ' + stage + '; changing standing instructions needs a "reason" ' +
            '(it is written to the personnel record as a reconfig). Use agent_performance to see why.',
        );
      }
    }

    const patch = this.#agentPatch(context.orgId, args, agent);
    if (!patch.ok) return patch.error;

    this.#store.org.updateAgent(agent.id, patch.value);
    // A `reason` on an instructions change is a personnel action by hand,
    // same rule as the automatic one in #develop: the record and the change
    // land together (decision E1). `stage` here is the one this reconfig
    // responds to, not necessarily still current a moment later.
    if (patch.value.instructions && reason) {
      const stage = this.#store.org.performance(agent.id).stage;
      this.#store.org.createAction({
        orgId: context.orgId,
        agentId: agent.id,
        kind: 'reconfig',
        stage: Math.max(stage, 1),
        reason,
        beforeText: agent.instructions,
        afterText: patch.value.instructions,
        decidedBy: 'assistant',
      });
    }
    this.emit('changed', { kind: 'agent', id: agent.id });
    return { text: 'Updated ' + agent.name + ' (' + agent.slug + '): ' + Object.keys(patch.value).join(', ') + '.' };
  }

  #agentPatch(orgId: string, args: ToolArgs, agent: Agent): Resolved<AgentPatch> {
    const patch: AgentPatch = {};
    if (args.text('name')) patch.name = args.text('name');
    if (args.text('title')) patch.title = args.text('title');
    if (args.text('instructions')) patch.instructions = args.text('instructions');
    if (args.text('team')) {
      const team = resolveClearable(args.text('team'), ['none'], (ref) => this.#store.org.findTeam(orgId, ref), noTeam);
      if (!team.ok) return team;
      patch.teamId = team.value;
    }
    if (args.text('manager')) {
      const manager = resolveClearable(args.text('manager'), ['assistant'], (ref) => this.#store.org.findAgent(orgId, ref), noAgent);
      if (!manager.ok) return manager;
      if (manager.value === agent.id) return { ok: false, error: toolError('An agent cannot be its own manager.') };
      patch.managerId = manager.value;
    }
    // An id the registry does not serve clears the preference back to the
    // company default, the same way an unknown permission does below.
    if (args.text('provider')) patch.provider = this.#asProvider(args.text('provider')) ?? null;
    if (args.text('model')) patch.model = args.text('model');
    if (args.text('permission')) patch.permission = asPermission(args.text('permission')) ?? null;
    const archived = args.flag('archived');
    if (archived !== undefined) patch.archived = archived;
    return { ok: true, value: patch };
  }

  #toolUpdateTeam(context: ToolContext, args: ToolArgs): ToolCallResult {
    if (context.audience !== 'assistant') return toolError('Only the assistant can change teams.');
    const team = this.#store.org.findTeam(context.orgId, args.text('team'));
    if (!team) return toolError(noTeam(args.text('team')));
    const patch: TeamPatch = {};
    if (args.text('name')) patch.name = args.text('name');
    if (args.text('purpose')) patch.purpose = args.text('purpose');
    if (args.text('lead')) {
      const lead = resolveClearable(args.text('lead'), ['none'], (ref) => this.#store.org.findAgent(context.orgId, ref), noAgent);
      if (!lead.ok) return lead.error;
      patch.leadId = lead.value;
    }
    this.#store.org.updateTeam(team.id, patch);
    this.emit('changed', { kind: 'team', id: team.id });
    return { text: 'Updated team "' + (patch.name ?? team.name) + '".' };
  }

  /* --------------------------------- tasks -------------------------------- */

  /** Find a task by id or unambiguous id prefix within one company. */
  findTask(orgId: string, ref: string): Task | null {
    const wanted = ref.trim();
    if (!wanted) return null;
    const exact = this.#store.org.getTask(wanted);
    if (exact && exact.orgId === orgId) return exact;
    const matches = this.#store.org.listAllTasks(orgId, LOOKUP_SCAN_LIMIT).filter((task) => task.id.startsWith(wanted));
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }

  async #toolUpdateTask(context: ToolContext, args: ToolArgs): Promise<ToolCallResult> {
    const task = this.findTask(context.orgId, args.text('id'));
    if (!task) return toolError('No task ' + args.text('id') + '.');
    if (task.status === 'running') {
      // The one edit allowed mid-run: pulling the plug. The run loop writes
      // the final status itself once its assignments have stopped.
      if (args.text('status') === 'cancelled' && this.cancelTask(task.id)) {
        return { text: 'Cancelling task "' + task.title + '" and everything it started.' };
      }
      return toolError('The task is running; wait for it to finish, or cancel it with status "cancelled".');
    }
    const patch = this.#taskPatch(context.orgId, args);
    if (!patch.ok) return patch.error;
    // The status goes through `setTaskStatus`, which is what makes this tool
    // record on the card what it did and tell whoever is owed the ending -
    // closing a task from here used to leave whoever was waiting waiting for
    // good.
    //
    // It runs *first*. Writing the fields first meant a refused status left
    // the other edits standing and unannounced: the caller read "that is not
    // allowed", believed nothing had happened, and the card had quietly lost
    // its assignee in an open browser that was never told.
    const fields = Object.keys(patch.value);
    const status = args.text('status');
    const settable = status === 'open' || status === 'done' || status === 'cancelled' || status === 'blocked';
    if (!settable && !fields.length) return toolError('Nothing to change.');

    if (settable) {
      const result = args.text('result');
      const moved = await this.setTaskStatus({
        task,
        to: status,
        by: callerKind(context),
        ...(result ? { result } : {}),
        emit: context.emit,
      });
      if (!moved.ok) return toolError(moved.reason);
    }
    if (fields.length) this.#store.org.updateTask(task.id, patch.value);
    const edited = this.#current(task);
    this.#announceTask(edited, context.emit);
    return {
      text:
        'Updated task "' + edited.title + '": ' +
        [...fields, ...(settable ? ['status'] : [])].join(', ') + '.',
    };
  }

  #taskPatch(orgId: string, args: ToolArgs): Resolved<TaskPatch> {
    const patch: TaskPatch = {};
    if (args.text('title')) patch.title = args.text('title');
    if (args.text('description')) patch.description = args.text('description');
    if (args.text('priority')) patch.priority = asPriority(args.text('priority'));
    if (args.text('assignee')) {
      const assignee = resolveClearable(args.text('assignee'), ['none'], (ref) => this.#store.org.findAgent(orgId, ref), noAgent);
      if (!assignee.ok) return assignee;
      patch.assigneeId = assignee.value;
    }
    return { ok: true, value: patch };
  }

  /**
   * Plan a task: ask the planner, then write the decision to the board as an
   * assignee or as subtasks. Existing unfinished subtasks are cancelled first,
   * so re-planning replaces the old split instead of adding to it.
   */
  async planTask(context: ToolContext, task: Task, hint?: string): Promise<TaskPlan> {
    const snapshot = this.snapshot(context.orgId);
    const project = task.projectId ? (this.#store.org.getProject(task.projectId) ?? undefined) : undefined;
    const plan = await planTask({
      registry: this.#registry,
      config: this.#config,
      snapshot,
      task,
      project,
      hint,
      signal: context.signal,
    });

    this.#cancelUnfinishedSubtasks(context.orgId, task.id);
    this.#applyPlan(context, task, plan, snapshot.agents);
    this.#announceTask(this.#current(task), context.emit);
    return plan;
  }

  #cancelUnfinishedSubtasks(orgId: string, parentId: string): void {
    for (const child of this.#store.org.listTasks(orgId, { parentId })) {
      if (child.status === 'open' || child.status === 'planned') {
        this.#store.org.updateTask(child.id, { status: 'cancelled', finishedAt: Date.now() });
      }
    }
  }

  /** Write the planner's decision to the board: subtasks for a split, an assignee for a single task. */
  #applyPlan(context: ToolContext, task: Task, plan: TaskPlan, agents: Agent[]): void {
    const bySlug = new Map(agents.map((agent) => [agent.slug, agent]));
    if (plan.mode !== 'split') {
      this.#store.org.updateTask(task.id, {
        status: 'planned',
        planNote: plan.reason,
        assigneeId: plan.assignee ? (bySlug.get(plan.assignee)?.id ?? null) : null,
      });
      return;
    }
    const created: Task[] = [];
    for (const subtask of plan.subtasks) {
      const child = this.#store.org.createTask({
        orgId: context.orgId,
        parentId: task.id,
        projectId: task.projectId,
        title: subtask.title,
        description: subtask.description,
        priority: task.priority,
        assigneeId: bySlug.get(subtask.agent)?.id,
        createdBy: 'assistant',
        dependsOn: subtask.dependsOn.map((index) => created[index]?.id ?? '').filter(Boolean),
        status: 'planned',
      });
      created.push(child);
      this.#announceTask(child, context.emit);
    }
    this.#store.org.updateTask(task.id, { status: 'planned', planNote: plan.reason, assigneeId: null });
  }

  /**
   * Run a task to completion. Unplanned tasks are planned first. Subtasks
   * run as assignments in dependency waves; the parent collects their
   * reports. Never throws; the returned task says how it ended.
   */
  async runTask(outer: ToolContext, task: Task): Promise<Task> {
    // A task's row only says `running` once planning has finished, and
    // planning awaits - so two first invocations (a double-click before the
    // first scheduling) both read a not-yet-running row and both plan. The
    // claim on `#activeTasks` below is written before the first await, which
    // makes it the one check a concurrent invocation cannot slip past.
    if (this.#activeTasks.has(task.id) || this.#current(task).status === 'running') return this.#current(task);

    // The run gets its own abort controller so cancelTask() can stop it
    // without touching the caller's turn; the caller's signal feeds into it.
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    outer.signal?.addEventListener('abort', onAbort, { once: true });
    this.#activeTasks.set(task.id, controller);
    const context: ToolContext = { ...outer, signal: controller.signal };
    try {
      return await this.#runTask(context, task);
    } finally {
      this.#activeTasks.delete(task.id);
      outer.signal?.removeEventListener('abort', onAbort);
      // Every ending of every run passes here, thrown or not, so this is the
      // one place a report-back can be neither forgotten nor sent twice.
      this.#detached.delete(task.id);
      this.#reportBack(this.#current(task));
    }
  }

  /**
   * A task that ended outside any run - failed by the startup sweep after a
   * restart killed its run. It is reported back like any other ending: the
   * conversation that handed it off must not wait for ever on a run that no
   * longer exists.
   */
  reportEnded(task: Task): void {
    // On the card and to the user as well, by the same rules as any other
    // ending: a card the user put up must not end in silence because the
    // process that ran it died.
    this.#recordStatus(task, 'system');
    if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
      this.#deliverEnding(task, task.status, { by: 'assistant', fromRun: true });
    }
    this.#reportBack(task);
  }

  /** `runTask` for a caller that blocks on the result - it hears the ending itself. */
  async #runAwaited(context: ToolContext, task: Task): Promise<Task> {
    this.#awaited.add(task.id);
    try {
      return await this.runTask(context, task);
    } finally {
      this.#awaited.delete(task.id);
    }
  }

  /**
   * Tell whoever handed this work off how it ended (R2). Only a conversation
   * is told here: a caller blocked on the run gets its return value, a
   * subtask reports to the task it belongs to, and a card nobody handed over
   * - the board, a schedule - is told through `#deliverEnding`. A
   * conversation that cannot take a turn (a schedule's, say) is the
   * runtime's to fall back from: it turns the event into a notification.
   */
  #reportBack(task: Task): void {
    if (!task.requesterSessionId || task.parentId || this.#awaited.has(task.id) || !isEnding(task.status)) return;
    const agent = task.assigneeId ? this.#store.org.getAgent(task.assigneeId) : null;
    const event: ReportBackEvent = {
      sessionId: task.requesterSessionId,
      taskId: task.id,
      status: task.status,
      notice: reportBackNotice(task, agent, task.status === 'blocked' ? this.#questionFor(task) : undefined),
    };
    this.emit('report-back', event);
  }

  /**
   * The leaf is finished, but work it handed off in the background may not
   * be (R4). Wait for all of it, then - if the leaf itself had finished
   * cleanly - run it once more with the results, so the task's report is
   * built on them instead of on a promise that they are coming. A cancelled
   * task takes its handed-off work down with it.
   */
  async #awaitDelegated(context: ToolContext, task: Task, agent: Agent, first: LeafOutcome): Promise<LeafOutcome> {
    let outcome = first;
    for (let round = 0; ; round += 1) {
      const pending = this.#detached.get(task.id);
      if (!pending || pending.size === 0) {
        this.#detached.delete(task.id);
        return outcome;
      }
      const handedOff = [...pending.entries()];
      pending.clear();
      if (context.signal?.aborted || outcome.status === 'cancelled') {
        for (const [id] of handedOff) this.cancelTask(id);
        this.#detached.delete(task.id);
        return outcome;
      }
      const children = await this.#awaitHandedOff(context.signal, handedOff);
      // Cancelled while it waited: the task ends cancelled, not with the
      // interim report it had written before the work came back.
      if (context.signal?.aborted) {
        this.#detached.delete(task.id);
        return { ...outcome, status: 'cancelled' };
      }
      // A leaf that failed or is waiting on a question is not picked back up:
      // the children's results are on the board, and a re-run would paper
      // over the question or the failure. Nor is one past either ceiling.
      // A child that came back with a question then has nobody left to ask
      // it of, and a question is never silent: it goes to the user.
      const current = children.map((child) => this.#current(child));
      const mayPickUp =
        outcome.status === 'done' &&
        !outcome.askedRequester &&
        round < MAX_DELEGATION_ROUNDS &&
        this.#store.org.taskRunCount(task.id) < this.#config.org.maxTaskRuns;
      if (!mayPickUp) {
        for (const child of current) if (child.status === 'blocked') this.#escalateQuestion(child);
        continue;
      }
      const note =
        'The work you handed off in the background while doing this task has come back:\n\n' +
        current.map((child) => this.#handedOffReport(child)).join('\n\n') +
        '\n\nYour own report from before it came back:\n' + clip(outcome.result ?? '', CHILD_REPORT_BUDGET) +
        '\n\nPick the task back up with these results and finish it. What you answer now is the final report.';
      outcome = await this.#runTaskLeaf({ ...context, taskNote: note }, this.#current(task), agent);
    }
  }

  /** Wait for work handed off in the background; an abort of the waiter calls all of it off. */
  async #awaitHandedOff(signal: AbortSignal | undefined, handedOff: [string, Promise<Task>][]): Promise<Task[]> {
    const cancelAll = (): void => {
      for (const [id] of handedOff) this.cancelTask(id);
    };
    signal?.addEventListener('abort', cancelAll, { once: true });
    try {
      return await Promise.all(handedOff.map(([, promise]) => promise));
    } finally {
      signal?.removeEventListener('abort', cancelAll);
    }
  }

  /** One handed-off child as its parent reads it when the work is back. */
  #handedOffReport(child: Task): string {
    const who = child.assigneeId ? (this.#store.org.getAgent(child.assigneeId)?.slug ?? 'agent') : 'agent';
    const head = '### ' + child.title + ' (' + who + ', ' + child.status + ', task ' + shortId(child.id) + ')\n';
    if (child.status === 'blocked') {
      // R4 meets ask_requester: the child asked its requester, and the
      // requester is this run. The question comes back here with the
      // results, and answering it carries the child on.
      const question = this.#questionFor(child);
      return (
        head + 'It stopped with a question for you:\n' + clip(question ?? child.result ?? '(no text)', CHILD_REPORT_BUDGET) +
        '\nAnswer it with answer_task("' + shortId(child.id) + '", ...) - it then carries on in the ' +
        'background, and you are started again once it is back. If you cannot answer it, say so in your ' +
        'report instead.'
      );
    }
    return head + clip(child.result ?? (child.error ? 'FAILED: ' + child.error : 'no output'), CHILD_REPORT_BUDGET);
  }

  async #runTask(context: ToolContext, task: Task): Promise<Task> {
    const org = this.#store.org;
    const started = Date.now();

    // How a run ends is the card's business, not an HTTP route's: every
    // ending passes here, and `setTaskStatus` records it and decides who is
    // owed it (decision E7).
    // Through the one writer like everyone else. `fromRun` is what lets it
    // move a card that is `running`: this loop owns that card for the
    // duration, and it is the only writer that may decide the outcome from
    // inside rather than having to cancel first.
    const finish: TaskFinisher = async (status, patch) => {
      const moved = await this.setTaskStatus({
        task: this.#current(task),
        to: status,
        by: task.createdBy,
        fromRun: true,
        emit: context.emit,
        ...patch,
      });
      return moved.ok ? moved.task : this.#current(task);
    };

    try {
      // Planning belongs inside the guard. It ran before it once, so a
      // failure there escaped `#runTask` entirely - and
      // `Runtime.assign` had already put the card on the board by then,
      // leaving it sitting at `open` with no run, no error and no
      // explanation. The claim below is what makes the card `running`, and
      // it is atomic: a status write that slips in between the read above
      // and this line loses, rather than being silently overwritten.
      let children = this.#liveSubtasks(context.orgId, task.id);
      if (!children.length && !this.#current(task).assigneeId) {
        await this.planTask(context, this.#current(task));
        children = this.#liveSubtasks(context.orgId, task.id);
      }

      if (!org.claimTaskForRun(task.id, started)) {
        // Somebody finished or cancelled it while this was getting ready.
        return this.#current(task);
      }
      this.#announceTask(this.#current(task), context.emit);

      return await this.#runTaskBody(context, task, children, finish);
    } catch (error) {
      // The card claims to be running and nothing is. Left like that it can
      // be neither cancelled (no controller any more) nor edited (every
      // writer refuses a running task), so only a restart would clear it -
      // and the restart sweep would then report it as a failure nobody
      // could explain. It ends here instead, with the reason on it.
      const message = (error as Error).message;
      this.#log.warn('Task run failed', { task: task.id, error: message });
      try {
        return await finish('failed', { error: message });
      } catch {
        // Even the status write failed. The column is the last thing that
        // can still be made true, so it is written directly.
        this.#markEnded(task.id, { status: 'failed', error: message });
        return this.#current(task);
      }
    }
  }

  /** The subtasks of a task that still count: everything but the cancelled. */
  #liveSubtasks(orgId: string, parentId: string): Task[] {
    return this.#store.org.listTasks(orgId, { parentId }).filter((child) => child.status !== 'cancelled');
  }

  /**
   * The body of one task run, split out only so `#runTask` can wrap the
   * whole of it - planning, waves and all - in a single catch.
   */
  async #runTaskBody(context: ToolContext, task: Task, children: Task[], finish: TaskFinisher): Promise<Task> {
    if (!children.length) return await this.#runUnsplitTask(context, task, finish);

    // The note that continued the parent is the parent's; each subtask runs
    // on its own brief. The parent speaks for the split once, below, with
    // the combined result.
    const waveContext: ToolContext = { ...context, taskNote: undefined };
    for (const wave of buildTaskWaves(children.filter((child) => child.status !== 'done'))) {
      if (waveContext.signal?.aborted) break;
      await Promise.all(wave.map((child) => this.#runSubtask(waveContext, child)));
    }

    const outcome = this.#splitOutcome(
      this.#liveSubtasks(context.orgId, task.id),
      Boolean(context.signal?.aborted),
    );
    return await finish(outcome.status, { result: outcome.result, error: outcome.error });
  }

  /** A task that was not split: its assignee does the whole of it. */
  async #runUnsplitTask(context: ToolContext, task: Task, finish: TaskFinisher): Promise<Task> {
    const current = this.#current(task);
    const agent = current.assigneeId ? this.#store.org.getAgent(current.assigneeId) : null;
    if (!agent) return await finish('failed', { error: 'Nobody is assigned and nobody could be found to do it.' });
    const leaf = await this.#runTaskLeaf(context, current, agent);
    const outcome = await this.#awaitDelegated(context, current, agent, leaf);
    return await finish(taskStatusFor(outcome), { result: outcome.result, error: outcome.error });
  }

  /** How a split task ended, from where its subtasks ended up, with their reports side by side. */
  #splitOutcome(
    subtasks: Task[],
    aborted: boolean,
  ): { status: TaskStatus; result: string; error?: string } {
    const failed = subtasks.filter((child) => child.status === 'failed');
    const result = subtasks
      .map((child) => {
        const agent = child.assigneeId ? this.#store.org.getAgent(child.assigneeId) : null;
        const head = '### ' + child.title + ' (' + (agent?.slug ?? 'unassigned') + ', ' + child.status + ')';
        return head + '\n' + (child.result ?? (child.error ? 'FAILED: ' + child.error : 'no output'));
      })
      .join('\n\n');
    if (aborted) return { status: 'cancelled', result };
    if (failed.length === subtasks.length) return { status: 'failed', error: 'Every subtask failed.', result };
    return {
      status: 'done',
      result,
      error: failed.length ? failed.length + ' of ' + subtasks.length + ' subtasks failed.' : undefined,
    };
  }

  /** One subtask inside a wave: mark it, run its leaf, record the outcome. */
  async #runSubtask(outer: ToolContext, child: Task): Promise<void> {
    // A subtask gets its own controller in `#activeTasks`, exactly like the
    // task above it. Without one, `cancelTask(childId)` found nothing and
    // returned false, so a single stuck child of a five-way split could not
    // be stopped from the UI, the tool or the CLI - all three refuse to
    // edit a running card - and the only way out was restarting the server.
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    outer.signal?.addEventListener('abort', onAbort, { once: true });
    this.#activeTasks.set(child.id, controller);
    const context: ToolContext = { ...outer, signal: controller.signal };
    try {
      await this.#runSubtaskBody(context, child);
    } catch (error) {
      // Same rule as the parent: a child must never be left claiming to run.
      const message = (error as Error).message;
      this.#log.warn('Subtask run failed', { task: child.id, error: message });
      this.#markEnded(child.id, { status: 'failed', error: message });
      this.#announceTask(this.#current(child), context.emit);
    } finally {
      this.#activeTasks.delete(child.id);
      this.#detached.delete(child.id);
      outer.signal?.removeEventListener('abort', onAbort);
    }
  }

  async #runSubtaskBody(context: ToolContext, child: Task): Promise<void> {
    this.#store.org.updateTask(child.id, { status: 'running', startedAt: Date.now() });
    this.#announceTask(this.#current(child), context.emit);
    await this.#carryOutSubtask(context, child);
    const ended = this.#current(child);
    this.#announceTask(ended, context.emit);
    // A subtask's ending is written straight to its row above - the parent's
    // loop owns it - but it still goes on the card, and a question on it
    // still has to reach somebody: the split's parent only collects results.
    if (isEnding(ended.status)) {
      this.#recordStatus(ended, 'system');
      this.#deliverEnding(ended, ended.status, { by: 'assistant', fromRun: true });
    }
  }

  /** Run the subtask's leaf - or refuse it - and write how that ended onto its row. */
  async #carryOutSubtask(context: ToolContext, child: Task): Promise<void> {
    const org = this.#store.org;
    if (context.signal?.aborted) return this.#markEnded(child.id, { status: 'cancelled' });
    const agent = child.assigneeId ? org.getAgent(child.assigneeId) : null;
    if (!agent) return this.#markEnded(child.id, { status: 'failed', error: 'No assignee.' });

    const deps = child.dependsOn.map((id) => org.getTask(id)).filter((dep): dep is Task => Boolean(dep));
    // A dependency that ended failed or cancelled used to be silently
    // dropped (no result), and this subtask ran on a basis it never saw.
    // It fails with the reason instead, the way a missing assignee does;
    // the parent's summary then carries the failure. A dependency that is
    // merely not finished yet (a cycle released in one wave) is not broken
    // here - it stays dropped from the inputs, as before.
    const broken = deps.filter((dep) => dep.status === 'failed' || dep.status === 'cancelled');
    if (broken.length) {
      return this.#markEnded(child.id, {
        status: 'failed',
        error: 'Dependency did not finish: ' + broken.map((dep) => dep.title).join(', ') + '.',
      });
    }

    // A subtask's agent may hand work on in the background as well; the
    // subtask is not done before that work is back (R4).
    const leaf = await this.#runTaskLeaf(context, child, agent, deps.filter((dep) => dep.result));
    const outcome = await this.#awaitDelegated(context, child, agent, leaf);
    this.#markEnded(child.id, { status: taskStatusFor(outcome), result: outcome.result, error: outcome.error });
  }

  /** Write a task's final status straight onto its row, stamped as finished now. */
  #markEnded(taskId: string, patch: { status: TaskStatus; result?: string; error?: string }): void {
    this.#store.org.updateTask(taskId, { ...patch, finishedAt: Date.now() });
  }

  /** The task as the store has it now; the one passed in when it has gone. */
  #current(task: Task): Task {
    return this.#store.org.getTask(task.id) ?? task;
  }

  /** The card's own line about where it now stands. */
  #recordStatus(task: Task, actor: TaskEventActor): void {
    if (!isEnding(task.status)) return;
    this.#taskEvent({ taskId: task.id, kind: 'status', actorKind: actor, text: statusNote(task, task.status) });
  }

  /** One task, one agent, one assignment. */
  async #runTaskLeaf(
    context: ToolContext,
    task: Task,
    agent: Agent,
    deps: Task[] = [],
  ): Promise<LeafOutcome> {
    // What continued the task comes after the work order: the order is what
    // the task is, the note is what changed about it.
    const note = context.taskNote ? '\n\n---\n\n' + context.taskNote : '';
    let askedRequester = false;
    const runNumber = this.#store.org.taskRunCount(task.id) + 1;
    const assignment = await this.run({
      orgId: context.orgId,
      agent,
      // The run is the task, so it goes by the task's name; which run of it
      // this is comes from the chain, not from a second title (decision E17).
      title: task.title,
      taskId: task.id,
      // A title that was derived from the brief is the brief's own first
      // line, so heading the brief with it says the same thing twice - and
      // the agent reads the repetition as emphasis that was never meant.
      // Only a title that adds something gets a heading.
      task: dependencyResults(deps) + briefFor(task) + note,
      projectId: task.projectId ?? context.projectId,
      sessionId: context.sessionId,
      parentId: context.parentAssignmentId,
      // Who is waiting for this comes off the card, not off the audience
      // that happens to be driving the run. They are not the same thing: a
      // task the user put on the board is carried out by the assistant, so
      // reading the audience said "assistant" and the agent was told the
      // work came from a party that never asked for it.
      //
      // `#deliverEnding` answers this question from `task.createdBy` as
      // well; the two have to agree.
      requesterKind: task.createdBy,
      requesterAgentId: task.createdBy === 'agent' ? task.createdByAgentId : undefined,
      depth: context.depth + 1,
      emit: context.emit,
      signal: context.signal,
      onAskedRequester: (asked) => {
        askedRequester = asked;
      },
      onStarted: (started) => {
        this.#taskEvent({
          taskId: task.id,
          kind: 'run-started',
          actorKind: 'agent',
          actorAgentId: agent.id,
          text: agent.name + ' started run ' + runNumber + (context.taskNote ? ', carrying on with new input' : '') + '.',
          assignmentId: started.id,
        });
      },
    });
    this.#store.org.linkTaskAssignment(task.id, assignment.id);
    this.#taskEvent({
      taskId: task.id,
      kind: 'run-ended',
      actorKind: 'agent',
      actorAgentId: agent.id,
      text: runEndedNote(runNumber, assignment, askedRequester),
      assignmentId: assignment.id,
    });
    return {
      status: assignment.status,
      result: assignment.result,
      error: assignment.error,
      assignmentId: assignment.id,
      askedRequester,
    };
  }

  /**
   * The one place a task's status changes.
   *
   * There used to be six: the HTTP route, the `update_task` tool, the CLI,
   * the run loop, the planner and the startup sweep - each with its own
   * idea of what else has to happen. The route checked for a conflicting
   * run and wrote a note into the task's mail thread; the tool did neither;
   * the CLI did not even emit an event, so an open browser never heard that
   * the card had moved. Whether anybody learned a task was finished
   * depended on which process happened to finish it, and that is what made
   * the board feel arbitrary.
   *
   * Three things belong together and now cannot come apart: the guard, the
   * write, and telling everyone - the card's activity, and whoever is owed
   * the ending. `by` is who is asking, which decides whether a running task
   * may be touched at all.
   *
   * Reopening clears what the previous life left behind. A card moved back
   * to `open` kept its old `finishedAt` and `result`, so every duration on
   * the page - and the watcher's "running far longer than it should" - did
   * arithmetic with a timestamp from a run that had ended days ago.
   */
  async setTaskStatus(input: TaskStatusChange): Promise<{ ok: true; task: Task } | { ok: false; reason: string }> {
    const org = this.#store.org;
    const current = org.getTask(input.task.id);
    if (!current) return { ok: false, reason: 'The task no longer exists.' };
    if (current.status === input.to && !input.fromRun) {
      return { ok: true, task: current };
    }
    const refusal = statusChangeRefusal(current, input);
    if (refusal) return { ok: false, reason: refusal };

    org.updateTask(current.id, statusPatch(input, Date.now()));
    const updated = this.#current(current);
    this.#announceTask(updated, input.emit ?? ignoreEvent);
    // Every ending and every wait goes on the card, whoever moved it; then
    // whoever is owed the news gets it (`#deliverEnding` has the rules - who
    // hears, and the old silences: a schedule's card, the person's own
    // cancel).
    if (isEnding(input.to)) {
      this.#recordStatus(updated, input.fromRun ? 'system' : input.by);
      this.#deliverEnding(updated, input.to, { by: input.by, fromRun: Boolean(input.fromRun) });
    }
    return { ok: true, task: updated };
  }

  /**
   * Tell everyone about a card created outside a turn - `Runtime.assign`,
   * which has listeners but no turn to emit into. The board should show the
   * card the moment the work is handed over, not once planning is done.
   */
  announceTask(task: Task): void {
    this.#announceTask(task, ignoreEvent);
  }

  #announceTask(task: Task, emit: (event: AgentEvent) => void): void {
    const event: AgentEvent = { type: 'task', task };
    emit(event);
    this.emit('task', event);
  }

  /* ------------------------------- internals ------------------------------ */

  /**
   * A provider id the registry actually serves, or undefined.
   *
   * The set is open: both built-ins plus one id per configured provider
   * profile, and a profile can appear or disappear while the process runs.
   * So this asks the registry rather than carrying a list that goes stale the
   * moment somebody adds a backend on the Providers page.
   */
  #asProvider(value: string): ProviderId | undefined {
    const id = value.trim();
    return id && this.#registry.has(id) ? id : undefined;
  }

  /** The ids currently served, for the message when one did not match. */
  #providerIds(): string {
    return this.#registry.list().map((provider) => provider.id).join(', ');
  }

  /**
   * Skills for an agent turn: the home skills plus, when the project has a
   * directory, its own `.claude/skills` - the project wins on a name clash.
   * A fresh `SkillStore` is cheap (it only reads directories on demand), and
   * the project changes per assignment, so this cannot be the one long-lived
   * instance on `this.#skills`.
   */
  #agentSkills(project: Project | null | undefined): Skill[] {
    if (!project?.path) return this.#skills.for('agent');
    return new SkillStore([this.#config.skillsDir, projectSkillsDir(project.path)]).for('agent');
  }

  /**
   * The memories an agent's turn runs on, through the one resolver (E16,
   * S18).
   *
   * This call site used to assemble its own parameter set: `recallLimit` and
   * `recallThreshold` from the config, and nothing for the hop weights - so
   * `recall` fell back to the literals in recall.ts while the assistant's
   * turn handed in `memory.graph`. Two effective policies for one function,
   * invisible only because the values happen to match. They stop matching
   * the moment somebody moves a knob, and a promotion is exactly such a
   * move. Nothing is promoted FOR an agent in this stage; what changes here
   * is that a config deviation now reaches the agent path too.
   *
   * The other two `recall` call sites - the memory tool and the extractor's
   * pre-check - stay as they are on purpose: they are a different
   * population, neither of them is the ranking a turn is judged on.
   */
  #memoriesFor(agentId: string, task: string) {
    if (!this.#config.memory.enabled) return [];
    const policy = resolvePolicy(this.#store, this.#config, agentId, 'recall');
    const matched = recall(this.#store, {
      text: task,
      owner: agentId,
      limit: policy.limit,
      threshold: policy.threshold,
      hopEntity: policy.hopEntity,
      hopEdge: policy.hopEdge,
    });
    const profile = coreProfile(this.#store, { owner: agentId, limit: AGENT_PROFILE_LIMIT });
    const byId = new Map(profile.map((memory) => [memory.id, memory]));
    for (const memory of matched) byId.set(memory.id, memory);
    // Total order on ties (R11): score descending, then id ascending - the
    // same rule every other in-JS sort of scored memories follows, so a tie
    // no longer falls to the Map's insertion order.
    return [...byId.values()].sort(byScoreThenId);
  }

  /** Let an agent keep what it learned, in its own memory bank. */
  async #learn(agent: Agent, task: string, report: string, providerId: ProviderId): Promise<void> {
    try {
      // The memories relevant to this assignment, not the ones that happen to
      // rank highest overall - otherwise the model cannot tell that it is
      // about to write the same sentence for the fourth time.
      const known = recall(this.#store, {
        text: task + '\n' + report,
        owner: agent.id,
        limit: KNOWN_MEMORIES_LIMIT,
        threshold: KNOWN_MEMORIES_THRESHOLD,
        touch: false,
        expand: false,
      }).map((memory) => memory.content);
      const candidates = await extractMemories(this.#registry.get(providerId), {
        userText: task,
        assistantText: report,
        known,
        model: smallModelFor(providerId),
        perspective: 'agent',
      });
      admitCandidates(this.#store, {
        candidates,
        owner: agent.id,
        config: this.#config.memory,
        // An agent has no user standing by to confirm anything, so its
        // evidence comes from the two texts that are on the record: what it
        // was asked to do, and what it reported back.
        sources: [task, report],
      });
    } catch (error) {
      this.#log.warn('Agent memory extraction failed', { agent: agent.slug, error: (error as Error).message });
    }
  }

  /** A successor's handover section, straight from the `replace` action - never through recall (decision E3). */
  #handoverFor(agent: Agent): { predecessorName: string; text: string } | undefined {
    const predecessor = this.#store.org.predecessorFor(agent.id);
    if (!predecessor) return undefined;
    const handoverText = this.#store.org.replacementFor(predecessor.id)?.handoverText;
    return handoverText ? { predecessorName: predecessor.name, text: handoverText } : undefined;
  }

  /**
   * Jarvis's own judgment of one finished assignment
   * (docs/concepts/agent-performance-management.md). Runs after every
   * `status: 'done'` run, exactly like `#learn` above and with the same
   * fault tolerance - a review that cannot be written is logged, never
   * thrown. Deliberately no `smallModelFor`: judging whether work is good
   * is a decision, not extraction, so this runs on the provider's own
   * default model unless the deployment has set one explicitly.
   */
  async #review(agent: Agent, assignment: Assignment, task: string, report: string, providerId: ProviderId): Promise<void> {
    try {
      const judged = await judgeAssignment(this.#registry.get(providerId), {
        role: agent.title,
        instructions: agent.instructions,
        task,
        report,
      });
      if (!judged) return;
      this.#store.org.upsertReview({
        orgId: assignment.orgId,
        agentId: agent.id,
        assignmentId: assignment.id,
        taskId: this.#store.org.getTaskIdForAssignment(assignment.id) ?? undefined,
        source: 'assistant',
        ...judged,
      });
      await this.#develop(agent, assignment.orgId, providerId);
    } catch (error) {
      this.#log.warn('Agent review failed', { agent: agent.slug, error: (error as Error).message });
    }
  }

  /**
   * After a review lands, see whether the agent's escalation stage rose
   * since the last thing done about it, and if so, act on it - a `note` at
   * stage 1, a self-executed `reconfig` at stage 2, or (at stage 3) a
   * replacement proposal that only logs itself as a pending action; nothing
   * beyond the user approving it moves the agent. Comparing against
   * `lastAction.stage` is what keeps this idempotent: unless the computed
   * stage has actually moved past what the last action recorded, nothing
   * happens, so a steady stream of weak-but-unchanged reviews writes one
   * note, not one per review.
   */
  async #develop(agent: Agent, orgId: string, providerId: ProviderId): Promise<void> {
    const performance = this.#store.org.performance(agent.id);
    const lastStage = this.#store.org.listActions(agent.id, { limit: 1 })[0]?.stage ?? 0;
    if (performance.stage <= lastStage) return;

    const reviews = this.#store.org.effectiveReviews(agent.id, 10).filter((review) => !review.failedRun);
    const weak: WeakReview[] = reviews.slice(0, 5).map((review) => ({
      overall: review.overall,
      source: review.source,
      comment: review.comment,
      tags: review.tags,
      createdAt: review.createdAt,
    }));
    const subject: DevelopmentSubject = { agent, orgId, provider: this.#registry.get(providerId), reviews, weak };

    if (performance.stage === 1) await this.#fileNote(subject);
    else if (performance.stage === 2) await this.#fileReconfig(subject);
    else if (performance.stage === 3) await this.#fileReplacementProposal(subject);
  }

  async #fileNote({ agent, orgId, provider, reviews, weak }: DevelopmentSubject): Promise<void> {
    const drafted = await draftNote(provider, { roleTitle: agent.title, instructions: agent.instructions, reviews: weak });
    if (!drafted) return;
    this.#store.org.createAction({
      orgId,
      agentId: agent.id,
      kind: 'note',
      stage: 1,
      reason: drafted.reason,
      agentNote: drafted.agentNote,
      reviewIds: reviews.slice(0, 3).map((review) => review.id),
      decidedBy: 'assistant',
    });
    this.emit('changed', { kind: 'agent', id: agent.id });
  }

  async #fileReconfig({ agent, orgId, provider, reviews, weak }: DevelopmentSubject): Promise<void> {
    const drafted = await draftReconfig(provider, { roleTitle: agent.title, instructions: agent.instructions, reviews: weak });
    if (!drafted) return;
    // Propose by default, apply only where the user has said it may
    // (`org.autoReconfig`). Standing instructions are something a person
    // wrote, and stage 2 is reached by one model's judgment of another
    // model's output - a chain with nobody in it. Filed as a proposal,
    // the same text is one click away on the agent's page and the agent
    // keeps working to its current instructions until then.
    const applying = this.#config.org.autoReconfig;
    // Protocol before effect (decision E1): the action and the instruction
    // change happen together, or not at all - `updateAgent` never runs
    // ahead of a personnel-file entry that justifies it.
    this.#store.org.createAction({
      orgId,
      agentId: agent.id,
      kind: applying ? 'reconfig' : 'reconfig-proposal',
      stage: 2,
      reason: drafted.reason,
      beforeText: agent.instructions,
      afterText: drafted.newInstructions,
      agentNote: drafted.agentNote,
      reviewIds: reviews.slice(0, 5).map((review) => review.id),
      decidedBy: 'assistant',
    });
    if (applying) this.#store.org.updateAgent(agent.id, { instructions: drafted.newInstructions });
    this.emit('changed', { kind: 'agent', id: agent.id });
  }

  async #fileReplacementProposal({ agent, orgId, provider, reviews, weak }: DevelopmentSubject): Promise<void> {
    const drafted = await draftReplacementProposal(provider, {
      currentName: agent.name,
      roleTitle: agent.title,
      instructions: agent.instructions,
      reviews: weak,
    });
    if (!drafted) return;
    // Only a proposal (section 4, stage 3): logged so the agent page can
    // show it as a pending action item, nothing about the agent changes
    // until the user approves the replacement.
    this.#store.org.createAction({
      orgId,
      agentId: agent.id,
      kind: 'probation',
      stage: 3,
      reason:
        drafted.reason +
        '\n\nProposed successor: ' + drafted.successorName + ' (' + drafted.successorSlug + '), ' +
        drafted.successorTitle + '.\n\n' + drafted.successorInstructions,
      reviewIds: reviews.slice(0, 5).map((review) => review.id),
      decidedBy: 'assistant',
    });
    this.emit('changed', { kind: 'agent', id: agent.id });
  }

  /**
   * Stage 2, the half the machine does not do: the user accepts a drafted
   * instruction rewrite that `#develop` filed rather than applied.
   *
   * The proposal keeps both texts, so accepting it is a single write plus
   * the record that justifies it - and the record is a real `reconfig`,
   * decided by the user, which is what opens the probation window in
   * `stageFromReviews`. Rejecting one needs no call at all: an unapproved
   * proposal simply never takes effect, and the agent's next good stretch
   * drops the stage back to zero on its own.
   */
  applyReconfig(actionId: string): Agent | null {
    const action = this.#store.org.getAction(actionId);
    if (!action || action.kind !== 'reconfig-proposal' || !action.afterText) return null;
    const agent = this.#store.org.getAgent(action.agentId);
    if (!agent || agent.archived) return null;
    // Protocol before effect (decision E1), the same order the automatic
    // path uses: the entry that justifies the change is written first.
    this.#store.org.createAction({
      orgId: action.orgId,
      agentId: agent.id,
      kind: 'reconfig',
      stage: action.stage,
      reason: action.reason,
      // `beforeText` is read off the agent as it stands now, not copied from
      // the proposal: the user may have edited the instructions by hand
      // since it was drafted, and the record has to say what was actually
      // replaced.
      beforeText: agent.instructions,
      afterText: action.afterText,
      agentNote: action.agentNote,
      reviewIds: action.reviewIds,
      decidedBy: 'user',
    });
    this.#store.org.updateAgent(agent.id, { instructions: action.afterText });
    this.emit('changed', { kind: 'agent', id: agent.id });
    return this.#store.org.getAgent(agent.id);
  }

  /**
   * Stage 4 (section 4): the user has approved parting ways. Archives the
   * predecessor and its memory, condenses a handover, and hires the
   * successor in its place - team, manager and reports carried over, new
   * name and slug (decision E4), the predecessor's slug never freed.
   */
  async replaceAgent(
    orgId: string,
    predecessorId: string,
    successor: { name: string; slug?: string; title: string; instructions: string; voice?: string; handover?: string },
    providerId?: ProviderId,
  ): Promise<Agent> {
    const predecessor = this.#store.org.getAgent(predecessorId);
    if (!predecessor) throw new Error('No agent ' + predecessorId + '.');

    const handover = successor.handover?.trim() || (await this.#condenseHandover(predecessor, providerId));

    const newAgent = this.#store.org.createAgent({
      orgId,
      slug: successor.slug,
      name: successor.name,
      title: successor.title,
      instructions: successor.instructions,
      // Decision E4 (agent-performance-management.md): a successor is a new
      // identity, never a copy - the voice is never inherited either.
      voice: successor.voice,
      teamId: predecessor.teamId,
      managerId: predecessor.managerId,
      provider: predecessor.provider,
      model: predecessor.model,
      permission: predecessor.permission,
    });
    // The predecessor's own reports now answer to the successor - otherwise
    // a whole team would silently report to an archived agent.
    for (const report of this.#store.org.listAgents(orgId, { managerId: predecessor.id })) {
      this.#store.org.updateAgent(report.id, { managerId: newAgent.id });
    }
    this.#store.org.updateAgent(predecessor.id, { archived: true });
    this.#store.archiveMemories(predecessor.id);
    this.#store.org.createAction({
      orgId,
      agentId: predecessor.id,
      kind: 'replace',
      stage: 4,
      reason: 'Replaced by ' + newAgent.name + ' (' + newAgent.slug + ').',
      handoverText: handover,
      decidedBy: 'user',
      successorAgentId: newAgent.id,
    });
    this.emit('changed', { kind: 'agent', id: predecessor.id });
    this.emit('changed', { kind: 'agent', id: newAgent.id });
    return newAgent;
  }

  /** A handover condensed from the predecessor's memory; undefined without a usable provider or when drafting fails. */
  async #condenseHandover(predecessor: Agent, providerId?: ProviderId): Promise<string | undefined> {
    const resolvedProvider = await this.#registry.resolveUsable(providerId ?? this.#config.defaultProvider);
    if (!resolvedProvider) return undefined;
    try {
      const memories = this.#store.listMemories({ owner: predecessor.id, limit: 300, includeDormant: false });
      const handover = await draftHandover(this.#registry.get(resolvedProvider), {
        predecessorName: predecessor.name,
        roleTitle: predecessor.title,
        instructions: predecessor.instructions,
        memories: memories.map((memory) => ({
          content: memory.content,
          importance: memory.importance,
          createdAt: memory.createdAt,
        })),
      });
      return handover ?? undefined;
    } catch (error) {
      this.#log.warn('Handover draft failed', { agent: predecessor.slug, error: (error as Error).message });
      return undefined;
    }
  }

  /** Concurrency gate: at most `maxConcurrentAssignments` provider processes at once. */
  #acquire(signal?: AbortSignal): Promise<void> {
    if (this.#running < this.#config.org.maxConcurrentAssignments) {
      this.#running += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const grant = (): void => {
        this.#running += 1;
        resolve();
      };
      this.#waiting.push(grant);
      signal?.addEventListener(
        'abort',
        () => {
          const index = this.#waiting.indexOf(grant);
          if (index !== -1) {
            this.#waiting.splice(index, 1);
            grant();
          }
        },
        { once: true },
      );
    });
  }

  #release(): void {
    this.#running = Math.max(0, this.#running - 1);
    const next = this.#waiting.shift();
    if (next) next();
  }
}

/* --------------------------------- helpers --------------------------------- */

export function toView(assignment: Assignment, agent: Agent, extra: Partial<AssignmentView> = {}): AssignmentView {
  return {
    id: assignment.id,
    agentId: agent.id,
    agentSlug: agent.slug,
    agentName: agent.name,
    title: assignment.title,
    task: assignment.task,
    status: assignment.status,
    projectId: assignment.projectId,
    parentId: assignment.parentId,
    depth: assignment.depth,
    provider: assignment.provider,
    chars: assignment.chars,
    durationMs: assignment.durationMs,
    error: assignment.error,
    ...extra,
  };
}

/**
 * One run's record. The name leads and the brief stands underneath it: a
 * name replaces the prompt in a list, never in the file (concept 7.2).
 */
export function describeAssignment(assignment: Assignment, agent: Agent | null, runNumber?: number | null): string {
  const lines = [
    assignment.title + (runNumber && runNumber > 1 ? ' — run ' + runNumber : ''),
    'Run ' + assignment.id,
    'Agent: ' + (agent ? agent.name + ' (' + agent.slug + ')' : assignment.agentId),
    'Status: ' + assignment.status,
    'Brief: ' + clip(assignment.task, 400),
  ];
  if (assignment.durationMs !== undefined) lines.push('Duration: ' + toSeconds(assignment.durationMs) + ' s');
  if (assignment.error) lines.push('Error: ' + assignment.error);
  if (assignment.result) lines.push('', clip(assignment.result, RESULT_BUDGET));
  return lines.join('\n');
}

const STAGE_LABEL = ['normal', 'flagged', 'reconfigured/on probation', 'replacement proposed'] as const;

/** The "development conversation" tool's text: history, average, trend, stage, open actions. */
export function describeAgentPerformance(agent: Agent, org: OrgStore): string {
  const performance = org.performance(agent.id);
  const actions = org.listActions(agent.id, { limit: 10 });
  const lines = [
    agent.name + ' (' + agent.slug + '), ' + agent.title,
    'Stage: ' + performance.stage + ' - ' + STAGE_LABEL[performance.stage],
    'Average (last ' + performance.count + '): ' + (performance.average?.toFixed(2) ?? 'not enough data'),
    'Trend: ' + (performance.trend === null ? 'not enough data' : (performance.trend >= 0 ? '+' : '') + performance.trend.toFixed(2)),
    'Failure rate (last 20): ' + Math.round(performance.failureRate * 100) + '%',
  ];
  if (actions.length) {
    lines.push('', 'Personnel record:');
    for (const action of actions) {
      const when = formatDay(action.createdAt);
      lines.push('- ' + when + ' ' + action.kind + ' (stage ' + action.stage + '): ' + clip(action.reason, 200));
    }
  } else {
    lines.push('', 'No actions on record yet.');
  }
  return lines.join('\n');
}

/** The settings the assistant may see and change, as plain lines. */
export function describeSettings(config: RookeryConfig): string {
  return [
    'Default provider: ' + config.defaultProvider,
    'Default model: ' + (config.defaultModel || 'provider default'),
    'Default effort: ' + (config.defaultEffort ?? 'provider default'),
    'Parallel runs: ' + config.org.maxConcurrentAssignments,
    'Delegation depth: ' + config.org.maxDelegationDepth,
    'Run timeout: ' + Math.round(config.org.assignmentTimeoutMs / 60000) + ' min',
  ].join('\n');
}

/**
 * The work order an agent reads for one task.
 *
 * A card made from a one-line instruction has a title taken from that very
 * line (`titleFromBrief`), so heading the brief with the title repeats it
 * word for word. A card someone wrote deliberately has a title that says
 * something the description does not, and there the heading earns its
 * place. Repeating it is not merely untidy: an agent reads a doubled
 * instruction as emphasis nobody intended.
 */
function briefFor(task: Task): string {
  const description = task.description.trim();
  if (!description) return 'TASK: ' + task.title;
  const first = description.split('\n', 1)[0]?.trim() ?? '';
  // `titleFromBrief` shortens, so the title is a prefix of the line it came
  // from rather than equal to it.
  const derived = first === task.title || first.startsWith(task.title) || task.title.startsWith(first);
  return derived ? description : 'TASK: ' + task.title + '\n\n' + description;
}

/**
 * The card's `status` line when a task ends or waits - the work, not the
 * bookkeeping.
 *
 * This used to say "The task X was marked as done." and nothing else, which
 * is the worst of both worlds: a line that interrupts somebody and then
 * makes them go somewhere else to find the thing it is about. If a note is
 * worth writing at all it carries the result; if the result is not worth
 * reading, the note was not worth writing.
 *
 * Clipped rather than whole: the full text is on the card and on the run.
 */
function statusNote(task: Task, status: 'done' | 'failed' | 'cancelled' | 'blocked'): string {
  const name = 'The task "' + task.title + '"';
  if (status === 'done') {
    const result = task.result?.trim();
    return result ? name + ' is done.\n\n' + clip(result, NOTE_RESULT_BUDGET) : name + ' is done.';
  }
  if (status === 'cancelled') return name + ' was cancelled.';
  if (status === 'blocked') return name + ' is waiting for an answer.';
  return name + ' failed' + (task.error ? ': ' + task.error : '.');
}

/**
 * What one finished leaf run means for its card. A run that ended by asking
 * its requester a question is not done, whatever its own status says: the
 * work waits for an answer, and the card says so (decision E6). The error
 * falls the safe way round - a task wrongly left `blocked` sits on the board
 * and is carried on by the next answer, while a task wrongly called `done`
 * disappears.
 */
function taskStatusFor(outcome: { status: Assignment['status']; askedRequester: boolean }): TaskStatus {
  if (outcome.status === 'cancelled') return 'cancelled';
  if (outcome.status !== 'done') return 'failed';
  return outcome.askedRequester ? 'blocked' : 'done';
}

/** The plan as the assistant reads it back, with the subtask ids it can edit. */
export function describePlan(plan: TaskPlan, children: Task[]): string {
  const lines = ['Plan: ' + plan.mode + '. ' + plan.reason];
  if (plan.mode === 'single') lines.push('Assignee: ' + (plan.assignee ?? 'nobody'));
  else {
    lines.push('Subtasks:');
    for (const [index, subtask] of plan.subtasks.entries()) {
      const child = children.find((c) => c.title === subtask.title && c.status === 'planned');
      lines.push(
        '- [' + (child ? shortId(child.id) : '?') + '] ' + subtask.title + ' → ' + subtask.agent +
          (subtask.dependsOn.length ? ' (after ' + subtask.dependsOn.map((i) => i + 1).join(', ') + ')' : '') +
          ' #' + (index + 1),
      );
    }
  }
  lines.push('Use update_task to change assignees or wording, then run_task to execute.');
  return lines.join('\n');
}

/** The first characters of an id: what people and models see, and quote back. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

function toSeconds(ms: number): number {
  return Math.round(ms / 1000);
}

function ignoreEvent(): void {
  // A caller with no turn to emit into: the controller's own listeners still hear it.
}

const noAgent = (ref: string): string => 'No agent "' + ref + '".';
const noTeam = (ref: string): string => 'No team "' + ref + '".';
const noProject = (ref: string): string => 'No project "' + ref + '".';

/** Who a tool call comes from, as the cards and notifications it writes name them. */
function callerKind(context: ToolContext): 'agent' | 'assistant' {
  return context.audience === 'agent' ? 'agent' : 'assistant';
}

/** The memory bank a caller reads and writes: an agent's own, or the assistant's. */
function memoryOwnerOf(context: ToolContext): string {
  return context.audience === 'agent' && context.agentId ? context.agentId : ASSISTANT_MEMORY_OWNER;
}

function isEnding(status: TaskStatus): status is EndingStatus {
  return status === 'done' || status === 'failed' || status === 'cancelled' || status === 'blocked';
}

/** A card the user put on the board themselves, with no conversation or parent to report into. */
function isUserCard(task: Task): boolean {
  return task.createdBy === 'user' && !task.requesterSessionId && !task.parentId;
}

/** Work a conversation handed off: its ending travels back to that conversation as a turn of its own. */
function reportsBackToConversation(task: Task): boolean {
  return Boolean(task.requesterSessionId) && !task.parentId;
}

/** Why `change` may not move `current`, or null when it may. */
function statusChangeRefusal(current: Task, change: TaskStatusChange): string | null {
  // A run in flight owns its card. Cancelling is the way to interrupt it;
  // anything else would have two writers deciding the same outcome.
  if (current.status === 'running' && !change.fromRun && change.to !== 'cancelled') {
    return 'The task is running. Cancel it first, or wait for it to finish.';
  }
  // An agent reports; the person who asked decides it is finished
  // (decision O3). `update_task` is offered to agents and checked nothing,
  // so an agent could close or drop a card the user had put on the board
  // themselves - and the user found out by noticing it was gone. Marking
  // it `blocked` or handing back a result stays open to them, and a run
  // recording its own outcome passes `fromRun`.
  if (
    change.by === 'agent' &&
    !change.fromRun &&
    current.createdBy === 'user' &&
    (change.to === 'done' || change.to === 'cancelled')
  ) {
    return 'This task belongs to the user. Report what you found and let them close it.';
  }
  return null;
}

/** The columns a move to `change.to` writes. */
function statusPatch(change: TaskStatusChange, now: number): TaskPatch {
  const patch: TaskPatch = { status: change.to };
  if (isEnding(change.to)) {
    // Waiting is not a new life. A blocked card is mid-question: it
    // carries what the run produced so far and the reason it stopped,
    // and clearing those - as "back into play" does - threw away the
    // very thing the person is being asked about.
    patch.finishedAt = change.to === 'blocked' ? null : now;
    if (change.result !== undefined) patch.result = change.result;
    if (change.error !== undefined) patch.error = change.error;
    return patch;
  }
  // Back into play: nothing from the last attempt may survive as if it
  // described this one.
  patch.finishedAt = null;
  patch.result = change.result ?? null;
  patch.error = change.error ?? null;
  if (change.to === 'running') patch.startedAt = now;
  return patch;
}

/** The results of the subtasks a task depends on, ahead of its own work order. */
function dependencyResults(deps: Task[]): string {
  if (!deps.length) return '';
  return (
    'Results of the subtasks this one depends on:\n\n' +
    deps.map((dep) => '### ' + dep.title + '\n' + clip(dep.result ?? '', CHILD_REPORT_BUDGET)).join('\n\n') +
    '\n\n---\n\n'
  );
}

/** The card's line about one run of it ending. */
function runEndedNote(runNumber: number, assignment: Assignment, askedRequester: boolean): string {
  const outcome = askedRequester && assignment.status === 'done' ? 'ended with a question' : assignment.status;
  return (
    'Run ' + runNumber + ' ' + outcome +
    (assignment.durationMs !== undefined ? ' after ' + toSeconds(assignment.durationMs) + ' s' : '') +
    (assignment.error ? ': ' + assignment.error : '.') +
    (assignment.result ? '\n\n' + clip(assignment.result, NOTE_RESULT_BUDGET) : '')
  );
}

/** The org settings `update_settings` was asked to change, each within its bounds. */
function orgSettingsPatch(args: ToolArgs): Partial<RookeryConfig['org']> {
  const org: Partial<RookeryConfig['org']> = {};
  if (args.has('maxConcurrentAssignments')) {
    org.maxConcurrentAssignments = args.number('maxConcurrentAssignments', 1, 16, 4);
  }
  if (args.has('maxDelegationDepth')) org.maxDelegationDepth = args.number('maxDelegationDepth', 1, 6, 3);
  if (args.has('assignmentTimeoutMinutes')) {
    org.assignmentTimeoutMs = args.number('assignmentTimeoutMinutes', 1, 600, 45) * 60 * 1000;
  }
  return org;
}

/** "event" takes a schedule off the clock, and then it needs no expression at all; anything else keeps the old rule that one is required. */
function triggerModeArg(args: ToolArgs): 'event' | 'schedule' | undefined {
  const mode = args.text('triggerMode');
  if (mode.toLowerCase() === 'event') return 'event';
  return mode ? 'schedule' : undefined;
}

function cooldownMsArg(args: ToolArgs): number | undefined {
  if (!args.has('cooldownSeconds')) return undefined;
  return args.number('cooldownSeconds', 0, 86_400, 60) * 1000;
}

/** The mailbox settings as they stand after this call: what it names, over what was there, over the defaults. */
function mergeListener(
  id: string,
  existing: ImapListenerConfig | null,
  args: ToolArgs,
  jobId: string | undefined,
): ImapListenerConfig {
  return {
    id,
    enabled: args.flag('enabled') ?? existing?.enabled ?? false,
    host: args.text('host') || existing?.host || '',
    port: args.has('port')
      ? args.number('port', 1, 65535, DEFAULT_IMAP_PORT)
      : existing?.port ?? DEFAULT_IMAP_PORT,
    secure: args.flag('secure') ?? existing?.secure ?? true,
    user: args.text('user') || existing?.user || '',
    password: args.text('password') || existing?.password || '',
    mailbox: args.text('mailbox') || existing?.mailbox || 'INBOX',
    jobId: jobId ?? existing?.jobId ?? '',
  };
}

function asServerAudience(value: unknown): ToolServerAudience | undefined {
  return value === 'assistant' || value === 'agents' || value === 'both' ? value : undefined;
}

/** What a turn is told when its question went unanswered until the timeout. */
function noAnswerText(timeoutMs: number): string {
  const minutes = Math.max(1, Math.round(timeoutMs / 60000));
  return (
    'No answer within ' + minutes + ' minute' + (minutes === 1 ? '' : 's') + '. Carry on with ' +
    'your own best judgement and say which way you went and why.'
  );
}

/** What a turn is told when the user answered its question: the options they chose, and what they added. */
function answerText(answer: QuestionAnswer, options: QuestionOption[]): string {
  const chosen = answer.selected
    .map((index) => options[index]?.label)
    .filter((label): label is string => Boolean(label));
  const parts: string[] = [];
  if (chosen.length) parts.push('The user chose: ' + chosen.join(', ') + '.');
  if (answer.text) parts.push((chosen.length ? 'They added: ' : 'The user answered: ') + answer.text);
  return parts.join('\n');
}
