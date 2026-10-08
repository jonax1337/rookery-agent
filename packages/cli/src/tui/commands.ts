/**
 * Slash commands for the TUI.
 *
 * Kept out of App.tsx so the commands stay ordinary async functions over
 * plain data: they return what should change instead of touching React state
 * themselves. `src/replSlash.ts` is the same set for the non-TTY fallback,
 * which prints line by line and never builds entries; what both do to the
 * assistant lives in `commands/slash.ts`.
 */

import { EFFORT_LEVELS, providerQuota, renderOrgOverview } from '@rookery/core';
import type { Assistant } from '@rookery/core';
import {
  PERMISSION_LEVELS,
  PROVIDER_IDS,
  agentIndex,
  counterpartLabel,
  parseEffort,
  parsePermission,
  parseProvider,
  pickByIdPrefix,
  resolveAgent,
  resolveProject,
  resolveSession,
} from '../commands/shared.js';
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
} from '../commands/slash.js';
import type { ProviderHealth } from '../ui/render.js';
import {
  HEALTH_GLYPH,
  agentRosterRow,
  memoryLine,
  providerHealth,
  quotaWindowLine,
  relativeTime,
  sessionLine,
  shorten,
  shortId,
} from '../ui/render.js';
import { SPEECH_UNAVAILABLE, describeSpeech, stopSpeaking } from '../ui/speech.js';
import { EMPTY_MODEL_CATALOGUE, modelName } from '../ui/modelNames.js';
import type { ModelCatalogue } from '../ui/modelNames.js';
import { glyph, ui } from './theme.js';
import { SLASH_COMMANDS } from './hooks/useSlash.js';
import { historyEntries } from './history.js';
import type { Entry, NoticeLine, SessionState } from './types.js';
import type { TurnRequest } from './hooks/useTurn.js';

export interface SlashOutcome {
  /** Lines to append to the scrollback. */
  entries?: Entry[];
  /** Session-state fields to change. */
  patch?: Partial<SessionState>;
  /** Leave the app. */
  exit?: boolean;
  /** Drop the scrollback. */
  clear?: boolean;
  /** Start a turn instead of just printing something. */
  run?: TurnRequest;
  /** Open the live watch for a running assignment. */
  watch?: { assignmentId: string };
}

export interface SlashContext {
  assistant: Assistant;
  session: SessionState;
  /** Monotonic id source, shared with the rest of the app. */
  nextId: () => string;
  /** Model display names, when the app managed to load a catalogue. */
  catalogue?: ModelCatalogue;
}

/** One invocation: the context, plus what the user typed after the command name. */
interface SlashCall {
  argument: string;
  assistant: Assistant;
  session: SessionState;
  nextId: () => string;
  catalogue: ModelCatalogue;
  /** A notice entry made of `lines`. */
  notice: (lines: NoticeLine[]) => SlashOutcome;
  /** A one-line confirmation notice. */
  ok: (text: string) => SlashOutcome;
}

type SlashCommand = (call: SlashCall) => SlashOutcome | Promise<SlashOutcome>;

const NEW_CONVERSATION_TITLE = 'New conversation';
const HELP_NAME_WIDTH = 24;
/** Usage percentages from which a window is drawn as a warning / as critical. */
const USAGE_WARN_PERCENT = 70;
const USAGE_DANGER_PERCENT = 90;
/** How many earlier messages `/switch` replays into the scrollback. */
const RESUMED_MESSAGE_COUNT = 50;
/** How many running assignments `/watch` considers. */
const WATCHABLE_ASSIGNMENTS = 50;

const HEALTH_COLOR: Record<ProviderHealth, string> = {
  ok: ui.ok,
  warn: ui.warn,
  fail: ui.danger,
};

const dim = (text: string): NoticeLine => ({ text, dim: true });

const dimLines = (text: string): NoticeLine[] => text.split('\n').map(dim);

/** "14.9k of 200k (7%)", or just the count when the window is unknown. */
function contextLabel(tokens: number, window: number | undefined): string {
  const short = (value: number): string =>
    value >= 1000 ? (value / 1000).toFixed(value >= 10000 ? 0 : 1) + 'k' : String(value);
  if (!window) return short(tokens);
  return short(tokens) + ' of ' + short(window) + ' (' + Math.round((tokens / window) * 100) + '%)';
}

