import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { readProfileExcerpt, searchProfile } from '../profile.js';
import type {
  Agent,
  AgentEvent,
  Assignment,
  AssignmentStatus,
  AssignmentView,
  EffortLevel,
  Mail,
  MailWho,
  MemoryKind,
  NotifyEvent,
  Organization,
  PermissionLevel,
  Project,
  ProviderId,
  RequesterKind,
  RookeryConfig,
  Task,
  TaskPriority,
  TaskStatus,
} from '../types.js';
import { ASSISTANT_MEMORY_OWNER, EFFORT_LEVELS } from '../types.js';
import { agentWorkspace, applyConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Store } from '../memory/store.js';
import type { OrgStore } from './store.js';
import { coreProfile, recall } from '../memory/recall.js';
import { extractMemories, smallModelFor } from '../memory/extractor.js';
import { admitCandidates, linkEntities } from '../memory/gate.js';
import type { SleepRunner } from '../memory/sleep.js';
import { clip, shorten, tail } from '../util/queue.js';
import type { BridgeServer, ToolCallResult, ToolHandler } from './bridge.js';
import { buildAgentPrompt, renderBoard, renderMail, renderOrgOverview, renderSchedules, type OrgSnapshot } from './prompts.js';
import { buildTaskWaves, planTask, type TaskPlan } from './planner.js';
import { toolsFor, type ToolAudience } from './tools.js';
import { ensureToolServers, renderToolServers, toolServerStates, toolServersFor, withToolServer } from '../tools/hub.js';
import { SkillStore, projectSkillsDir, renderSkill, renderSkillsIndex, type Skill } from '../skills/store.js';
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
  /** Depth of the caller; the assistant is -1, its direct assignments are 0. */
  depth: number;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
  /** Set when the running assignment itself came from mail; carries the auto-trigger loop guard. */
  sourceMail?: { id: string; threadId: string; depth: number };
}

export interface RunAssignmentInput {
  orgId: string;
  agent: Agent;
  task: string;
  projectId?: string;
  sessionId?: string;
  parentId?: string;
  requesterKind: RequesterKind;
  requesterAgentId?: string;
  depth: number;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
  /**
   * Set when this assignment was started by mailing the agent's To line.
   * On success, `run()` mails the result back to the sender as a reply.
   */
  sourceMail?: { id: string; threadId: string; depth: number; fromKind: RequesterKind; fromAgentId?: string; subject: string };
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

export class OrgController extends EventEmitter {
  readonly #store: Store;
  readonly #registry: ProviderRegistry;
  readonly #config: RookeryConfig;
  readonly #bridge: BridgeServer;
  readonly #log: Logger;
  readonly #skills: SkillStore;
  readonly #cron: CronScheduler | undefined;
  readonly #sleep: SleepRunner | undefined;
  readonly #canNotify: (() => boolean) | undefined;
  readonly #runAssistantMail: OrgControllerOptions['runAssistantMail'];
  #running = 0;
  #waiting: (() => void)[] = [];
  /** Cancel hooks of assignments that are queued or running, by assignment id. */
  readonly #active = new Map<string, (by: string) => void>();
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

