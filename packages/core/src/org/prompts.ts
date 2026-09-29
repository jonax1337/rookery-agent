import type {
  Agent,
  AgentMessage,
  Assignment,
  CronJob,
  Organization,
  Project,
  RookeryConfig,
  ScoredMemory,
  Task,
  TaskEvent,
  Team,
} from '../types.js';
import type { OrgStore } from './store.js';
import type { Store } from '../memory/store.js';
import { renderMemoryBlock } from '../memory/recall.js';
import { PONYTAIL_RULESET } from './ponytail.js';
import { describeCronJob } from '../cron/scheduler.js';
import { clip, shorten } from '../util/queue.js';
import { formatAge, formatNow, formatWhen } from '../util/time.js';

/**
 * Prompt text for the organisation.
 *
 * Two kinds of prompt come out of here. The assistant's turn gets a block
 * describing the company it runs and how to use its tools; it is appended to
 * the ordinary identity prompt. An agent's run gets a complete system
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
  /** Runs currently pending or running. */
  active: Assignment[];
}

const agentById = (snapshot: OrgSnapshot): Map<string, Agent> =>
  new Map(snapshot.agents.map((agent) => [agent.id, agent]));

/**
 * Voices of one agent's own team and manager only - never the whole company
 * (decision E13, section 6.4): a company of twenty would otherwise carry
 * nineteen irrelevant voice descriptions into every single run. An agent
 * with no voice set contributes no line here at all; that is the silent,
 * neutral default (F5), not something worth naming as absent.
 */
function renderColleagueVoices(agent: Agent, snapshot: OrgSnapshot): string {
  const byId = agentById(snapshot);
  const manager = agent.managerId ? byId.get(agent.managerId) : undefined;
  const teammates = agent.teamId
    ? snapshot.agents.filter((entry) => entry.teamId === agent.teamId && entry.id !== agent.id)
    : [];
  const lines: string[] = [];
  if (manager?.voice) lines.push('- ' + manager.slug + ' (your manager): ' + manager.voice);
  for (const mate of teammates) {
    if (mate.voice) lines.push('- ' + mate.slug + ' (your team): ' + mate.voice);
  }
  if (!lines.length) return '';
  return 'How your manager and team write, so what comes from or is about them reads like them:\n' + lines.join('\n');
}

/**
 * The org chart as plain text, shared by the overview tool and the prompts.
 *
 * `org` is optional and only buys the run numbers: without it a running piece
 * of work still has its name, which is the part that makes the list readable.
 */
