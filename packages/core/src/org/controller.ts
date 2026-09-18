import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { readProfileExcerpt, searchProfile } from '../profile.js';
import type {
  Agent,
  AgentAction,
  AgentEvent,
  AgentPerformance,
  AgentReview,
  Assignment,
  AssignmentLogEntry,
  AssignmentLogFrame,
  AssignmentLogSnapshot,
  AssignmentStatus,
  AssignmentView,
  EffortLevel,
  Mail,
  MailThreadKind,
  MailWho,
  MemoryKind,
  NotifyEvent,
  Organization,
  PermissionLevel,
  ImapListenerConfig,
  Project,
  ProviderId,
  QuestionOption,
  RequesterKind,
  RookeryConfig,
  Task,
  TaskPriority,
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
import { extractMemories, smallModelFor } from '../memory/extractor.js';
import { admitCandidates, linkEntities } from '../memory/gate.js';
import type { SleepRunner } from '../memory/sleep.js';
import { clip, shorten, tail, titleFromBrief } from '../util/queue.js';
import { formatAge, formatDay, formatWhen } from '../util/time.js';
import type { BridgeServer, ToolCallResult, ToolHandler } from './bridge.js';
import { buildAgentPrompt, renderBoard, renderMail, renderOrgOverview, renderSchedules, type OrgSnapshot } from './prompts.js';
import {
  draftHandover,
  draftNote,
  draftReconfig,
  draftReplacementProposal,
  judgeAssignment,
  type WeakReview,
} from './review.js';
import { buildTaskWaves, planTask, type TaskPlan } from './planner.js';
import { toolsFor, type ToolAudience } from './tools.js';
import type { QuestionCloseReason, QuestionRegistry } from './questions.js';
import {
  ensureToolServers,
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
   * Set when the running assignment itself came from mail; carries the
   * auto-trigger loop guard, and everything `run()` needs to mail the result
   * back to the sender as a reply in the same thread.
   */
  sourceMail?: SourceMailRef;
  /**
   * Appended to the brief of the task leaf this context runs. It carries the
   * mail that continued a task thread: that mail is not in the task's own
   * description, and without it a continued run would read the original work
   * order again and answer it twice.
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
   * The bridge token of the calling turn, stamped in by `register`. `ask_user`
   * files it with the question so the turn can take its questions with it on
   * every exit, not only on an abort.
   */
  questionOwner?: string;
}

/**
 * The mail that started a run: who wrote it, which thread it lives in, how
 * deep the run already is. The depth is the loop guard; the rest is what the
 * finished run's reply is built from.
 */
export interface SourceMailRef {
  id: string;
  threadId: string;
  depth: number;
  fromKind: RequesterKind;
  fromAgentId?: string;
  subject: string;
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
   * Set when this assignment was started by mailing the agent's To line.
   * On success, `run()` mails the result back to the sender as a reply.
   */
  sourceMail?: SourceMailRef;
  /**
   * Told, when the run ends, whether the agent wrote to whoever asked for
   * the work on the To line while it was running - the signal that turns a
   * finished task leaf into `blocked` instead of `done` (decision E6).
   *
   * It is reported from inside the run because only here is the answer
   * still true: the run's own reply goes out to the same recipient a breath
   * later, and from outside the two are indistinguishable.
   */
  onAskedRequester?: (asked: boolean) => void;
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
  /**
   * Runs one assistant turn for a mail addressed to it and returns the reply
   * body. The assistant is not an agent and has no `run()` of its own, so
   * without this a mail to it would sit unanswered until the user's next chat;
   * the runtime owns `chat()` and passes this in, the way it passes `cron`.
   */
  runAssistantMail?: (input: { mail: Mail; senderLabel: string; thread: Mail[] }) => Promise<string>;
}

/** Emit a progress line roughly every this many characters of agent output. */
const PROGRESS_EVERY = 700;
/** How much of a result travels back into the caller's tool response. */
const RESULT_BUDGET = 24000;
/**
 * How many providers one assignment may run on. The second only happens when
 * the first died on its usage limit before producing anything, so a switch
 * costs one provider process, never the assignment's place in the queue.
 */
const MAX_PROVIDER_ATTEMPTS = 2;

/** How much of one assignment's live log is kept, in JSON bytes. */
const ASSIGNMENT_LOG_BYTES = 256 * 1024;

/**
 * The live log of one running assignment: a ring buffer capped in bytes and
 * the watchers following it. It exists only while the run does - once the
 * assignment ends, watchers learn it from the `assignment` broadcast and the
 * buffer goes away, so watching never grows anything on disk.
 */
class AssignmentLogBuffer {
  /** Buffered entries in arrival order; the oldest go when the cap is hit. */
  readonly entries: AssignmentLogEntry[] = [];
  /** Set once whole entries were dropped to stay under the cap. */
  overflowed = false;
  readonly listeners = new Set<(entry: AssignmentLogEntry) => void>();
  #seq = 0;
  #bytes = 0;
  #done = false;
  readonly #waiters: (() => void)[] = [];

  /** Append one event; returns the numbered entry the watchers receive. */
  push(event: AgentEvent): AssignmentLogEntry {
    const entry: AssignmentLogEntry = { seq: (this.#seq += 1), event };
    this.entries.push(entry);
    this.#bytes += byteSize(entry);
    // Over the cap, whole entries go, oldest first - but never the one just
    // pushed: a single huge line is better kept than silently dropped.
    while (this.#bytes > ASSIGNMENT_LOG_BYTES && this.entries.length > 1) {
      const dropped = this.entries.shift();
      if (!dropped) break;
      this.#bytes -= byteSize(dropped);
      this.overflowed = true;
    }
    for (const listener of [...this.listeners]) listener(entry);
    this.#wake();
    return entry;
  }

  /**
   * A provider switch starts the transcript over: the dead attempt's half
   * output would only read as a broken restart. `seq` keeps counting, so a
   * client ordering by it stays whole across the gap.
   */
  reset(): void {
    this.entries.length = 0;
    this.#bytes = 0;
    this.overflowed = false;
  }

  /** The run is over: generators drain what is left and then end. */
  end(): void {
    this.#done = true;
    this.#wake();
  }

  /** Replay the buffer, then follow it live until the run ends. */
  async *stream(): AsyncGenerator<AssignmentLogEntry, void, unknown> {
    let lastSeq = 0;
    for (;;) {
      // The cap shifts the oldest entries out from under any index, and a
      // reset empties the list entirely - the cursor is the last seq
      // yielded, never a position.
      const next = this.entries.find((entry) => entry.seq > lastSeq);
      if (next) {
        lastSeq = next.seq;
        yield next;
        continue;
      }
      if (this.#done) return;
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }

  #wake(): void {
    // splice, never length = 0 before the loop: both names point at the
    // same array here, and emptying it first would leave nothing to iterate.
    for (const waiter of this.#waiters.splice(0)) waiter();
  }
}

function byteSize(entry: AssignmentLogEntry): number {
  return Buffer.byteLength(JSON.stringify(entry));
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
  readonly #runAssistantMail: OrgControllerOptions['runAssistantMail'];
  #running = 0;
  #waiting: (() => void)[] = [];
  /** Cancel hooks of assignments that are queued or running, by assignment id. */
  readonly #active = new Map<string, (by: string) => void>();
  /** Live logs of assignments that are queued or running, by assignment id. */
  readonly #logs = new Map<string, AssignmentLogBuffer>();
  /** Abort controllers of tasks being run from the board, by task id. */
  readonly #activeTasks = new Map<string, AbortController>();

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
    this.#runAssistantMail = options.runAssistantMail;
  }

  get bridge(): BridgeServer {
    return this.#bridge;
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
      toolsFor(context.audience, { scheduled: context.scheduled }),
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

  async handle(context: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const text = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
    const fail = (message: string): ToolCallResult => ({ text: message, isError: true });

    switch (name) {
      case 'org_overview':
        return { text: renderOrgOverview(this.snapshot(context.orgId), this.#store.org) };

      case 'assign':
        return this.#assign(context, text('agent'), text('title'), text('task'), text('project'), args.wait !== false);

      case 'assignment_status': {
        const assignment = this.findAssignment(context.orgId, text('id'));
        if (!assignment) return fail('No run with that id.');
        return {
          text: describeAssignment(
            assignment,
            this.#store.org.getAgent(assignment.agentId),
            this.#store.org.taskRunNumber(assignment.id),
          ),
        };
      }

      case 'review_assignment': {
        if (context.audience !== 'assistant') return fail('Only the assistant records reviews.');
        const assignment = this.findAssignment(context.orgId, text('id'));
        if (!assignment) return fail('No run with that id.');
        const overall = clampNumber(args.overall, 1, 5, 3);
        const review = this.#store.org.upsertReview({
          orgId: context.orgId,
          agentId: assignment.agentId,
          assignmentId: assignment.id,
          taskId: this.#store.org.getTaskIdForAssignment(assignment.id) ?? undefined,
          source: 'assistant',
          overall,
          comment: text('comment') || undefined,
        });
        this.emit('changed', { kind: 'agent', id: assignment.agentId });
        return { text: 'Review recorded (overall ' + review.overall + ').' };
      }

      case 'agent_performance': {
        if (context.audience !== 'assistant') return fail('Only the assistant sees the personnel record.');
        const agent = this.#store.org.findAgent(context.orgId, text('agent'));
        if (!agent) return fail('No agent "' + text('agent') + '".');
        return { text: describeAgentPerformance(agent, this.#store.org) };
      }

      case 'cancel_assignment': {
        if (context.audience !== 'assistant') return fail('Only the assistant can call off a running task.');
        const assignment = this.findAssignment(context.orgId, text('id'));
        if (!assignment) return fail('No run with that id.');
        if (!this.cancel(assignment.id, 'the assistant')) {
          return fail('Run ' + assignment.id.slice(0, 8) + ' is not running; it is ' + assignment.status + '.');
        }
        return { text: 'Calling off run ' + assignment.id.slice(0, 8) + '. It ends as cancelled within a moment.' };
      }

      case 'list_assignments': {
        if (context.audience !== 'assistant') return fail('Only the assistant can read the history.');
        const agent = text('agent') ? this.#store.org.findAgent(context.orgId, text('agent')) : null;
        if (text('agent') && !agent) return fail('No agent "' + text('agent') + '".');
        const project = text('project') ? this.#store.org.findProject(context.orgId, text('project')) : null;
        if (text('project') && !project) return fail('No project "' + text('project') + '".');
        const wanted = text('status').split(',').map((v) => v.trim()).filter(Boolean) as AssignmentStatus[];
        const limit = clampNumber(args.limit, 1, 200, 20);
        const rows = this.#store.org
          .listAssignments(context.orgId, {
            agentId: agent?.id,
            status: wanted.length ? wanted : undefined,
            limit: project ? 500 : limit,
          })
          .filter((entry) => !project || entry.projectId === project.id)
          .slice(0, limit);
        if (!rows.length) return { text: 'No runs match.' };
        const byId = new Map(
          this.#store.org.listAgents(context.orgId, { includeArchived: true }).map((entry) => [entry.id, entry]),
        );
        return {
          text: rows
            .map((entry) => {
              const who = byId.get(entry.agentId)?.slug ?? '?';
              // Local wall clock, and for anything still going the elapsed
              // span as well: "has this run too long" is the question the
              // board watcher asks, and a span cannot be read in the wrong
              // timezone the way a stamp can.
              const when = formatWhen(entry.createdAt);
              const took = entry.durationMs
                ? ' ' + Math.round(entry.durationMs / 1000) + 's'
                : entry.status === 'running'
                  ? ' running ' + formatAge(entry.createdAt)
                  : '';
              // The name, never the brief: three runs of the same errand open
              // with the same twenty words, and a list of those tells nobody
              // which is which (concept 7.1).
              const run = this.#store.org.taskRunNumber(entry.id);
              return '- ' + entry.id.slice(0, 8) + ' ' + when + ' ' + entry.status + took + ' ' + who + ': ' +
                shorten(entry.title, 100) + (run && run > 1 ? ' (run ' + run + ')' : '') +
                (entry.error ? ' [' + shorten(entry.error, 60) + ']' : '');
            })
            .join('\n'),
        };
      }

      case 'update_project': {
        if (context.audience !== 'assistant') return fail('Only the assistant can change projects.');
        const project = this.#store.org.findProject(context.orgId, text('project'));
        if (!project) return fail('No project "' + text('project') + '".');
        const patch: Parameters<OrgStore['updateProject']>[1] = {};
        if (text('name')) patch.name = text('name');
        if (text('description')) patch.description = text('description');
        if (text('path')) {
          if (text('path').toLowerCase() === 'none') patch.path = null;
          else if (!existsSync(text('path'))) return fail('The directory ' + text('path') + ' does not exist.');
          else patch.path = text('path');
        }
        if (typeof args.archived === 'boolean') patch.archived = args.archived;
        if (!Object.keys(patch).length) return fail('Nothing to change.');
        this.#store.org.updateProject(project.id, patch);
        this.emit('changed', { kind: 'project', id: project.id });
        return { text: 'Updated project "' + (patch.name ?? project.name) + '": ' + Object.keys(patch).join(', ') + '.' };
      }

      case 'sleep_now': {
        if (context.audience !== 'assistant') return fail('Only the assistant has this memory.');
        if (!this.#sleep) return fail('The nightly memory run is not available here.');
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

      case 'read_profile': {
        if (context.audience !== 'assistant') return fail('Only the assistant has this profile.');
        return { text: readProfileExcerpt(this.#config, text('name'), args.offset === undefined ? 0 : Number(args.offset), args.limit === undefined ? 12000 : Number(args.limit)) };
      }
      case 'search_profile': {
        if (context.audience !== 'assistant') return fail('Only the assistant has this profile.');
        return { text: searchProfile(this.#config, text('query')) };
      }
      case 'remember': {
        // The assistant keeps facts about the user; an agent keeps facts
        // about its own work. Either way the write lands in the caller's own
        // bank and nowhere else - there is no path here that writes across
        // the owner boundary.
        const owner =
          context.audience === 'agent' && context.agentId ? context.agentId : ASSISTANT_MEMORY_OWNER;
        // Same rule as write_skill below: a scheduled run has nobody present
        // to confirm anything, and a memory it pinned would even carry
        // origin 'user' - protected from the very night that should weigh it.
        if (context.scheduled) {
          return fail(
            'This run was started by a schedule. Automated runs leave no memories - if this ' +
              'belongs in memory, bring it up in a conversation.',
          );
        }
        if (!text('content')) return fail('A memory needs content.');
        const tags = text('tags').split(',').map((v) => v.trim()).filter(Boolean);
        const record = this.#store.upsertMemory({
          kind: asMemoryKind(text('kind')),
          content: text('content'),
          tags,
          importance: clampNumber(args.importance, 0, 1, 0.7),
          owner,
          sourceSessionId: context.sessionId,
          // Asked for explicitly, so the night never merges it away.
          origin: 'user',
        });
        linkEntities(this.#store, owner, record.id, tags);
        this.emit('changed', { kind: 'memory', id: record.id });
        return { text: 'Remembered (' + record.id.slice(0, 8) + '): ' + record.content };
      }

      case 'forget': {
        if (context.audience !== 'assistant') return fail('Only the assistant has this memory.');
        // Forgetting is a deletion, and E1 of the memory concept says a
        // deletion happens only on the user's explicit word - a schedule has
        // nobody behind it to give that word.
        if (context.scheduled) {
          return fail(
            'This run was started by a schedule. Nothing is forgotten on an automated run - ask ' +
              'in a conversation instead.',
          );
        }
        const ref = text('id');
        if (!ref) return fail('Which memory? Give its id.');
        const record =
          this.#store.getMemory(ref) ??
          this.#store.listMemories({ owner: ASSISTANT_MEMORY_OWNER, limit: 1000 }).find((m) => m.id.startsWith(ref));
        if (!record || record.owner !== ASSISTANT_MEMORY_OWNER) return fail('No memory ' + ref + '.');
        this.#store.forgetMemory(record.id);
        this.emit('changed', { kind: 'memory', id: record.id });
        return { text: 'Forgotten: ' + record.content };
      }

      case 'search_memory': {
        // Read-only, and strictly inside the caller's own bank: the
        // assistant searches what it knows about the user, an agent searches
        // its own working memory. One owner in, one owner out.
        const owner =
          context.audience === 'agent' && context.agentId ? context.agentId : ASSISTANT_MEMORY_OWNER;
        const limit = clampNumber(args.limit, 1, 100, 20);
        const query = text('query');
        const rows = query
          ? recall(this.#store, { text: query, limit, owner, touch: false })
          : this.#store.listMemories({ owner, limit });
        if (!rows.length) return { text: query ? 'Nothing in memory matches.' : 'Memory is empty.' };
        return {
          text: rows
            .map((m) => '- ' + m.id.slice(0, 8) + ' [' + m.kind + ', ' + m.importance.toFixed(2) + '] ' + m.content)
            .join('\n'),
        };
      }

      case 'get_settings':
        if (context.audience !== 'assistant') return fail('Only the assistant can read settings.');
        return { text: describeSettings(this.#config) };

      case 'update_settings':
        return this.#updateSettings(context, args);

      case 'send_mail':
        return this.#sendMail(context, text('to'), text('cc'), text('subject'), text('body'), text('inReplyTo') || undefined);

      case 'read_mail': {
        const who: MailWho = context.audience === 'agent' ? { kind: 'agent', id: context.agentId } : { kind: 'assistant' };
        const mail = this.#store.org.unreadMailFor(context.orgId, who);
        if (!mail.length) return { text: 'No unread mail.' };
        this.#store.org.markMailReadFor(mail, who);
        return { text: renderMail(mail, this.snapshot(context.orgId), 'Unread mail:') };
      }

      case 'read_mail_thread': {
        const reference = text('thread');
        if (!reference) return fail('Name the thread to read.');
        const who: MailWho = context.audience === 'agent' ? { kind: 'agent', id: context.agentId } : { kind: 'assistant' };
        // Either id works: a mail names its own thread, and the id an agent
        // has to hand is usually the mail it was woken with.
        const threadId = this.#store.org.getMail(reference)?.threadId ?? reference;
        const thread = this.#store.org.thread(context.orgId, threadId, { who });
        if (!thread.length) return { text: 'No mail in that thread, or none of it was addressed to you.' };
        // Asked for in full, answered in full: the prompt's 600-character
        // preview is the wrong answer to "give me the whole thread".
        return {
          text: clip(renderMail(thread, this.snapshot(context.orgId), 'The thread, oldest first:', 4000), RESULT_BUDGET),
        };
      }

      case 'notify': {
        if (context.audience !== 'assistant') return fail('Only the assistant can send notifications.');
        if (!text('text')) return fail('A notification needs text.');
        if (!this.#canNotify || !this.#canNotify()) {
          return fail(
            'No notification channel can reach the user right now - none is set up, it is ' +
              'switched off, or it has no recipient. Nothing was sent.',
          );
        }
        const urgency = args.urgency === 'high' ? 'high' : 'normal';
        const event: NotifyEvent = { text: text('text'), urgency, at: Date.now() };
        this.emit('notify', event);
        return { text: 'Sent' + (urgency === 'high' ? ' (high urgency)' : '') + ': ' + event.text };
      }

      case 'ask_user': {
        // Only the assistant asks. An agent runs unattended by design and
        // reports back by mail; letting one block on a person would stall a
        // whole delegation chain behind somebody's inbox.
        if (context.audience !== 'assistant') {
          return fail('Only the assistant can ask the user. Report what you need in your result instead.');
        }
        // Belt and braces: a scheduled run is not offered the tool at all
        // (see `register`), so getting here means the list was built for a
        // conversation and the run turned out to be automated.
        if (context.scheduled) {
          return fail(
            'This run was started by a schedule and nobody is there to answer. Decide it yourself ' +
              'and say in your result what you assumed.',
          );
        }
        if (!this.#questions) return fail('Asking the user is not available here.');
        const header = text('header');
        const question = text('question');
        if (!question) return fail('A question needs its text.');
        const options = asQuestionOptions(args.options);
        if (options.length < 2) return fail('Offer at least two options to choose from.');
        if (options.length > 4) return fail('Offer at most four options; more does not fit a phone.');

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
            header: header || 'Question',
            question,
            options,
            multiSelect: args.multiSelect === true,
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
          if (closedBecause === 'cancelled' || context.signal?.aborted) {
            return { text: 'The question was cancelled before anybody answered it.' };
          }
          const minutes = Math.max(1, Math.round(timeoutMs / 60000));
          return {
            text:
              'No answer within ' + minutes + ' minute' + (minutes === 1 ? '' : 's') + '. Carry on with ' +
              'your own best judgement and say which way you went and why.',
          };
        }
        const chosen = answer.selected
          .map((index) => options[index]?.label)
          .filter((label): label is string => Boolean(label));
        const parts: string[] = [];
        if (chosen.length) parts.push('The user chose: ' + chosen.join(', ') + '.');
        if (answer.text) parts.push((chosen.length ? 'They added: ' : 'The user answered: ') + answer.text);
        return { text: parts.join('\n') };
      }

      case 'use_skill': {
        // An agent's own instructions carry its project's skills too (Befund
        // 4 in the concept doc): the tool must resolve against the running
        // assignment's project, not only the one long-lived home store.
        const project =
          context.audience === 'agent' && context.projectId ? this.#store.org.getProject(context.projectId) : null;
        const who = context.audience === 'agent' ? 'agent' : 'assistant';
        const skills = context.audience === 'agent' ? this.#agentSkills(project) : this.#skills.for('assistant');
        // Rookery's own shelf first, then the one installed in Claude Code -
        // a skill a person wrote here outranks a plugin's.
        const skill =
          skills.find((entry) => entry.name === text('name').toLowerCase()) ??
          openExternalSkill(this.#config, who, text('name'));
        if (!skill) {
          return fail(
            'No skill "' + text('name') + '". The list in your instructions is authoritative for ' +
              "Rookery's own skills; for the ones installed on this machine, search with find_skill first.",
          );
        }
        // Noted, not just answered. Which run had a skill open is the only
        // way the night can later tell a procedure that still holds from one
        // that is quietly sending every run that follows it into a wall.
        this.#store.recordSkillUse({
          skill: skill.name,
          owner: context.audience === 'agent' && context.agentId ? context.agentId : ASSISTANT_MEMORY_OWNER,
          assignmentId: context.audience === 'agent' ? context.parentAssignmentId : undefined,
          sessionId: context.sessionId,
        });
        return { text: renderSkill(skill) };
      }

      case 'find_skill': {
        const who = context.audience === 'agent' ? 'agent' : 'assistant';
        const hits = findExternalSkills(this.#config, who, text('query'));
        return { text: renderSkillHits(hits) };
      }

      case 'write_skill': {
        // A scheduled run has a person's trust but not a person present:
        // what it writes down would echo its own job prompt, and nothing
        // standing behind it would ever be read by anyone. It says so and
        // carries on without the skill.
        if (context.scheduled) {
          return fail(
            'This run was started by a schedule. Automated runs leave no memories and write no ' +
              'skills - if this procedure matters, ask for it in a conversation or write it yourself.',
          );
        }
        // Always the home store, never the project one: a skill written in
        // the middle of an assignment must not land in somebody's repository.
        const audience =
          args.audience === 'assistant' || args.audience === 'agents' || args.audience === 'both'
            ? (args.audience as ToolServerAudience)
            : 'both';
        try {
          // Keep the previous wording before replacing it. Revising a skill
          // is the point of this tool, and a revision that turns out worse
          // than what it replaced has to leave a way back.
          const name = skillSlug(text('name'));
          this.#store.snapshotSkill({ skill: name, content: this.#skills.raw(name) });
          const skill = this.#skills.save({
            name: text('name'),
            description: text('description'),
            body: text('body'),
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
          return fail((cause as Error).message);
        }
      }

      case 'project_mcp_servers': {
        if (context.audience !== 'assistant') return fail('Only the assistant reviews project MCP servers.');
        const project = this.#store.org.findProject(context.orgId, text('project'));
        if (!project) return fail('No project "' + text('project') + '".');
        if (!project.path) return fail('Project "' + project.name + '" has no directory.');
        const file = readProjectMcpFile(project.path);
        if (!file || !file.servers.length) return { text: "No MCP servers in this project's .mcp.json." };
        const status = projectMcpStatus(file, project.mcpTrust);
        return {
          text:
            'Status: ' + status + '.\n' +
            renderProjectMcpServers(file.servers) +
            (status === 'trusted' ? '' : '\nUse trust_project_mcp to approve before these start for a run.'),
        };
      }

      case 'trust_project_mcp': {
        if (context.audience !== 'assistant') return fail('Only the assistant decides project trust.');
        const project = this.#store.org.findProject(context.orgId, text('project'));
        if (!project) return fail('No project "' + text('project') + '".');
        const decision = text('decision');
        if (decision !== 'approve' && decision !== 'revoke') return fail('decision must be approve or revoke.');
        if (decision === 'revoke') {
          this.#store.org.updateProject(project.id, { mcpTrust: null });
          this.emit('changed', { kind: 'project', id: project.id });
          return { text: 'Revoked trust for "' + project.name + '"; its MCP servers no longer start for its runs.' };
        }
        if (!project.path) return fail('Project "' + project.name + '" has no directory.');
        const file = readProjectMcpFile(project.path);
        if (!file || !file.servers.length) return fail("No MCP servers in this project's .mcp.json.");
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

      case 'tool_servers':
        if (context.audience !== 'assistant') return fail('Only the assistant sees the hub.');
        return { text: renderToolServers(toolServerStates(this.#config)) };

      case 'set_tool_server': {
        if (context.audience !== 'assistant') return fail('Only the assistant can switch tools.');
        const state = toolServerStates(this.#config).find((entry) => entry.id === text('id'));
        if (!state) return fail('No tool server "' + text('id') + '".');
        if (typeof args.enabled !== 'boolean') return fail('enabled must be true or false.');
        // A server read out of Claude Code belongs to somebody else's
        // installation. Starting it is the user's call, made on the Tools page.
        if (state.approvalRequired) {
          return fail(
            state.name + ' comes from ' + (state.source || 'another installation') + ' and only the user can ' +
              'switch it on, on the Tools page. Say that you need it and why.',
          );
        }
        if (args.enabled && !state.installed) return fail(state.name + ' is not installed on this machine.');
        if (args.enabled && state.missingEnv.length) {
          return fail(state.name + ' needs ' + state.missingEnv.join(', ') + ' first; the user sets that on the Tools page.');
        }
        const audience = text('audience');
        applyConfig(
          this.#config,
          withToolServer(this.#config, state.id, {
            enabled: args.enabled,
            ...(audience === 'assistant' || audience === 'agents' || audience === 'both' ? { audience } : {}),
          }),
        );
        this.emit('changed', { kind: 'tools', id: state.id });
        return {
          text: state.name + ' is now ' + (args.enabled ? 'on' : 'off') + ' for ' + (audience || state.audience) + '. ' +
            (args.enabled
              ? 'Finish this answer and it is attached; the turn then carries on and you can use it.'
              : 'It is gone from the next turn on.'),
        };
      }

      case 'hire_agent': {
        if (context.audience !== 'assistant') return fail('Only the assistant can hire.');
        const replaces = text('replaces') ? this.#store.org.findAgent(context.orgId, text('replaces')) : null;
        if (text('replaces') && !replaces) return fail('No agent "' + text('replaces') + '" to replace.');
        if (replaces) {
          // Stage 4 (docs/concepts/agent-performance-management.md, section
          // 4): archiving, the handover and the hire happen together in
          // #replaceAgent, never as three separate steps a half-finished
          // call could leave inconsistent.
          if (!text('name') || !text('title') || !text('instructions')) {
            return fail('Replacing an agent still needs a name, a title and instructions for the successor.');
          }
          if (text('name').trim().toLowerCase() === replaces.name.trim().toLowerCase()) {
            return fail('The successor needs a different name from ' + replaces.name + " - decision E4: a new identity, not a reused one.");
          }
          const successor = await this.replaceAgent(
            context.orgId,
            replaces.id,
            {
              name: text('name'),
              slug: text('slug') || undefined,
              title: text('title'),
              instructions: text('instructions'),
              voice: text('voice') || undefined,
              handover: text('handover') || undefined,
            },
            this.#asProvider(text('provider')) ?? replaces.provider,
          );
          return {
            text:
              'Archived ' + replaces.name + ' (' + replaces.slug + ') and hired ' + successor.name + ' as ' +
              successor.title + ' (slug: ' + successor.slug + ') in their place.',
          };
        }
        const team = text('team') ? this.#store.org.findTeam(context.orgId, text('team')) : null;
        if (text('team') && !team) return fail('No team "' + text('team') + '". Create it first.');
        const manager = text('manager') ? this.#store.org.findAgent(context.orgId, text('manager')) : null;
        if (text('manager') && !manager) return fail('No agent "' + text('manager') + '" to report to.');
        const agent = this.#store.org.createAgent({
          orgId: context.orgId,
          slug: text('slug') || undefined,
          name: text('name'),
          title: text('title'),
          instructions: text('instructions'),
          voice: text('voice') || undefined,
          teamId: team?.id,
          managerId: manager?.id,
          provider: this.#asProvider(text('provider')),
          model: text('model') || undefined,
          permission: asPermission(text('permission')),
        });
        this.emit('changed', { kind: 'agent', id: agent.id });
        return { text: 'Hired ' + agent.name + ' as ' + agent.title + ' (slug: ' + agent.slug + ').' };
      }

      case 'create_team': {
        if (context.audience !== 'assistant') return fail('Only the assistant can create teams.');
        const lead = text('lead') ? this.#store.org.findAgent(context.orgId, text('lead')) : null;
        if (text('lead') && !lead) return fail('No agent "' + text('lead') + '" to lead the team.');
        const team = this.#store.org.createTeam({
          orgId: context.orgId,
          name: text('name'),
          purpose: text('purpose') || undefined,
          leadId: lead?.id,
        });
        this.emit('changed', { kind: 'team', id: team.id });
        return { text: 'Created team "' + team.name + '" (id: ' + team.id + ').' };
      }

      case 'create_project': {
        if (context.audience !== 'assistant') return fail('Only the assistant can create projects.');
        const path = text('path') || undefined;
        if (path && !existsSync(path)) return fail('The directory ' + path + ' does not exist.');
        const project = this.#store.org.createProject({
          orgId: context.orgId,
          name: text('name'),
          description: text('description') || undefined,
          path,
        });
        this.emit('changed', { kind: 'project', id: project.id });
        return { text: 'Created project "' + project.name + '" (id: ' + project.id + ').' };
      }

      case 'update_agent':
        return this.#updateAgent(context, args);

      case 'update_team':
        return this.#updateTeam(context, args);

      case 'create_task': {
        if (!text('title') || !text('description')) return fail('A task needs a title and a description.');
        const project = text('project') ? this.#store.org.findProject(context.orgId, text('project')) : null;
        if (text('project') && !project) return fail('No project "' + text('project') + '".');
        const assignee = text('assignee') ? this.#store.org.findAgent(context.orgId, text('assignee')) : null;
        if (text('assignee') && !assignee) return fail('No agent "' + text('assignee') + '".');
        const task = this.#store.org.createTask({
          orgId: context.orgId,
          title: text('title'),
          description: text('description'),
          projectId: project?.id ?? context.projectId,
          priority: asPriority(text('priority')),
          assigneeId: assignee?.id,
          createdBy: context.audience === 'agent' ? 'agent' : 'assistant',
          createdByAgentId: context.agentId,
        });
        this.#announceTask(task, context.emit);
        // A task with an owner gets its thread now rather than at its first
        // run: the work order is the mail, and the owner should be able to
        // ask about it before anybody presses start.
        await this.#ensureTaskThread(task, context.emit);
        return { text: 'Task ' + task.id.slice(0, 8) + ' "' + task.title + '" is on the board.' };
      }

      case 'list_tasks': {
        const wanted = text('status').split(',').map((v) => v.trim()).filter(Boolean) as TaskStatus[];
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

      case 'update_task':
        return this.#updateTask(context, args);

      case 'plan_task': {
        const task = this.findTask(context.orgId, text('id'));
        if (!task) return fail('No task ' + text('id') + '.');
        const plan = await this.planTask(context, task, text('hint') || undefined);
        return { text: describePlan(plan, this.#store.org.listTasks(context.orgId, { parentId: task.id })) };
      }

      case 'run_task': {
        const task = this.findTask(context.orgId, text('id'));
        if (!task) return fail('No task ' + text('id') + '.');
        const finished = await this.runTask(context, task);
        if (finished.status !== 'done') {
          return fail('Task "' + finished.title + '" ' + finished.status + (finished.error ? ': ' + finished.error : '.'));
        }
        return { text: 'Task "' + finished.title + '" is done.\n\n' + clip(finished.result ?? '', RESULT_BUDGET) };
      }

      case 'list_schedules':
      case 'create_schedule':
      case 'update_schedule':
      case 'delete_schedule':
      case 'run_schedule':
      case 'set_webhook':
        return this.#schedules(context, name, args);

      case 'list_listeners':
      case 'set_listener':
      case 'remove_listener':
        return this.#listeners(context, name, args);

      default:
        return fail('Unknown tool ' + name + '.');
    }
  }

  /* ------------------------------- schedules ------------------------------ */

  /** The schedule tools: thin validation around the clock, with agents and projects resolved by name. */
  #schedules(context: ToolContext, name: string, args: Record<string, unknown>): ToolCallResult {
    const text = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
    const flag = (key: string): boolean | undefined => (typeof args[key] === 'boolean' ? (args[key] as boolean) : undefined);
    const fail = (message: string): ToolCallResult => ({ text: message, isError: true });
    const cron = this.#cron;
    if (!cron) return fail('Schedules are not available in this session.');
    const snapshot = this.snapshot(context.orgId);
    const bySlug = new Map(snapshot.agents.map((agent) => [agent.id, agent.slug]));
    const line = (job: Parameters<typeof describeCronJob>[0]): string =>
      describeCronJob(job, job.agentId ? bySlug.get(job.agentId) : undefined);

    if (name === 'list_schedules') {
      return { text: renderSchedules(cron.list(context.orgId), snapshot) };
    }

    // "event" takes a schedule off the clock, and then it needs no expression
    // at all; anything else keeps the old rule that one is required.
    const triggerMode = text('triggerMode').toLowerCase() === 'event' ? 'event' : text('triggerMode') ? 'schedule' : undefined;
    const cooldownMs =
      args.cooldownSeconds === undefined ? undefined : clampNumber(args.cooldownSeconds, 0, 86_400, 60) * 1000;

    if (name === 'create_schedule') {
      if (!text('name') || !text('prompt')) return fail('A schedule needs a name and a prompt.');
      if (!text('schedule') && triggerMode !== 'event') {
        return fail('A schedule needs a cron expression, or triggerMode "event" to take it off the clock.');
      }
      const agent = text('agent') ? this.#store.org.findAgent(context.orgId, text('agent')) : null;
      if (text('agent') && !agent) return fail('No agent "' + text('agent') + '".');
      const project = text('project') ? this.#store.org.findProject(context.orgId, text('project')) : null;
      if (text('project') && !project) return fail('No project "' + text('project') + '".');
      // A one-off follow-up ("I'll get back to you here") should land back
      // in the conversation it was promised in, not in a brand-new one.
      // Only for the assistant's own runs - a recurring job, or one handed
      // to an agent, keeps creating its own dedicated conversation.
      const replyHere = !agent && flag('once') === true ? context.sessionId : undefined;
      try {
        const job = cron.create({
          orgId: context.orgId,
          name: text('name'),
          schedule: text('schedule'),
          triggerMode,
          eventCooldownMs: cooldownMs,
          prompt: text('prompt'),
          kind: agent ? 'agent' : 'assistant',
          agentId: agent?.id,
          projectId: project?.id ?? context.projectId,
          sessionId: replyHere,
          once: flag('once'),
          enabled: flag('enabled'),
          createdBy: 'assistant',
        });
        const when = job.schedule ? describeCron(job.schedule) : 'on events only, no timetable';
        return { text: 'Schedule created: ' + when + '.\n' + line(job) };
      } catch (error) {
        return fail((error as Error).message);
      }
    }

    const job = cron.find(context.orgId, text('id'));
    if (!job) return fail('No schedule "' + text('id') + '". list_schedules shows the ids.');
    // The nightly memory run is Rookery's internal clockwork: it is not on
    // the list, and it is not the assistant's to delete, fire or reschedule.
    // The memory page owns it.
    if (job.kind === 'sleep') {
      return fail('"' + job.name + '" is the memory\'s own nightly run, not a schedule of yours. It is managed on the memory page.');
    }

    if (name === 'set_webhook') {
      if (text('action').toLowerCase() === 'remove') {
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

    if (name === 'delete_schedule') {
      cron.remove(job.id);
      return { text: 'Deleted schedule "' + job.name + '".' };
    }

    if (name === 'run_schedule') {
      if (cron.isRunning(job.id)) return { text: 'Schedule "' + job.name + '" is already running.' };
      void cron.runNow(job.id).catch((error: Error) => this.#log.warn('Manual schedule run failed', { error: error.message }));
      return { text: 'Schedule "' + job.name + '" is running now; the result will arrive in your inbox.' };
    }

    // update_schedule
    const patch: CronJobPatch = {};
    if (text('name')) patch.name = text('name');
    if (text('schedule')) patch.schedule = text('schedule');
    if (text('prompt')) patch.prompt = text('prompt');
    if (text('agent')) {
      const wanted = text('agent').toLowerCase();
      if (wanted === 'assistant' || wanted === 'me' || wanted === 'none') patch.agentId = null;
      else {
        const agent = this.#store.org.findAgent(context.orgId, text('agent'));
        if (!agent) return fail('No agent "' + text('agent') + '".');
        patch.agentId = agent.id;
      }
    }
    if (text('project')) {
      if (text('project').toLowerCase() === 'none') patch.projectId = null;
      else {
        const project = this.#store.org.findProject(context.orgId, text('project'));
        if (!project) return fail('No project "' + text('project') + '".');
        patch.projectId = project.id;
      }
    }
    if (triggerMode) patch.triggerMode = triggerMode;
    if (cooldownMs !== undefined) patch.eventCooldownMs = cooldownMs;
    if (flag('enabled') !== undefined) patch.enabled = flag('enabled');
    if (flag('once') !== undefined) patch.once = flag('once');
    if (!Object.keys(patch).length) return fail('Nothing to change; pass at least one field.');
    try {
      const updated = cron.update(job.id, patch);
      return { text: 'Updated schedule "' + updated.name + '": ' + Object.keys(patch).join(', ') + '.\n' + line(updated) };
    } catch (error) {
      return fail((error as Error).message);
    }
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
  #listeners(context: ToolContext, name: string, args: Record<string, unknown>): ToolCallResult {
    const text = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
    const flag = (key: string): boolean | undefined => (typeof args[key] === 'boolean' ? (args[key] as boolean) : undefined);
    const fail = (message: string): ToolCallResult => ({ text: message, isError: true });
    if (context.audience !== 'assistant') return fail('Only the assistant can change listeners.');
    const entries = this.#config.listeners.imap;
    const jobName = (jobId: string): string => this.#cron?.get(jobId)?.name ?? '(no schedule)';

    if (name === 'list_listeners') {
      if (!entries.length) return { text: 'No mailbox is being watched.' };
      return {
        text: entries
          .map(
            (entry) =>
              '- ' + entry.id + ': ' + entry.user + ' / ' + entry.mailbox + ' on ' + entry.host + ':' + entry.port +
              ', fires "' + jobName(entry.jobId) + '", ' + (entry.enabled ? 'on' : 'off') +
              ', password ' + (entry.password ? 'set' : 'missing'),
          )
          .join('\n'),
      };
    }

    const id = text('id');
    if (!id) return fail('Name the listener.');
    // It ends up in `imap:<id>` on every run this mailbox causes, so it has to
    // stay a plain word.
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return fail('A listener id is letters, digits, dot, dash or underscore.');
    const existing = entries.find((entry) => entry.id === id) ?? null;

    if (name === 'remove_listener') {
      if (!existing) return fail('No listener "' + id + '".');
      this.#writeListeners(entries.filter((entry) => entry.id !== id));
      return { text: 'Stopped watching "' + id + '" and forgot its settings, the password included.' };
    }

    const wantedJob = text('schedule') ? this.#cron?.find(context.orgId, text('schedule')) ?? null : null;
    if (text('schedule') && !wantedJob) {
      return fail('No schedule "' + text('schedule') + '". list_schedules shows the names.');
    }
    const merged: ImapListenerConfig = {
      id,
      enabled: flag('enabled') ?? existing?.enabled ?? false,
      host: text('host') || existing?.host || '',
      port: args.port === undefined ? existing?.port ?? 993 : clampNumber(args.port, 1, 65535, 993),
      secure: flag('secure') ?? existing?.secure ?? true,
      user: text('user') || existing?.user || '',
      password: text('password') || existing?.password || '',
      mailbox: text('mailbox') || existing?.mailbox || 'INBOX',
      jobId: wantedJob?.id ?? existing?.jobId ?? '',
    };
    const missing: string[] = [];
    if (!merged.host) missing.push('a server');
    if (!merged.user) missing.push('a user');
    if (!merged.jobId) missing.push('a schedule to fire');
    if (missing.length) return fail('This mailbox still needs ' + missing.join(', ') + '.');
    // Switched on without a password it would only produce a rejected login
    // and a stopped listener, which reads like a bug rather than a blank field.
    if (merged.enabled && !merged.password) return fail('Set the password before switching "' + id + '" on.');

    this.#writeListeners(existing ? entries.map((entry) => (entry.id === id ? merged : entry)) : [...entries, merged]);
    // The password is never repeated back, not even to the person who just
    // said it: a tool result is transcript too, and one copy is enough.
    return {
      text:
        (existing ? 'Updated mailbox "' : 'Now watching "') + id + '": ' + merged.user + ' / ' + merged.mailbox +
        ' on ' + merged.host + ':' + merged.port + ', firing "' + jobName(merged.jobId) + '", ' +
        (merged.enabled ? 'on.' : 'off - switch it on once the details are right.'),
    };
  }

  /** Write the list back; the server's registry follows on the event. */
  #writeListeners(imap: ImapListenerConfig[]): void {
    applyConfig(this.#config, { listeners: { imap } });
    this.emit('changed', { kind: 'listeners', id: 'listeners' });
  }

  async #assign(
    context: ToolContext,
    agentRef: string,
    titleRaw: string,
    task: string,
    projectRef: string,
    wait = true,
  ): Promise<ToolCallResult> {
    const fail = (message: string): ToolCallResult => ({ text: message, isError: true });
    if (!agentRef) return fail('Name the agent to assign to.');
    if (!task) return fail('The task is empty.');

    const agent = this.#store.org.findAgent(context.orgId, agentRef);
    if (!agent) {
      const known = this.#store.org.listAgents(context.orgId).map((entry) => entry.slug);
      return fail(
        'No agent "' + agentRef + '". ' +
          (known.length ? 'Known agents: ' + known.join(', ') + '.' : 'Nobody is hired yet.'),
      );
    }

    if (context.audience === 'agent') {
      if (agent.id === context.agentId) {
        // A self-assignment only makes sense detached: waiting on it would
        // just be the same process blocking on itself for no reason, and in
        // a chat turn there is no coding tool to do the work with anyway.
        if (wait) return fail('Taking work on yourself has to run in the background - call assign with wait=false.');
      } else if (agent.managerId !== context.agentId) {
        const reports = this.#store.org.listAgents(context.orgId, { managerId: context.agentId }).map((r) => r.slug);
        return fail(
          'You may only assign work to your direct reports' +
            (reports.length ? ': ' + reports.join(', ') : ', and you have none') + '.',
        );
      }
    }

    const depth = context.depth + 1;
    if (depth >= this.#config.org.maxDelegationDepth) {
      return fail('Delegation is nested too deep already. Do this part of the work yourself.');
    }

    let projectId = context.projectId;
    if (projectRef) {
      const project = this.#store.org.findProject(context.orgId, projectRef);
      if (!project) return fail('No project "' + projectRef + '".');
      projectId = project.id;
    }

    // Handing work to somebody puts it on the board like every other way in
    // (decision E9). This was the fourth entrance, and the only one that left
    // a run nobody could find on a card. Inside a task, the new one becomes a
    // child of it, so a delegation chain reads as a tree.
    const title = titleRaw.trim() || titleFromBrief(task);
    const board = this.#store.org.createTask({
      orgId: context.orgId,
      parentId: context.taskId,
      title,
      description: task,
      projectId,
      assigneeId: agent.id,
      createdBy: context.audience === 'agent' ? 'agent' : 'assistant',
      createdByAgentId: context.agentId,
    });
    this.#announceTask(board, context.emit);
    const shortId = board.id.slice(0, 8);

    // The new task is its own errand: the mail that started the caller's run
    // must not be answered by this one as well, and the note that continued
    // the caller's thread is not part of this brief.
    const runContext: ToolContext = {
      ...context,
      projectId,
      taskId: board.id,
      sourceMail: undefined,
      taskNote: undefined,
      emit: wait ? context.emit : (): void => undefined,
      signal: wait ? context.signal : undefined,
    };

    if (!wait) {
      // Detached: the turn ends while the agent works. Its progress reaches
      // every socket through the org-level run events; the turn's own stream
      // and abort signal must not be tied to it.
      const isSelf = agent.id === context.agentId;
      this.runTask(runContext, board)
        .then((finished) => {
          if (!isSelf) return undefined;
          // A self-assignment has nobody else waiting on assignment_status,
          // so it reports for itself the same way mail-triggered work does:
          // a mail addressed to the user.
          const body =
            finished.status === 'done'
              ? clip(finished.result ?? '', RESULT_BUDGET)
              : 'Could not finish: ' + (finished.error ?? finished.status) + '.';
          return this.#deliverMail({
            orgId: context.orgId,
            from: { kind: 'agent', id: agent.id },
            to: [{ kind: 'user' }],
            cc: [],
            subject: 'Re: ' + title,
            body,
            depth: 0,
            emit: () => undefined,
          });
        })
        .catch((error: unknown) => {
          this.#log.warn('Detached task failed', { agent: agent.slug, error: String(error) });
        });
      return {
        text: isSelf
          ? 'Started in the background as task ' + shortId + ' "' + title +
            '" - I will follow up in this chat once it is done.'
          : 'Handed to ' + agent.name + ' (' + agent.slug + ') as task ' + shortId + ' "' + title +
            '". It runs in the background and is on the board; the user is told when it finishes.',
      };
    }

    const finished = await this.runTask(runContext, board);
    const duration =
      finished.startedAt && finished.finishedAt
        ? ', ' + Math.round((finished.finishedAt - finished.startedAt) / 1000) + ' s'
        : '';

    if (finished.status === 'blocked') {
      // Not a failure: the agent asked whoever wanted the work a question,
      // and the card stays open until it is answered.
      return {
        text:
          agent.name + ' (' + agent.slug + ') has a question about task ' + shortId + ' "' + title +
          '"; it is waiting in the mail thread.' +
          (finished.result ? '\n\n' + clip(finished.result, RESULT_BUDGET) : ''),
      };
    }
    if (finished.status !== 'done') {
      return fail(
        'Task ' + shortId + ' "' + title + '" with ' + agent.slug + ' ' + finished.status +
          (finished.error ? ': ' + finished.error : '.'),
      );
    }
    return {
      text:
        'Report from ' + agent.name + ' (' + agent.slug + ') on task ' + shortId + ' "' + title + '"' +
        duration + ':\n\n' + clip(finished.result ?? '', RESULT_BUDGET),
    };
  }

  /** "user", "assistant", or an agent by slug/name/id - the tokens send_mail's to/cc take. */
  #resolveMailTarget(orgId: string, token: string): MailWho | null {
    const lower = token.toLowerCase();
    if (lower === 'user') return { kind: 'user' };
    if (lower === 'assistant') return { kind: 'assistant' };
    const agent = this.#store.org.findAgent(orgId, token);
    return agent ? { kind: 'agent', id: agent.id } : null;
  }

  #mailWhoLabel(who: MailWho): string {
    if (who.kind !== 'agent') return who.kind;
    return (who.id ? this.#store.org.getAgent(who.id)?.slug : undefined) ?? 'unknown agent';
  }

  /**
   * Whether `writer` already wrote to this recipient during the run that
   * started at `since` - that is, answered the mail with `send_mail` rather
   * than by ending its turn.
   *
   * Both are legitimate on their own: the turn's closing text is delivered
   * as the reply, and `send_mail` is how anyone here writes to anyone at
   * all. What is not legitimate is both, which is how a real answer was
   * followed by a second mail reading "Done - the reply went out". The
   * turn's own text loses, because by then the recipient has the answer in
   * writing and the leftover text is bookkeeping about it.
   *
   * `box` narrows the question to one line of the address: for the duplicate
   * reply any box counts, but a task only goes `blocked` on a To (decision
   * E6) - a Cc to the requester is information, not a question.
   */
  #answeredDuringTurn(
    orgId: string,
    writer: MailWho,
    recipient: MailWho,
    since: number,
    box?: 'to' | 'cc',
  ): boolean {
    const key = (who: MailWho): string => who.kind + ':' + (who.id ?? '');
    const wanted = key(recipient);
    return this.#store.org
      .mailbox(orgId, writer, 'outbox', { limit: 20 })
      .some(
        (sent) =>
          sent.createdAt >= since &&
          sent.recipients.some(
            (entry) =>
              (!box || entry.box === box) &&
              key({ kind: entry.recipientKind, id: entry.recipientId }) === wanted,
          ),
      );
  }

  /**
   * The Cc line of a reply: everyone who was on the mail being answered,
   * minus the two who are already on it - the sender, who is the reply's To,
   * and the replier itself.
   *
   * Every automatic reply used to go out with an empty Cc, which quietly
   * ended the thread for anyone looped in: somebody Cc'd on the opening mail
   * saw that one line and never an answer to it, and the assistant copying
   * the user in on a question it asked got the answer alone. Mail only works
   * if being on a conversation means staying on it.
   */
  #replyCc(source: Mail | null, replier: MailWho, sender: MailWho): MailWho[] {
    if (!source) return [];
    const key = (who: MailWho): string => who.kind + ':' + (who.id ?? '');
    const seen = new Set([key(replier), key(sender)]);
    const cc: MailWho[] = [];
    for (const recipient of source.recipients) {
      const who: MailWho = { kind: recipient.recipientKind, id: recipient.recipientId };
      if (seen.has(key(who))) continue;
      seen.add(key(who));
      cc.push(who);
    }
    // Whoever started the mail, when the reply is not addressed to them: an
    // answer still concerns the person who asked, even two hops down.
    const author: MailWho = { kind: source.fromKind, id: source.fromAgentId };
    if (!seen.has(key(author))) cc.push(author);
    return cc;
  }

  /**
   * Deliver mail and, per the user's rule, start a real run for every To
   * target that is an agent - never for Cc. Shared by the tool path
   * (`#sendMail`, permission-checked) and `sendUserMail` (the user may mail
   * anyone) and the automatic reply `run()` sends back when it finishes work
   * that arrived as mail.
   */
  async #deliverMail(params: {
    orgId: string;
    from: MailWho;
    to: MailWho[];
    cc: MailWho[];
    subject: string;
    body: string;
    inReplyTo?: string;
    threadId?: string;
    depth: number;
    parentAssignmentId?: string;
    projectId?: string;
    /** What thread this mail opens; only 'assignment' changes delivery. */
    kind?: MailThreadKind;
    /**
     * This mail is a finished run's own reply. It is delivered, but it wakes
     * nobody: an answer is not new work, and letting one start a run is what
     * turns two colleagues into an infinite exchange of pleasantries.
     */
    autoReply?: boolean;
    emit: (event: AgentEvent) => void;
  }): Promise<Mail> {
    const threadId =
      params.threadId ?? (params.inReplyTo ? (this.#store.org.getMail(params.inReplyTo)?.threadId ?? params.inReplyTo) : undefined);
    const mail = this.#store.org.sendMail({
      orgId: params.orgId,
      from: params.from,
      subject: params.subject,
      body: params.body,
      to: params.to,
      cc: params.cc,
      threadId,
      inReplyTo: params.inReplyTo,
      depth: params.depth,
      assignmentId: params.parentAssignmentId,
      kind: params.kind,
    });
    this.#announce({ type: 'mail', mail }, params.emit);

    // A task thread is dispatched by its task, never by the To line: the
    // thread's own row decides that, not the call's `kind` (decision E4).
    // Reading the parameter instead let a reply into a task thread - where
    // no caller passes a kind - start a second run beside the task, on no
    // board and on no card.
    let triggerTo = params.to;
    if (!params.autoReply && mail.threadKind === 'assignment') {
      this.#continueTask(mail, params.from, params.depth);
      // Who this thread belongs to has now been dealt with by the task. A
      // colleague on To who neither does this task nor asked for it is being
      // asked for something new, and still gets the run the agent prompt
      // promises them - delegation by mail is how work moves sideways here,
      // and a mail an agent writes from inside a task lands in this thread
      // whether it is about the task or not (`#sendMail` inherits it).
      const thread = this.#store.org.getMailThread(params.orgId, mail.threadId);
      const task = thread?.taskId ? this.#store.org.getTask(thread.taskId) : null;
      if (!task) return mail;
      triggerTo = params.to.filter((target) => !partyToTask(task, target));
      if (!triggerTo.length) return mail;
    }

    if (!params.autoReply && params.depth < this.#config.org.maxDelegationDepth) {
      const senderLabel = this.#mailWhoLabel(params.from);
      for (const target of triggerTo) {
        if (target.kind === 'assistant' && this.#runAssistantMail) {
          // Where the turn's own answer stops being the reply: if the
          // assistant wrote to the sender itself while thinking, that mail
          // is the answer, and delivering the turn's closing text on top of
          // it is how "Done - the reply went out" arrives as a second mail.
          const turnStartedAt = Date.now();
          this.#runAssistantMail({
            mail,
            senderLabel,
            thread: this.#store.org
              .thread(params.orgId, mail.threadId, { who: { kind: 'assistant' } })
              .filter((entry) => entry.id !== mail.id),
          })
            .then((reply) => {
              if (!reply.trim()) return;
              if (this.#answeredDuringTurn(params.orgId, { kind: 'assistant' }, params.from, turnStartedAt)) {
                this.#log.debug('Mail already answered by the turn itself', { mail: mail.id });
                return;
              }
              return this.#deliverMail({
                orgId: params.orgId,
                from: { kind: 'assistant' },
                to: [params.from],
                cc: this.#replyCc(mail, { kind: 'assistant' }, params.from),
                subject: mail.subject.startsWith('Re: ') ? mail.subject : 'Re: ' + mail.subject,
                body: reply,
                inReplyTo: mail.id,
                threadId: mail.threadId,
                depth: params.depth + 1,
                autoReply: true,
                emit: () => undefined,
              }).then(() => undefined);
            })
            .catch((error: unknown) => {
              this.#log.warn('Mail-triggered assistant turn failed', { error: String(error) });
            });
          continue;
        }
        if (target.kind !== 'agent' || !target.id) continue;
        const agent = this.#store.org.getAgent(target.id);
        if (!agent) continue;
        this.run({
          orgId: params.orgId,
          agent,
          // A human wrote the subject line; that is already a name, and the
          // same one the thread runs under (concept 7.2, source two).
          title: mail.subject.trim() || titleFromBrief(params.body),
          task:
            'Handle mail ' + mail.id + ' from ' + senderLabel + '.\nSubject: ' + mail.subject + '\n\n' + params.body,
          projectId: params.projectId,
          parentId: params.parentAssignmentId,
          requesterKind: params.from.kind,
          requesterAgentId: params.from.kind === 'agent' ? params.from.id : undefined,
          depth: params.depth,
          emit: () => undefined,
          sourceMail: {
            id: mail.id,
            threadId: mail.threadId,
            depth: params.depth,
            fromKind: params.from.kind,
            fromAgentId: params.from.id,
            subject: mail.subject,
          },
        }).catch((error: unknown) => {
          this.#log.warn('Mail-triggered run failed', { agent: agent.slug, error: String(error) });
        });
      }
    }
    return mail;
  }

  /**
   * A mail in a task thread continues its task; it never starts a run beside
   * it (decision E5). The task decides what happens, not the mail: a running
   * task only receives - the run it is in already has its prompt, and
   * aborting it would burn work that was started in good faith (F1) - while
   * a task that has stopped, however it stopped, runs again with this mail
   * as its brief. The new run hangs on the same task through
   * `linkTaskAssignment`, so the card keeps its whole chain, and the old
   * result stands until the new run has a better one.
   */
  #continueTask(mail: Mail, from: MailWho, depth: number): void {
    if (depth >= this.#config.org.maxDelegationDepth) return;
    const thread = this.#store.org.getMailThread(mail.orgId, mail.threadId);
    // A task thread with no task: the mail that opens one arrives here
    // before `sendTaskMail` has linked it, and its run is already on its
    // way. Nothing else may start a run in a thread that owns no task.
    if (!thread?.taskId) return;
    const task = this.#store.org.getTask(thread.taskId);
    if (!task || task.status === 'running') return;
    const agent = task.assigneeId ? this.#store.org.getAgent(task.assigneeId) : null;
    if (!agent) return;

    void this.runTask(
      {
        orgId: mail.orgId,
        audience: 'assistant',
        // One below the mail, so the leaf that carries out the task runs at
        // the mail's own depth - exactly where the To-trigger put it.
        depth: depth - 1,
        projectId: task.projectId,
        emit: () => undefined,
        sourceMail: {
          id: mail.id,
          threadId: mail.threadId,
          depth,
          fromKind: from.kind,
          fromAgentId: from.id,
          subject: mail.subject,
        },
        taskNote: this.#mailWhoLabel(from) + ' wrote back:\n\n' + mail.body,
      },
      task,
    ).catch((error: unknown) => {
      this.#log.warn('Task continuation failed', { task: task.id, error: String(error) });
    });
  }

  /**
   * A task and the thread it is negotiated in are one thing (concept section
   * 2), so a task that was not born as mail gets its work order written now:
   * one mail from whoever asked for it to whoever does it, opening the
   * thread the card is linked to.
   *
   * It delivers without triggering anything. An `assignment` thread is
   * dispatched by its task, and at this moment the thread carries no task id
   * yet - the link is made one line below - so `#continueTask` finds nothing
   * and returns. Whoever created the task starts the run.
   *
   * A task nobody is assigned to gets no thread yet: there would be no
   * second party to address, and it gets one as soon as it has an owner.
   */
  async #ensureTaskThread(task: Task, emit: (event: AgentEvent) => void): Promise<void> {
    if (this.#store.org.getMailThreadForTask(task.orgId, task.id)) return;
    if (!task.assigneeId || !this.#store.org.getAgent(task.assigneeId)) return;
    const from: MailWho =
      task.createdBy === 'user'
        ? { kind: 'user' }
        : task.createdBy === 'agent' && task.createdByAgentId
          ? { kind: 'agent', id: task.createdByAgentId }
          : { kind: 'assistant' };
    try {
      const mail = await this.#deliverMail({
        orgId: task.orgId,
        from,
        to: [{ kind: 'agent', id: task.assigneeId }],
        cc: [],
        subject: task.title,
        body: task.description,
        depth: 0,
        kind: 'assignment',
        projectId: task.projectId,
        emit,
      });
      this.#store.org.linkMailThreadTask(task.orgId, mail.threadId, task.id);
    } catch (error: unknown) {
      this.#log.warn('Task thread could not be opened', { task: task.id, error: String(error) });
    }
  }

  async #sendMail(
    context: ToolContext,
    toRaw: string,
    ccRaw: string,
    subject: string,
    body: string,
    inReplyTo?: string,
  ): Promise<ToolCallResult> {
    const fail = (message: string): ToolCallResult => ({ text: message, isError: true });
    if (!toRaw) return fail('Name at least one recipient in "to".');
    if (!subject) return fail('The mail needs a subject.');
    if (!body) return fail('The mail is empty.');

    const toTokens = toRaw.split(',').map((v) => v.trim()).filter(Boolean);
    const ccTokens = ccRaw.split(',').map((v) => v.trim()).filter(Boolean);

    const to: MailWho[] = [];
    for (const token of toTokens) {
      const target = this.#resolveMailTarget(context.orgId, token);
      if (!target) return fail('No agent "' + token + '".');
      to.push(target);
    }
    const cc: MailWho[] = [];
    for (const token of ccTokens) {
      const target = this.#resolveMailTarget(context.orgId, token);
      if (!target) return fail('No agent "' + token + '".');
      cc.push(target);
    }

    if (context.audience === 'agent') {
      const self = context.agentId ? this.#store.org.getAgent(context.agentId) : null;
      for (const target of [...to, ...cc]) {
        if (target.kind !== 'agent') continue; // user and assistant are always reachable
        const recipient = this.#store.org.getAgent(target.id ?? '');
        const allowed =
          recipient?.id === self?.managerId ||
          recipient?.managerId === context.agentId ||
          (Boolean(self?.teamId) && recipient?.teamId === self?.teamId);
        if (!allowed) return fail('You may mail your manager, your team, your reports, the assistant, or the user.');
      }
    }

    const from: MailWho = context.audience === 'agent' ? { kind: 'agent', id: context.agentId } : { kind: 'assistant' };
    const depth = context.sourceMail ? context.sourceMail.depth + 1 : 0;
    const mail = await this.#deliverMail({
      orgId: context.orgId,
      from,
      to,
      cc,
      subject,
      // A mail a scheduled run writes opens a report thread - it exists
      // because a run produced it, no matter which box it came from. Replies
      // inherit their thread anyway; only new threads land here.
      kind: context.scheduled ? 'report' : undefined,
      body,
      inReplyTo,
      threadId: inReplyTo ? undefined : context.sourceMail?.threadId,
      depth,
      parentAssignmentId: context.parentAssignmentId,
      projectId: context.projectId,
      emit: context.emit,
    });
    return { text: 'Mail sent to ' + [...to, ...cc].map((who) => this.#mailWhoLabel(who)).join(', ') + ': "' + mail.subject + '".' };
  }

  /**
   * The user sends mail to anyone, no permission circle applied - the one
   * entrance behind `POST /api/org/mail`.
   *
   * What comes of it is read off the address line, never off a switch the
   * user has to remember afterwards (decisions E2 and E3): exactly one agent
   * on To is a work order and opens a task, Cc whoever you like. The
   * assistant on To, the user on To, or several people on To is a
   * conversation - the agents among them are woken exactly as before, and no
   * card is created, because splitting work is `plan_task`'s job and not the
   * address line's.
   *
   * A reply opens nothing either way: the thread it lands in decided long ago
   * what it is, and a task thread carries its own task on (decision E5).
   */
  async sendUserMail(input: {
    orgId: string;
    to: string[];
    cc?: string[];
    subject: string;
    body: string;
    inReplyTo?: string;
    projectId?: string;
    emit?: (event: AgentEvent) => void;
  }): Promise<{ mail: Mail; task?: Task }> {
    const resolve = (token: string): MailWho => {
      const target = this.#resolveMailTarget(input.orgId, token);
      if (!target) throw new Error('No agent "' + token + '".');
      return target;
    };
    const to = input.to.map(resolve);
    const soleRecipient = input.to.length === 1 ? input.to[0] : undefined;
    if (!input.inReplyTo && soleRecipient !== undefined && to.length === 1 && to[0]?.kind === 'agent') {
      return this.sendTaskMail({
        orgId: input.orgId,
        to: soleRecipient,
        cc: input.cc,
        subject: input.subject,
        body: input.body,
        projectId: input.projectId,
        emit: input.emit,
      });
    }
    const mail = await this.#deliverMail({
      orgId: input.orgId,
      from: { kind: 'user' },
      to,
      cc: (input.cc ?? []).map(resolve),
      subject: input.subject,
      body: input.body,
      inReplyTo: input.inReplyTo,
      depth: 0,
      projectId: input.projectId,
      emit: input.emit ?? (() => undefined),
    });
    return { mail };
  }

  /**
   * A work order as mail: one agent on the To line, one task on the board,
   * one thread tying them together. The mail opens an `assignment` thread -
   * delivered, but not auto-triggered, because the run happens here over the
   * task, which is what keeps assignment, board and mail the same story.
   * The agent's finished run replies into the thread; marking the task done
   * posts a status note into it (see `notifyTaskStatus`).
   */
  async sendTaskMail(input: {
    orgId: string;
    to: string;
    cc?: string[];
    subject: string;
    body: string;
    projectId?: string;
    emit?: (event: AgentEvent) => void;
  }): Promise<{ mail: Mail; task: Task }> {
    const target = this.#resolveMailTarget(input.orgId, input.to);
    if (!target || target.kind !== 'agent' || !target.id) throw new Error('A work order needs exactly one agent on the To line.');

    const task = this.#store.org.createTask({
      orgId: input.orgId,
      title: input.subject.trim() || '(no subject)',
      description: input.body,
      assigneeId: target.id,
      createdBy: 'user',
      projectId: input.projectId,
    });
    this.#announceTask(task, input.emit ?? (() => undefined));

    const mail = await this.#deliverMail({
      orgId: input.orgId,
      from: { kind: 'user' },
      to: [target],
      cc: (input.cc ?? [])
        .map((token) => this.#resolveMailTarget(input.orgId, token))
        .filter((who): who is MailWho => who !== null),
      subject: input.subject,
      body: input.body,
      depth: 0,
      kind: 'assignment',
      projectId: input.projectId,
      emit: input.emit ?? (() => undefined),
    });
    this.#store.org.linkMailThreadTask(input.orgId, mail.threadId, task.id);

    // The run goes over the task, so the board keeps the assignment and the
    // task's own trail. sourceMail is what makes the finished run mail its
    // result back into this thread. Fire-and-forget like every delivery
    // trigger: the mail exists, the answer arrives when it arrives.
    void this.runTask(
      {
        orgId: input.orgId,
        audience: 'assistant',
        depth: -1,
        projectId: input.projectId,
        emit: () => undefined,
        sourceMail: { id: mail.id, threadId: mail.threadId, depth: 0, fromKind: 'user', subject: mail.subject },
      },
      this.#store.org.getTask(task.id) ?? task,
    ).catch((error: unknown) => {
      this.#log.warn('Task run for assignment mail failed', { task: task.id, error: String(error) });
    });

    return { mail, task };
  }

  /**
   * A task's status change, told to its thread: a system note from the
   * assistant as a reply, so the mail trail shows not just the work order
   * and the result but also how the work ended. Never throws, and never
   * wakes anyone - `autoReply` delivers without triggering.
   *
   * It writes only when the thread has heard nothing else about this ending
   * (decision E7). A finished run mails its result and a stuck one mails its
   * question; both are the message, and a note repeating them is the same
   * news twice. What the thread never hears on its own is a run that failed
   * or was called off, and that is what the note is for.
   *
   * `since` is when this ending began - a run passes its own start, so only
   * that run's mail can speak for it. A change made by hand has no run and
   * passes nothing: it happens now, the thread has said nothing about it,
   * and the note always goes out. Judging every ending against the first
   * run's start left a task cancelled by hand hours later silent, because
   * the old result reply still counted as news about it.
   */
  async notifyTaskStatus(
    task: Task,
    status: 'done' | 'failed' | 'cancelled' | 'blocked',
    since: number = Date.now(),
  ): Promise<void> {
    const orgId = task.orgId;
    const thread = this.#store.org.getMailThreadForTask(orgId, task.id);
    if (!thread) return;
    const mails = this.#store.org.thread(orgId, thread.threadId, { limit: 50 });
    const latest = mails.at(-1);
    if (!latest) return;
    // Anyone but the person who asked: their own mail is the work order or a
    // follow-up to it, never an answer. Asking "not the user" instead
    // silenced every task nobody mailed in - `#ensureTaskThread` writes that
    // work order from the assistant or a lead, one millisecond before the
    // run starts, so a delegated task that failed said nothing at all.
    const asked = (entry: Mail): boolean =>
      entry.fromKind === task.createdBy && (task.createdBy !== 'agent' || entry.fromAgentId === task.createdByAgentId);
    if (mails.some((entry) => entry.createdAt >= since && !asked(entry))) return;
    try {
      await this.#deliverMail({
        orgId,
        from: { kind: 'assistant' },
        to: [{ kind: 'user' }],
        // Everyone the conversation already has stays on it; the status note
        // is bookkeeping, but bookkeeping the assignee should see.
        cc: this.#replyCc(latest, { kind: 'assistant' }, { kind: 'user' }),
        subject: latest.subject.startsWith('Re: ') ? latest.subject : 'Re: ' + latest.subject,
        body: statusNote(task, status),
        inReplyTo: latest.id,
        threadId: thread.threadId,
        depth: latest.depth + 1,
        autoReply: true,
        emit: () => undefined,
      });
    } catch (error: unknown) {
      this.#log.warn('Task status mail failed', { task: task.id, error: String(error) });
    }
  }

  /** Emit into the turn that caused an event, and to everyone listening on the controller. */
  #announce(event: Extract<AgentEvent, { type: 'assignment' | 'message' | 'mail' }>, emit: (event: AgentEvent) => void): void {
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
   * agent's own prompt, memory, inbox and tools. Never throws; the returned
   * record says how it ended. Events flow to `input.emit` as they happen.
   */
  async run(input: RunAssignmentInput): Promise<Assignment> {
    const { agent } = input;
    const org = this.#store.org;
    const project = input.projectId ? org.getProject(input.projectId) : null;
    let assignment = org.createAssignment({
      orgId: input.orgId,
      agentId: agent.id,
      title: input.title,
      task: input.task,
      projectId: project?.id,
      sessionId: input.sessionId,
      parentId: input.parentId,
      requesterKind: input.requesterKind,
      requesterAgentId: input.requesterAgentId,
      depth: input.depth,
    });

    const view = (extra: Partial<AssignmentView> = {}): AssignmentView => toView(assignment, agent, extra);
    const announce = (extra: Partial<AssignmentView> = {}): void =>
      this.#announce({ type: 'assignment', assignment: view(extra) }, input.emit);
    const finish = (patch: Parameters<typeof org.updateAssignment>[1], extra: Partial<AssignmentView> = {}): Assignment => {
      org.updateAssignment(assignment.id, patch);
      assignment = org.getAssignment(assignment.id) ?? assignment;
      announce(extra);
      return assignment;
    };
    const fail = (error: string, started: number): Assignment => {
      const failed = finish(
        { status: 'failed', error, finishedAt: Date.now(), durationMs: Date.now() - started },
        { error },
      );
      // Every fail() path is a hard signal (timeout, no provider, empty
      // output, a fatal provider error) - no model call, and it marks the run
      // as a technical failure rather than a quality judgement (see
      // docs/concepts/agent-performance-management.md). A write that cannot
      // land must never take the assignment result down with it.
      try {
        org.upsertReview({
          orgId: input.orgId,
          agentId: agent.id,
          assignmentId: assignment.id,
          source: 'system',
          overall: 1,
          failedRun: true,
        });
      } catch (reviewError) {
        this.#log.warn('System review failed to write', {
          assignment: assignment.id,
          error: (reviewError as Error).message,
        });
      }
      return failed;
    };

    // One abort controller per assignment, live from the moment it is queued:
    // the caller going away, a cancel() by id and the timeout all end in it.
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    input.signal?.addEventListener('abort', onAbort, { once: true });
    let cancelledBy: string | null = null;
    this.#active.set(assignment.id, (by) => {
      cancelledBy = by;
      controller.abort();
    });
    // The live log lives from the moment the run is queued: watching a
    // pending assignment is legal, it simply has nothing to show yet. Its
    // journal opens here too, under the assignment's own id - the buffer is
    // the transport's convenience, the journal is the record, and one without
    // the other is exactly the half that does not survive a reload.
    this.#logs.set(assignment.id, new AssignmentLogBuffer());
    this.#store.turns.beginAssignment(assignment.id, input.sessionId, Date.now());
    const cancelled = (): boolean => cancelledBy !== null || Boolean(input.signal?.aborted);

    announce();
    await this.#acquire(controller.signal);
    const started = Date.now();

    try {
      if (controller.signal.aborted) return finish({ status: 'cancelled', finishedAt: started, durationMs: 0 });

      const preferred = agent.provider ?? this.#config.defaultProvider;
      const providerId = await this.#registry.resolveUsable(preferred);
      if (!providerId) {
        // A company parked entirely for quota says so: there is nothing to
        // log in to, only windows to wait out.
        const ready = (await this.#registry.statuses()).filter((status) => status.available && status.authenticated);
        return fail(
          ready.length > 0 && ready.every((status) => providerBlocked(status.id))
            ? 'Every provider is out of quota.'
            : 'No provider is logged in.',
          started,
        );
      }

      const cwd = project?.path || agentWorkspace(this.#config, agent.id);
      if (!existsSync(cwd)) return fail('The project directory ' + cwd + ' does not exist.', started);

      // Everything below is shared by every provider attempt of this
      // assignment: the company, the memory, the inbox and the skills are the
      // agent's, not the backend's.
      const snapshot = this.snapshot(input.orgId);
      const memories = this.#memoriesFor(agent.id, input.task);
      const mailWho: MailWho = { kind: 'agent', id: agent.id };
      const unreadMail = org.unreadMailFor(input.orgId, mailWho);
      const requester =
        input.requesterKind === 'agent'
          ? (org.getAgent(input.requesterAgentId ?? '')?.name ?? 'your manager')
          : input.requesterKind === 'user'
            ? 'the user, directly'
            : 'the assistant';
      // Read once the context is assembled: the mail is in the prompt, so a
      // provider switch must not deliver it a second time.
      if (unreadMail.length) org.markMailReadFor(unreadMail, mailWho);

      // The project's own MCP servers - read from its `.mcp.json`, the same
      // file a person's own session in that folder would read - only start
      // once the assistant has approved this exact file (see
      // trust_project_mcp). Untrusted or changed, they stay off and the
      // agent is told why instead of silently missing tools it expects.
      const projectMcp = project?.path ? readProjectMcpFile(project.path) : null;
      const projectMcpState = projectMcpStatus(projectMcp, project?.mcpTrust);
      const projectMcpSpecs = projectMcpState === 'trusted' && projectMcp ? projectMcp.servers : [];
      // Rookery searches its own shelf rather than trusting the agent to
      // remember: the index says what exists, the hint says how much more is
      // installed, and the third line is the two or three that look like this
      // assignment - put there the way a recalled memory is, not left to a
      // tool call somebody has to think of.
      const agentSkills = this.#agentSkills(project);
      const skillsIndex = [
        renderSkillsIndex(agentSkills),
        renderExternalSkillsHint(this.#config, 'agent'),
        renderSkillMatches(matchSkills(this.#config, 'agent', agentSkills, input.task)),
      ]
        .filter(Boolean)
        .join('\n\n');

      // The timeout and the bridge token span every provider attempt: a
      // switch does not buy a second timeout, and the bridge serves whichever
      // process is currently running.
      const timer = setTimeout(() => controller.abort(), this.#config.org.assignmentTimeoutMs);
      timer.unref?.();
      const token = this.register({
        orgId: input.orgId,
        audience: 'agent',
        agentId: agent.id,
        sessionId: input.sessionId,
        projectId: project?.id,
        parentAssignmentId: assignment.id,
        // What this run is carrying out, so anything it hands on lands under
        // the same card instead of starting a second one (decision E9).
        taskId: input.taskId,
        depth: input.depth,
        emit: input.emit,
        signal: controller.signal,
        scheduled: input.scheduled,
        sourceMail: input.sourceMail,
      });

      let text = '';
      let fatal: string | null = null;
      /** The provider and model the assignment ends up having run with. */
      let usedProvider = providerId;
      let usedModel = agent.model;
      const tried = new Set<ProviderId>([providerId]);

      try {
        for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
          const pid = usedProvider;
          // A different backend serves different names; the fallback
          // provider's own default stands in for a model it has never
          // heard of.
          usedModel = attempt === 1 ? agent.model : remapModel(pid, agent.model);

          finish({ status: 'running', provider: pid, model: usedModel, startedAt: started });

          await ensureToolServers(this.#config, 'agent', pid, project?.id, (id, error) =>
            this.#log.warn('Tool server could not prepare', { id, error: error.message }),
          );
          const extra = toolServersFor(this.#config, 'agent', pid, project?.id);
          const toolHints = [...extra.hints];
          if (projectMcp?.servers.length && projectMcpState !== 'trusted') {
            toolHints.push(
              "This project's .mcp.json lists " + projectMcp.servers.length + ' MCP server(s) not yet trusted' +
                (projectMcpState === 'changed' ? ' (the file changed since it was approved)' : '') +
                '; the assistant can review them with project_mcp_servers and trust_project_mcp.',
            );
          }

          const systemPrompt = buildAgentPrompt({
            config: this.#config,
            agent,
            snapshot,
            project: project ?? undefined,
            memories,
            mail: unreadMail,
            assignmentId: assignment.id,
            requestedBy: requester,
            sourceMailSubject: input.sourceMail?.subject,
            sourceMailId: input.sourceMail?.id,
            sourceMailThreadId: input.sourceMail?.threadId,
            // Everything said before the mail that woke this run, minus that mail
            // itself - it is already the task above. Listed as an index only; the
            // prompt points at `read_mail_thread` for the text.
            sourceMailThread: input.sourceMail
              ? org
                  .thread(input.orgId, input.sourceMail.threadId, { who: mailWho })
                  .filter((entry) => entry.id !== input.sourceMail?.id)
              : undefined,
            toolHints,
            skillsIndex,
            agentNotes: org.agentNotesSince(agent.id).slice(0, 2),
            handoverFrom: this.#handoverFor(agent),
          });

          // A switch discards the dead attempt's partial text: an assignment
          // has no resume, so it starts over rather than stitching.
          text = '';
          let sinceProgress = 0;
          fatal = null;
          this.#logReset(assignment.id);

          try {
            const mcp = await this.#bridge.spec(token);
            const mcpExtra = [...extra.specs, ...projectMcpSpecs];
            for await (const event of this.#registry.get(pid).run({
              prompt: input.task,
              systemPrompt,
              model: usedModel,
              effort: this.#config.defaultEffort,
              cwd,
              permission: agent.permission ?? this.#config.defaultPermission,
              mcp,
              mcpExtra: mcpExtra.length ? mcpExtra : undefined,
              // Approved subagents and hooks out of the Claude Code
              // installation, plus Rookery's own permission floor.
              ...externalTurnExtras(this.#config, 'agent'),
              signal: controller.signal,
            })) {
              if (event.type === 'text') {
                this.#logPush(assignment.id, event);
                text += event.delta;
                sinceProgress += event.delta.length;
                if (sinceProgress >= PROGRESS_EVERY) {
                  sinceProgress = 0;
                  org.updateAssignment(assignment.id, { chars: text.length });
                  announce({ chars: text.length, preview: shorten(tail(text, 160), 110) });
                }
              } else if (event.type === 'thinking') {
                this.#logPush(assignment.id, event);
              } else if (event.type === 'tool') {
                // The live log keeps the raw event: the `[slug]` prefix below
                // is for the parent turn's stream, not this run's own log.
                this.#logPush(assignment.id, event);
                input.emit({ ...event, detail: '[' + agent.slug + '] ' + (event.detail ?? '') });
                // A tool starting is the one moment worth telling everyone about,
                // not just the turn that started this run - the same `announce`
                // that already carries `chars`/`preview` org-wide, extended with
                // what the run is doing right now. Not persisted, same as
                // `preview`: a live-only field, gone once the run finishes.
                if (event.status === 'start') {
                  announce({ lastActivity: { kind: 'tool', label: event.name, at: Date.now() } });
                }
              } else if (event.type === 'done') {
                text = event.text || text;
              } else if (event.type === 'error' && event.fatal) {
                this.#logPush(assignment.id, event);
                fatal = event.message;
              }
            }
          } catch (error) {
            fatal = (error as Error).message;
          }

          // Only a usage-limit death goes around once more, on a provider
          // that has not been tried yet; anything else falls through to the
          // ordinary ending below. Cancelled and timed-out runs are never
          // retried on another backend.
          if (
            fatal === null ||
            !isUsageLimitError(fatal) ||
            attempt >= MAX_PROVIDER_ATTEMPTS ||
            cancelled() ||
            controller.signal.aborted ||
            !this.#config.providerFallback.enabled
          ) {
            break;
          }
          rememberUsageFailure(pid);
          const alternate = await this.#registry.resolveUsable(preferred, { exclude: [...tried] });
          if (!alternate) break;
          const switchEvent: Extract<AgentEvent, { type: 'status' }> = {
            type: 'status',
            label: 'provider',
            detail: pid + ' hit its usage limit, continuing on ' + alternate,
          };
          this.#logPush(assignment.id, switchEvent);
          input.emit(switchEvent);
          announce({ lastActivity: { kind: 'status', label: 'provider', at: Date.now() } });
          usedProvider = alternate;
          tried.add(alternate);
        }
      } finally {
        clearTimeout(timer);
        this.unregister(token);
      }

      if (cancelled()) {
        return finish({ status: 'cancelled', finishedAt: Date.now(), durationMs: Date.now() - started });
      }
      if (controller.signal.aborted) return fail('Timed out.', started);
      if (fatal) return fail(fatal, started);
      if (!text.trim()) return fail('The agent produced no output.', started);

      const done = finish(
        { status: 'done', result: text, chars: text.length, finishedAt: Date.now(), durationMs: Date.now() - started },
        { chars: text.length, preview: shorten(tail(text, 160), 110) },
      );
      // A scheduled assignment does not learn: its "task" is the job's own
      // prompt, written once when the schedule was created, and every firing
      // would otherwise quote it back into the bank as if it were news.
      if (this.#config.memory.enabled && this.#config.memory.autoExtract && !input.scheduled) {
        void this.#learn(agent, input.task, text, usedProvider);
      }
      if (this.#config.org.autoReview) void this.#review(agent, done, input.task, text, usedProvider);
      if (input.onAskedRequester) {
        // Who asked for this: the sender of the mail that started the run,
        // or else whoever handed the assignment over.
        const requester: MailWho = input.sourceMail
          ? { kind: input.sourceMail.fromKind, id: input.sourceMail.fromAgentId }
          : { kind: input.requesterKind, id: input.requesterAgentId };
        input.onAskedRequester(
          this.#answeredDuringTurn(input.orgId, { kind: 'agent', id: agent.id }, requester, started, 'to'),
        );
      }
      if (input.sourceMail) {
        const sourceMail = input.sourceMail;
        const replier: MailWho = { kind: 'agent', id: agent.id };
        const sender: MailWho = { kind: sourceMail.fromKind, id: sourceMail.fromAgentId };
        // An agent that mailed the requester itself has already answered;
        // the report would arrive behind it as a duplicate.
        if (this.#answeredDuringTurn(input.orgId, replier, sender, started)) return done;
        this.#deliverMail({
          orgId: input.orgId,
          from: replier,
          to: [sender],
          // Everyone the mail was addressed to stays addressed: a reply that
          // drops the Cc is where a thread silently loses its audience.
          cc: this.#replyCc(this.#store.org.getMail(sourceMail.id), replier, sender),
          subject: 'Re: ' + sourceMail.subject,
          body: text,
          inReplyTo: sourceMail.id,
          threadId: sourceMail.threadId,
          depth: sourceMail.depth + 1,
          // The reply carries the run that produced it; the thread's task, if
          // it has one, is one `task_assignments` hop away from here.
          parentAssignmentId: assignment.id,
          projectId: project?.id,
          autoReply: true,
          emit: input.emit,
        }).catch((error: unknown) => {
          this.#log.warn('Mail reply failed', { agent: agent.slug, error: String(error) });
        });
      }
      return done;
    } catch (error) {
      this.#log.warn('Assignment failed', { id: assignment.id, error: (error as Error).message });
      return fail((error as Error).message, started);
    } finally {
      const log = this.#logs.get(assignment.id);
      if (log) {
        // The run is over: live watchers hear it from the `assignment`
        // broadcast `finish()` already sent, generators end here, and the
        // buffer itself is gone. The journal stays - after a run, its
        // transcript remains readable instead of only the result.
        log.end();
        this.#logs.delete(assignment.id);
      }
      this.#store.turns.settle(assignment.id, 'done', Date.now());
      this.#active.delete(assignment.id);
      input.signal?.removeEventListener('abort', onAbort);
      this.#release();
    }
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
      .listAssignments(orgId, { limit: 500 })
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

  #updateSettings(context: ToolContext, args: Record<string, unknown>): ToolCallResult {
    const text = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
    const fail = (message: string): ToolCallResult => ({ text: message, isError: true });
    if (context.audience !== 'assistant') return fail('Only the assistant can change settings.');

    const patch: Omit<Partial<RookeryConfig>, 'org'> & { org?: Partial<RookeryConfig['org']> } = {};
    if (text('defaultProvider')) {
      const provider = this.#asProvider(text('defaultProvider'));
      if (!provider) return fail('No provider "' + text('defaultProvider') + '". Configured: ' + this.#providerIds() + '.');
      patch.defaultProvider = provider;
    }
    // An empty string clears a setting: the merge skips undefined, and
    // loadConfig turns '' back into "unset".
    if (text('defaultModel')) patch.defaultModel = text('defaultModel') === 'default' ? '' : text('defaultModel');
    if (text('defaultEffort')) {
      const effort = text('defaultEffort');
      if (effort === 'default') patch.defaultEffort = '' as EffortLevel;
      else if ((EFFORT_LEVELS as readonly string[]).includes(effort)) patch.defaultEffort = effort as EffortLevel;
      else return fail('Effort must be one of ' + EFFORT_LEVELS.join(', ') + ', or default.');
    }
    const org: Partial<RookeryConfig['org']> = {};
    if (args.maxConcurrentAssignments !== undefined) {
      org.maxConcurrentAssignments = clampNumber(args.maxConcurrentAssignments, 1, 16, 4);
    }
    if (args.maxDelegationDepth !== undefined) org.maxDelegationDepth = clampNumber(args.maxDelegationDepth, 1, 6, 3);
    if (args.assignmentTimeoutMinutes !== undefined) {
      org.assignmentTimeoutMs = clampNumber(args.assignmentTimeoutMinutes, 1, 600, 45) * 60 * 1000;
    }
    if (Object.keys(org).length) patch.org = org;
    if (!Object.keys(patch).length) return fail('Nothing to change.');

    // applyConfig writes ~/.rookery/config.json and refreshes the one config
    // object the runtime and the server share, dropping the keys a cleared
    // setting leaves behind.
    applyConfig(this.#config, patch as Partial<RookeryConfig>);
    this.emit('changed', { kind: 'config', id: 'config' });
    return { text: 'Settings updated.\n' + describeSettings(this.#config) };
  }

  /* ------------------------------- structure ------------------------------ */

  async #updateAgent(context: ToolContext, args: Record<string, unknown>): Promise<ToolCallResult> {
    const text = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
    const fail = (message: string): ToolCallResult => ({ text: message, isError: true });
    if (context.audience !== 'assistant') return fail('Only the assistant can change staff.');
    const agent = this.#store.org.findAgent(context.orgId, text('agent'));
    if (!agent) return fail('No agent "' + text('agent') + '".');

    const newInstructions = text('instructions');
    // Once an agent is flagged (stage >= 1), a silent instruction change is
    // the exact failure `agent_actions` exists to prevent - "protocol before
    // effect", decision E1. Below stage 1 this is unchanged: a free
    // restructuring of the company is not a personnel action.
    if (newInstructions && newInstructions !== agent.instructions) {
      const stage = this.#store.org.performance(agent.id).stage;
      if (stage >= 1 && !text('reason')) {
        return fail(
          agent.name + ' is at escalation stage ' + stage + '; changing standing instructions needs a "reason" ' +
            '(it is written to the personnel record as a reconfig). Use agent_performance to see why.',
        );
      }
    }

    const patch: Parameters<OrgStore['updateAgent']>[1] = {};
    if (text('name')) patch.name = text('name');
    if (text('title')) patch.title = text('title');
    if (newInstructions) patch.instructions = newInstructions;
    if (text('team')) {
      if (text('team').toLowerCase() === 'none') patch.teamId = null;
      else {
        const team = this.#store.org.findTeam(context.orgId, text('team'));
        if (!team) return fail('No team "' + text('team') + '".');
        patch.teamId = team.id;
      }
    }
    if (text('manager')) {
      if (text('manager').toLowerCase() === 'assistant') patch.managerId = null;
      else {
        const manager = this.#store.org.findAgent(context.orgId, text('manager'));
        if (!manager) return fail('No agent "' + text('manager') + '".');
        if (manager.id === agent.id) return fail('An agent cannot be its own manager.');
        patch.managerId = manager.id;
      }
    }
    // An id the registry does not serve clears the preference back to the
    // company default, the same way an unknown permission does below.
    if (text('provider')) patch.provider = this.#asProvider(text('provider')) ?? null;
    if (text('model')) patch.model = text('model');
    if (text('permission')) patch.permission = asPermission(text('permission')) ?? null;
    if (typeof args.archived === 'boolean') patch.archived = args.archived;

    this.#store.org.updateAgent(agent.id, patch);
    // A `reason` on an instructions change is a personnel action by hand,
    // same rule as the automatic one in #develop: the record and the change
    // land together (decision E1). `stage` here is the one this reconfig
    // responds to, not necessarily still current a moment later.
    if (patch.instructions && text('reason')) {
      const stage = this.#store.org.performance(agent.id).stage;
      this.#store.org.createAction({
        orgId: context.orgId,
        agentId: agent.id,
        kind: 'reconfig',
        stage: Math.max(stage, 1),
        reason: text('reason'),
        beforeText: agent.instructions,
        afterText: patch.instructions,
        decidedBy: 'assistant',
      });
    }
    this.emit('changed', { kind: 'agent', id: agent.id });
    return { text: 'Updated ' + agent.name + ' (' + agent.slug + '): ' + Object.keys(patch).join(', ') + '.' };
  }

  async #updateTeam(context: ToolContext, args: Record<string, unknown>): Promise<ToolCallResult> {
    const text = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
    const fail = (message: string): ToolCallResult => ({ text: message, isError: true });
    if (context.audience !== 'assistant') return fail('Only the assistant can change teams.');
    const team = this.#store.org.findTeam(context.orgId, text('team'));
    if (!team) return fail('No team "' + text('team') + '".');
    const patch: Parameters<OrgStore['updateTeam']>[1] = {};
    if (text('name')) patch.name = text('name');
    if (text('purpose')) patch.purpose = text('purpose');
    if (text('lead')) {
      if (text('lead').toLowerCase() === 'none') patch.leadId = null;
      else {
        const lead = this.#store.org.findAgent(context.orgId, text('lead'));
        if (!lead) return fail('No agent "' + text('lead') + '".');
        patch.leadId = lead.id;
      }
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
    const matches = this.#store.org.listAllTasks(orgId, 500).filter((task) => task.id.startsWith(wanted));
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }

  async #updateTask(context: ToolContext, args: Record<string, unknown>): Promise<ToolCallResult> {
    const text = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
    const fail = (message: string): ToolCallResult => ({ text: message, isError: true });
    const task = this.findTask(context.orgId, text('id'));
    if (!task) return fail('No task ' + text('id') + '.');
    if (task.status === 'running') {
      // The one edit allowed mid-run: pulling the plug. The run loop writes
      // the final status itself once its assignments have stopped.
      if (text('status') === 'cancelled' && this.cancelTask(task.id)) {
        return { text: 'Cancelling task "' + task.title + '" and everything it started.' };
      }
      return fail('The task is running; wait for it to finish, or cancel it with status "cancelled".');
    }
    const patch: Parameters<OrgStore['updateTask']>[1] = {};
    if (text('title')) patch.title = text('title');
    if (text('description')) patch.description = text('description');
    if (text('priority')) patch.priority = asPriority(text('priority'));
    if (text('assignee')) {
      if (text('assignee').toLowerCase() === 'none') patch.assigneeId = null;
      else {
        const agent = this.#store.org.findAgent(context.orgId, text('assignee'));
        if (!agent) return fail('No agent "' + text('assignee') + '".');
        patch.assigneeId = agent.id;
      }
    }
    const status = text('status');
    if (status === 'open' || status === 'done' || status === 'cancelled' || status === 'blocked') {
      patch.status = status;
      if (status !== 'open') patch.finishedAt = Date.now();
      if (text('result')) patch.result = text('result');
    }
    this.#store.org.updateTask(task.id, patch);
    const updated = this.#store.org.getTask(task.id) ?? task;
    this.#announceTask(updated, context.emit);
    return { text: 'Updated task "' + updated.title + '": ' + Object.keys(patch).join(', ') + '.' };
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

    for (const child of this.#store.org.listTasks(context.orgId, { parentId: task.id })) {
      if (child.status === 'open' || child.status === 'planned') {
        this.#store.org.updateTask(child.id, { status: 'cancelled', finishedAt: Date.now() });
      }
    }

    const bySlug = new Map(snapshot.agents.map((agent) => [agent.slug, agent]));
    if (plan.mode === 'split') {
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
    } else {
      this.#store.org.updateTask(task.id, {
        status: 'planned',
        planNote: plan.reason,
        assigneeId: plan.assignee ? (bySlug.get(plan.assignee)?.id ?? null) : null,
      });
    }
    this.#announceTask(this.#store.org.getTask(task.id) ?? task, context.emit);
    return plan;
  }

  /**
   * Run a task to completion. Unplanned tasks are planned first. Subtasks
   * run as assignments in dependency waves; the parent collects their
   * reports. Never throws; the returned task says how it ended.
   */
  async runTask(outer: ToolContext, task: Task): Promise<Task> {
    const org = this.#store.org;
    const reload = (): Task => org.getTask(task.id) ?? task;
    // A task's row only says `running` once planning has finished, and
    // planning awaits - so two first invocations (a double-click before the
    // first scheduling) both read a not-yet-running row and both plan. The
    // claim on `#activeTasks` below is written before the first await, which
    // makes it the one check a concurrent invocation cannot slip past.
    if (this.#activeTasks.has(task.id) || reload().status === 'running') return reload();

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
    }
  }

  async #runTask(context: ToolContext, task: Task): Promise<Task> {
    const org = this.#store.org;
    const reload = (): Task => org.getTask(task.id) ?? task;

    let children = org.listTasks(context.orgId, { parentId: task.id }).filter((c) => c.status !== 'cancelled');
    if (!children.length && !reload().assigneeId) {
      await this.planTask(context, reload());
      children = org.listTasks(context.orgId, { parentId: task.id }).filter((c) => c.status !== 'cancelled');
    }

    // Every task is negotiated in a thread, whichever way it got here: one
    // that was not born as mail has its work order written before it runs,
    // so its result, its questions and its ending all have somewhere to go.
    await this.#ensureTaskThread(reload(), context.emit);

    const started = Date.now();
    org.updateTask(task.id, { status: 'running', startedAt: started, error: null });
    this.#announceTask(reload(), context.emit);

    // How a run ends is the thread's business, not an HTTP route's: every
    // ending passes here, and `notifyTaskStatus` decides for itself whether
    // the thread still needs to be told (decision E7).
    const finish = (status: TaskStatus, patch: { result?: string; error?: string }): Task => {
      org.updateTask(task.id, { status, finishedAt: Date.now(), ...patch });
      const done = reload();
      this.#announceTask(done, context.emit);
      if (status !== 'open' && status !== 'planned' && status !== 'running') {
        void this.notifyTaskStatus(done, status, started);
      }
      return done;
    };

    if (!children.length) {
      const current = reload();
      const agent = current.assigneeId ? org.getAgent(current.assigneeId) : null;
      if (!agent) return finish('failed', { error: 'Nobody is assigned and nobody could be found to do it.' });
      const outcome = await this.#runTaskLeaf(context, current, agent);
      return finish(taskStatusFor(outcome), { result: outcome.result, error: outcome.error });
    }

    const waves = buildTaskWaves(children.filter((c) => c.status !== 'done'));
    // A task that arrived as mail must not let every subtask's leaf answer
    // the thread in turn - three subtasks would mail three replies. The
    // waves run without the mail context; the parent speaks for the split
    // once, below, with the combined result.
    const waveContext: ToolContext = { ...context, sourceMail: undefined, taskNote: undefined };
    for (const wave of waves) {
      if (waveContext.signal?.aborted) break;
      await Promise.all(wave.map((child) => this.#runSubtask(waveContext, child)));
    }

    const all = org.listTasks(context.orgId, { parentId: task.id }).filter((c) => c.status !== 'cancelled');
    const failed = all.filter((c) => c.status === 'failed');
    const combined = all
      .map((c) => {
        const agent = c.assigneeId ? org.getAgent(c.assigneeId) : null;
        const head = '### ' + c.title + ' (' + (agent?.slug ?? 'unassigned') + ', ' + c.status + ')';
        return head + '\n' + (c.result ?? (c.error ? 'FAILED: ' + c.error : 'no output'));
      })
      .join('\n\n');
    const outcome =
      context.signal?.aborted
        ? { status: 'cancelled' as const, result: combined }
        : failed.length === all.length
          ? { status: 'failed' as const, error: 'Every subtask failed.', result: combined }
          : {
              status: 'done' as const,
              result: combined,
              error: failed.length ? failed.length + ' of ' + all.length + ' subtasks failed.' : undefined,
            };
    // The one answer the mailed split makes: the parent's combined report,
    // through the same auto-reply path a leaf would have used. It goes out
    // before the task is closed, so that the status note `finish()` may add
    // sees a thread that has already heard how the work ended.
    if (context.sourceMail && outcome.status === 'done') {
      const sourceMail = context.sourceMail;
      const replier: MailWho = { kind: 'assistant' };
      const sender: MailWho = { kind: sourceMail.fromKind, id: sourceMail.fromAgentId };
      if (!this.#answeredDuringTurn(context.orgId, replier, sender, started)) {
        void this.#deliverMail({
          orgId: context.orgId,
          from: replier,
          to: [sender],
          cc: this.#replyCc(this.#store.org.getMail(sourceMail.id), replier, sender),
          subject: 'Re: ' + sourceMail.subject,
          body: combined,
          inReplyTo: sourceMail.id,
          threadId: sourceMail.threadId,
          depth: sourceMail.depth + 1,
          autoReply: true,
          emit: context.emit,
        }).catch((error: unknown) => {
          this.#log.warn('Task completion mail failed', { task: task.id, error: String(error) });
        });
      }
    }
    return finish(outcome.status, { result: outcome.result, error: outcome.error });
  }

  /** One subtask inside a wave: mark it, run its leaf, record the outcome. */
  async #runSubtask(context: ToolContext, child: Task): Promise<void> {
    const org = this.#store.org;
    const agent = child.assigneeId ? org.getAgent(child.assigneeId) : null;
    org.updateTask(child.id, { status: 'running', startedAt: Date.now() });
    this.#announceTask(org.getTask(child.id) ?? child, context.emit);
    if (!agent) {
      org.updateTask(child.id, { status: 'failed', error: 'No assignee.', finishedAt: Date.now() });
    } else {
      const deps = child.dependsOn.map((id) => org.getTask(id)).filter((t): t is Task => Boolean(t));
      // A dependency that ended failed or cancelled used to be silently
      // dropped (no result), and this subtask ran on a basis it never saw.
      // It fails with the reason instead, the way a missing assignee does;
      // the parent's summary then carries the failure. A dependency that is
      // merely not finished yet (a cycle released in one wave) is not broken
      // here - it stays dropped from the inputs, as before.
      const broken = deps.filter((t) => t.status === 'failed' || t.status === 'cancelled');
      if (broken.length) {
        org.updateTask(child.id, {
          status: 'failed',
          error: 'Dependency did not finish: ' + broken.map((t) => t.title).join(', ') + '.',
          finishedAt: Date.now(),
        });
      } else {
        const outcome = await this.#runTaskLeaf(context, child, agent, deps.filter((t) => t.result));
        org.updateTask(child.id, {
          status: taskStatusFor(outcome),
          result: outcome.result,
          error: outcome.error,
          finishedAt: Date.now(),
        });
      }
    }
    this.#announceTask(org.getTask(child.id) ?? child, context.emit);
  }

  /** One task, one agent, one assignment. */
  async #runTaskLeaf(
    context: ToolContext,
    task: Task,
    agent: Agent,
    deps: Task[] = [],
  ): Promise<{
    status: Assignment['status'];
    result?: string;
    error?: string;
    assignmentId: string;
    /** The agent asked its requester something while running (decision E6). */
    askedRequester: boolean;
  }> {
    const prior = deps.length
      ? 'Results of the subtasks this one depends on:\n\n' +
        deps.map((dep) => '### ' + dep.title + '\n' + clip(dep.result ?? '', 6000)).join('\n\n') +
        '\n\n---\n\n'
      : '';
    // What continued the thread comes after the work order: the order is
    // what the task is, the note is what changed about it.
    const note = context.taskNote ? '\n\n---\n\n' + context.taskNote : '';
    let askedRequester = false;
    const assignment = await this.run({
      orgId: context.orgId,
      agent,
      // The run is the task, so it goes by the task's name; which run of it
      // this is comes from the chain, not from a second title (decision E17).
      title: task.title,
      taskId: task.id,
      task: prior + 'TASK: ' + task.title + '\n\n' + task.description + note,
      projectId: task.projectId ?? context.projectId,
      sessionId: context.sessionId,
      parentId: context.parentAssignmentId,
      requesterKind: context.audience === 'agent' ? 'agent' : 'assistant',
      requesterAgentId: context.agentId,
      depth: context.depth + 1,
      emit: context.emit,
      signal: context.signal,
      // A task that arrived as mail answers in its thread: the leaf's run
      // mails its result back to the sender, the way a To-line run does.
      sourceMail: context.sourceMail,
      onAskedRequester: (asked) => {
        askedRequester = asked;
      },
    });
    this.#store.org.linkTaskAssignment(task.id, assignment.id);
    return {
      status: assignment.status,
      result: assignment.result,
      error: assignment.error,
      assignmentId: assignment.id,
      askedRequester,
    };
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

  #memoriesFor(agentId: string, task: string) {
    if (!this.#config.memory.enabled) return [];
    const matched = recall(this.#store, {
      text: task,
      owner: agentId,
      limit: this.#config.memory.recallLimit,
      threshold: this.#config.memory.recallThreshold,
    });
    const profile = coreProfile(this.#store, { owner: agentId, limit: 3 });
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
        limit: 20,
        threshold: 0.05,
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
    const actions = this.#store.org.listActions(agent.id, { limit: 1 });
    const lastStage = actions[0]?.stage ?? 0;
    if (performance.stage <= lastStage) return;

    const reviews = this.#store.org.effectiveReviews(agent.id, 10).filter((review) => !review.failedRun);
    const weak: WeakReview[] = reviews.slice(0, 5).map((review) => ({
      overall: review.overall,
      source: review.source,
      comment: review.comment,
      tags: review.tags,
      createdAt: review.createdAt,
    }));
    const provider = this.#registry.get(providerId);

    if (performance.stage === 1) {
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
      return;
    }

    if (performance.stage === 2) {
      const drafted = await draftReconfig(provider, { roleTitle: agent.title, instructions: agent.instructions, reviews: weak });
      if (!drafted) return;
      // Protocol before effect (decision E1): the action and the instruction
      // change happen together, or not at all - `updateAgent` never runs
      // ahead of a personnel-file entry that justifies it.
      this.#store.org.createAction({
        orgId,
        agentId: agent.id,
        kind: 'reconfig',
        stage: 2,
        reason: drafted.reason,
        beforeText: agent.instructions,
        afterText: drafted.newInstructions,
        agentNote: drafted.agentNote,
        reviewIds: reviews.slice(0, 5).map((review) => review.id),
        decidedBy: 'assistant',
      });
      this.#store.org.updateAgent(agent.id, { instructions: drafted.newInstructions });
      this.emit('changed', { kind: 'agent', id: agent.id });
      return;
    }

    if (performance.stage === 3) {
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

    let handover = successor.handover?.trim();
    if (!handover) {
      const resolvedProvider = await this.#registry.resolveUsable(providerId ?? this.#config.defaultProvider);
      if (resolvedProvider) {
        try {
          const memories = this.#store.listMemories({ owner: predecessor.id, limit: 300, includeDormant: false });
          handover =
            (await draftHandover(this.#registry.get(resolvedProvider), {
              predecessorName: predecessor.name,
              roleTitle: predecessor.title,
              instructions: predecessor.instructions,
              memories: memories.map((memory) => ({
                content: memory.content,
                importance: memory.importance,
                createdAt: memory.createdAt,
              })),
            })) ?? undefined;
        } catch (error) {
          this.#log.warn('Handover draft failed', { agent: predecessor.slug, error: (error as Error).message });
        }
      }
    }

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
  if (assignment.durationMs !== undefined) lines.push('Duration: ' + Math.round(assignment.durationMs / 1000) + ' s');
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