/** Run one `/command`. Throws `CliError` for anything the user got wrong. */
export async function runSlashCommand(input: string, ctx: SlashContext): Promise<SlashOutcome> {
  const { command, argument } = parseSlashInput(input);
  if (command === 'exit') return { exit: true };

  const handler = lookupSlashHandler(TUI_COMMANDS, command);
  return handler({
    argument,
    assistant: ctx.assistant,
    session: ctx.session,
    nextId: ctx.nextId,
    catalogue: ctx.catalogue ?? EMPTY_MODEL_CATALOGUE,
    notice: (lines) => ({ entries: [{ kind: 'notice', id: ctx.nextId(), lines }] }),
    ok: (text) => ({ entries: [{ kind: 'notice', id: ctx.nextId(), lines: [dim(glyph.ok + ' ' + text)] }] }),
  });
}

/* ------------------------------ conversation ------------------------------ */

function showHelp({ notice }: SlashCall): SlashOutcome {
  const lines: NoticeLine[] = [{ text: 'Commands', color: ui.accent, bold: true }];
  for (const entry of SLASH_COMMANDS) {
    const label = entry.name + (entry.args ? ' ' + entry.args : '');
    lines.push(dim('  ' + label.padEnd(HELP_NAME_WIDTH) + entry.description));
  }
  lines.push({ text: '' });
  lines.push(
    dim(
      'Enter sends ' + glyph.dot + ' Shift+Enter (or a \\ at the end of the line) adds a newline ' +
        glyph.dot + ' Ctrl+C interrupts ' + glyph.dot + ' Ctrl+D exits',
    ),
  );
  return notice(lines);
}

function startNewConversation({ ok }: SlashCall): SlashOutcome {
  return {
    patch: { sessionId: undefined, title: NEW_CONVERSATION_TITLE, contextTokens: undefined },
    ...ok('new conversation'),
  };
}

function listSessions({ assistant, session, notice }: SlashCall): SlashOutcome {
  const sessions = recentSessions(assistant);
  if (!sessions.length) return notice([dim('No conversations yet.')]);
  const lines: NoticeLine[] = sessions.map((item) => ({
    text:
      (item.id === session.sessionId ? glyph.bullet + ' ' : '  ') +
      sessionLine(item, counterpartLabel(assistant, item.agentId)),
  }));
  lines.push(dim('/switch <id> resumes a conversation'));
  return notice(lines);
}

function switchSession({ argument, assistant, session, nextId }: SlashCall): SlashOutcome {
  requireArgument(argument, '/switch <session id>');
  const found = resolveSession(assistant, argument);
  // The conversation decides who it is with, not the prompt you came from.
  const agent = found.agentId ? assistant.store.org.getAgent(found.agentId) : null;
  const counterpart = found.agentId ? counterpartLabel(assistant, found.agentId) : session.assistantName;
  // The history speaks with the conversation's own voice, so the target
  // counterpart has to be in place before the entries are built.
  const target = { ...session, agentId: found.agentId, counterpart };
  const resumed =
    glyph.ok + ' ' + shortId(found.id) + '  ' + shorten(found.title, 50) + '  with ' +
    counterpart + '  ' + relativeTime(found.updatedAt);
  return {
    clear: true,
    patch: {
      sessionId: found.id,
      title: found.title,
      provider: found.provider,
      model: found.model ?? session.model,
      agentId: found.agentId,
      agentTitle: agent?.title,
      counterpart,
    },
    entries: [
      ...historyEntries(assistant.store.getMessages(found.id, RESUMED_MESSAGE_COUNT), target, nextId),
      { kind: 'notice', id: nextId(), lines: [dim(resumed)] },
    ],
  };
}

function talkTo({ argument, assistant, session, notice, ok }: SlashCall): SlashOutcome {
  if (!argument) return notice([dim('talking to ' + session.counterpart)]);

  // A counterpart owns its own thread, so switching always starts fresh.
  if (ASSISTANT_ALIASES.includes(argument.toLowerCase())) {
    return {
      patch: {
        agentId: undefined,
        agentTitle: undefined,
        counterpart: session.assistantName,
        sessionId: undefined,
        title: NEW_CONVERSATION_TITLE,
      },
      ...ok('talking to ' + session.assistantName + ' (new conversation)'),
    };
  }
  const agent = resolveAgent(assistant, argument);
  return {
    patch: {
      agentId: agent.id,
      agentTitle: agent.title,
      counterpart: agent.slug,
      provider: agent.provider ?? session.provider,
      model: agent.model ?? session.model,
      sessionId: undefined,
      title: NEW_CONVERSATION_TITLE,
    },
    ...ok('talking to ' + agent.name + ', ' + agent.title + '  (new conversation)'),
  };
}

