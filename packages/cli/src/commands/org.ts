/**
 * `rookery org ...` and `rookery assign ...` - the company on the command line.
 *
 * The assistant runs its organisation from inside a turn, through its own
 * tools. These commands are the operator's window on the same records: who
 * works here, what they are working on, and what came back. Nothing here
 * starts a conversation - `assign` hands one agent one task and prints the
 * report it wrote.
 */

import { existsSync } from 'node:fs';
import { describeAssignment, renderOrgOverview } from '@rookery/core';
import type { Agent, Assignment, Assistant, Organization } from '@rookery/core';
import { EventRenderer, formatDuration, heading, shorten, shortId } from '../ui/render.js';
import { Spinner } from '../ui/spinner.js';
import { glyph, theme } from '../ui/theme.js';
import {
  CliError,
  parseLimit,
  parsePermission,
  parseProvider,
  withAssistant,
} from './shared.js';

const out = process.stdout;

/* ------------------------------ overview ------------------------------- */

export interface OrgViewOptions {
  json?: boolean;
}

/** `rookery org` - the org chart as the assistant sees it. */
export async function orgOverviewCommand(options: OrgViewOptions = {}): Promise<number> {
  return withAssistant((assistant) => {
    const organization = assistant.org.activeOrganization();
    const snapshot = assistant.org.snapshot(organization.id);

    if (options.json) {
      out.write(JSON.stringify(snapshot, null, 2) + '\n');
      return 0;
    }

    out.write('\n' + renderOrgOverview(snapshot) + '\n');
    if (!snapshot.agents.length) {
      out.write('\n' + theme.dim('rookery org hire --name … --title … --instructions "…"') + '\n');
    }
    out.write('\n');
    return 0;
  });
}

/* -------------------------------- agents -------------------------------- */

/** `rookery org agents` - the staff list. */
export async function orgAgentsCommand(options: OrgViewOptions = {}): Promise<number> {
  return withAssistant((assistant) => {
    const organization = assistant.org.activeOrganization();
    const agents = assistant.store.org.listAgents(organization.id);

    if (options.json) {
      out.write(JSON.stringify(agents, null, 2) + '\n');
      return 0;
    }

    if (!agents.length) {
      out.write(theme.dim('Nobody works here yet. Hire someone with `rookery org hire`.') + '\n');
      return 0;
    }

    const teams = new Map(assistant.store.org.listTeams(organization.id).map((team) => [team.id, team.name]));
    const byId = new Map(agents.map((agent) => [agent.id, agent]));

    out.write('\n' + heading('Agents') + theme.dim('  (' + agents.length + ')') + '\n\n');
    for (const agent of agents) {
      const manager = agent.managerId ? byId.get(agent.managerId) : undefined;
      out.write(
        theme.amber(shorten(agent.slug, 17).padEnd(18)) +
          theme.ivory(shorten(agent.name, 19).padEnd(20)) +
          theme.dim(
            shorten(agent.title, 25).padEnd(26) +
              (agent.teamId ? shorten(teams.get(agent.teamId) ?? '?', 13) : '-').padEnd(14) +
              (manager ? shorten(manager.slug, 13) : 'assistant').padEnd(14) +
              (agent.provider ?? 'default'),
          ) +
          '\n',
      );
    }
    out.write('\n');
    return 0;
  });
}

export interface HireOptions {
  name?: string;
  title?: string;
  instructions?: string;
  slug?: string;
  team?: string;
  manager?: string;
  provider?: string;
  model?: string;
  permission?: string;
  json?: boolean;
}

/** `rookery org hire` - add a permanent member of staff. */
export async function orgHireCommand(options: HireOptions): Promise<number> {
  const name = (options.name ?? '').trim();
  const title = (options.title ?? '').trim();
  const instructions = (options.instructions ?? '').trim();
  if (!name) throw new CliError('--name is required.');
  if (!title) throw new CliError('--title is required.');
  if (!instructions) throw new CliError('--instructions is required: what does this role do?');

  return withAssistant((assistant) => {
    const organization = assistant.org.activeOrganization();

    const team = options.team ? assistant.store.org.findTeam(organization.id, options.team) : null;
    if (options.team && !team) {
      throw new CliError('No team "' + options.team + '". Create it with `rookery org teams add`.');
    }
    const manager = options.manager ? assistant.store.org.findAgent(organization.id, options.manager) : null;
    if (options.manager && !manager) throw new CliError('No agent "' + options.manager + '" to report to.');

    const agent = assistant.store.org.createAgent({
      orgId: organization.id,
      name,
      title,
      instructions,
      slug: options.slug,
      teamId: team?.id,
      managerId: manager?.id,
      provider: parseProvider(options.provider),
      model: options.model,
      permission: parsePermission(options.permission),
    });

    if (options.json) {
      out.write(JSON.stringify(agent, null, 2) + '\n');
      return 0;
    }

    out.write(theme.green(glyph.ok + ' Hired ' + agent.name + ' as ' + agent.title) + '\n');
    out.write(theme.dim('  slug ' + agent.slug + '  ' + glyph.dot + '  id ' + shortId(agent.id)) + '\n');
    out.write(theme.dim('  rookery assign ' + agent.slug + ' "<task>"') + '\n');
    return 0;
  });
}