  /** Register a provider process with the bridge and hand back its token. */
  register(context: ToolContext): string {
    return this.#bridge.register(toolsFor(context.audience), this.handler(context));
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
        return { text: renderOrgOverview(this.snapshot(context.orgId)) };

      case 'assign':
        return this.#assign(context, text('agent'), text('task'), text('project'), args.wait !== false);

      case 'assignment_status': {
        const assignment = this.findAssignment(context.orgId, text('id'));
        if (!assignment) return fail('No assignment with that id.');
        return { text: describeAssignment(assignment, this.#store.org.getAgent(assignment.agentId)) };
      }

      case 'cancel_assignment': {
        if (context.audience !== 'assistant') return fail('Only the assistant can cancel assignments.');
        const assignment = this.findAssignment(context.orgId, text('id'));
        if (!assignment) return fail('No assignment with that id.');
        if (!this.cancel(assignment.id, 'the assistant')) {
          return fail('Assignment ' + assignment.id.slice(0, 8) + ' is not running; it is ' + assignment.status + '.');
        }
        return { text: 'Cancelling assignment ' + assignment.id.slice(0, 8) + '. It ends as cancelled within a moment.' };
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
        if (!rows.length) return { text: 'No assignments match.' };
        const byId = new Map(
          this.#store.org.listAgents(context.orgId, { includeArchived: true }).map((entry) => [entry.id, entry]),
        );
        return {
          text: rows
            .map((entry) => {
              const who = byId.get(entry.agentId)?.slug ?? '?';
              const when = new Date(entry.createdAt).toISOString().slice(0, 16).replace('T', ' ');
              const took = entry.durationMs ? ' ' + Math.round(entry.durationMs / 1000) + 's' : '';
              return '- ' + entry.id.slice(0, 8) + ' ' + when + ' ' + entry.status + took + ' ' + who + ': ' +
                shorten(entry.task, 100) + (entry.error ? ' [' + shorten(entry.error, 60) + ']' : '');
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
        if (context.audience !== 'assistant') return fail('Only the assistant has this memory.');
        if (!text('content')) return fail('A memory needs content.');
        const tags = text('tags').split(',').map((v) => v.trim()).filter(Boolean);
        const record = this.#store.upsertMemory({
          kind: asMemoryKind(text('kind')),
          content: text('content'),
          tags,
          importance: clampNumber(args.importance, 0, 1, 0.7),
          owner: ASSISTANT_MEMORY_OWNER,
          sourceSessionId: context.sessionId,
          // Asked for explicitly, so the night never merges it away.
          origin: 'user',
        });
        linkEntities(this.#store, ASSISTANT_MEMORY_OWNER, record.id, tags);
        this.emit('changed', { kind: 'memory', id: record.id });
        return { text: 'Remembered (' + record.id.slice(0, 8) + '): ' + record.content };
      }

      case 'forget': {
        if (context.audience !== 'assistant') return fail('Only the assistant has this memory.');
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
        if (context.audience !== 'assistant') return fail('Only the assistant has this memory.');
        const limit = clampNumber(args.limit, 1, 100, 20);
        const query = text('query');
        const rows = query
          ? recall(this.#store, { text: query, limit, owner: ASSISTANT_MEMORY_OWNER, touch: false })
          : this.#store.listMemories({ owner: ASSISTANT_MEMORY_OWNER, limit });
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

      case 'use_skill': {
        // An agent's own instructions carry its project's skills too (Befund
        // 4 in the concept doc): the tool must resolve against the running
        // assignment's project, not only the one long-lived home store.
        const project =
          context.audience === 'agent' && context.projectId ? this.#store.org.getProject(context.projectId) : null;
        const skills = context.audience === 'agent' ? this.#agentSkills(project) : this.#skills.for('assistant');
        const skill = skills.find((entry) => entry.name === text('name').toLowerCase());
        if (!skill) return fail('No skill "' + text('name') + '". The list in your instructions is authoritative.');
        return { text: renderSkill(skill) };
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
            (status === 'trusted' ? '' : '\nUse trust_project_mcp to approve before these start for an assignment.'),
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
          return { text: 'Revoked trust for "' + project.name + '"; its MCP servers no longer start for assignments.' };
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
            ' MCP server(s) start for its assignments from now on.',
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
        if (args.enabled && !state.installed) return fail(state.name + ' is not installed on this machine.');
        if (args.enabled && state.missingEnv.length) {
          return fail(state.name + ' needs ' + state.missingEnv.join(', ') + ' first; the user sets that on the Tools page.');
        }
        const audience = text('audience');
        const tools = withToolServer(this.#config, state.id, {
          enabled: args.enabled,
          ...(audience === 'assistant' || audience === 'agents' || audience === 'both' ? { audience } : {}),
        });
        applyConfig(this.#config, { tools });
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
          teamId: team?.id,
          managerId: manager?.id,
          provider: asProvider(text('provider')),
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
        return { text: 'Task ' + task.id.slice(0, 8) + ' "' + task.title + '" is on the board.' };
      }

      case 'list_tasks': {
        const wanted = text('status').split(',').map((v) => v.trim()).filter(Boolean) as TaskStatus[];
        const tasks = this.#store.org.listTasks(context.orgId, { status: wanted.length ? wanted : undefined });
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
        return this.#schedules(context, name, args);

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

    if (name === 'create_schedule') {
      if (!text('name') || !text('schedule') || !text('prompt')) {
        return fail('A schedule needs a name, a cron expression and a prompt.');
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
          prompt: text('prompt'),
          kind: agent ? 'agent' : 'assistant',
          agentId: agent?.id,
          projectId: project?.id ?? context.projectId,
          sessionId: replyHere,
          once: flag('once'),
          enabled: flag('enabled'),
          createdBy: 'assistant',
        });
        return { text: 'Schedule created: ' + describeCron(job.schedule) + '.\n' + line(job) };
      } catch (error) {
        return fail((error as Error).message);
      }
    }

    const job = cron.find(context.orgId, text('id'));
    if (!job) return fail('No schedule "' + text('id') + '". list_schedules shows the ids.');

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

  async #assign(
    context: ToolContext,
    agentRef: string,
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
        if (wait) return fail('A self-assignment has to run in the background - call assign with wait=false.');
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

    const runInput = {
      orgId: context.orgId,
      agent,
      task,
      projectId,
      sessionId: context.sessionId,
      parentId: context.parentAssignmentId,
      requesterKind: context.audience === 'agent' ? 'agent' : 'assistant',
      requesterAgentId: context.agentId,
      depth,
    } as const;

    if (!wait) {
      // Detached: the turn ends while the agent works. Its progress reaches
      // every socket through the org-level assignment events; the turn's own
      // stream and abort signal must not be tied to it.
      const isSelf = agent.id === context.agentId;
      const started = this.run({ ...runInput, emit: () => undefined });
      started
        .then((assignment) => {
          if (!isSelf) return undefined;
          // A self-assignment has nobody else waiting on assignment_status,
          // so it reports for itself the same way mail-triggered work does:
          // a mail addressed to the user.
          const body =
            assignment.status === 'done'
              ? clip(assignment.result ?? '', RESULT_BUDGET)
              : 'Could not finish: ' + (assignment.error ?? assignment.status) + '.';
          return this.#deliverMail({
            orgId: context.orgId,
            from: { kind: 'agent', id: agent.id },
            to: [{ kind: 'user' }],
            cc: [],
            subject: 'Re: background task',
            body,
            depth: 0,
            emit: () => undefined,
          });
        })
        .catch((error: unknown) => {
          this.#log.warn('Detached assignment failed', { agent: agent.slug, error: String(error) });
        });
      return {
        text: isSelf
          ? 'Started in the background - I will follow up in this chat once it is done.'
          : 'Handed to ' + agent.name + ' (' + agent.slug + '). The assignment runs in the background; ' +
            'assignment_status reports on it, and the user is told when it finishes.',
      };
    }

    const assignment = await this.run({
      ...runInput,
      emit: context.emit,
      signal: context.signal,
    });

    if (assignment.status !== 'done') {
      return fail(
        'Assignment ' + assignment.id.slice(0, 8) + ' to ' + agent.slug + ' ' + assignment.status +
          (assignment.error ? ': ' + assignment.error : '.'),
      );
    }
    return {
      text:
        'Report from ' + agent.name + ' (' + agent.slug + '), assignment ' + assignment.id.slice(0, 8) +
        ', ' + Math.round((assignment.durationMs ?? 0) / 1000) + ' s:\n\n' +
        clip(assignment.result ?? '', RESULT_BUDGET),
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
    });
    this.#announce({ type: 'mail', mail }, params.emit);

    if (!params.autoReply && params.depth < this.#config.org.maxDelegationDepth) {
      const senderLabel = this.#mailWhoLabel(params.from);
      for (const target of params.to) {
        if (target.kind === 'assistant' && this.#runAssistantMail) {
          this.#runAssistantMail({
            mail,
            senderLabel,
            thread: this.#store.org
              .thread(params.orgId, mail.threadId, { who: { kind: 'assistant' } })
              .filter((entry) => entry.id !== mail.id),
          })
            .then((reply) => {
              if (!reply.trim()) return;
              return this.#deliverMail({
                orgId: params.orgId,
                from: { kind: 'assistant' },
                to: [params.from],
                cc: [],
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
   * The user sends mail to anyone, no permission circle applied - for a
   * future `POST /api/org/mail` route to call directly, the way
   * `POST /api/org/messages` bypassed the tool-context path before it.
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
  }): Promise<Mail> {
    const resolve = (token: string): MailWho => {
      const target = this.#resolveMailTarget(input.orgId, token);
      if (!target) throw new Error('No agent "' + token + '".');
      return target;
    };
    return this.#deliverMail({
      orgId: input.orgId,
      from: { kind: 'user' },
      to: input.to.map(resolve),
      cc: (input.cc ?? []).map(resolve),
      subject: input.subject,
      body: input.body,
      inReplyTo: input.inReplyTo,
      depth: 0,
      projectId: input.projectId,
      emit: input.emit ?? (() => undefined),
    });
  }

  /** Emit into the turn that caused an event, and to everyone listening on the controller. */
  #announce(event: Extract<AgentEvent, { type: 'assignment' | 'message' | 'mail' }>, emit: (event: AgentEvent) => void): void {
    emit(event);
    this.emit(event.type, event);
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
    const fail = (error: string, started: number): Assignment =>
      finish({ status: 'failed', error, finishedAt: Date.now(), durationMs: Date.now() - started }, { error });

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
    const cancelled = (): boolean => cancelledBy !== null || Boolean(input.signal?.aborted);

    announce();
    await this.#acquire(controller.signal);
    const started = Date.now();

    try {
      if (controller.signal.aborted) return finish({ status: 'cancelled', finishedAt: started, durationMs: 0 });

      const providerId = await this.#registry.resolveUsable(agent.provider ?? this.#config.defaultProvider);
      if (!providerId) return fail('No provider is logged in.', started);

      const cwd = project?.path || agentWorkspace(this.#config, agent.id);
      if (!existsSync(cwd)) return fail('The project directory ' + cwd + ' does not exist.', started);

      finish({ status: 'running', provider: providerId, model: agent.model, startedAt: started });

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

      await ensureToolServers(this.#config, 'agent', providerId, project?.id, (id, error) =>
        this.#log.warn('Tool server could not prepare', { id, error: error.message }),
      );
      const extra = toolServersFor(this.#config, 'agent', providerId, project?.id);

      // The project's own MCP servers - read from its `.mcp.json`, the same
      // file a person's own session in that folder would read - only start
      // once the assistant has approved this exact file (see
      // trust_project_mcp). Untrusted or changed, they stay off and the
      // agent is told why instead of silently missing tools it expects.
      const projectMcp = project?.path ? readProjectMcpFile(project.path) : null;
      const projectMcpState = projectMcpStatus(projectMcp, project?.mcpTrust);
      const projectMcpSpecs = projectMcpState === 'trusted' && projectMcp ? projectMcp.servers : [];
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
        skillsIndex: renderSkillsIndex(this.#agentSkills(project)),
      });
      if (unreadMail.length) org.markMailReadFor(unreadMail, mailWho);

      const timer = setTimeout(() => controller.abort(), this.#config.org.assignmentTimeoutMs);
      timer.unref?.();

      const token = this.register({
        orgId: input.orgId,
        audience: 'agent',
        agentId: agent.id,
        sessionId: input.sessionId,
        projectId: project?.id,
        parentAssignmentId: assignment.id,
        depth: input.depth,
        emit: input.emit,
        signal: controller.signal,
        sourceMail: input.sourceMail
          ? { id: input.sourceMail.id, threadId: input.sourceMail.threadId, depth: input.sourceMail.depth }
          : undefined,
      });

      let text = '';
      let sinceProgress = 0;
      let fatal: string | null = null;

      try {
        const mcp = await this.#bridge.spec(token);
        const mcpExtra = [...extra.specs, ...projectMcpSpecs];
        for await (const event of this.#registry.get(providerId).run({
          prompt: input.task,
          systemPrompt,
          model: agent.model,
          effort: this.#config.defaultEffort,
          cwd,
          permission: agent.permission ?? this.#config.defaultPermission,
          mcp,
          mcpExtra: mcpExtra.length ? mcpExtra : undefined,
          signal: controller.signal,
        })) {
          if (event.type === 'text') {
            text += event.delta;
            sinceProgress += event.delta.length;
            if (sinceProgress >= PROGRESS_EVERY) {
              sinceProgress = 0;
              org.updateAssignment(assignment.id, { chars: text.length });
              announce({ chars: text.length, preview: shorten(tail(text, 160), 110) });
            }
          } else if (event.type === 'tool') {
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
            fatal = event.message;
          }
        }
      } catch (error) {
        fatal = (error as Error).message;
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
      if (this.#config.memory.enabled && this.#config.memory.autoExtract) {
        void this.#learn(agent, input.task, text, providerId);
      }
      if (input.sourceMail) {
        const sourceMail = input.sourceMail;
        this.#deliverMail({
          orgId: input.orgId,
          from: { kind: 'agent', id: agent.id },
          to: [{ kind: sourceMail.fromKind, id: sourceMail.fromAgentId }],
          cc: [],
          subject: 'Re: ' + sourceMail.subject,
          body: text,
          inReplyTo: sourceMail.id,
          threadId: sourceMail.threadId,
          depth: sourceMail.depth + 1,
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

  /* ------------------------------- settings ------------------------------- */

  #updateSettings(context: ToolContext, args: Record<string, unknown>): ToolCallResult {
    const text = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
    const fail = (message: string): ToolCallResult => ({ text: message, isError: true });
    if (context.audience !== 'assistant') return fail('Only the assistant can change settings.');

    const patch: Omit<Partial<RookeryConfig>, 'org'> & { org?: Partial<RookeryConfig['org']> } = {};
    if (text('defaultProvider')) {
      const provider = asProvider(text('defaultProvider'));
      if (!provider) return fail('Provider must be claude or codex.');
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

    const patch: Parameters<OrgStore['updateAgent']>[1] = {};
    if (text('name')) patch.name = text('name');
    if (text('title')) patch.title = text('title');
    if (text('instructions')) patch.instructions = text('instructions');
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
    if (text('provider')) patch.provider = asProvider(text('provider')) ?? null;
    if (text('model')) patch.model = text('model');
    if (text('permission')) patch.permission = asPermission(text('permission')) ?? null;
    if (typeof args.archived === 'boolean') patch.archived = args.archived;

    this.#store.org.updateAgent(agent.id, patch);
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
    if (status === 'open' || status === 'done' || status === 'cancelled') {
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
    if (reload().status === 'running') return reload();

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

    const started = Date.now();
    org.updateTask(task.id, { status: 'running', startedAt: started, error: null });
    this.#announceTask(reload(), context.emit);

    const finish = (status: TaskStatus, patch: { result?: string; error?: string }): Task => {
      org.updateTask(task.id, { status, finishedAt: Date.now(), ...patch });
      const done = reload();
      this.#announceTask(done, context.emit);
      return done;
    };

    if (!children.length) {
      const current = reload();
      const agent = current.assigneeId ? org.getAgent(current.assigneeId) : null;
      if (!agent) return finish('failed', { error: 'Nobody is assigned and nobody could be found to do it.' });
      const outcome = await this.#runTaskLeaf(context, current, agent);
      return finish(outcome.status === 'done' ? 'done' : outcome.status === 'cancelled' ? 'cancelled' : 'failed', {
        result: outcome.result,
        error: outcome.error,
      });
    }

    const waves = buildTaskWaves(children.filter((c) => c.status !== 'done'));
    for (const wave of waves) {
      if (context.signal?.aborted) break;
      await Promise.all(wave.map((child) => this.#runSubtask(context, child)));
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
    if (context.signal?.aborted) return finish('cancelled', { result: combined });
    if (failed.length === all.length) return finish('failed', { error: 'Every subtask failed.', result: combined });
    return finish('done', {
      result: combined,
      error: failed.length ? failed.length + ' of ' + all.length + ' subtasks failed.' : undefined,
    });
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
      const deps = child.dependsOn.map((id) => org.getTask(id)).filter((t): t is Task => Boolean(t?.result));
      const outcome = await this.#runTaskLeaf(context, child, agent, deps);
      org.updateTask(child.id, {
        status: outcome.status === 'done' ? 'done' : outcome.status === 'cancelled' ? 'cancelled' : 'failed',
        result: outcome.result,
        error: outcome.error,
        finishedAt: Date.now(),
      });
    }
    this.#announceTask(org.getTask(child.id) ?? child, context.emit);
  }

  /** One task, one agent, one assignment. */
  async #runTaskLeaf(
    context: ToolContext,
    task: Task,
    agent: Agent,
    deps: Task[] = [],
  ): Promise<{ status: Assignment['status']; result?: string; error?: string; assignmentId: string }> {
    const prior = deps.length
      ? 'Results of the subtasks this one depends on:\n\n' +
        deps.map((dep) => '### ' + dep.title + '\n' + clip(dep.result ?? '', 6000)).join('\n\n') +
        '\n\n---\n\n'
      : '';
    const assignment = await this.run({
      orgId: context.orgId,
      agent,
      task: prior + 'TASK: ' + task.title + '\n\n' + task.description,
      projectId: task.projectId ?? context.projectId,
      sessionId: context.sessionId,
      parentId: context.parentAssignmentId,
      requesterKind: context.audience === 'agent' ? 'agent' : 'assistant',
      requesterAgentId: context.agentId,
      depth: context.depth + 1,
      emit: context.emit,
      signal: context.signal,
    });
    this.#store.org.linkTaskAssignment(task.id, assignment.id);
    return { status: assignment.status, result: assignment.result, error: assignment.error, assignmentId: assignment.id };
  }

  #announceTask(task: Task, emit: (event: AgentEvent) => void): void {
    const event: AgentEvent = { type: 'task', task };
    emit(event);
    this.emit('task', event);
  }

  /* ------------------------------- internals ------------------------------ */

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
    return [...byId.values()].sort((a, b) => b.score - a.score);
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
      });
    } catch (error) {
      this.#log.warn('Agent memory extraction failed', { agent: agent.slug, error: (error as Error).message });
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

export function describeAssignment(assignment: Assignment, agent: Agent | null): string {
  const lines = [
    'Assignment ' + assignment.id,
    'Agent: ' + (agent ? agent.name + ' (' + agent.slug + ')' : assignment.agentId),
    'Status: ' + assignment.status,
    'Task: ' + clip(assignment.task, 400),
  ];
  if (assignment.durationMs !== undefined) lines.push('Duration: ' + Math.round(assignment.durationMs / 1000) + ' s');
  if (assignment.error) lines.push('Error: ' + assignment.error);
  if (assignment.result) lines.push('', clip(assignment.result, RESULT_BUDGET));
  return lines.join('\n');
}

function asProvider(value: string): ProviderId | undefined {
  return value === 'claude' || value === 'codex' ? value : undefined;
}

function asMemoryKind(value: string): MemoryKind {
  return value === 'preference' || value === 'project' || value === 'event' ? value : 'fact';
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
    'Parallel assignments: ' + config.org.maxConcurrentAssignments,
    'Delegation depth: ' + config.org.maxDelegationDepth,
    'Assignment timeout: ' + Math.round(config.org.assignmentTimeoutMs / 60000) + ' min',
  ].join('\n');
}

function asPriority(value: string): TaskPriority | undefined {
  return value === 'low' || value === 'normal' || value === 'high' ? value : undefined;
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