function setProject({ argument, assistant, session, notice, ok }: SlashCall): SlashOutcome {
  if (!argument) {
    return notice([dim(session.projectName ? 'project: ' + session.projectName : 'no project set')]);
  }
  if (PROJECT_DETACH_WORDS.includes(argument.toLowerCase())) {
    return { patch: { projectId: undefined, projectName: undefined }, ...ok('Project detached') };
  }
  const project = resolveProject(assistant, argument);
  if (!project) return {};
  return {
    patch: { projectId: project.id, projectName: project.name },
    ...ok('Project ' + project.name + '  ' + (project.path ?? 'no directory')),
  };
}

/* ------------------------------- settings ------------------------------- */

function setProvider({ argument, notice, ok }: SlashCall): SlashOutcome {
  if (!argument) return notice([dim('Provider: ' + PROVIDER_IDS.join(', '))]);
  const provider = parseProvider(argument);
  // The other CLI cannot resume this one's thread, so start fresh.
  return {
    patch: { provider, sessionId: undefined, title: NEW_CONVERSATION_TITLE },
    ...ok('Provider ' + provider + ' (new conversation)'),
  };
}

function setModel({ argument, session, catalogue, ok }: SlashCall): SlashOutcome {
  if (!argument) {
    const fallback = modelName(catalogue, session.provider, undefined);
    return {
      patch: { model: undefined },
      ...ok('Model: provider default' + (fallback ? ' (' + fallback + ')' : '')),
    };
  }
  const display = modelName(catalogue, session.provider, argument) ?? argument;
  return { patch: { model: argument }, ...ok('Model ' + display) };
}

function setEffort({ argument, session, notice, ok }: SlashCall): SlashOutcome {
  if (!argument) {
    return notice([
      dim(
        'effort is ' + (session.effort ?? 'provider default') + '  (' +
          EFFORT_LEVELS.join(', ') + ', or `off`)',
      ),
    ]);
  }
  if (EFFORT_RESET_WORDS.includes(argument.toLowerCase())) {
    return { patch: { effort: undefined }, ...ok('Effort: provider default') };
  }
  const level = parseEffort(argument);
  return { patch: { effort: level }, ...ok('Effort ' + level) };
}

function setPermission({ argument, session, notice, ok }: SlashCall): SlashOutcome {
  if (!argument) {
    return notice([
      dim('Permission is ' + session.permission + '  (' + PERMISSION_LEVELS.join(', ') + ')'),
    ]);
  }
  const level = parsePermission(argument);
  return { patch: { permission: level }, ...ok('Permission ' + level) };
}

async function toggleVoice({ session, ok, nextId }: SlashCall): Promise<SlashOutcome> {
  const voice = !session.voice;
  if (!voice) {
    stopSpeaking();
    return { patch: { voice }, ...ok('Voice off') };
  }
  const backend = await describeSpeech();
  const lines: NoticeLine[] = [dim(glyph.ok + ' voice on  ' + glyph.dot + ' ' + backend)];
  if (backend === SPEECH_UNAVAILABLE) {
    lines.push(dim('  Replies remain speech-friendly but will not be read aloud.'));
  }
  return { patch: { voice }, entries: [{ kind: 'notice', id: nextId(), lines }] };
}

function toggleVerbose({ session, ok }: SlashCall): SlashOutcome {
  return { patch: { verbose: !session.verbose }, ...ok('Verbose ' + (session.verbose ? 'off' : 'on')) };
}

/* -------------------------------- company -------------------------------- */

function showOrg({ assistant, notice }: SlashCall): SlashOutcome {
  const organization = assistant.org.activeOrganization();
  return notice(dimLines(renderOrgOverview(assistant.org.snapshot(organization.id))));
}

function listAgents({ assistant, notice }: SlashCall): SlashOutcome {
  const organization = assistant.org.activeOrganization();
  const agents = assistant.store.org.listAgents(organization.id);
  if (!agents.length) return notice([dim('No staff yet. Use `rookery org hire` to hire an agent.')]);

  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const lines = agents.map((agent) => {
    const row = agentRosterRow(agent, byId);
    return dim('  ' + row.handle + row.title + row.reportsTo);
  });
  lines.push(dim('/assign <agent> <task> hands an agent a task'));
  return notice(lines);
}

function assign({ argument, assistant, session, nextId }: SlashCall): SlashOutcome {
  const { agent, task } = parseAssignment(assistant, argument);
  return {
    entries: [{ kind: 'user', id: nextId(), text: agent.slug + ': ' + task }],
    run: { kind: 'assign', agent: agent.id, text: task, projectId: session.projectId },
  };
}

