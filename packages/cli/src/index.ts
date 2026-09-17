#!/usr/bin/env node
/**
 * Rookery CLI entry point - commander wiring only.
 *
 * Every command returns an exit code instead of calling `process.exit`
 * itself, and this file does the exiting once stdout has drained. That
 * matters because core kicks off background memory extraction after a turn:
 * without an explicit exit the process would sit there waiting for a learning
 * turn the user is not waiting for.
 *
 * There is no working-directory option anywhere: the assistant always runs in
 * its own workspace, and only agents work in project directories.
 */

import { Command } from 'commander';
import { chatCommand } from './commands/chat.js';
import { configCommand } from './commands/config.js';
import { doctorCommand } from './commands/doctor.js';
import {
  memoryAddCommand,
  memoryForgetCommand,
  memoryListCommand,
  memorySearchCommand,
  memoryStatsCommand,
} from './commands/memory.js';
import {
  assignCommand,
  orgAgentsCommand,
  orgAssignmentCommand,
  orgAssignmentsCommand,
  orgHireCommand,
  orgMessagesCommand,
  orgOverviewCommand,
  orgProjectAddCommand,
  orgProjectsCommand,
  orgTeamAddCommand,
  orgTeamsCommand,
} from './commands/org.js';
import { serveCommand } from './commands/serve.js';
import { skillsCommand, toolsCommand } from './commands/tools.js';
import {
  sessionRemoveCommand,
  sessionShowCommand,
  sessionsCommand,
} from './commands/sessions.js';
import {
  taskAddCommand,
  taskCancelCommand,
  taskDoneCommand,
  taskPlanCommand,
  taskRunCommand,
  taskShowCommand,
  tasksBoardCommand,
} from './commands/tasks.js';
import { CliError, printError } from './commands/shared.js';
import { startRepl, type ReplOptions } from './repl.js';

const VERSION = '0.1.0';

/**
 * The Ink TUI needs raw-mode stdin and cursor control on stdout. Anything
 * else - a pipe, CI, `echo "/exit" | rookery`, `TERM=dumb` - gets the
 * line-based REPL, which is the same code path it has always used.
 * `ROOKERY_TUI=0` (or `--plain`) forces the fallback by hand.
 */
function tuiAvailable(): boolean {
  if (process.env.ROOKERY_TUI === '0') return false;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** Start the interactive session: full TUI when possible, REPL otherwise. */
async function startInteractive(options: ReplOptions & { plain?: boolean }): Promise<number> {
  if (options.plain || !tuiAvailable()) return startRepl(options);
  // Imported lazily so `doctor`, `chat` and friends never pay for React/Ink.
  const { startTui } = await import('./tui/App.js');
  return startTui(options);
}

/** Run a command, report failures consistently, then leave. */
async function run(fn: () => Promise<number> | number): Promise<void> {
  let code = 0;
  try {
    code = await fn();
  } catch (error) {
    printError(error);
    code = error instanceof CliError ? error.exitCode : 1;
  }
  await shutdown(code);
}

async function shutdown(code: number): Promise<never> {
  await Promise.all([drain(process.stdout), drain(process.stderr)]);
  process.exit(code);
}

function drain(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.writableEnded || stream.writableLength === 0) {
      resolve();
      return;
    }
    stream.write('', () => resolve());
    // Never let a stuck pipe hold the process open.
    const timer = setTimeout(resolve, 2000);
    timer.unref?.();
  });
}

const program = new Command();