function asMemoryKind(value: string): MemoryKind {
  return value === 'preference' || value === 'project' || value === 'event' ? value : 'fact';
}

/**
 * The `ask_user` options, read defensively. The schema says objects with a
 * label, but a model that answers a list of strings is asking the same
 * question and should not be sent back round for a formality; anything
 * without readable text is dropped rather than shown as an empty button.
 */
function asQuestionOptions(value: unknown): QuestionOption[] {
  if (!Array.isArray(value)) return [];
  const options: QuestionOption[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const label = entry.trim();
      if (label) options.push({ label });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    if (!label) continue;
    const description = typeof record.description === 'string' ? record.description.trim() : '';
    options.push(description ? { label, description } : { label });
  }
  return options;
}

/** A number argument within bounds; the fallback when it is missing or not a number. */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
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

function asPriority(value: string): TaskPriority | undefined {
  return value === 'low' || value === 'normal' || value === 'high' ? value : undefined;
}

/** The status note itself: one sentence a person can read without the board. */
function statusNote(task: Task, status: 'done' | 'failed' | 'cancelled' | 'blocked'): string {
  const name = 'The task "' + task.title + '"';
  if (status === 'done') return name + ' was marked as done.';
  if (status === 'cancelled') return name + ' was cancelled.';
  if (status === 'blocked') return name + ' is waiting for an answer.';
  return name + ' failed' + (task.error ? ': ' + task.error : '.');
}