/* --------------------------------- teams -------------------------------- */

/** `rookery org teams` - the groups agents belong to. */
export async function orgTeamsCommand(options: OrgViewOptions = {}): Promise<number> {
  return withAssistant((assistant) => {
    const organization = assistant.org.activeOrganization();
    const teams = assistant.store.org.listTeams(organization.id);

    if (options.json) {
      out.write(JSON.stringify(teams, null, 2) + '\n');
      return 0;
    }

    if (!teams.length) {
      out.write(theme.dim('No teams yet. Add one with `rookery org teams add <name>`.') + '\n');
      return 0;
    }

    const agents = new Map(
      assistant.store.org.listAgents(organization.id).map((agent) => [agent.id, agent]),
    );

    out.write('\n' + heading('Teams') + theme.dim('  (' + teams.length + ')') + '\n\n');
    for (const team of teams) {
      const lead = team.leadId ? agents.get(team.leadId) : undefined;
      const members = [...agents.values()].filter((agent) => agent.teamId === team.id).length;
      out.write(
        theme.amber(shorten(team.name, 21).padEnd(22)) +
          theme.ivory(shorten(team.purpose ?? '', 44).padEnd(46)) +
          theme.dim(
            (lead ? 'lead ' + shorten(lead.slug, 16) : 'no lead').padEnd(24) +
              members +
              (members === 1 ? ' member' : ' members'),
          ) +
          '\n',
      );
    }
    out.write('\n');
    return 0;
  });
}

export interface TeamAddOptions {
  purpose?: string;
  lead?: string;
}

/** `rookery org teams add <name>` */
export async function orgTeamAddCommand(name: string, options: TeamAddOptions = {}): Promise<number> {
  const wanted = name.trim();
  if (!wanted) throw new CliError('A team needs a name.');

  return withAssistant((assistant) => {
    const organization = assistant.org.activeOrganization();
    const lead = options.lead ? assistant.store.org.findAgent(organization.id, options.lead) : null;
    if (options.lead && !lead) throw new CliError('No agent "' + options.lead + '" to lead the team.');

    const team = assistant.store.org.createTeam({
      orgId: organization.id,
      name: wanted,
      purpose: options.purpose,
      leadId: lead?.id,
    });

    out.write(theme.green(glyph.ok + ' Team "' + team.name + '"') + '\n');
    out.write(theme.dim('  id ' + shortId(team.id) + (lead ? '  ' + glyph.dot + '  lead ' + lead.slug : '')) + '\n');
    return 0;
  });
}

/* ------------------------------- projects ------------------------------- */

/** `rookery org projects` - what the company is working on. */
export async function orgProjectsCommand(options: OrgViewOptions = {}): Promise<number> {
  return withAssistant((assistant) => {
    const organization = assistant.org.activeOrganization();
    const projects = assistant.store.org.listProjects(organization.id);

    if (options.json) {
      out.write(JSON.stringify(projects, null, 2) + '\n');
      return 0;
    }

    if (!projects.length) {
      out.write(theme.dim('No projects yet. Add one with `rookery org projects add <name>`.') + '\n');
      return 0;
    }

    out.write('\n' + heading('Projects') + theme.dim('  (' + projects.length + ')') + '\n\n');
    for (const project of projects) {
      out.write(
        theme.amber(shorten(project.name, 21).padEnd(22)) +
          theme.ivory(shorten(project.description ?? '', 38).padEnd(40)) +
          theme.dim(project.path ?? 'no directory') +
          '\n',
      );
    }
    out.write('\n');
    return 0;
  });
}

export interface ProjectAddOptions {
  path?: string;
  description?: string;
}