export function renderOrgOverview(snapshot: OrgSnapshot, org?: OrgStore): string {
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
    lines.push('Running now:');
    for (const assignment of snapshot.active) {
      const agent = byId.get(assignment.agentId);
      // The name, not the first 120 characters of the brief: three errands
      // for the same agent open with the same twenty words, and a list of
      // those tells nobody which is which (concept 7.1).
      const run = org?.taskRunNumber(assignment.id) ?? null;
      lines.push(
        '- ' + assignment.id.slice(0, 8) + ' ' + (agent?.slug ?? '?') + ': ' + shorten(assignment.title, 120) +
          (run && run > 1 ? ' (run ' + run + ')' : ''),
      );
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
 * One task's activity as a tool answer: who did what, oldest first. The
 * whole of each line - the tool is asked for when the answer depends on the
 * detail - but clipped per line, so one enormous report cannot crowd out the
 * question that came after it.
 */
export function renderTaskActivity(task: Task, events: TaskEvent[], snapshot: OrgSnapshot, bodyChars = 4000): string {
  const byId = agentById(snapshot);
  const who = (event: TaskEvent): string =>
    event.actorKind === 'agent'
      ? (event.actorAgentId ? (byId.get(event.actorAgentId)?.slug ?? 'unknown agent') : 'an agent')
      : event.actorKind === 'system'
        ? 'Rookery'
        : event.actorKind;
  const head = 'Task ' + task.id.slice(0, 8) + ' "' + task.title + '" - ' + task.status;
  if (!events.length) return head + '\nNothing recorded on it yet.';
  const lines = events.map(
    (event) => '- ' + formatWhen(event.at) + ' ' + event.kind + ' by ' + who(event) + ':\n  ' + clip(event.text || '-', bodyChars),
  );
  return head + '\n' + lines.join('\n');
}

/**
 * The block appended to the assistant's identity prompt: what it runs and
 * how to delegate.
 */
export function assistantOrgBlock(
  config: RookeryConfig,
  snapshot: OrgSnapshot,
  activeProject?: Project,
  schedules: CronJob[] = [],
  store?: Store,
): string {
  const sections: string[] = [];

  sections.push(
    [
      'As the personal assistant described in your saved profile, you run a small company of AI agents on their behalf.',
      'The agents are permanent staff with roles and their own memory; every task you hand',
      'one runs as a separate process in the background, in the project directory when the project',
      'has one. The rookery tools are yours: `assign` hands a task to one agent, puts it on the',
      'board and returns the report (several `assign` calls in one message run in parallel);',
      '`create_task`, `plan_task`',
      'and `run_task` put bigger work on the board, decide who does it or how to split it, and',
      'execute it; `hire_agent`, `update_agent`, `create_team`, `update_team`, `create_project` and',
      '`update_project` shape the company when the user asks or when a job clearly needs a role',
      'nobody holds. `list_assignments` is the history of what ran; `cancel_assignment` stops a',
      'stuck or unwanted run, and `update_task` with status "cancelled" stops a running task.',
      'Everything that gets worked on is a task: it has a card on the board, and the card keeps its',
      'own activity - the brief, every run and how it ended, questions and answers - which',
      '`task_activity` reads.',
      'Name every task you create: three to eight words, no full stop, a noun phrase or an',
      'imperative, in the language of the brief - never the brief itself pasted into the title.',
      'An agent that needs something only whoever asked for the work can answer puts the question on',
      'the card and the task waits as "blocked". When that is work you handed off, the question comes',
      'to you as a message in the conversation it came from: put it to the user, then answer with',
      '`answer_task` - the task picks up again with the answer. Answer it yourself only when you know',
      'the answer for certain. Questions on cards the user put up themselves reach them directly.',
      '`remember`, `forget` and `search_memory` are your long-term memory of the user;',
      '`get_settings` and `update_settings` are the defaults and limits you work under.',
      '`create_schedule`, `list_schedules`, `update_schedule`, `delete_schedule` and `run_schedule`',
      'are your schedules (cron jobs): standing orders that fire on a timetable without anyone',
      'asking - a turn of your own in a fresh conversation, or a task for an agent - with the',
      'outcome reaching the user as a notification. Use them whenever the user wants something',
      'regularly ("every morning at 8", "on Fridays") or at a later time ("tomorrow at 15:00", once).',
      'Turn what they say into a cron expression yourself and confirm the time in words.',
      'A scheduled run of your own always ends with that "completed" notification, carrying your',
      'closing report, unless the run itself already delivered the result to the user - a `notify`',
      'that was the point of the job. In that case end the turn with exactly [SILENT] instead of a',
      'report, or the user gets the same thing twice.',
      'Nothing here needs permission from anyone: you own the company and its machinery.',
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
      'How things reach whom: work you hand off with `assign` comes back to you - as the tool result',
      'when you wait, as a message in this conversation when you hand it off in the background - and',
      'you tell the user in your own words. You reach the user through your answer in the',
      'conversation; outside one, `notify` sends them one line that has to arrive now, and it is',
      'also kept for them to read later. Schedule results, questions on cards the user put up',
      'themselves and what agents report reach the user as notifications on their own - you do not',
      'have to relay those. There is no internal mail: never promise to "write" or "mail" anyone.',
    ].join(' '),
  );

  sections.push(renderOrgOverview(snapshot, store?.org));

  if (store) {
    const flags = renderPerformanceFlags(snapshot, store.org);
    if (flags) sections.push(flags);
  }

  if (activeProject) {
    sections.push(
      'Active project for this conversation: ' + activeProject.name +
        (activeProject.path ? ' at ' + activeProject.path : ' (no directory)') +
        '. Work you hand out defaults to it.',
    );
  }

  if (schedules.length) sections.push(renderSchedules(schedules, snapshot));

  return sections.join('\n\n');
}

/** The schedules, one line each, as the assistant's prompt and the list tool show them. */
export function renderSchedules(schedules: CronJob[], snapshot: OrgSnapshot): string {
  if (!schedules.length) return 'No schedules yet.';
  const byId = agentById(snapshot);
  const lines = schedules.map((job) => describeCronJob(job, job.agentId ? byId.get(job.agentId)?.slug : undefined));
  return 'Your schedules (cron jobs, local time):\n' + lines.join('\n');
}

/**
 * One line per agent at escalation stage >= 1 (agent-performance-
 * management, section 5): the point is that Jarvis brings this up on its
 * own turn rather than waiting to be asked. Empty string when nobody is
 * flagged, so a healthy company adds nothing to the prompt.
 */
function renderPerformanceFlags(snapshot: OrgSnapshot, org: OrgStore): string {
  const lines: string[] = [];
  for (const agent of snapshot.agents) {
    const performance = org.performance(agent.id);
    if (performance.stage === 0) continue;
    const detail =
      performance.stage === 1
        ? 'flagged, a development note is on record'
        : performance.stage === 2
          ? 'reconfigured, on probation'
          : 'reconfigured twice, a replacement has been proposed - awaiting your decision';
    lines.push(
      '- ' + agent.slug + ': stage ' + performance.stage + ' (' + detail + ')' +
        (performance.average !== null ? ', average ' + performance.average.toFixed(1) : ''),
    );
  }
  if (!lines.length) return '';
  return 'Staff performance needing your attention (agent_performance for detail):\n' + lines.join('\n');
}

export interface AgentPromptInput {
  config: RookeryConfig;
  agent: Agent;
  snapshot: OrgSnapshot;
  project?: Project;
  memories: ScoredMemory[];
  assignmentId: string;
  /** Who asked for the work, for the prompt's sense of the chain of command. */
  requestedBy: string;
  /**
   * The task this run carries out, when there is one. Only then is there a
   * card to put a question on, so only then does the prompt offer
   * `ask_requester`.
   */
  taskId?: string;
  /** One paragraph per tool server attached to this run, from the hub. */
  toolHints?: string[];
  /** The skills index, when there are skills for agents. */
  skillsIndex?: string;
  /**
   * Development feedback written since the last reconfig (decision E2): no
   * number, no dimension name and no reference to being reviewed ever
   * reaches this far - only the qualitative note itself. Newest first,
   * at most two shown.
   */
  agentNotes?: { note: string; createdAt: number }[];
  /** Set only for a successor agent: who it replaced, and the condensed handover (decision E3). */
  handoverFrom?: { predecessorName: string; text: string };
}

/** The complete system prompt for one agent carrying out one task. */
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
      'This task (' + input.assignmentId.slice(0, 8) + ') was given to you by ' + input.requestedBy + '.',
    ]
      .filter(Boolean)
      .join(' '),
  );

  sections.push('Your standing instructions:\n' + agent.instructions);

  const colleagueVoices = renderColleagueVoices(agent, snapshot);
  if (colleagueVoices) sections.push(colleagueVoices);

  // How anything leaves this run. There is no mail between colleagues any
  // more (docs/concepts/mail-removal-notifications-and-task-activity.md):
  // the result is the answer, a question goes on the card, and the user is
  // written to rarely and on purpose. The lead sentence is the reason the
  // user's phone stays quiet: a team speaks to them through one agent, not
  // five.
  sections.push(
    [
      'Your result is the answer: whatever you end this run with goes back to whoever gave you the',
      'task, on its own - there is nothing to send.',
      input.taskId
        ? 'If you cannot go on without something only they can tell you, ask it with `ask_requester`: ' +
          'the question goes on the task card, the task waits for the answer, and you are started again ' +
          'with it. Then end the run with a short summary of where the work stands. Never guess past a ' +
          'question that changes the outcome, and never ask one you could answer yourself.'
        : '',
      '`task_activity` shows what already happened on a card.',
      team && team.leadId === agent.id
        ? 'You lead ' + team.name + ': your team reaches the user through you. When something truly ' +
          'cannot wait for your result, `report_to_user` leaves them one notification with the whole ' +
          'picture - one, not one per person.'
        : '`report_to_user` leaves the user a notification. Use it only when something truly cannot ' +
          'wait for your result and nobody above you can decide it; everything else belongs in the result.',
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
      'unblock it. Stop short of anything irreversible or consequential the task did not ask',
      'for, and never claim a result you have not seen.',
    ].join(' '),
  );

  // One register for every run. The letter register a mail-born run used to
  // write in went with mail itself; `org.roleplay` is read by nothing now.
  sections.push(
    [
      'Work the task and nothing else. Your output is a report to whoever asked for it,',
      'not a chat with the user: lead with the result, then what you changed or found, then open',
      'questions. No preamble, no restating the brief. Separate what you verified from what you',
      'assume. Write in the language the task is written in.',
    ].join(' '),
  );

  // Decision E2: qualitative, never a number - see AgentPromptInput.agentNotes.
  if (input.agentNotes?.length) {
    const notes = input.agentNotes
      .slice(0, 2)
      .map((entry) => '- ' + entry.note)
      .join('\n');
    sections.push('Feedback on your work:\n' + notes);
  }

  // Decision E3: fixed prompt text, never through recall - a successor gets
  // exactly one telling of this, not a memory that might not surface.
  if (input.handoverFrom) {
    sections.push('Handover from ' + input.handoverFrom.predecessorName + ':\n' + input.handoverFrom.text);
  }

  // The clock a model judges every other stamp against, in this machine's own
  // zone. A UTC date here and a local one elsewhere is how a healthy run comes
  // to look hours old.
  sections.push('It is now ' + formatNow() + '.');
  return sections.join('\n\n');
}