function watch({ argument, assistant, notice }: SlashCall): SlashOutcome {
  const organization = assistant.org.activeOrganization();
  const running = assistant.store.org.listAssignments(organization.id, {
    status: ['pending', 'running'],
    limit: WATCHABLE_ASSIGNMENTS,
  });

  if (argument) {
    const found = pickByIdPrefix(
      running,
      argument,
      'run',
      'No running task matches "' + argument + '". Try /watch with no argument.',
    );
    return { watch: { assignmentId: found.id } };
  }
  if (!running.length) return notice([dim('Nothing is running.')]);

  const agents = agentIndex(assistant, organization);
  const lines = running.map((assignment) => {
    const slug = agents.get(assignment.agentId)?.slug ?? shortId(assignment.agentId);
    return dim('  ' + shortId(assignment.id).padEnd(10) + shorten(slug, 15).padEnd(16) + shorten(assignment.task, 52));
  });
  lines.push(dim('/watch <id> follows one live'));
  return notice(lines);
}

function showBoard({ argument, assistant, notice }: SlashCall): SlashOutcome {
  return notice([...dimLines(renderTaskBoard(assistant, argument)), dim('/task <title> creates a task')]);
}

function addTask({ argument, assistant, session, notice }: SlashCall): SlashOutcome {
  requireArgument(argument, '/task <title>');
  const task = addUserTask(assistant, argument, session.projectId);
  return notice([
    dim(glyph.ok + ' task ' + shortId(task.id) + '  ' + shorten(task.title, 60)),
    dim('  rookery tasks plan ' + shortId(task.id)),
  ]);
}

function showInbox({ assistant, notice }: SlashCall): SlashOutcome {
  const rows = unreadInbox(assistant);
  if (!rows.length) return notice([dim('No unread messages.')]);
  return notice(
    rows.map((row) =>
      dim('  ' + shorten(row.from, 15).padEnd(16) + shorten(row.content, 68) + '  ' + relativeTime(row.createdAt)),
    ),
  );
}

/* -------------------------------- memory -------------------------------- */

function recallMemory({ argument, assistant, notice }: SlashCall): SlashOutcome {
  requireArgument(argument, '/memory <query>');
  const hits = searchMemory(assistant, argument);
  if (!hits.length) return notice([dim('no matches for "' + shorten(argument, 50) + '"')]);
  return notice(hits.map((hit) => ({ text: '  ' + memoryLine(hit) })));
}

function remember({ argument, assistant, ok }: SlashCall): SlashOutcome {
  requireArgument(argument, '/remember <text>');
  return ok('remembered: ' + shortId(rememberByHand(assistant, argument).id));
}

function forget({ argument, assistant, ok }: SlashCall): SlashOutcome {
  requireArgument(argument, '/forget <memory id>');
  return ok('forgotten: ' + shorten(forgetMemory(assistant, argument), 60));
}

/* ------------------------------ diagnostics ------------------------------ */

async function showUsage({ session, notice }: SlashCall): Promise<SlashOutcome> {
  const quota = await providerQuota(session.provider);
  const lines: NoticeLine[] = [
    {
      text: session.provider + (quota.plan ? '  ' + quota.plan : '') + '  ' + glyph.dot + '  subscription usage',
      color: ui.accent,
      bold: true,
    },
  ];
  for (const window of quota.windows) {
    lines.push({ text: quotaWindowLine(window), color: usageColor(window.percent) });
  }
  if (quota.error) lines.push(dim('  ' + quota.error));
  if (session.contextTokens !== undefined) {
    lines.push(dim('  Context ' + contextLabel(session.contextTokens, session.contextWindow)));
  }
  return notice(lines);
}

function usageColor(percent: number): string | undefined {
  if (percent >= USAGE_DANGER_PERCENT) return ui.danger;
  return percent >= USAGE_WARN_PERCENT ? ui.warn : undefined;
}

async function showDoctor({ assistant, notice }: SlashCall): Promise<SlashOutcome> {
  const statuses = await assistant.providers.statuses(true);
  const lines: NoticeLine[] = statuses.map((status) => {
    const health = providerHealth(status);
    return {
      text:
        '  ' + HEALTH_GLYPH[health] + ' ' + status.id.padEnd(8) + (status.version ?? 'unknown') + '  ' +
        (status.authenticated ? 'authenticated' : status.detail ?? 'not ready'),
      color: HEALTH_COLOR[health],
    };
  });
  lines.push(dim('  `rookery doctor` shows the full report'));
  return notice(lines);
}

const TUI_COMMANDS: Readonly<Record<string, SlashCommand>> = {
  help: showHelp,
  new: startNewConversation,
  sessions: listSessions,
  switch: switchSession,
  talk: talkTo,
  provider: setProvider,
  model: setModel,
  effort: setEffort,
  usage: showUsage,
  permission: setPermission,
  org: showOrg,
  agents: listAgents,
  assign,
  watch,
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
  clear: () => ({ clear: true }),
};