program
  .name('rookery')
  /**
   * The root command and `chat` deliberately share option names (`-s`, `-p`,
   * `-m`, `--permission`, `--project`, `--agent`), because `rookery chat` with
   * no prompt just drops into the same interactive session. Commander's
   * default is to let a parent swallow its own option names wherever they
   * appear, so `rookery chat --agent ada "hi"` would hand `--agent` to the
   * program and leave the subcommand with nothing. Positional parsing puts
   * each option where it was typed: program options before the subcommand
   * name, the subcommand's own after it.
   */
  .enablePositionalOptions()
  .description('Rookery - a personal AI assistant on top of your Claude Code and ChatGPT logins.')
  .version(VERSION, '-V, --version')
  .option('-s, --session <id>', 'continue a session')
  .option('-p, --provider <id>', 'claude | codex | profile id')
  .option('-m, --model <model>', 'model to use')
  .option('--effort <level>', 'low | medium | high | xhigh | max')
  .option('--permission <level>', 'chat | read | write | full')
  .option('--project <name>', 'project this conversation is about')
  .option('--agent <slug>', 'talk to one agent instead of the assistant')
  .option('--voice', 'speak replies aloud', false)
  .option('-v, --verbose', 'show thinking traces and tool detail', false)
  .option('--plain', 'skip the full-screen TUI and use the line-based REPL', false)
  .action(async (options: Record<string, string | boolean | undefined>) => {
    await run(() =>
      startInteractive({
        session: options.session as string | undefined,
        provider: options.provider as string | undefined,
        model: options.model as string | undefined,
        effort: options.effort as string | undefined,
        permission: options.permission as string | undefined,
        project: options.project as string | undefined,
        agent: options.agent as string | undefined,
        voice: Boolean(options.voice),
        verbose: Boolean(options.verbose),
        plain: Boolean(options.plain),
      }),
    );
  });

/* -------------------------------- chat -------------------------------- */

program
  .command('chat')
  .description('one-shot turn; with no prompt this drops into the REPL')
  .argument('[prompt...]', 'what to say')
  .option('-s, --session <id>', 'continue a session')
  .option('-p, --provider <id>', 'claude | codex | profile id')
  .option('-m, --model <model>', 'model to use')
  .option('--effort <level>', 'low | medium | high | xhigh | max')
  .option('--permission <level>', 'chat | read | write | full')
  .option('--project <name>', 'project this conversation is about')
  .option('--agent <slug>', 'talk to one agent instead of the assistant')
  .option('--json', 'emit raw AgentEvent JSON lines', false)
  .option('--quiet', 'print only the final answer', false)
  .option('--voice', 'shape the reply for speech and speak it', false)
  .option('-v, --verbose', 'show thinking traces', false)
  .option('--plain', 'skip the full-screen TUI and use the line-based REPL', false)
  .action(async (promptParts: string[], options: Record<string, unknown>) => {
    const shared = {
      session: options.session as string | undefined,
      provider: options.provider as string | undefined,
      model: options.model as string | undefined,
      effort: options.effort as string | undefined,
      permission: options.permission as string | undefined,
      project: options.project as string | undefined,
      agent: options.agent as string | undefined,
      voice: Boolean(options.voice),
      verbose: Boolean(options.verbose),
    };
    await run(() =>
      promptParts.length
        ? chatCommand(promptParts, {
            ...shared,
            json: Boolean(options.json),
            quiet: Boolean(options.quiet),
          })
        : startInteractive({ ...shared, plain: Boolean(options.plain) }),
    );
  });

/* --------------------------------- tools -------------------------------- */

program
  .command('tools')
  .description('the tool hub: list MCP servers, `tools enable <id> [audience]`, `tools disable <id>`')
  .argument('[verb]', 'list | enable | disable')
  .argument('[id]', 'server id, e.g. playwright')
  .argument('[audience]', 'assistant | agents | both')
  .action(async (verb?: string, id?: string, audience?: string) => {
    await run(() => toolsCommand(verb, id, audience));
  });

program
  .command('skills')
  .description('list the skills folder')
  .action(async () => {
    await run(() => skillsCommand());
  });

/* --------------------------------- org --------------------------------- */

const org = program
  .command('org')
  .description('the company: agents, teams, projects, runs and messages');

org
  .command('overview', { isDefault: true })
  .description('who works here and what is running')
  .option('--json', 'machine-readable output', false)
  .action(async (options: Record<string, unknown>) => {
    await run(() => orgOverviewCommand({ json: Boolean(options.json) }));
  });

org
  .command('agents')
  .description('list the staff')
  .option('--json', 'machine-readable output', false)
  .action(async (options: Record<string, unknown>) => {
    await run(() => orgAgentsCommand({ json: Boolean(options.json) }));
  });

