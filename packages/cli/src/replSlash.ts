/**
 * The REPL's slash commands, printed line by line.
 *
 * `src/tui/commands.ts` is the same set for the full-screen app, which builds
 * scrollback entries instead; what both do to the assistant lives in
 * `commands/slash.ts`.
 */

import { providerQuota, renderOrgOverview } from '@rookery/core';
import type { Assistant } from '@rookery/core';
import { runAssignment } from './commands/org.js';
import {
  PERMISSION_LEVELS,
  PROVIDER_IDS,
  counterpartLabel,
  parseEffort,
  parsePermission,
  parseProvider,
  resolveAgent,
  resolveProject,
  resolveSession,
} from './commands/shared.js';
import {
  ASSISTANT_ALIASES,
  EFFORT_RESET_WORDS,
  PROJECT_DETACH_WORDS,
  addUserTask,
  forgetMemory,
  lookupSlashHandler,
  parseAssignment,
  parseSlashInput,
  recentSessions,
  rememberByHand,
  renderTaskBoard,
  requireArgument,
  searchMemory,
  unreadInbox,
} from './commands/slash.js';
import { printDim, printLine, printOk } from './replOutput.js';
import { adoptAgent, adoptProject, adoptSession, adoptSessionProject } from './replState.js';
import type { ReplState } from './replState.js';
import { cachedModelCatalogue, modelName } from './ui/modelNames.js';
import {
  agentRosterRow,
  heading,
  memoryLine,
  providerMark,
  quotaWindowLine,
  relativeTime,
  sessionLine,
  shortId,
  shorten,
} from './ui/render.js';
import { SPEECH_UNAVAILABLE, describeSpeech, stopSpeaking } from './ui/speech.js';
import { glyph, isTty, theme } from './ui/theme.js';

const SLASH_HELP: [string, string][] = [
  ['/help', 'show this list'],
  ['/new', 'start a fresh session'],
  ['/sessions', 'list recent sessions'],
  ['/switch <id>', 'continue an earlier session'],
  ['/talk <slug>', 'talk to an agent, or `assistant` to come back'],
  ['/provider <id>', 'claude, codex or a configured profile id'],
  ['/model <m>', 'set the model (blank = provider default)'],
  ['/effort <l>', 'low | medium | high | xhigh | max | off'],
  ['/usage', 'subscription usage of the current provider'],
  ['/permission <l>', 'chat | read | write | full'],
  ['/org', 'who works here and what is running'],
  ['/agents', 'list the agents of the company'],
  ['/assign <agent> <task>', 'hand one agent one task'],
  ['/tasks [status]', 'the company board'],
  ['/task <title>', 'put a task on the board'],
  ['/project <name|off>', 'set the project this conversation is about'],
  ['/inbox', 'unread messages from the staff'],
  ['/memory <query>', 'search long-term memory'],
  ['/remember <text>', 'store a memory by hand'],
  ['/forget <id>', 'forget a memory'],
  ['/voice', 'toggle speaking replies aloud'],
  ['/doctor', 'provider health'],
  ['/verbose', 'toggle thinking traces'],
  ['/clear', 'clear the screen'],
  ['/exit', 'leave'],
];

const HELP_NAME_WIDTH = 24;

/** What a slash command works on. */
export interface ReplCommandContext {
  assistant: Assistant;
  state: ReplState;
  /** Aborted when the user interrupts the command, as for a turn. */
  signal: AbortSignal;
  /** The Rookery home directory, where the model catalogue is cached. */
  home: string;
}

/** One invocation: the context, plus what the user typed after the command name. */
interface ReplCall extends ReplCommandContext {
  argument: string;
}

type ReplCommand = (call: ReplCall) => void | Promise<void>;

/**
 * Run one `/command`. Returns true when the REPL should exit; throws
 * `CliError` for anything the user got wrong.
 */
export async function handleSlash(input: string, context: ReplCommandContext): Promise<boolean> {
  const { command, argument } = parseSlashInput(input);
  if (command === 'exit') return true;

  await lookupSlashHandler(REPL_COMMANDS, command)({ ...context, argument });
  return false;
}

/* ------------------------------ conversation ------------------------------ */

function showHelp(): void {
  printLine();
  printLine(heading('Commands'));
  for (const [name, description] of SLASH_HELP) {
    printLine(theme.accent('  ' + name.padEnd(HELP_NAME_WIDTH)) + theme.dim(description));
  }
}

function startNewSession({ state }: ReplCall): void {
  state.sessionId = undefined;
  printOk('new session');
}