/** `rookery org projects add <name>` */
export async function orgProjectAddCommand(
  name: string,
  options: ProjectAddOptions = {},
): Promise<number> {
  const wanted = name.trim();
  if (!wanted) throw new CliError('A project needs a name.');

  const path = options.path?.trim();
  // A project path is where assignments actually run; a typo here would only
  // surface much later, as an agent failing in a directory nobody meant.
  if (path && !existsSync(path)) throw new CliError('The directory ' + path + ' does not exist.');

  return withAssistant((assistant) => {
    const organization = assistant.org.activeOrganization();
    const project = assistant.store.org.createProject({
      orgId: organization.id,
      name: wanted,
      description: options.description,
      path,
    });

    out.write(theme.green(glyph.ok + ' Project "' + project.name + '"') + '\n');
    out.write(
      theme.dim('  id ' + shortId(project.id) + '  ' + glyph.dot + '  ' + (project.path ?? 'no directory')) + '\n',
    );
    return 0;
  });
}

/* ------------------------------ assignments ----------------------------- */

export interface AssignmentsOptions {
  limit?: string;
  json?: boolean;
}

/** `rookery org assignments` - what has been handed out lately. */
export async function orgAssignmentsCommand(options: AssignmentsOptions = {}): Promise<number> {
  return withAssistant((assistant) => {
    const organization = assistant.org.activeOrganization();
    const limit = parseLimit(options.limit, 20);
    const assignments = assistant.store.org.listAssignments(organization.id, { limit });

    if (options.json) {
      out.write(JSON.stringify(assignments, null, 2) + '\n');
      return 0;
    }

    if (!assignments.length) {
      out.write(theme.dim('No assignments yet. Try `rookery assign <agent> "<task>"`.') + '\n');
      return 0;
    }

    const agents = agentIndex(assistant, organization);

    out.write('\n' + heading('Assignments') + theme.dim('  (' + assignments.length + ')') + '\n\n');
    for (const assignment of assignments) {
      out.write(assignmentLine(assignment, agents.get(assignment.agentId)) + '\n');
    }
    out.write('\n' + theme.dim('rookery org assignment <id>  to read one') + '\n\n');
    return 0;
  });
}

/** `rookery org assignment <id>` - the full record, report included. */
export async function orgAssignmentCommand(idOrPrefix: string): Promise<number> {
  return withAssistant((assistant) => {
    const organization = assistant.org.activeOrganization();
    const assignment = resolveAssignment(assistant, organization, idOrPrefix);
    out.write('\n' + describeAssignment(assignment, assistant.store.org.getAgent(assignment.agentId)) + '\n\n');
    return 0;
  });
}

/* -------------------------------- messages ------------------------------ */

export interface MessagesOptions {
  limit?: string;
  json?: boolean;
}

/** `rookery org messages` - the internal post. */
export async function orgMessagesCommand(options: MessagesOptions = {}): Promise<number> {
  return withAssistant((assistant) => {
    const organization = assistant.org.activeOrganization();
    const limit = parseLimit(options.limit, 20);
    const messages = assistant.store.org.listMessages(organization.id, limit);

    if (options.json) {
      out.write(JSON.stringify(messages, null, 2) + '\n');
      return 0;
    }

    if (!messages.length) {
      out.write(theme.dim('No messages yet.') + '\n');
      return 0;
    }

    const agents = agentIndex(assistant, organization);
    const who = (id: string | undefined): string =>
      id ? (agents.get(id)?.slug ?? shortId(id)) : 'assistant';

    out.write('\n' + heading('Messages') + theme.dim('  (' + messages.length + ')') + '\n\n');
    for (const message of messages) {
      out.write(
        theme.dim(new Date(message.createdAt).toISOString().slice(0, 16).replace('T', ' ') + '  ') +
          theme.amber(shorten(who(message.fromAgentId), 15).padEnd(16)) +
          theme.dim(glyph.prompt + ' ') +
          theme.cyan(shorten(who(message.toAgentId), 15).padEnd(16)) +
          theme.ivory(shorten(message.content, 60)) +
          (message.readAt ? '' : theme.dim('  new')) +
          '\n',
      );
    }
    out.write('\n');
    return 0;
  });
}

/* --------------------------------- assign ------------------------------- */

export interface AssignCommandOptions {
  project?: string;
  session?: string;
  json?: boolean;
  verbose?: boolean;
}