org
  .command('hire')
  .description('hire a permanent agent')
  .requiredOption('--name <name>', 'the agent\'s name')
  .requiredOption('--title <title>', 'job title, e.g. "Backend Engineer"')
  .requiredOption('--instructions <text>', 'the standing instructions for the role')
  .option('--slug <slug>', 'handle used in tool calls and the CLI')
  .option('--team <name>', 'team name or id')
  .option('--manager <slug>', 'who this agent reports to')
  .option('-p, --provider <id>', 'claude | codex | profile id')
  .option('-m, --model <model>', 'model this agent runs on')
  .option('--permission <level>', 'chat | read | write | full')
  .option('--json', 'machine-readable output', false)
  .action(async (options: Record<string, unknown>) => {
    await run(() =>
      orgHireCommand({
        name: options.name as string | undefined,
        title: options.title as string | undefined,
        instructions: options.instructions as string | undefined,
        slug: options.slug as string | undefined,
        team: options.team as string | undefined,
        manager: options.manager as string | undefined,
        provider: options.provider as string | undefined,
        model: options.model as string | undefined,
        permission: options.permission as string | undefined,
        json: Boolean(options.json),
      }),
    );
  });

const teams = org.command('teams').description('list teams, or `teams add <name>`');

teams
  .command('list', { isDefault: true })
  .description('list teams')
  .option('--json', 'machine-readable output', false)
  .action(async (options: Record<string, unknown>) => {
    await run(() => orgTeamsCommand({ json: Boolean(options.json) }));
  });

teams
  .command('add')
  .description('create a team')
  .argument('<name>', 'team name')
  .option('--purpose <text>', 'what the team is for')
  .option('--lead <slug>', 'agent leading the team')
  .action(async (name: string, options: Record<string, unknown>) => {
    await run(() =>
      orgTeamAddCommand(name, {
        purpose: options.purpose as string | undefined,
        lead: options.lead as string | undefined,
      }),
    );
  });

const projects = org.command('projects').description('list projects, or `projects add <name>`');

projects
  .command('list', { isDefault: true })
  .description('list projects')
  .option('--json', 'machine-readable output', false)
  .action(async (options: Record<string, unknown>) => {
    await run(() => orgProjectsCommand({ json: Boolean(options.json) }));
  });

projects
  .command('add')
  .description('create a project')
  .argument('<name>', 'project name')
  .option('--path <dir>', 'directory work on this project runs in')
  .option('--description <text>', 'what the project is')
  .action(async (name: string, options: Record<string, unknown>) => {
    await run(() =>
      orgProjectAddCommand(name, {
        path: options.path as string | undefined,
        description: options.description as string | undefined,
      }),
    );
  });

org
  .command('assignments')
  .description('recent runs')
  .option('-n, --limit <n>', 'how many to show', '20')
  .option('--json', 'machine-readable output', false)
  .action(async (options: Record<string, unknown>) => {
    await run(() =>
      orgAssignmentsCommand({
        limit: options.limit as string | undefined,
        json: Boolean(options.json),
      }),
    );
  });

org
  .command('assignment')
  .description('one run in full, report included')
  .argument('<id>', 'run id or unambiguous prefix')
  .action(async (id: string) => {
    await run(() => orgAssignmentCommand(id));
  });

org
  .command('messages')
  .description('recent messages between the assistant and its staff')
  .option('-n, --limit <n>', 'how many to show', '20')
  .option('--json', 'machine-readable output', false)
  .action(async (options: Record<string, unknown>) => {
    await run(() =>
      orgMessagesCommand({
        limit: options.limit as string | undefined,
        json: Boolean(options.json),
      }),
    );
  });

/* -------------------------------- assign ------------------------------- */

program
  .command('assign')
  .description('hand one agent one task and print the report it writes')
  .argument('<agent>', 'agent slug, name or id')
  .argument('<task...>', 'what the agent should do')
  .option('--project <name>', 'project the work runs in')
  .option('-s, --session <id>', 'attach the run to a session')
  .option('--json', 'emit raw AgentEvent JSON lines', false)
  .option('-v, --verbose', 'show thinking traces and run progress', false)
  .action(async (agent: string, taskParts: string[], options: Record<string, unknown>) => {
    await run(() =>
      assignCommand(agent, taskParts, {
        project: options.project as string | undefined,
        session: options.session as string | undefined,
        json: Boolean(options.json),
        verbose: Boolean(options.verbose),
      }),
    );
  });

/* -------------------------------- tasks -------------------------------- */

const tasks = program
  .command('tasks')
  .description('the company board: what is to be done, planned, running and finished');

