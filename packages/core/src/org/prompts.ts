import type {
  Agent,
  AgentMessage,
  Assignment,
  CronJob,
  Message,
  Organization,
  Project,
  RookeryConfig,
  ScoredMemory,
  Task,
  Team,
} from '../types.js';
import type { OrgStore } from './store.js';
import { renderMemoryBlock } from '../memory/recall.js';
import { PONYTAIL_RULESET } from './ponytail.js';
import { describeCronJob } from '../cron/scheduler.js';
import { clip, shorten } from '../util/queue.js';

/**
 * Prompt text for the organisation.
 *
 * Two kinds of prompt come out of here. The assistant's turn gets a block
 * describing the company it runs and how to use its tools; it is appended to
 * the ordinary identity prompt. An agent's assignment gets a complete system
 * prompt of its own, pointedly not built on the assistant's identity: an
 * agent is a member of staff, and its notes must never read like the
 * assistant speaking to the user.
 */

/** Everything a prompt needs to know about the company. */
export interface OrgSnapshot {
  organization: Organization;
  teams: Team[];
  agents: Agent[];
  projects: Project[];
  /** Assignments currently pending or running. */
  active: Assignment[];
}

const agentById = (snapshot: OrgSnapshot): Map<string, Agent> =>
  new Map(snapshot.agents.map((agent) => [agent.id, agent]));

/** The org chart as plain text, shared by the overview tool and the prompts. */
export function renderOrgOverview(snapshot: OrgSnapshot): string {
  const byId = agentById(snapshot);
  const teamName = new Map(snapshot.teams.map((team) => [team.id, team.name]));
  const lines: string[] = [];

  lines.push('Company: ' + snapshot.organization.name);
  if (snapshot.organization.mission) lines.push('Mission: ' + snapshot.organization.mission);

  lines.push('');
  lines.push(snapshot.agents.length ? 'Agents:' : 'Agents: none yet. Hire someone before delegating.');
  for (const agent of snapshot.agents) {
    const manager = agent.managerId ? byId.get(agent.managerId) : undefined;
    const bits = [
      '- ' + agent.slug + ' — ' + agent.name + ', ' + agent.title,
      agent.teamId ? 'team: ' + (teamName.get(agent.teamId) ?? '?') : '',
      manager ? 'reports to: ' + manager.slug : 'reports to: the assistant',
      agent.provider ? 'provider: ' + agent.provider : '',
    ].filter(Boolean);
    lines.push(bits.join(' · '));
  }

  if (snapshot.teams.length) {
    lines.push('');
    lines.push('Teams:');
    for (const team of snapshot.teams) {
      const lead = team.leadId ? byId.get(team.leadId) : undefined;
      lines.push(
        '- ' + team.name + (team.purpose ? ' — ' + team.purpose : '') + (lead ? ' (lead: ' + lead.slug + ')' : ''),
      );
    }
  }

  if (snapshot.projects.length) {
    lines.push('');
    lines.push('Projects:');
    for (const project of snapshot.projects) {
      lines.push(
        '- ' + project.name + (project.description ? ' — ' + project.description : '') +
          (project.path ? ' [' + project.path + ']' : ' [no directory]'),
      );
    }
  }

  if (snapshot.active.length) {
    lines.push('');
    lines.push('Running assignments:');
    for (const assignment of snapshot.active) {
      const agent = byId.get(assignment.agentId);
      lines.push('- ' + assignment.id.slice(0, 8) + ' ' + (agent?.slug ?? '?') + ': ' + clip(assignment.task, 120));
    }
  }

  return lines.join('\n');
}

/** Inbox lines for a prompt; empty string when there is nothing unread. */
export function renderInbox(messages: AgentMessage[], snapshot: OrgSnapshot, heading: string): string {
  if (!messages.length) return '';
  const byId = agentById(snapshot);
  const lines = messages.map((message) => {
    const from = message.fromAgentId ? (byId.get(message.fromAgentId)?.slug ?? 'unknown agent') : 'the assistant';
    return '- from ' + from + ': ' + clip(message.content, 600);
  });
  return heading + '\n' + lines.join('\n');
}