export interface AssignmentRunInput {
  /** Agent id, slug or name. */
  agent: string;
  task: string;
  projectId?: string;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface AssignmentRunResult {
  /** The report the agent wrote. */
  report: string;
  aborted: boolean;
  failed: boolean;
}

/**
 * Stream one assignment to a line-based terminal. Shared by `rookery assign`
 * and the REPL's `/assign`, so both render and abort identically. Never throws.
 */
export async function runAssignment(
  assistant: Assistant,
  input: AssignmentRunInput,
  options: { json?: boolean; verbose?: boolean; label?: string } = {},
): Promise<AssignmentRunResult> {
  const json = options.json ?? false;
  const spinner = json ? null : new Spinner(options.label ?? 'working');
  const renderer = new EventRenderer({
    json,
    verbose: options.verbose ?? false,
    spinner,
    agentSlug: (id) => assistant.store.org.getAgent(id)?.slug ?? shortId(id),
  });

  let failed = false;

  spinner?.start();
  try {
    for await (const event of assistant.assign(input)) {
      if (event.type === 'error') {
        if (input.signal?.aborted) continue;
        if (event.fatal) failed = true;
      }
      renderer.handle(event);
    }
  } catch (error) {
    if (!input.signal?.aborted) {
      failed = true;
      renderer.handle({ type: 'error', message: (error as Error).message, fatal: true });
    }
  } finally {
    spinner?.stop();
  }

  const aborted = Boolean(input.signal?.aborted);
  // `assign` ends with a `done` carrying the report; the renderer only
  // collected it, because an agent's report is not streamed prose.
  return { report: renderer.finish().trim(), aborted, failed: failed && !aborted };
}

/** `rookery assign <agent> <task...>` - one agent, one task, one report. */
export async function assignCommand(
  agentRef: string,
  taskParts: string[],
  options: AssignCommandOptions = {},
): Promise<number> {
  const task = taskParts.join(' ').trim();
  if (!task) throw new CliError('Nothing to assign. Pass a task, e.g. `rookery assign backend-dev "..."`.');

  const controller = new AbortController();
  const onInterrupt = (): void => {
    controller.abort();
  };
  process.on('SIGINT', onInterrupt);

  try {
    return await withAssistant(async (assistant) => {
      const organization = assistant.org.activeOrganization();
      const agent = assistant.store.org.findAgent(organization.id, agentRef);
      if (!agent) {
        throw new CliError('No agent "' + agentRef + '". Run `rookery org agents` to see who works here.');
      }

      let projectId: string | undefined;
      if (options.project) {
        const project = assistant.store.org.findProject(organization.id, options.project);
        if (!project) throw new CliError('No project "' + options.project + '".');
        projectId = project.id;
      }

      const json = options.json ?? false;
      const result = await runAssignment(
        assistant,
        {
          agent: agent.id,
          task,
          projectId,
          sessionId: options.session,
          signal: controller.signal,
        },
        { json, verbose: options.verbose ?? false, label: agent.slug + ' working' },
      );

      if (!json && result.report) out.write('\n' + result.report + '\n');

      if (result.aborted) {
        if (!json) process.stderr.write(theme.dim(glyph.warn + ' interrupted') + '\n');
        return 130;
      }
      return result.failed ? 1 : 0;
    });
  } finally {
    process.off('SIGINT', onInterrupt);
  }
}

/* -------------------------------- helpers ------------------------------- */

function agentIndex(assistant: Assistant, organization: Organization): Map<string, Agent> {
  return new Map(
    assistant.store.org
      .listAgents(organization.id, { includeArchived: true })
      .map((agent) => [agent.id, agent]),
  );
}

function assignmentLine(assignment: Assignment, agent: Agent | undefined): string {
  const paint =
    assignment.status === 'done'
      ? theme.green
      : assignment.status === 'failed'
        ? theme.red
        : assignment.status === 'running'
          ? theme.yellow
          : theme.dim;
  return (
    theme.amber(shortId(assignment.id).padEnd(9)) +
    theme.cyan(shorten(agent?.slug ?? assignment.agentId, 15).padEnd(16)) +
    paint(assignment.status.padEnd(10)) +
    theme.dim((assignment.durationMs === undefined ? '' : formatDuration(assignment.durationMs)).padStart(7) + '  ') +
    theme.ivory(shorten(assignment.task, 48))
  );
}

/** Accept a full assignment id or any unambiguous prefix of one. */
function resolveAssignment(
  assistant: Assistant,
  organization: Organization,
  idOrPrefix: string,
): Assignment {
  const exact = assistant.store.org.getAssignment(idOrPrefix);
  if (exact && exact.orgId === organization.id) return exact;

  const needle = idOrPrefix.trim().toLowerCase();
  const matches = assistant.store.org
    .listAssignments(organization.id, { limit: 1000 })
    .filter((assignment) => assignment.id.toLowerCase().startsWith(needle));

  if (matches.length === 1) return matches[0] as Assignment;
  if (matches.length === 0) throw new CliError('No assignment matches "' + idOrPrefix + '".');
  throw new CliError(
    'Ambiguous assignment id "' + idOrPrefix + '": ' + matches.map((a) => shortId(a.id)).join(', '),
  );
}