tasks
  .command('board', { isDefault: true })
  .description('show the board')
  .option('--status <a,b>', 'only these statuses, e.g. open,running')
  .option('--all', 'include finished and cancelled tasks', false)
  .option('--json', 'machine-readable output', false)
  .action(async (options: Record<string, unknown>) => {
    await run(() =>
      tasksBoardCommand({
        status: options.status as string | undefined,
        all: Boolean(options.all),
        json: Boolean(options.json),
      }),
    );
  });

tasks
  .command('add')
  .description('put a task on the board')
  .argument('<title...>', 'what needs doing')
  .option('--description <text>', 'the full brief; defaults to the title')
  .option('--project <name>', 'project the task belongs to')
  .option('--priority <level>', 'low | normal | high')
  .option('--assignee <slug>', 'agent the task is on')
  .option('--json', 'machine-readable output', false)
  .action(async (titleParts: string[], options: Record<string, unknown>) => {
    await run(() =>
      taskAddCommand(titleParts, {
        description: options.description as string | undefined,
        project: options.project as string | undefined,
        priority: options.priority as string | undefined,
        assignee: options.assignee as string | undefined,
        json: Boolean(options.json),
      }),
    );
  });

tasks
  .command('show')
  .description('one task in full, subtasks and result included')
  .argument('<id>', 'task id or unambiguous prefix')
  .option('--json', 'machine-readable output', false)
  .action(async (id: string, options: Record<string, unknown>) => {
    await run(() => taskShowCommand(id, { json: Boolean(options.json) }));
  });

tasks
  .command('plan')
  .description('decide who does the task, and whether it splits into subtasks')
  .argument('<id>', 'task id or unambiguous prefix')
  .option('--hint <text>', 'guidance for the planner')
  .option('--json', 'machine-readable output', false)
  .action(async (id: string, options: Record<string, unknown>) => {
    await run(() =>
      taskPlanCommand(id, {
        hint: options.hint as string | undefined,
        json: Boolean(options.json),
      }),
    );
  });

tasks
  .command('run')
  .description('run the task and print what the agents produced')
  .argument('<id>', 'task id or unambiguous prefix')
  .option('--json', 'emit raw AgentEvent JSON lines', false)
  .option('-v, --verbose', 'show thinking traces and run progress', false)
  .action(async (id: string, options: Record<string, unknown>) => {
    await run(() =>
      taskRunCommand(id, { json: Boolean(options.json), verbose: Boolean(options.verbose) }),
    );
  });

tasks
  .command('done')
  .description('close a task by hand')
  .argument('<id>', 'task id or unambiguous prefix')
  .option('--result <text>', 'what came out of it')
  .action(async (id: string, options: Record<string, unknown>) => {
    await run(() => taskDoneCommand(id, { result: options.result as string | undefined }));
  });

tasks
  .command('cancel')
  .description('take a task off the board without doing it')
  .argument('<id>', 'task id or unambiguous prefix')
  .action(async (id: string) => {
    await run(() => taskCancelCommand(id));
  });

/* ------------------------------- doctor ------------------------------- */

program
  .command('doctor')
  .description('check providers, storage and defaults; exits 1 when nothing is logged in')
  .option('--json', 'machine-readable report', false)
  .action(async (options: Record<string, unknown>) => {
    await run(() => doctorCommand({ json: Boolean(options.json) }));
  });

/* ------------------------------ sessions ------------------------------ */

program
  .command('sessions')
  .description('list recent sessions')
  .option('-n, --limit <n>', 'how many to show', '20')
  .option('--all', 'include archived sessions', false)
  .option('--json', 'machine-readable output', false)
  .action(async (options: Record<string, unknown>) => {
    await run(() =>
      sessionsCommand({
        limit: options.limit as string | undefined,
        all: Boolean(options.all),
        json: Boolean(options.json),
      }),
    );
  });

program
  .command('session')
  .description('show a session transcript, or `session rm <id>` to delete one')
  .argument('<target>', 'session id, or the literal word `rm`')
  .argument('[id]', 'session id when the first argument is `rm`')
  .option('--json', 'machine-readable output', false)
  .option('-y, --yes', 'skip the delete confirmation', false)
  .action(async (target: string, id: string | undefined, options: Record<string, unknown>) => {
    const removing = ['rm', 'remove', 'delete'].includes(target.toLowerCase());
    await run(() => {
      if (removing) {
        if (!id) throw new CliError('Usage: rookery session rm <id>');
        return sessionRemoveCommand(id, { yes: Boolean(options.yes) });
      }
      return sessionShowCommand(target, { json: Boolean(options.json) });
    });
  });