/**
 * The block appended to the assistant's identity prompt: what it runs, how
 * to delegate, and what arrived in its inbox since the last turn.
 */
export function assistantOrgBlock(
  config: RookeryConfig,
  snapshot: OrgSnapshot,
  inbox: AgentMessage[],
  activeProject?: Project,
  schedules: CronJob[] = [],
): string {
  const name = config.assistantName || 'Rookery';
  const sections: string[] = [];

  sections.push(
    [
      'Besides being ' + name + ' for your user, you run a small company of AI agents on their behalf.',
      'The agents are permanent staff with roles and their own memory; every assignment you give',
      'one runs as a separate process in the background, in the project directory when the project',
      'has one. The rookery tools are yours: `assign` hands a task to one agent and returns the',
      'report (several `assign` calls in one message run in parallel); `create_task`, `plan_task`',
      'and `run_task` put bigger work on the board, decide who does it or how to split it, and',
      'execute it; `hire_agent`, `update_agent`, `create_team`, `update_team`, `create_project` and',
      '`update_project` shape the company when the user asks or when a job clearly needs a role',
      'nobody holds. `list_assignments` is the history of what ran; `cancel_assignment` stops a',
      'stuck or unwanted one, and `update_task` with status "cancelled" stops a running task.',
      '`remember`, `forget` and `search_memory` are your long-term memory of the user;',
      '`get_settings` and `update_settings` are the defaults and limits you work under.',
      '`create_schedule`, `list_schedules`, `update_schedule`, `delete_schedule` and `run_schedule`',
      'are your schedules (cron jobs): standing orders that fire on a timetable without anyone',
      'asking - a turn of your own in a conversation dedicated to the job, or an assignment to an',
      'agent - with the outcome posted to your inbox. Use them whenever the user wants something',
      'regularly ("jeden Morgen um 8", "freitags") or at a later time ("morgen um 15 Uhr", once).',
      'Turn what they say into a cron expression yourself and confirm the time in words.',
      'Nothing here needs permission from anyone: you own the company and its machinery.',
      'Two words to keep apart when you talk to the user: an assignment (German "Auftrag") is',
      'one agent running one brief, with a result; a task (German "Aufgabe") is an item on the',
      'board that gets planned and then executed as one or more assignments.',
      'Delegate real work - code, research, analysis, long writing - instead of doing it here;',
      'you have no project files in this conversation.',
      'Most turns are not work at all. Small talk, questions about the user, their day or their',
      'plans, and anything you can answer from memory get a direct, personal reply: talk about',
      'them and what you know of them, never about repositories or tools unless they ask.',
      'When you delegated, report the outcome as ' + name + ' in your own words; never narrate',
      'tool mechanics.',
    ].join(' '),
  );

  sections.push(renderOrgOverview(snapshot));

  if (activeProject) {
    sections.push(
      'Active project for this conversation: ' + activeProject.name +
        (activeProject.path ? ' at ' + activeProject.path : ' (no directory)') +
        '. Assignments default to it.',
    );
  }

  if (schedules.length) sections.push(renderSchedules(schedules, snapshot));

  const inboxBlock = renderInbox(inbox, snapshot, 'New messages from your staff since last time:');
  if (inboxBlock) sections.push(inboxBlock);

  return sections.join('\n\n');
}

/** The schedules, one line each, as the assistant's prompt and the list tool show them. */
export function renderSchedules(schedules: CronJob[], snapshot: OrgSnapshot): string {
  if (!schedules.length) return 'No schedules yet.';
  const byId = agentById(snapshot);
  const lines = schedules.map((job) => describeCronJob(job, job.agentId ? byId.get(job.agentId)?.slug : undefined));
  return 'Your schedules (cron jobs, local time):\n' + lines.join('\n');
}

export interface AgentPromptInput {
  config: RookeryConfig;
  agent: Agent;
  snapshot: OrgSnapshot;
  project?: Project;
  memories: ScoredMemory[];
  inbox: AgentMessage[];
  assignmentId: string;
  /** Who gave the assignment, for the prompt's sense of the chain of command. */
  requestedBy: string;
  /** One paragraph per tool server attached to this run, from the hub. */
  toolHints?: string[];
  /** The skills index, when there are skills for agents. */
  skillsIndex?: string;
}