/**
 * Whether a recipient is a party to a task: the agent who does it, or
 * whoever asked for it. Their mail in the task's thread is the negotiation
 * of the task itself and is dispatched by the task (`#continueTask`).
 * Anybody else on the To line is being asked for something new and keeps the
 * run the mail trigger has always given them.
 */
function partyToTask(task: Task, who: MailWho): boolean {
  if (who.kind === 'agent' && who.id && who.id === task.assigneeId) return true;
  if (who.kind !== task.createdBy) return false;
  return who.kind !== 'agent' || who.id === task.createdByAgentId;
}

/**
 * What one finished leaf run means for its card. A run that ended by asking
 * its requester a question is not done, whatever its own status says: the
 * work waits for an answer, and the card says so (decision E6). The error
 * falls the safe way round - a task wrongly left `blocked` sits on the board
 * and is carried on by the next reply, while a task wrongly called `done`
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
        '- [' + (child?.id.slice(0, 8) ?? '?') + '] ' + subtask.title + ' → ' + subtask.agent +
          (subtask.dependsOn.length ? ' (after ' + subtask.dependsOn.map((i) => i + 1).join(', ') + ')' : '') +
          ' #' + (index + 1),
      );
    }
  }
  lines.push('Use update_task to change assignees or wording, then run_task to execute.');
  return lines.join('\n');
}

function asPermission(value: string): PermissionLevel | undefined {
  return value === 'chat' || value === 'read' || value === 'write' || value === 'full' ? value : undefined;
}