/* ------------------------------- memory ------------------------------- */

const memory = program
  .command('memory')
  .description('inspect and edit long-term memory');

memory
  .command('list', { isDefault: true })
  .description('list stored memories')
  .option('-k, --kind <kind>', 'fact | preference | project | event | summary')
  .option('-n, --limit <n>', 'how many to show', '30')
  .option('--all', 'include forgotten memories', false)
  .option('--json', 'machine-readable output', false)
  .action(async (options: Record<string, unknown>) => {
    await run(() =>
      memoryListCommand({
        kind: options.kind as string | undefined,
        limit: options.limit as string | undefined,
        all: Boolean(options.all),
        json: Boolean(options.json),
      }),
    );
  });

memory
  .command('add')
  .description('store a memory by hand')
  .argument('<text...>', 'the memory, as one self-contained sentence')
  .option('-k, --kind <kind>', 'fact | preference | project | event | summary', 'fact')
  .option('-t, --tags <a,b>', 'comma-separated tags')
  .option('-i, --importance <0..1>', 'how much this should outrank other memories')
  .option('--json', 'machine-readable output', false)
  .action(async (textParts: string[], options: Record<string, unknown>) => {
    await run(() =>
      memoryAddCommand(textParts, {
        kind: options.kind as string | undefined,
        tags: options.tags as string | undefined,
        importance: options.importance as string | undefined,
        json: Boolean(options.json),
      }),
    );
  });

memory
  .command('search')
  .description('scored recall, exactly as a turn would see it')
  .argument('<query...>', 'what to look for')
  .option('-k, --kind <kind>', 'restrict to one kind')
  .option('-n, --limit <n>', 'how many hits', '10')
  .option('--threshold <score>', 'minimum blended score', '0')
  .option('--json', 'machine-readable output', false)
  .action(async (queryParts: string[], options: Record<string, unknown>) => {
    await run(() =>
      memorySearchCommand(queryParts, {
        kind: options.kind as string | undefined,
        limit: options.limit as string | undefined,
        threshold: options.threshold as string | undefined,
        json: Boolean(options.json),
      }),
    );
  });

memory
  .command('forget')
  .description('forget a memory (soft by default, so it can be audited)')
  .argument('<id>', 'memory id or unambiguous prefix')
  .option('--hard', 'delete permanently', false)
  .action(async (id: string, options: Record<string, unknown>) => {
    await run(() => memoryForgetCommand(id, { hard: Boolean(options.hard) }));
  });

memory
  .command('stats')
  .description('counts by kind, plus the heaviest memories')
  .option('--json', 'machine-readable output', false)
  .action(async (options: Record<string, unknown>) => {
    await run(() => memoryStatsCommand({ json: Boolean(options.json) }));
  });

/* ------------------------------- config ------------------------------- */

program
  .command('config')
  .description('read or write config, e.g. `config set voice.lang en-GB`')
  .argument('<action>', 'get | set | path')
  .argument('[key]', 'dotted key, e.g. memory.recallLimit')
  .argument('[value]', 'new value, for `set`')
  .option('--json', 'machine-readable output', false)
  .action(async (
    action: string,
    key: string | undefined,
    value: string | undefined,
    options: Record<string, unknown>,
  ) => {
    await run(() => configCommand(action, key, value, { json: Boolean(options.json) }));
  });

/* -------------------------------- serve ------------------------------- */

program
  .command('serve')
  .description('run the Rookery server (HTTP + WebSocket) for the web UI')
  .option('--port <port>', 'port to listen on')
  .option('--host <host>', 'host to bind')
  .option('--open', 'open the UI in a browser once it is up', false)
  .action(async (options: Record<string, unknown>) => {
    await run(() =>
      serveCommand({
        port: options.port as string | undefined,
        host: options.host as string | undefined,
        open: Boolean(options.open),
      }),
    );
  });

program.showHelpAfterError('(run `rookery --help` for usage)');

await program.parseAsync(process.argv);