/** The complete system prompt for one agent running one assignment. */
export function buildAgentPrompt(input: AgentPromptInput): string {
  const { agent, snapshot, config } = input;
  const byId = agentById(snapshot);
  const team = agent.teamId ? snapshot.teams.find((entry) => entry.id === agent.teamId) : undefined;
  const manager = agent.managerId ? byId.get(agent.managerId) : undefined;
  const reports = snapshot.agents.filter((entry) => entry.managerId === agent.id);
  const sections: string[] = [];

  sections.push(
    [
      'You are ' + agent.name + ', ' + agent.title + ' at ' + snapshot.organization.name + ',',
      'a company of AI agents run by the assistant ' + (config.assistantName || 'Rookery') + '.',
      team ? 'You are in the team "' + team.name + '"' + (team.purpose ? ' (' + team.purpose + ')' : '') + '.' : '',
      manager
        ? 'Your manager is ' + manager.name + ' (' + manager.slug + ').'
        : 'You report directly to the assistant.',
      reports.length
        ? 'Your direct reports: ' + reports.map((entry) => entry.slug + ' (' + entry.title + ')').join(', ') +
          '. You may hand them parts of your work with the assign tool.'
        : 'You have no reports; do the work yourself.',
      'This assignment (' + input.assignmentId.slice(0, 8) + ') was given to you by ' + input.requestedBy + '.',
    ]
      .filter(Boolean)
      .join(' '),
  );

  sections.push('Your standing instructions:\n' + agent.instructions);

  // How the work gets done, below the role and above the task: the agent's
  // own instructions still win, because they were written for this job.
  if (config.org.lazyCoding) sections.push(PONYTAIL_RULESET);

  if (input.project) {
    sections.push(
      'Project: ' + input.project.name +
        (input.project.description ? ' — ' + input.project.description : '') +
        (input.project.path
          ? '. You are working inside its directory: ' + input.project.path + '.'
          : '. It has no directory; you are in a scratch workspace.'),
    );
  } else {
    sections.push('You are in a scratch workspace, not a project directory.');
  }

  const memoryBlock = renderMemoryBlock(input.memories, Math.floor(config.memory.contextBudget * 0.4), 'your work');
  if (memoryBlock) sections.push(memoryBlock);

  const inboxBlock = renderInbox(input.inbox, snapshot, 'Messages waiting for you:');
  if (inboxBlock) sections.push(inboxBlock);
  for (const hint of input.toolHints ?? []) sections.push(hint);
  if (input.skillsIndex) sections.push(input.skillsIndex);

  // The assistant is told not to accept dead ends; an agent that reports
  // "not possible" after one attempt would hand it one anyway.
  sections.push(
    [
      'Do not come back with a dead end you have not earned. A failed command, a missing file or a',
      'closed door is the first attempt, not the answer: read what the error actually says, change',
      'the approach rather than the parameter, and try a genuinely different route before you report',
      'that something cannot be done. When you do report it, say what you tried and what would',
      'unblock it. Stop short of anything irreversible or consequential the assignment did not ask',
      'for, and never claim a result you have not seen.',
    ].join(' '),
  );

  sections.push(
    [
      'Work the assignment and nothing else. Your output is a report to whoever assigned it,',
      'not a chat with the user: lead with the result, then what you changed or found, then open',
      'questions. No preamble, no restating the task. Separate what you verified from what you',
      'assume. Use send_message only for something your manager or the assistant must know',
      'outside this report. Write in the language the assignment is written in.',
    ].join(' '),
  );

  sections.push('Today is ' + new Date().toISOString().slice(0, 10) + '.');
  return sections.join('\n\n');
}

