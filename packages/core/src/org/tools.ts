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

/**
 * How a provider argument is described to the model.
 *
 * Deliberately not an enum: every turn runs on the same harness and the id
 * only says what it is pointed at, so the set is open - the two built-ins
 * plus one id per provider profile somebody configured. A fixed enum here
 * would reject a backend the moment it was added on the Providers page.
 * The controller checks the id against the registry instead.
 */
const PROVIDER_HINT =
  'Provider id: "claude" for the Claude login, "codex" for ChatGPT, or the id of a configured provider profile.';

export const ORG_TOOLS: ToolDefinition[] = [
  {
    name: 'read_profile',
    description: 'Read saved identity or memory notes. Names: IDENTITY.md, SOUL.md, USER.md, AGENTS.md, TOOLS.md, MEMORY.md or memory/*.md. Use offsets to read beyond context excerpts.',
    inputSchema: { type: 'object', properties: { name: str('Workspace-relative profile file name.'), offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 24000 } }, required: ['name'], additionalProperties: false },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'search_profile',
    description: 'Search portable Markdown profile and memory notes imported from Hermes or OpenClaw. Returns file names and excerpt offsets for read_profile. Native learned memories use search_memory.',
    inputSchema: { type: 'object', properties: { query: str('Words to find in the portable notes.') }, required: ['query'], additionalProperties: false },
    audience: ASSISTANT_ONLY,
  },
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
      'assignment_status. In a chat, name yourself as the agent with wait=false to spin off real ' +
      "work in the background while the conversation keeps going - your report posts back into " +
      'the same chat once it finishes. A self-assignment must use wait=false.',
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
    name: 'send_mail',
    description:
      'Send company mail: a subject, a body, To and optionally Cc. Addressing an agent\'s To starts a ' +
      'real run of that agent with the mail as its task, and its finished result comes back to you ' +
      'automatically as a reply. Cc only delivers to the mailbox - it never starts anything, so loop ' +
      'someone in on Cc when they should just know. Address "user" to write to the user directly, or ' +
      '"assistant" for the assistant. Not for handing out work you need to wait on - use assign for that.',
    inputSchema: {
      type: 'object',
      properties: {
        to: str('Comma-separated agent slugs/names, "user" and/or "assistant".'),
        cc: str('Comma-separated agent slugs/names, "user" and/or "assistant". Optional.'),
        subject: str('Subject line.'),
        body: str('The mail body.'),
        inReplyTo: str('Id of the mail this replies to, to keep the thread together. Optional.'),
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false,
    },
    audience: BOTH,
  },
  {
    name: 'read_mail',
    description: 'Unread mail addressed to you, by To or Cc. Reading marks it as read.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    audience: BOTH,
  },
  {
    name: 'read_mail_thread',
    description:
      'The full text of one mail conversation, oldest first - only the mails you sent or were To or ' +
      'Cc on. A mail that starts an assignment names its thread; call this when the answer depends on ' +
      'what was already said, and skip it when the mail stands on its own.',
    inputSchema: {
      type: 'object',
      properties: { thread: str('Thread id, or the id of any mail in it.') },
      required: ['thread'],
      additionalProperties: false,
    },
    audience: BOTH,
  },
  // ASSISTANT_ONLY on purpose: an agent that thinks something deserves the
  // user's attention mails its manager, same as any other report, or the
  // user directly (send_mail allows that). Only the assistant decides
  // whether that is also worth a push to the phone.
  {
    name: 'notify',
    description:
      'Send the user a message over whatever notification channel is open right now, even when no ' +
      'conversation is running - a phone push, say. For something worth surfacing on its own, not ' +
      'for an ordinary answer inside a turn. urgency "high" breaks through quiet hours, so use it ' +
      'only when that is worth it.',
    inputSchema: {
      type: 'object',
      properties: {
        text: str('The message to send.'),
        urgency: {
          type: 'string',
          enum: ['normal', 'high'],
          description: 'Default normal. "high" breaks through quiet hours.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'use_skill',
    description:
      'Open a skill: a written procedure for a particular kind of task. Takes a name from the list ' +
      'in your instructions or one that find_skill turned up. Returns the full instructions and the ' +
      'files that come with them. Open the matching skill before starting such a task, then follow it.',
    inputSchema: {
      type: 'object',
      properties: { name: str('The skill name from the list, or from a find_skill result.') },
      required: ['name'],
      additionalProperties: false,
    },
    audience: BOTH,
  },
  // The shelf the instructions cannot carry. Hundreds of skills are installed
  // in the Claude Code on this machine; the prompt says how many and from
  // where, this finds the one that fits.
  {
    name: 'find_skill',
    description:
      'Search the skills installed on this machine that are too many to list in your instructions. ' +
      'Use it when a task sounds like a procedure somebody has already written down - a file format, ' +
      'a framework, a tool, a kind of document. Returns names with their one-line description; open ' +
      'one with use_skill. Searching costs nothing, so look before working something out from scratch.',
    inputSchema: {
      type: 'object',
      properties: { query: str('What the task is about, e.g. "pdf", "scroll animation", "vercel deploy".') },
      required: ['query'],
      additionalProperties: false,
    },
    audience: BOTH,
  },
  // The other half of remembering. A memory records that something is true;
  // this records how something is done - the part that otherwise gets worked
  // out from scratch every single time.
  {
    name: 'write_skill',
    description:
      'Write down how a kind of task is done, so that next time it is not worked out from ' +
      'scratch. Use it when you have just solved something you will clearly meet again, when you ' +
      'had to discover a procedure the hard way, or when the user has corrected the same thing ' +
      'twice - that correction belongs in a skill. Write the steps you would want to be handed: ' +
      'concrete commands, paths, names and the traps you hit, not a summary of what you did. ' +
      'Writing over a skill you wrote earlier is how you improve one, so revise instead of ' +
      'inventing a second name for the same subject. Skills the user wrote are theirs and cannot ' +
      'be overwritten. Not for one-off notes about a single task - that is what memory is for.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Short name, lower case with dashes, e.g. release-checklist.'),
        description: str('One line saying when this skill should be opened. It is all the index shows.'),
        body: str('The instructions themselves, in Markdown. Steps someone can follow, not prose.'),
        audience: str('assistant, agents or both. Default both.'),
      },
      required: ['name', 'description', 'body'],
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
      "configuring keys is the user's job on the Tools page; you only flip switches. A " +
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
      'standing instructions describing how it works and what it is responsible for. With ' +
      '`replaces` set, this is a stage-4 personnel action instead: archives that agent and its ' +
      'memory, generates a handover (or uses the one you pass), hires the successor with the ' +
      'name/title/instructions given, and carries over its team, manager and reports. Only call ' +
      'that after the user has approved the replacement agent_performance proposed.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Display name, e.g. "Mara". With replaces set, must differ from the outgoing agent\'s name.'),
        title: str('Job title, e.g. "Backend Engineer".'),
        instructions: str('Standing instructions for the role, two to six sentences.'),
        slug: str('Short handle, lowercase with dashes. Derived from the name when omitted.'),
        team: str('Team name or id. Optional. Ignored when replaces is set (inherited instead).'),
        manager: str('Manager agent slug. Omit for an agent reporting to you directly. Ignored when replaces is set.'),
        provider: str(PROVIDER_HINT + ' Optional.'),
        model: str('Model name for that provider. Optional.'),
        permission: {
          type: 'string',
          enum: ['chat', 'read', 'write', 'full'],
          description: 'What the agent may do on the machine. Optional; defaults to the company default.',
        },
        replaces: str(
          'Slug of an agent to retire and replace with this one (stage 4). Their team, manager and ' +
            'reports pass to the successor; the outgoing slug is never freed. Optional.',
        ),
        handover: str(
          'Override the auto-generated handover document for the successor, when replaces is set. Optional.',
        ),
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
      'fields you pass change. An agent at escalation stage 1 or higher (check with ' +
      'agent_performance) needs `reason` set to change its instructions - that reason is written ' +
      'to its personnel record as a reconfig, together with the before/after text, so the change ' +
      'stays accountable and reversible.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: str('Agent slug or name.'),
        name: str('New display name. Optional.'),
        title: str('New job title. Optional.'),
        instructions: str('New standing instructions. Optional.'),
        team: str('Team name or id, or "none" to remove from its team. Optional.'),
        manager: str('Manager slug, or "assistant" to report to you directly. Optional.'),
        provider: str(PROVIDER_HINT + ' Optional.'),
        model: str('Optional.'),
        permission: { type: 'string', enum: ['chat', 'read', 'write', 'full'], description: 'Optional.' },
        archived: { type: 'boolean', description: 'true retires the agent, false brings it back. Optional.' },
        reason: str(
          'Why the instructions are changing. Required to change instructions once the agent is at ' +
            'escalation stage 1 or higher; logged to the personnel record as a reconfig either way ' +
            'when instructions change and this is set.',
        ),
      },
      required: ['agent'],
      additionalProperties: false,
    },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'review_assignment',
    description:
      'Add or correct your own judgment of one finished assignment - the same review that runs ' +
      'automatically after every run, but by hand: after the user disagreed with the automatic ' +
      'one, or for a run from before this existed. Upserts: a second call for the same assignment ' +
      'replaces your earlier judgment rather than adding a second one.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('Assignment id or prefix.'),
        overall: { type: 'number', description: '1 to 5. 5 as good as a good colleague would do it, 1 unusable or invented.' },
        comment: str('One to three sentences on what was good or bad. Optional.'),
      },
      required: ['id', 'overall'],
      additionalProperties: false,
    },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'agent_performance',
    description:
      'One agent\'s standing: review history, rolling average, trend, escalation stage, failure ' +
      'rate, and its personnel record (notes, reconfigs, probation, replacement proposals). This ' +
      'is the "development conversation" tool - open it before deciding whether a weak run is a ' +
      'pattern or a one-off, and before update_agent on a flagged agent.',
    inputSchema: {
      type: 'object',
      properties: { agent: str('Agent slug or name.') },
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
    name: 'project_mcp_servers',
    description:
      "The MCP servers listed in a project's own .mcp.json - the same file a person's own Claude " +
      'Code session in that folder would read - and whether they are trusted yet. An untrusted or ' +
      'changed file never starts its servers for an assignment. Call this before trust_project_mcp.',
    inputSchema: {
      type: 'object',
      properties: { project: str('Project name or id.') },
      required: ['project'],
      additionalProperties: false,
    },
    audience: ASSISTANT_ONLY,
  },
  {
    name: 'trust_project_mcp',
    description:
      "Approve or revoke a project's own .mcp.json, so its MCP servers do or do not start for " +
      "assignments in that project. This starts real processes from a file inside the project's " +
      'own folder, so show the user the server list and command lines from project_mcp_servers ' +
      'before approving. A later edit to .mcp.json needs approving again; revoke turns the ' +
      'servers off again without touching the file.',
    inputSchema: {
      type: 'object',
      properties: {
        project: str('Project name or id.'),
        decision: { type: 'string', enum: ['approve', 'revoke'], description: 'approve or revoke.' },
      },
      required: ['project', 'decision'],
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
      'have it run as an assignment instead. The outcome of every run lands in your inbox; a ' +
      'one-time run you do yourself (once=true, no agent) also replies directly in the ' +
      'conversation you are having right now, so "I\'ll get back to you here" actually happens - ' +
      'a recurring job, or one handed to an agent, keeps its own dedicated conversation. The ' +
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
      'your inbox and on the Schedules page when the run is over.',
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
        defaultProvider: str(PROVIDER_HINT + ' Optional.'),
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