function listSessions({ assistant, state }: ReplCall): void {
  const sessions = recentSessions(assistant);
  if (!sessions.length) {
    printDim('No sessions yet.');
    return;
  }
  printLine();
  for (const session of sessions) {
    const marker = session.id === state.sessionId ? theme.accent(glyph.bullet + ' ') : '  ';
    printLine(marker + sessionLine(session, counterpartLabel(assistant, session.agentId)));
  }
  printDim('/switch <id> to continue one');
}

function switchSession({ argument, assistant, state }: ReplCall): void {
  requireArgument(argument, '/switch <session id>');
  const session = resolveSession(assistant, argument);
  adoptSession(assistant, state, session);
  if (session.projectId) adoptSessionProject(assistant, state, session.projectId);
  printOk(
    shortId(session.id) + '  ' + shorten(session.title, 50) +
      '  with ' + state.counterpart + '  ' + relativeTime(session.updatedAt),
  );
}

function talkTo({ argument, assistant, state }: ReplCall): void {
  if (!argument) {
    printDim('talking to ' + state.counterpart);
    return;
  }
  // A counterpart owns its own thread, so switching always starts fresh.
  if (ASSISTANT_ALIASES.includes(argument.toLowerCase())) {
    state.agentId = undefined;
    state.counterpart = state.assistantName;
    state.sessionId = undefined;
    printOk('talking to ' + state.assistantName + ' (new session)');
    return;
  }
  const agent = resolveAgent(assistant, argument);
  adoptAgent(state, agent);
  state.sessionId = undefined;
  printOk('talking to ' + agent.name + ', ' + agent.title + '  (new session)');
}

function setProject({ argument, assistant, state }: ReplCall): void {
  if (!argument) {
    printDim(state.projectName ? 'project: ' + state.projectName : 'no project set');
    return;
  }
  if (PROJECT_DETACH_WORDS.includes(argument.toLowerCase())) {
    state.projectId = undefined;
    state.projectName = undefined;
    printOk('project cleared');
    return;
  }
  const project = resolveProject(assistant, argument);
  if (!project) return;
  adoptProject(state, project);
  printOk('project ' + project.name + '  ' + (project.path ?? 'no directory'));
}

/* ------------------------------- settings ------------------------------- */

function setProvider({ argument, state }: ReplCall): void {
  if (!argument) {
    printDim('providers: ' + PROVIDER_IDS.join(', '));
    return;
  }
  const provider = parseProvider(argument);
  state.provider = provider;
  // The other CLI cannot resume this one's thread, so start fresh.
  state.sessionId = undefined;
  printOk('provider ' + provider + ' (new session)');
}

function setEffort({ argument, state }: ReplCall): void {
  if (!argument) {
    printDim('effort is ' + (state.effort ?? 'provider default'));
    return;
  }
  if (EFFORT_RESET_WORDS.includes(argument.toLowerCase())) {
    state.effort = undefined;
    printOk('effort: provider default');
    return;
  }
  state.effort = parseEffort(argument);
  printOk('effort ' + state.effort);
}

function setModel({ argument, state, home }: ReplCall): void {
  // A cache probe, not a fetch: a piped REPL must never spawn a CLI just
  // to phrase an echo. No cache means the raw id, which is still the truth.
  const catalogue = cachedModelCatalogue(home);
  if (!argument) {
    state.model = undefined;
    const fallback = modelName(catalogue, state.provider, undefined);
    printOk('model: provider default' + (fallback ? ' (' + fallback + ')' : ''));
    return;
  }
  state.model = argument;
  printOk('model ' + (modelName(catalogue, state.provider, argument) ?? argument));
}

function setPermission({ argument, state }: ReplCall): void {
  if (!argument) {
    printDim('permission is ' + state.permission + '  (' + PERMISSION_LEVELS.join(', ') + ')');
    return;
  }
  state.permission = parsePermission(argument);
  printOk('permission ' + state.permission);
}

async function toggleVoice({ state }: ReplCall): Promise<void> {
  state.voice = !state.voice;
  if (!state.voice) {
    stopSpeaking();
    printOk('voice off');
    return;
  }
  const backend = await describeSpeech();
  printOk('voice on  ' + glyph.dot + ' ' + backend);
  if (backend === SPEECH_UNAVAILABLE) {
    printDim('  replies will still be shaped for speech, just not spoken.');
  }
}

function toggleVerbose({ state }: ReplCall): void {
  state.verbose = !state.verbose;
  printOk('verbose ' + (state.verbose ? 'on' : 'off'));
}

/* -------------------------------- company -------------------------------- */

function showOrg({ assistant }: ReplCall): void {
  const organization = assistant.org.activeOrganization();
  printLine();
  printLine(renderOrgOverview(assistant.org.snapshot(organization.id)));
}