/** The board as the assistant reads it. */
export function renderBoard(tasks: Task[], snapshot: OrgSnapshot, store: OrgStore): string {
  if (!tasks.length) return 'The board is empty.';
  const byId = agentById(snapshot);
  const lines: string[] = [];
  for (const task of tasks) {
    const assignee = task.assigneeId ? (byId.get(task.assigneeId)?.slug ?? '?') : 'unassigned';
    lines.push(
      '- [' + task.id.slice(0, 8) + '] ' + task.status.toUpperCase() + ' ' + task.priority + ' — ' + task.title +
        ' (' + assignee + ')' + (task.planNote ? ' · ' + shorten(task.planNote, 80) : ''),
    );
    for (const child of store.listTasks(task.orgId, { parentId: task.id })) {
      if (child.status === 'cancelled') continue;
      const who = child.assigneeId ? (byId.get(child.assigneeId)?.slug ?? '?') : 'unassigned';
      lines.push('    - [' + child.id.slice(0, 8) + '] ' + child.status + ' — ' + child.title + ' (' + who + ')');
    }
  }
  return lines.join('\n');
}

export interface AgentChatPromptInput {
  config: RookeryConfig;
  agent: Agent;
  snapshot: OrgSnapshot;
  memories: ScoredMemory[];
  inbox: AgentMessage[];
  history?: Message[];
  resumed: boolean;
  project?: Project;
  toolHints?: string[];
  skillsIndex?: string;
}

/**
 * The system prompt for a direct conversation between the user and one
 * agent - a direct message in the company chat. The agent speaks as itself,
 * knows its place in the company, and may hand work to its reports, but it
 * is not the assistant and does not pretend to be.
 */
export function buildAgentChatPrompt(input: AgentChatPromptInput): string {
  const { agent, snapshot, config } = input;
  const byId = agentById(snapshot);
  const team = agent.teamId ? snapshot.teams.find((entry) => entry.id === agent.teamId) : undefined;
  const manager = agent.managerId ? byId.get(agent.managerId) : undefined;
  const reports = snapshot.agents.filter((entry) => entry.managerId === agent.id);
  const user = config.userName ? config.userName : 'the owner of the company';
  const sections: string[] = [];

  sections.push(
    [
      'You are ' + agent.name + ', ' + agent.title + ' at ' + snapshot.organization.name + ',',
      'a company of AI agents run by the assistant ' + (config.assistantName || 'Rookery') + ' for ' + user + '.',
      'You are talking directly with ' + user + ' in a private chat, the way a colleague would.',
      'Speak as yourself, in your own voice, in the first person. You are not the assistant.',
      team ? 'You are in the team "' + team.name + '"' + (team.purpose ? ' (' + team.purpose + ')' : '') + '.' : '',
      manager ? 'Your manager is ' + manager.name + ' (' + manager.slug + ').' : 'You report directly to the assistant.',
      reports.length
        ? 'Your direct reports: ' + reports.map((entry) => entry.slug + ' (' + entry.title + ')').join(', ') +
          '. You may hand them work with the assign tool when the user asks for something done.'
        : '',
      'Be helpful and concrete, keep answers short unless asked for detail, and say plainly when',
      'something is outside your role. Match the language the user writes in.',
    ]
      .filter(Boolean)
      .join(' '),
  );

  sections.push('Your standing instructions:\n' + agent.instructions);

  // How the work gets done, below the role and above the task: the agent's
  // own instructions still win, because they were written for this job.
  if (config.org.lazyCoding) sections.push(PONYTAIL_RULESET);

  if (input.project) {
    sections.push(
      'Project in focus: ' + input.project.name +
        (input.project.description ? ' — ' + input.project.description : '') +
        (input.project.path ? ' at ' + input.project.path : ''),
    );
  }

  const memoryBlock = renderMemoryBlock(input.memories, Math.floor(config.memory.contextBudget * 0.4), 'your work and this person');
  if (memoryBlock) sections.push(memoryBlock);

  if (!input.resumed && input.history?.length) {
    const lines = input.history.slice(-12).map((message) => {
      const speaker = message.role === 'user' ? 'User' : 'You';
      return speaker + ': ' + shorten(message.content, 400);
    });
    sections.push('Earlier in this conversation:\n' + lines.join('\n'));
  }

  const inboxBlock = renderInbox(input.inbox, snapshot, 'Messages waiting for you:');
  if (inboxBlock) sections.push(inboxBlock);
  for (const hint of input.toolHints ?? []) sections.push(hint);
  if (input.skillsIndex) sections.push(input.skillsIndex);

  sections.push('Today is ' + new Date().toISOString().slice(0, 10) + '.');
  return sections.join('\n\n');
}