/** The board as the assistant reads it. */
export function renderBoard(tasks: Task[], snapshot: OrgSnapshot, store: OrgStore): string {
  if (!tasks.length) return 'The board is empty.';
  const byId = agentById(snapshot);
  // A status filter searches the whole board, subtasks included, so a task
  // that is on the list in its own right must not turn up a second time
  // under its parent.
  const listed = new Set(tasks.map((task) => task.id));
  const lines: string[] = [];
  for (const task of tasks) {
    const assignee = task.assigneeId ? (byId.get(task.assigneeId)?.slug ?? '?') : 'unassigned';
    lines.push(
      '- [' + task.id.slice(0, 8) + '] ' + task.status.toUpperCase() + ' ' + task.priority + ' — ' + task.title +
        ' (' + assignee + ')' + (task.planNote ? ' · ' + shorten(task.planNote, 80) : '') +
        waitingOn(task, store) + attemptsOn(task, store),
    );
    for (const child of store.listTasks(task.orgId, { parentId: task.id })) {
      if (child.status === 'cancelled' || listed.has(child.id)) continue;
      const who = child.assigneeId ? (byId.get(child.assigneeId)?.slug ?? '?') : 'unassigned';
      lines.push(
        '    - [' + child.id.slice(0, 8) + '] ' + child.status + ' — ' + child.title + ' (' + who + ')' +
          waitingOn(child, store),
      );
    }
  }
  return lines.join('\n');
}

/**
 * What a waiting task waits for: how long it has stood there and the subject
 * of the question on its card (concept section 9). The board is all the
 * watcher gets to read, and "BLOCKED normal — Fix the gate (mara)" says
 * neither what was asked nor for how long.
 */
/**
 * How often a failed task has already been tried. The board watcher reports
 * rather than retries, and "failed" on its own does not say whether this is
 * the first attempt or the fourth - which is the difference between "worth
 * another go" and "something here is broken and no amount of running it
 * again will help". Only shown where it changes the reading.
 */
function attemptsOn(task: Task, store: OrgStore): string {
  if (task.status !== 'failed') return '';
  const runs = store.taskRunCount(task.id);
  return runs > 1 ? ' · failed on run ' + runs : '';
}

function waitingOn(task: Task, store: OrgStore): string {
  if (task.status !== 'blocked') return '';
  // The question itself, from the card's activity: the last one asked is the
  // one it is waiting on.
  const question = store.lastTaskEvent(task.id, 'question');
  const span = formatAge(task.updatedAt || task.createdAt, Date.now(), 'minute');
  return ' · waiting ' + span + (question ? ' on "' + shorten(question.text.replace(/\s+/g, ' '), 80) + '"' : '');
}
