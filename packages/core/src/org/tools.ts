/**
 * The Rookery tool set, as the model sees it through MCP.
 *
 * Two audiences share one vocabulary. The assistant gets everything; an
 * agent gets the subset a member of staff would have - it can hand work to
 * its own reports and write to its manager, but it cannot hire anyone or
 * restructure the company.
 */

export type ToolAudience = 'assistant' | 'agent';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Who may see the tool. */
  audience: ToolAudience[];
}

const BOTH: ToolAudience[] = ['assistant', 'agent'];
const ASSISTANT_ONLY: ToolAudience[] = ['assistant'];

const str = (description: string): Record<string, unknown> => ({ type: 'string', description });

export const ORG_TOOLS: ToolDefinition[] = [
  {
    name: 'org_overview',
    description:
      'The company you run: teams, agents (with slug, title and manager), projects, and assignments ' +
      'currently running. Call this before delegating when you are unsure who does what.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    audience: BOTH,
  },
  {
    name: 'assign',
    description:
      'Hand a task to one agent and wait for the finished result. The agent works in a separate ' +
      'process with no access to this conversation, so the task must be self-contained: restate ' +
      'every fact, file and constraint it needs. Call assign several times in one message to run ' +
      "agents in parallel. Returns the agent's complete report. With wait=false it returns at once " +
      'with the assignment id and the agent keeps working in the background; check on it with ' +
      'assignment_status.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: str('Agent slug or name.'),
        task: str('The full, self-contained instruction.'),
        project: str("Project name or id. The agent works in that project's directory. Optional."),
        wait: {
          type: 'boolean',
          description: 'Default true. False hands the task off and returns immediately.',
        },
      },
      required: ['agent', 'task'],
      additionalProperties: false,
    },
    audience: BOTH,
  },
  {
    name: 'assignment_status',
    description: 'Status, duration and result of one assignment by id.',
    inputSchema: {
      type: 'object',
      properties: { id: str('Assignment id.') },
      required: ['id'],
      additionalProperties: false,
    },
    audience: BOTH,
  },
  {
    name: 'cancel_assignment',
    description:
      'Stop a pending or running assignment. The agent process is killed and the assignment ends ' +
      'as cancelled; whatever it had written so far is lost. Use it for a stuck or runaway agent, ' +
      'or when the user changes their mind.',
    inputSchema: {
      type: 'object',
      properties: { id: str('Assignment id or prefix.') },
      required: ['id'],
      additionalProperties: false,
    },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'list_assignments',
    description:
      'The assignment history: what ran, for whom, how it ended, how long it took. Newest first. ' +
      'Filter by agent, status or project when the question is about one of them.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: str('Agent slug or name. Optional.'),
        status: str('Comma-separated statuses (pending, running, done, failed, cancelled). Optional.'),
        project: str('Project name or id. Optional.'),
        limit: { type: 'number', description: 'How many to return, 1 to 200. Default 20.' },
      },
      additionalProperties: false,
    },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'send_message',
    description:
      'Leave a short message for an agent, or for the assistant (to: "assistant"). Messages wait ' +
      "in the recipient's inbox until their next assignment or turn. Not for handing out work - " +
      'use assign for that.',
    inputSchema: {
      type: 'object',
      properties: {
        to: str('Agent slug or name, or "assistant".'),
        content: str('The message.'),
      },
      required: ['to', 'content'],
      additionalProperties: false,
    },
    audience: BOTH,
  },
  {
    name: 'read_inbox',
    description: 'Unread messages addressed to you. Reading marks them as read.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    audience: BOTH,
  },
  {
    name: 'use_skill',
    description:
      'Open one of the skills listed in your instructions: written procedures for particular kinds ' +
      'of task. Returns the full instructions and the files that come with them. Open the matching ' +
      'skill before starting such a task, then follow it.',
    inputSchema: {
      type: 'object',
      properties: { name: str('The skill name from the list.') },
      required: ['name'],
      additionalProperties: false,
    },
    audience: BOTH,
  },
  {
    name: 'tool_servers',
    description:
      'The tool hub: which MCP servers exist (computer control, browser, filesystem, GitHub, ' +
      'documentation, custom ones), whether they are on, and for whom. A server you switch on ' +
      'is attached as soon as you stop talking, and the turn carries on with it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'set_tool_server',
    description:
      'Switch a tool server on or off, for the assistant, the agents or both. Installing or ' +
      "configuring keys is the user's job on the Werkzeuge page; you only flip switches. A " +
      'server you switch on for yourself is attached the moment this answer ends, and you get ' +
      'to go on working with it in the same turn, so switch it on and continue instead of ' +
      'asking the user to try again.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('Server id from tool_servers, e.g. playwright.'),
        enabled: { type: 'boolean', description: 'On or off.' },
        audience: str('assistant, agents or both. Optional.'),
      },
      required: ['id', 'enabled'],
      additionalProperties: false,
    },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'hire_agent',
    description:
      'Create a permanent agent in the company. Give it a clear role: a name, a job title, and ' +
      'standing instructions describing how it works and what it is responsible for.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Display name, e.g. "Mara".'),
        title: str('Job title, e.g. "Backend Engineer".'),
        instructions: str('Standing instructions for the role, two to six sentences.'),
        slug: str('Short handle, lowercase with dashes. Derived from the name when omitted.'),
        team: str('Team name or id. Optional.'),
        manager: str('Manager agent slug. Omit for an agent reporting to you directly.'),
        provider: { type: 'string', enum: ['claude', 'codex'], description: 'Preferred CLI. Optional.' },
        model: str('Model name for that provider. Optional.'),
        permission: {
          type: 'string',
          enum: ['chat', 'read', 'write', 'full'],
          description: 'What the agent may do on the machine. Optional; defaults to the company default.',
        },
      },
      required: ['name', 'title', 'instructions'],
      additionalProperties: false,
    },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'update_agent',
    description:
      'Change an existing agent: move it to a team, give it a manager, rewrite its title or ' +
      'standing instructions, change provider, model or permission, or archive it. Only the ' +
      'fields you pass change.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: str('Agent slug or name.'),
        name: str('New display name. Optional.'),
        title: str('New job title. Optional.'),
        instructions: str('New standing instructions. Optional.'),
        team: str('Team name or id, or "none" to remove from its team. Optional.'),
        manager: str('Manager slug, or "assistant" to report to you directly. Optional.'),
        provider: { type: 'string', enum: ['claude', 'codex'], description: 'Optional.' },
        model: str('Optional.'),
        permission: { type: 'string', enum: ['chat', 'read', 'write', 'full'], description: 'Optional.' },
        archived: { type: 'boolean', description: 'true retires the agent, false brings it back. Optional.' },
      },
      required: ['agent'],
      additionalProperties: false,
    },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'update_team',
    description: 'Rename a team, change its purpose, or name its lead.',
    inputSchema: {
      type: 'object',
      properties: {
        team: str('Team name or id.'),
        name: str('New name. Optional.'),
        purpose: str('New purpose. Optional.'),
        lead: str('Agent slug leading the team, or "none". Optional.'),
      },
      required: ['team'],
      additionalProperties: false,
    },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'create_task',
    description:
      'Put a task on the company board without running it yet. Use this for work the user ' +
      'wants tracked, or for anything bigger than one quick assignment. Then plan_task decides ' +
      'who does it and whether to split it, and run_task executes it.',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('Short title.'),
        description: str('Everything an agent needs to do the task: goal, constraints, files, definition of done.'),
        project: str('Project name or id. Optional.'),
        priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Optional, default normal.' },
        assignee: str('Agent slug, when you already know who should do it. Optional.'),
      },
      required: ['title', 'description'],
      additionalProperties: false,
    },
    audience: BOTH,
  },
  {
    name: 'list_tasks',
    description: 'The board: open, planned, running and recently finished tasks with their assignees.',
    inputSchema: {
      type: 'object',
      properties: {
        status: str('Comma-separated statuses to include (open, planned, running, done, failed, cancelled). Optional.'),
      },
      additionalProperties: false,
    },
    audience: BOTH,
  },
  {
    name: 'update_task',
    description: 'Edit a task: title, description, priority, assignee, or mark it done or cancelled by hand.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('Task id or prefix.'),
        title: str('Optional.'),
        description: str('Optional.'),
        priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Optional.' },
        assignee: str('Agent slug, or "none". Optional.'),
        status: { type: 'string', enum: ['open', 'done', 'cancelled'], description: 'Optional.' },
        result: str('What was done, when closing by hand. Optional.'),
      },
      required: ['id'],
      additionalProperties: false,
    },
    audience: BOTH,
  },
  {
    name: 'plan_task',
    description:
      'Decide how a task gets done: one agent, or a split into subtasks for several agents with ' +
      'dependencies. A planner reads the board and the org chart and proposes the plan; the ' +
      'subtasks are created on the board. Nothing runs yet. Returns the plan so you can adjust ' +
      'it with update_task before run_task.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('Task id or prefix.'),
        hint: str('Your own guidance for the planner, e.g. who should be involved or what not to split. Optional.'),
      },
      required: ['id'],
      additionalProperties: false,
    },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'run_task',
    description:
      'Execute a task from the board and wait for the outcome. A task without a plan is planned ' +
      'first. Subtasks run as parallel assignments in dependency order; their reports come back ' +
      'combined. This is the right tool for anything that should be tracked on the board.',
    inputSchema: {
      type: 'object',
      properties: { id: str('Task id or prefix.') },
      required: ['id'],
      additionalProperties: false,
    },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'create_team',
    description: 'Create a team. Agents can be placed in it when hired or later by the user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Team name.'),
        purpose: str('What the team is for. Optional.'),
        lead: str('Agent slug leading the team. Optional.'),
      },
      required: ['name'],
      additionalProperties: false,
    },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'create_project',
    description:
      'Create a project. With a path, assignments for it run inside that directory; without one, ' +
      'agents work in the scratch workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Project name.'),
        description: str('What the project is. Optional.'),
        path: str('Absolute directory the project lives in. Optional.'),
      },
      required: ['name'],
      additionalProperties: false,
    },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'update_project',
    description:
      'Rename a project, change its description or directory, or archive it (archived projects ' +
      'disappear from the lists but keep their history). Only the fields given change.',
    inputSchema: {
      type: 'object',
      properties: {
        project: str('Project name or id.'),
        name: str('New name. Optional.'),
        description: str('New description. Optional.'),
        path: str('New absolute directory, or "none" to detach it. Optional.'),
        archived: { type: 'boolean', description: 'true archives the project, false restores it. Optional.' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'list_schedules',
    description:
      'Your schedules (cron jobs): standing orders that fire on a timetable while the server ' +
      'runs, each with its next and last run. Call it before changing or deleting one.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'create_schedule',
    description:
      'Set up a standing order that fires on a cron schedule: "every morning at 8, summarise ' +
      '...", "every Friday at 17:00, have Mara ...", or a single later run (once=true) for ' +
      '"tomorrow at 15:00 remind me ...". By default you run the prompt yourself, as a turn of ' +
      'your own in a conversation dedicated to the job, with all your tools; name an agent to ' +
      'have it run as an assignment instead. The outcome of every run lands in your inbox. The ' +
      "schedule is a five-field cron expression in the machine's local time - minute hour " +
      'day-of-month month day-of-week - e.g. "0 8 * * 1-5" (weekdays 08:00), "*/30 * * * *" ' +
      '(every 30 minutes), "0 18 1 * *" (the 1st at 18:00), "30 15 11 9 *" with once=true ' +
      '(11 September 15:30, one time); aliases @hourly, @daily, @weekly, @monthly. Write the ' +
      'prompt for whoever runs it: self-contained, and say what the report should contain.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Short name, e.g. "Morgenbriefing".'),
        schedule: str('Five-field cron expression or alias.'),
        prompt: str('What to do on each run, self-contained.'),
        agent: str('Agent slug or name to run it as an assignment. Omit to run it yourself.'),
        project: str('Project name or id the run belongs to. Optional.'),
        once: { type: 'boolean', description: 'Fire once, then switch the schedule off. Default false.' },
        enabled: { type: 'boolean', description: 'Default true.' },
      },
      required: ['name', 'schedule', 'prompt'],
      additionalProperties: false,
    },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'update_schedule',
    description:
      'Change a schedule: rename it, move it to another time, rewrite the prompt, hand it to ' +
      'an agent or take it back, switch it on or off. Only the fields you pass change.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('Schedule id, prefix, or exact name.'),
        name: str('Optional.'),
        schedule: str('New cron expression. Optional.'),
        prompt: str('Optional.'),
        agent: str('Agent slug or name, or "assistant" to run it yourself. Optional.'),
        project: str('Project name or id, or "none". Optional.'),
        enabled: { type: 'boolean', description: 'Optional.' },
        once: { type: 'boolean', description: 'Optional.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'delete_schedule',
    description: 'Remove a schedule for good, with its run history. To pause it instead, update it with enabled=false.',
    inputSchema: {
      type: 'object',
      properties: { id: str('Schedule id, prefix, or exact name.') },
      required: ['id'],
      additionalProperties: false,
    },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'run_schedule',
    description:
      'Fire a schedule right now, in the background; returns at once. The result appears in ' +
      'your inbox and on the Zeitpläne page when the run is over.',
    inputSchema: {
      type: 'object',
      properties: { id: str('Schedule id, prefix, or exact name.') },
      required: ['id'],
      additionalProperties: false,
    },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'sleep_now',
    description:
      "Run the memory's nightly clean-up right now: condense memories that say the same thing, " +
      'let unused ones fall asleep, draw connections between them and note what the last days ' +
      'add up to. It normally runs on a schedule at night, so use this only when the user asks. ' +
      'Nothing is ever deleted, and the whole run can be undone from the memory page.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'remember',
    description:
      'Write one fact into your long-term memory of the user, so it comes back in later ' +
      'conversations. One self-contained sentence per call. Use it when the user tells you to ' +
      'remember something, or for something clearly worth keeping that the automatic extraction ' +
      'might miss.',
    inputSchema: {
      type: 'object',
      properties: {
        content: str('The memory, one self-contained sentence.'),
        kind: str('fact, preference, project or event. Default fact.'),
        tags: str('Comma-separated tags. Optional.'),
        importance: { type: 'number', description: '0 to 1, how much this should outrank others. Default 0.7.' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'forget',
    description:
      'Retire a memory that is wrong or that the user wants gone. Find its id with search_memory ' +
      'first. The memory stops being recalled but stays auditable.',
    inputSchema: {
      type: 'object',
      properties: { id: str('Memory id or prefix.') },
      required: ['id'],
      additionalProperties: false,
    },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'search_memory',
    description:
      'Search your long-term memory of the user. Without a query, the most important memories. ' +
      'Returns ids, so a wrong one can be passed to forget.',
    inputSchema: {
      type: 'object',
      properties: {
        query: str('What to look for. Optional.'),
        limit: { type: 'number', description: 'How many to return, 1 to 100. Default 20.' },
      },
      additionalProperties: false,
    },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'get_settings',
    description:
      'The current settings you may change: default provider, model and effort for turns and ' +
      'assignments, and the company limits (parallel assignments, delegation depth, assignment ' +
      'timeout).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'update_settings',
    description:
      'Change settings and persist them; they apply from the next turn or assignment. Only the ' +
      'fields given change. Do this when the user asks for it, or say what you changed and why.',
    inputSchema: {
      type: 'object',
      properties: {
        defaultProvider: str('claude or codex. Optional.'),
        defaultModel: str('Model id, or "default" for the provider default. Optional.'),
        defaultEffort: str('low, medium, high, or "default". Optional.'),
        maxConcurrentAssignments: { type: 'number', description: 'Agent processes at the same time, 1 to 16. Optional.' },
        maxDelegationDepth: { type: 'number', description: 'How deep agents may delegate below you, 1 to 6. Optional.' },
        assignmentTimeoutMinutes: { type: 'number', description: 'Hard stop for one assignment, 1 to 600. Optional.' },
      },
      additionalProperties: false,
    },
    audience: ASSISTANT_ONLY,
  },
];

/** The tools one audience may call. */
export function toolsFor(audience: ToolAudience): ToolDefinition[] {
  return ORG_TOOLS.filter((tool) => tool.audience.includes(audience));
}

/** The MCP server name; the CLI exposes tools as `mcp__rookery__<name>`. */
export const MCP_SERVER_NAME = 'rookery';