function listAgents({ assistant }: ReplCall): void {
  const organization = assistant.org.activeOrganization();
  const agents = assistant.store.org.listAgents(organization.id);
  if (!agents.length) {
    printDim('Nobody works here yet. `rookery org hire` adds someone.');
    return;
  }
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  printLine();
  for (const agent of agents) {
    const row = agentRosterRow(agent, byId);
    printLine('  ' + theme.accent(row.handle) + theme.frost(row.title) + theme.dim(row.reportsTo));
  }
  printDim('/assign <agent> <task> to give one of them work');
}

async function assign({ argument, assistant, state, signal }: ReplCall): Promise<void> {
  const { agent, task } = parseAssignment(assistant, argument);

  const result = await runAssignment(
    assistant,
    { agent: agent.id, task, projectId: state.projectId, sessionId: state.sessionId, signal },
    { verbose: state.verbose, label: agent.slug + ' working' },
  );

  if (result.report) printLine('\n' + result.report);
  if (result.aborted) printDim(glyph.warn + ' interrupted');
}

function showBoard({ argument, assistant }: ReplCall): void {
  printLine();
  printLine(renderTaskBoard(assistant, argument));
  printDim('/task <title> adds one  ' + glyph.dot + '  rookery tasks run <id> executes one');
}

function addTask({ argument, assistant, state }: ReplCall): void {
  requireArgument(argument, '/task <title>');
  const task = addUserTask(assistant, argument, state.projectId);
  printOk('task ' + shortId(task.id) + '  ' + shorten(task.title, 60));
  printDim('  rookery tasks plan ' + shortId(task.id));
}

function showInbox({ assistant }: ReplCall): void {
  const rows = unreadInbox(assistant);
  if (!rows.length) {
    printDim('No unread messages.');
    return;
  }
  printLine();
  for (const row of rows) {
    printLine(
      '  ' + theme.accent(shorten(row.from, 15).padEnd(16)) +
        theme.frost(shorten(row.content, 70)) +
        theme.dim('  ' + relativeTime(row.createdAt)),
    );
  }
}

/* -------------------------------- memory -------------------------------- */

function recallMemory({ argument, assistant }: ReplCall): void {
  requireArgument(argument, '/memory <query>');
  const hits = searchMemory(assistant, argument);
  if (!hits.length) {
    printDim('nothing recalled for "' + shorten(argument, 50) + '"');
    return;
  }
  printLine();
  for (const hit of hits) printLine('  ' + memoryLine(hit));
}

function remember({ argument, assistant }: ReplCall): void {
  requireArgument(argument, '/remember <text>');
  printOk('remembered ' + shortId(rememberByHand(assistant, argument).id));
}

function forget({ argument, assistant }: ReplCall): void {
  requireArgument(argument, '/forget <memory id>');
  printOk('forgot ' + shorten(forgetMemory(assistant, argument), 60));
}

/* ------------------------------ diagnostics ------------------------------ */

async function showUsage({ state }: ReplCall): Promise<void> {
  const quota = await providerQuota(state.provider);
  printLine(theme.accent(state.provider + (quota.plan ? '  ' + quota.plan : '') + '  subscription usage'));
  for (const window of quota.windows) printLine(quotaWindowLine(window));
  if (quota.error) printDim('  ' + quota.error);
}

async function showDoctor({ assistant }: ReplCall): Promise<void> {
  const statuses = await assistant.providers.statuses(true);
  printLine();
  for (const status of statuses) {
    printLine(
      '  ' + providerMark(status) + ' ' + theme.accent(status.id.padEnd(8)) +
        theme.dim(
          (status.version ?? 'unknown') + '  ' +
            (status.authenticated ? 'authenticated' : status.detail ?? 'not ready'),
        ),
    );
  }
  printDim('  run `rookery doctor` for the full report');
}

function clearScreen(): void {
  if (isTty) process.stdout.write('\x1B[2J\x1B[3J\x1B[H');
}

const REPL_COMMANDS: Readonly<Record<string, ReplCommand>> = {
  help: showHelp,
  new: startNewSession,
  sessions: listSessions,
  switch: switchSession,
  talk: talkTo,
  provider: setProvider,
  usage: showUsage,
  effort: setEffort,
  model: setModel,
  permission: setPermission,
  org: showOrg,
  agents: listAgents,
  assign,
  tasks: showBoard,
  task: addTask,
  project: setProject,
  inbox: showInbox,
  memory: recallMemory,
  remember,
  forget,
  voice: toggleVoice,
  verbose: toggleVerbose,
  doctor: showDoctor,
  clear: clearScreen,
};
