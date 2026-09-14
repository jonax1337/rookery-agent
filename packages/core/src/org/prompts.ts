import type {
  Agent,
  AgentMessage,
  Assignment,
  CronJob,
  Mail,
  Organization,
  Project,
  RequesterKind,
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

/** Who sent one mail, as a prompt says it: an agent's slug, or "user"/"assistant". */
export function mailSender(mail: Mail, snapshot: OrgSnapshot): string {
  if (mail.fromKind !== 'agent') return mail.fromKind;
  return (mail.fromAgentId ? agentById(snapshot).get(mail.fromAgentId)?.slug : undefined) ?? 'unknown agent';
}

/** Mail lines for a prompt or a read_mail reply; empty string when there is none. */
export function renderMail(mail: Mail[], snapshot: OrgSnapshot, heading: string, bodyChars = 600): string {
  if (!mail.length) return '';
  const byId = agentById(snapshot);
  const who = (kind: RequesterKind, id?: string): string =>
    kind === 'agent' ? (id ? (byId.get(id)?.slug ?? 'unknown agent') : 'unknown agent') : kind;
  const lines = mail.map((entry) => {
    const from = who(entry.fromKind, entry.fromAgentId);
    const to = entry.recipients.filter((r) => r.box === 'to').map((r) => who(r.recipientKind, r.recipientId)).join(', ');
    const cc = entry.recipients.filter((r) => r.box === 'cc').map((r) => who(r.recipientKind, r.recipientId)).join(', ');
    return (
      '- [' + entry.id.slice(0, 8) + '] from ' + from + ' to ' + (to || '-') + (cc ? ', cc ' + cc : '') +
      ' - subject: ' + entry.subject + '\n  ' + clip(entry.body, bodyChars)
    );
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
  mail: Mail[],
  activeProject?: Project,
  schedules: CronJob[] = [],
): string {
  const sections: string[] = [];

  sections.push(
    [
      'As the personal assistant described in your saved profile, you run a small company of AI agents on their behalf.',
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
      'asking - a turn of your own in a fresh conversation, or an assignment to an agent - with the',
      'outcome posted to your inbox. Use them whenever the user wants something regularly ("every',
      'morning at 8", "on Fridays") or at a later time ("tomorrow at 15:00", once).',
      'Turn what they say into a cron expression yourself and confirm the time in words.',
      'A scheduled run of your own always ends with that "completed" note in the inbox, unless the',
      'run itself already delivered the result to the user - a mail you sent them as the point of the',
      'job. In that case end the turn with exactly [SILENT] instead of a report, or the user gets the',
      'same thing twice: the mail the job exists to send, and a second mail just saying it ran.',
      'Nothing here needs permission from anyone: you own the company and its machinery.',
      'Two words to keep apart when you talk to the user: an assignment is',
      'one agent running one brief, with a result; a task is an item on the',
      'board that gets planned and then executed as one or more assignments.',
      'Delegate real work - code, research, analysis, long writing - instead of doing it here;',
      'you have no project files in this conversation.',
      'Most turns are not work at all. Small talk, questions about the user, their day or their',
      'plans, and anything you can answer from memory get a direct, personal reply: talk about',
      'them and what you know of them, never about repositories or tools unless they ask.',
      'When you delegated, report the outcome in your own identity and words; never narrate',
      'tool mechanics.',
    ].join(' '),
  );

  sections.push(
    [
      'Company mail is how everyone here talks to everyone else, and how you reach the user when no',
      'conversation is running. `send_mail` writes to an agent, to "user", or to several at once;',
      '`read_mail` and `read_mail_thread` are your side of it. Mail with an agent on To starts a real',
      'run of that agent and its report comes back to you as a reply - that is delegation you do not',
      'have to wait for, where `assign` is delegation you do. Cc only delivers.',
      'Write to the user by mail when you are the one starting it: a finished piece of work, a report',
      'they asked for, a decision only they can make. Answering a mail that arrived for you works the',
      'other way round - the answer is what you write in that turn, it goes back as the reply on its',
      'own, and a send_mail carrying the same thing delivers it twice.',
      'A mail to the user also reaches their phone',
      'through whatever channel is connected, so it is a real message and not a note left in a drawer -',
      'say the thing and stop; never mail them a running commentary on what the company is doing.',
      '`notify` is not a second mailbox: it is the one line that has to arrive now, and everything',
      'that can be read later is mail.',
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

  const mailBlock = renderMail(mail, snapshot, 'Mail waiting for you:');
  if (mailBlock) sections.push(mailBlock);

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
  mail: Mail[];
  assignmentId: string;
  /** Who gave the assignment, for the prompt's sense of the chain of command. */
  requestedBy: string;
  /** Set when this assignment came from mail: its subject, for the reply paragraph below. */
  sourceMailSubject?: string;
  /** That mail's id and thread, so the prompt can point at the history instead of carrying it. */
  sourceMailId?: string;
  sourceMailThreadId?: string;
  /** The rest of that mail's thread, oldest first - listed as an index, not in full. */
  sourceMailThread?: Mail[];
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

  // Mail is the company's only channel between colleagues, so the prompt
  // says who to write to rather than leaving `send_mail` as a tool nobody
  // reaches for. The lead sentence is the reason the user's phone stays
  // quiet: a team speaks to them through one agent, not five.
  sections.push(
    [
      'Company mail is how people here reach each other. `send_mail` writes to a colleague by slug, to',
      'your manager, to "assistant" or to "user"; `read_mail` and `read_mail_thread` are your side of',
      'it. Mail with a colleague on To starts a real run of theirs and their answer comes back as a',
      'reply, so it is how you ask somebody for something you do not have to sit and wait for; Cc only',
      'delivers, for keeping somebody in the picture. Use it: a question for whoever knows the system,',
      'a heads-up that changes their plans, a hand-off of work that is not yours. What it is not for',
      'is thinking out loud or saying thank you - every mail you send costs somebody a run.',
      team && team.leadId === agent.id
        ? 'You lead ' + team.name + ': your team reaches the user through you, so what the team has to ' +
          'tell them is yours to write - one mail with the whole picture, not one per person.'
        : 'Write to the user only when the work was theirs to begin with or nobody else can answer; ' +
          'otherwise it goes to your manager, your team lead or the assistant, who decides what ' +
          'reaches them.',
    ]
      .filter(Boolean)
      .join(' '),
  );

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

  const mailBlock = renderMail(input.mail, snapshot, 'Mail waiting for you:');
  if (mailBlock) sections.push(mailBlock);
  for (const hint of input.toolHints ?? []) sections.push(hint);
  if (input.skillsIndex) sections.push(input.skillsIndex);

  if (input.sourceMailSubject) {
    // The thread stays out of the prompt: a long conversation would cost more
    // context than most mails need. What goes in is the index and where to get
    // the rest, so the agent pays for the history only when it reads it.
    const earlier = input.sourceMailThread ?? [];
    if (earlier.length && input.sourceMailThreadId) {
      // With the id: eight replies in one thread share almost the same
      // subject, and without it there is no way to name one of them.
      const index = earlier
        .map((entry) => '- [' + entry.id.slice(0, 8) + '] ' + mailSender(entry, snapshot) + ': ' + entry.subject)
        .join('\n');
      sections.push(
        'Earlier in this mail thread (' + earlier.length + ' mail(s) you sent or were To/Cc on), subjects only:\n' +
          index + '\nRead the full text with read_mail_thread("' + input.sourceMailThreadId + '") when the answer ' +
          'depends on it.',
      );
    }
    sections.push(
      'This assignment arrived as an email from ' + input.requestedBy + ', subject "' + input.sourceMailSubject + '". ' +
        "Write your result as the reply's body, not a chat answer or a report - it goes back to them " +
        'automatically, and everyone who was Cc on their mail stays Cc on yours. Do not send_mail the ' +
        'same answer to them on top of it; send_mail is for bringing in somebody who was not on the thread.',
    );
  }

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
      'assume. Anything that belongs to somebody other than whoever assigned this goes by mail, as',
      'described above, not into the report. Write in the language the assignment is written in.',
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
