/**
 * The Rookery REPL.
 *
 * Design notes that matter:
 *  - One turn is one AbortController. Ctrl+C during a turn cancels that turn
 *    and returns to the prompt; Ctrl+C at an idle prompt leaves cleanly.
 *  - Background memory extraction finishes after the turn, so its notice is
 *    buffered and printed just before the next prompt rather than on top of
 *    whatever the user is typing.
 *  - Voice is opt-in and isolated: a missing speech engine prints one dim
 *    line and the REPL carries on.
 *  - There is no working directory to set. The assistant runs in its own
 *    workspace; `/project` only says which project its agents work in.
 */

import { createInterface, type Interface } from 'node:readline/promises';
import { Assistant, loadConfig, providerQuota, renderBoard, renderOrgOverview } from '@rookery/core';
import type { EffortLevel, PermissionLevel, ProviderId, ScoredMemory } from '@rookery/core';
import { recall } from '@rookery/core';
import { runTurn } from './commands/chat.js';
import { runAssignment } from './commands/org.js';
import {
  ACTIVE_TASK_STATUSES,
  CliError,
  PERMISSION_LEVELS,
  PROVIDER_IDS,
  counterpartLabel,
  parseEffort,
  parsePermission,
  parseProvider,
  parseTaskStatuses,
  resolveAgent,
  resolveMemoryId,
  resolveProject,
  resolveSession,
} from './commands/shared.js';
import { glyph, isTty, theme } from './ui/theme.js';
import { heading, memoryLine, relativeTime, sessionLine, shorten, shortId, untilTime } from './ui/render.js';
import { cachedModelCatalogue, modelName } from './ui/modelNames.js';
import { describeSpeech, speak, stopSpeaking } from './ui/speech.js';

export interface ReplOptions {
  session?: string;
  provider?: string;
  model?: string;
  effort?: string;
  permission?: string;
  /** Project name or id this conversation is about. */
  project?: string;
  /** Agent slug or name to talk to instead of the assistant. */
  agent?: string;
  verbose?: boolean;
  voice?: boolean;
}

interface ReplState {
  sessionId: string | undefined;
  provider: ProviderId;
  model: string | undefined;
  effort: EffortLevel | undefined;
  permission: PermissionLevel;
  projectId: string | undefined;
  projectName: string | undefined;
  /**
   * The agent this conversation is with. Unset means the assistant, which is
   * the only counterpart that can run the company rather than work in it.
   */
  agentId: string | undefined;
  /** Display name of the counterpart, shown in the prompt. */
  counterpart: string;
  voice: boolean;
  verbose: boolean;
}

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

export async function startRepl(options: ReplOptions = {}): Promise<number> {
  const config = loadConfig();
  const assistant = new Assistant();

  const assistantName = config.assistantName || 'Rookery';

  const state: ReplState = {
    sessionId: options.session,
    provider: parseProvider(options.provider) ?? config.defaultProvider,
    model: options.model ?? config.defaultModel,
    effort: parseEffort(options.effort) ?? config.defaultEffort,
    permission: parsePermission(options.permission) ?? config.defaultPermission,
    projectId: undefined,
    projectName: undefined,
    agentId: undefined,
    counterpart: assistantName,
    voice: options.voice ?? false,
    verbose: options.verbose ?? false,
  };

  try {
    const project = resolveProject(assistant, options.project);
    if (project) {
      state.projectId = project.id;
      state.projectName = project.name;
    }
  } catch (error) {
    note(theme.yellow(glyph.warn + ' ' + (error as Error).message));
  }

  if (options.agent) {
    try {
      const agent = resolveAgent(assistant, options.agent);
      state.agentId = agent.id;
      state.counterpart = agent.slug;
      state.provider = agent.provider ?? state.provider;
      state.model = agent.model ?? state.model;
    } catch (error) {
      note(theme.yellow(glyph.warn + ' ' + (error as Error).message));
    }
  }

  if (state.sessionId) {
    try {
      const existing = resolveSession(assistant, state.sessionId);
      state.sessionId = existing.id;
      state.provider = existing.provider;
      state.model = existing.model ?? state.model;
      // A resumed conversation keeps its own counterpart: core will not let
      // `--agent` re-point a session that already has one.
      state.agentId = existing.agentId;
      state.counterpart = existing.agentId
        ? counterpartLabel(assistant, existing.agentId)
        : assistantName;
      if (existing.projectId && !state.projectId) {
        state.projectId = existing.projectId;
        state.projectName = assistant.store.org.getProject(existing.projectId)?.name;
      }
    } catch (error) {
      note(theme.yellow(glyph.warn + ' ' + (error as Error).message));
      state.sessionId = undefined;
    }
  }

  /** Notices produced off the turn's critical path, shown before the next prompt. */
  const pending: string[] = [];
  assistant.on('memory', (event: { stored: { content: string }[] }) => {
    if (!event.stored.length) return;
    pending.push(
      glyph.memory + ' learned ' + event.stored.length +
        (event.stored.length === 1 ? ' memory' : ' memories'),
    );
    if (state.verbose) {
      for (const item of event.stored) pending.push('  ' + glyph.dot + ' ' + shorten(item.content, 88));
    }
  });

  const rl: Interface = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
    history: [],
    historySize: 250,
    removeHistoryDuplicates: true,
  });

  let activeTurn: AbortController | null = null;
  let leaving = false;

  /**
   * Lines are queued rather than pulled one `question()` at a time.
   * Piped input (`echo "/help" | rookery`) arrives - and hits EOF - long
   * before the first prompt is drawn, so anything not buffered would be lost.
   * It also gives interactive users free type-ahead during a turn.
   */
  const queue: string[] = [];
  let inputClosed = false;
  let waiter: ((line: string | null) => void) | null = null;

  const wake = (line: string | null): void => {
    const resolveWaiter = waiter;
    waiter = null;
    resolveWaiter?.(line);
  };

  rl.on('line', (line: string) => {
    if (waiter) wake(line);
    else queue.push(line);
  });
  rl.on('close', () => {
    inputClosed = true;
    wake(null);
  });

  const nextLine = (): Promise<string | null> => {
    if (queue.length) return Promise.resolve(queue.shift() as string);
    if (inputClosed || leaving) return Promise.resolve(null);
    return new Promise((resolveLine) => {
      waiter = resolveLine;
    });
  };

  const interrupt = (): void => {
    if (activeTurn) {
      activeTurn.abort();
      stopSpeaking();
      return;
    }
    leaving = true;
    queue.length = 0;
    wake(null);
    rl.close();
  };

  rl.on('SIGINT', interrupt);
  process.on('SIGINT', interrupt);

  await printBanner(assistant, state);

  try {
    while (!leaving) {
      for (const line of pending.splice(0)) note(theme.dim(line));

      // Piped input reaches EOF before the first prompt is ever drawn; the
      // queued commands still run, they just do not get a prompt line.
      if (!inputClosed) {
        process.stdout.write('\n');
        rl.setPrompt(promptText(state));
        rl.prompt();
      }

      const line = await nextLine();
      if (line === null) break;

      const input = line.trim();
      if (!input) continue;

      if (input.startsWith('/')) {
        let exit = false;
        activeTurn = new AbortController();
        try {
          exit = await handleSlash(
            input, assistant, state, rl, activeTurn.signal, assistantName, config.home,
          );
        } catch (error) {
          note(theme.red(glyph.fail + ' ' + (error as Error).message));
        } finally {
          activeTurn = null;
        }
        if (exit) break;
        continue;
      }

      activeTurn = new AbortController();
      try {
        const result = await runTurn(
          assistant,
          {
            text: input,
            sessionId: state.sessionId,
            provider: state.provider,
            model: state.model,
            effort: state.effort,
            permission: state.permission,
            projectId: state.projectId,
            agentId: state.agentId,
            voice: state.voice,
            signal: activeTurn.signal,
          },
          {
            verbose: state.verbose,
            ...(state.agentId ? { spinnerLabel: state.counterpart + ' thinking' } : {}),
          },
        );

        if (result.sessionId) state.sessionId = result.sessionId;

        if (result.aborted) {
          note(theme.dim(glyph.warn + ' interrupted'));
        } else if (state.voice && result.text.trim()) {
          const spoken = await speak(result.text, {
            lang: config.voice.lang,
            rate: config.voice.rate,
            voiceName: config.voice.voiceName,
            signal: activeTurn.signal,
          });
          if (!spoken.ok && spoken.detail !== 'aborted') {
            note(theme.dim(glyph.warn + ' voice: ' + spoken.detail));
          }
        }
      } finally {
        activeTurn = null;
      }
    }
  } finally {
    process.off('SIGINT', interrupt);
    stopSpeaking();
    rl.close();
    assistant.close();
  }

  process.stdout.write(theme.dim('bye') + '\n');
  return 0;
}

/* ------------------------------ chrome ------------------------------- */

function promptText(state: ReplState): string {
  // Who you are talking to comes first: in a company chat that is the one
  // thing you must not lose track of.
  const bits: string[] = [state.counterpart, state.provider];
  if (state.projectName) bits.push(state.projectName);
  if (state.voice) bits.push('voice');
  // Single line on purpose: readline's cursor math breaks on multi-line prompts.
  return theme.amberBold(bits.join(glyph.dot) + ' ' + glyph.prompt + ' ');
}

function note(text: string): void {
  process.stdout.write(text + '\n');
}

async function printBanner(assistant: Assistant, state: ReplState): Promise<void> {
  const out = process.stdout;
  out.write(
    '\n' + theme.amberBold('Rookery') +
      theme.dim((state.agentId ? '  with ' + state.counterpart : '') + '  via ' + state.provider) +
      '\n',
  );

  const statuses = await assistant.providers.statuses();
  const ready = statuses.filter((status) => status.available && status.authenticated);
  if (!ready.length) {
    out.write(
      theme.red(glyph.fail + ' No provider is logged in - run `rookery doctor` for the fix.') + '\n',
    );
  } else {
    const missing = statuses.filter((status) => !(status.available && status.authenticated));
    out.write(
      theme.dim(
        glyph.ok + ' ' + ready.map((status) => status.id).join(' + ') +
          (missing.length ? '  (' + missing.map((status) => status.id + ' offline').join(', ') + ')' : ''),
      ) + '\n',
    );
  }
  out.write(theme.dim('/help for commands' + (isTty ? '  ·  Ctrl+C to interrupt or exit' : '')) + '\n');
}

/* --------------------------- slash commands --------------------------- */

/** Returns true when the REPL should exit. */
async function handleSlash(
  input: string,
  assistant: Assistant,
  state: ReplState,
  rl: Interface,
  signal: AbortSignal,
  assistantName: string,
  home: string,
): Promise<boolean> {
  const [rawCommand, ...rest] = input.slice(1).split(/\s+/);
  const command = (rawCommand ?? '').toLowerCase();
  const argument = input.slice(1).slice((rawCommand ?? '').length).trim();

  switch (command) {
    case 'help':
    case '?': {
      note('');
      note(heading('Commands'));
      for (const [name, description] of SLASH_HELP) {
        note(theme.amber('  ' + name.padEnd(24)) + theme.dim(description));
      }
      return false;
    }

    case 'new': {
      state.sessionId = undefined;
      note(theme.dim(glyph.ok + ' new session'));
      return false;
    }

    case 'sessions': {
      const sessions = assistant.store.listSessions({ limit: 10 });
      if (!sessions.length) {
        note(theme.dim('No sessions yet.'));
        return false;
      }
      note('');
      for (const session of sessions) {
        const marker = session.id === state.sessionId ? theme.amber(glyph.bullet + ' ') : '  ';
        note(marker + sessionLine(session, counterpartLabel(assistant, session.agentId)));
      }
      note(theme.dim('/switch <id> to continue one'));
      return false;
    }

    case 'switch': {
      if (!argument) throw new CliError('Usage: /switch <session id>');
      const session = resolveSession(assistant, argument);
      state.sessionId = session.id;
      state.provider = session.provider;
      state.model = session.model ?? state.model;
      // The conversation decides who it is with, not the prompt you came from.
      state.agentId = session.agentId;
      state.counterpart = session.agentId
        ? counterpartLabel(assistant, session.agentId)
        : assistantName;
      if (session.projectId) {
        state.projectId = session.projectId;
        state.projectName = assistant.store.org.getProject(session.projectId)?.name;
      }
      note(
        theme.dim(
          glyph.ok + ' ' + shortId(session.id) + '  ' + shorten(session.title, 50) +
            '  with ' + state.counterpart + '  ' + relativeTime(session.updatedAt),
        ),
      );
      return false;
    }

    case 'talk': {
      if (!argument) {
        note(theme.dim('talking to ' + state.counterpart));
        return false;
      }
      const wanted = argument.trim();
      if (['assistant', 'rookery', 'off', 'none'].includes(wanted.toLowerCase())) {
        state.agentId = undefined;
        state.counterpart = assistantName;
        // A counterpart owns its own thread, so switching always starts fresh.
        state.sessionId = undefined;
        note(theme.dim(glyph.ok + ' talking to ' + assistantName + ' (new session)'));
        return false;
      }
      const agent = resolveAgent(assistant, wanted);
      state.agentId = agent.id;
      state.counterpart = agent.slug;
      state.provider = agent.provider ?? state.provider;
      state.model = agent.model ?? state.model;
      state.sessionId = undefined;
      note(
        theme.dim(
          glyph.ok + ' talking to ' + agent.name + ', ' + agent.title + '  (new session)',
        ),
      );
      return false;
    }

    case 'provider': {
      if (!argument) {
        note(theme.dim('providers: ' + PROVIDER_IDS.join(', ')));
        return false;
      }
      const provider = parseProvider(argument);
      if (provider) {
        state.provider = provider;
        // The other CLI cannot resume this one's thread, so start fresh.
        state.sessionId = undefined;
        note(theme.dim(glyph.ok + ' provider ' + provider + ' (new session)'));
      }
      return false;
    }

    case 'usage': {
      const quota = await providerQuota(state.provider);
      note(theme.amber(state.provider + (quota.plan ? '  ' + quota.plan : '') + '  subscription usage'));
      for (const window of quota.windows) {
        const filled = Math.round(window.percent / 5);
        const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
        const reset = window.resetsAt ? '  resets ' + untilTime(new Date(window.resetsAt).getTime()) : '';
        note('  ' + window.label.padEnd(14) + bar + '  ' + String(window.percent).padStart(3) + '%' + reset);
      }
      if (quota.error) note(theme.dim('  ' + quota.error));
      return false;
    }

    case 'effort': {
      if (!argument) {
        note(theme.dim('effort is ' + (state.effort ?? 'provider default')));
        return false;
      }
      if (['off', 'default', 'none'].includes(argument.toLowerCase())) {
        state.effort = undefined;
        note(theme.dim(glyph.ok + ' effort: provider default'));
        return false;
      }
      state.effort = parseEffort(argument);
      note(theme.dim(glyph.ok + ' effort ' + state.effort));
      return false;
    }

    case 'model': {
      // A cache probe, not a fetch: a piped REPL must never spawn a CLI just
      // to phrase an echo. No cache means the raw id, which is still the truth.
      const catalogue = cachedModelCatalogue(home);
      if (!argument) {
        state.model = undefined;
        const fallback = modelName(catalogue, state.provider, undefined);
        note(
          theme.dim(glyph.ok + ' model: provider default' + (fallback ? ' (' + fallback + ')' : '')),
        );
        return false;
      }
      state.model = argument;
      note(
        theme.dim(
          glyph.ok + ' model ' + (modelName(catalogue, state.provider, argument) ?? argument),
        ),
      );
      return false;
    }

    case 'permission': {
      if (!argument) {
        note(theme.dim('permission is ' + state.permission + '  (' + PERMISSION_LEVELS.join(', ') + ')'));
        return false;
      }
      const level = parsePermission(argument);
      if (level) {
        state.permission = level;
        note(theme.dim(glyph.ok + ' permission ' + level));
      }
      return false;
    }

    case 'org': {
      const organization = assistant.org.activeOrganization();
      note('');
      note(renderOrgOverview(assistant.org.snapshot(organization.id)));
      return false;
    }

    case 'agents': {
      const organization = assistant.org.activeOrganization();
      const agents = assistant.store.org.listAgents(organization.id);
      if (!agents.length) {
        note(theme.dim('Nobody works here yet. `rookery org hire` adds someone.'));
        return false;
      }
      const byId = new Map(agents.map((agent) => [agent.id, agent]));
      note('');
      for (const agent of agents) {
        const manager = agent.managerId ? byId.get(agent.managerId) : undefined;
        note(
          '  ' + theme.amber(shorten(agent.slug, 17).padEnd(18)) +
            theme.ivory(shorten(agent.title, 27).padEnd(28)) +
            theme.dim('reports to ' + (manager ? manager.slug : 'the assistant')),
        );
      }
      note(theme.dim('/assign <agent> <task> to give one of them work'));
      return false;
    }

    case 'assign': {
      const agentRef = rest[0] ?? '';
      const task = argument.slice(agentRef.length).trim();
      if (!agentRef || !task) throw new CliError('Usage: /assign <agent> <task>');

      const organization = assistant.org.activeOrganization();
      const agent = assistant.store.org.findAgent(organization.id, agentRef);
      if (!agent) throw new CliError('No agent "' + agentRef + '". Try /agents.');

      const result = await runAssignment(
        assistant,
        {
          agent: agent.id,
          task,
          projectId: state.projectId,
          sessionId: state.sessionId,
          signal,
        },
        { verbose: state.verbose, label: agent.slug + ' working' },
      );

      if (result.report) note('\n' + result.report);
      if (result.aborted) note(theme.dim(glyph.warn + ' interrupted'));
      return false;
    }

    case 'tasks': {
      const organization = assistant.org.activeOrganization();
      const status = parseTaskStatuses(argument || undefined) ?? [...ACTIVE_TASK_STATUSES];
      const board = assistant.store.org.listTasks(organization.id, { status });
      note('');
      note(renderBoard(board, assistant.org.snapshot(organization.id), assistant.store.org));
      note(theme.dim('/task <title> adds one  ' + glyph.dot + '  rookery tasks run <id> executes one'));
      return false;
    }

    case 'task': {
      if (!argument) throw new CliError('Usage: /task <title>');
      const organization = assistant.org.activeOrganization();
      const task = assistant.store.org.createTask({
        orgId: organization.id,
        title: argument,
        // A one-line task is its own brief; planning reads the description.
        description: argument,
        projectId: state.projectId,
        createdBy: 'user',
      });
      note(theme.dim(glyph.ok + ' task ' + shortId(task.id) + '  ' + shorten(task.title, 60)));
      note(theme.dim('  rookery tasks plan ' + shortId(task.id)));
      return false;
    }

    case 'project': {
      if (!argument) {
        note(theme.dim(state.projectName ? 'project: ' + state.projectName : 'no project set'));
        return false;
      }
      if (argument.toLowerCase() === 'off' || argument.toLowerCase() === 'none') {
        state.projectId = undefined;
        state.projectName = undefined;
        note(theme.dim(glyph.ok + ' project cleared'));
        return false;
      }
      const project = resolveProject(assistant, argument);
      if (project) {
        state.projectId = project.id;
        state.projectName = project.name;
        note(theme.dim(glyph.ok + ' project ' + project.name + '  ' + (project.path ?? 'no directory')));
      }
      return false;
    }

    case 'inbox': {
      const organization = assistant.org.activeOrganization();
      // Read-only on purpose: the turn that actually uses the inbox is the one
      // allowed to mark it read.
      const messages = assistant.store.org.inbox(organization.id, null, { unreadOnly: true });
      if (!messages.length) {
        note(theme.dim('No unread messages.'));
        return false;
      }
      const agents = new Map(
        assistant.store.org
          .listAgents(organization.id, { includeArchived: true })
          .map((agent) => [agent.id, agent]),
      );
      note('');
      for (const message of messages) {
        const from = message.fromAgentId
          ? (agents.get(message.fromAgentId)?.slug ?? shortId(message.fromAgentId))
          : 'the assistant';
        note(
          '  ' + theme.amber(shorten(from, 15).padEnd(16)) +
            theme.ivory(shorten(message.content, 70)) +
            theme.dim('  ' + relativeTime(message.createdAt)),
        );
      }
      return false;
    }

    case 'memory': {
      if (!argument) throw new CliError('Usage: /memory <query>');
      const hits: ScoredMemory[] = recall(assistant.store, {
        text: argument,
        limit: 10,
        threshold: 0,
        touch: false,
      });
      if (!hits.length) {
        note(theme.dim('nothing recalled for "' + shorten(argument, 50) + '"'));
        return false;
      }
      note('');
      for (const hit of hits) note('  ' + memoryLine(hit));
      return false;
    }

    case 'remember': {
      if (!argument) throw new CliError('Usage: /remember <text>');
      const record = assistant.rememberFact({ content: argument, kind: 'fact', importance: 0.7 });
      note(theme.dim(glyph.ok + ' remembered ' + shortId(record.id)));
      return false;
    }

    case 'forget': {
      if (!argument) throw new CliError('Usage: /forget <memory id>');
      const id = resolveMemoryId(assistant, argument);
      const memory = assistant.store.getMemory(id);
      assistant.store.forgetMemory(id);
      note(theme.dim(glyph.ok + ' forgot ' + shorten(memory?.content ?? id, 60)));
      return false;
    }

    case 'voice': {
      state.voice = !state.voice;
      if (state.voice) {
        const backend = await describeSpeech();
        note(theme.dim(glyph.ok + ' voice on  ' + glyph.dot + ' ' + backend));
        if (backend.startsWith('unavailable')) {
          note(theme.dim('  replies will still be shaped for speech, just not spoken.'));
        }
      } else {
        stopSpeaking();
        note(theme.dim(glyph.ok + ' voice off'));
      }
      return false;
    }

    case 'verbose': {
      state.verbose = !state.verbose;
      note(theme.dim(glyph.ok + ' verbose ' + (state.verbose ? 'on' : 'off')));
      return false;
    }

    case 'doctor': {
      const statuses = await assistant.providers.statuses(true);
      note('');
      for (const status of statuses) {
        const mark =
          status.available && status.authenticated
            ? theme.green(glyph.ok)
            : status.available
              ? theme.yellow(glyph.warn)
              : theme.red(glyph.fail);
        note(
          '  ' + mark + ' ' + theme.amber(status.id.padEnd(8)) +
            theme.dim(
              (status.version ?? 'unknown') + '  ' +
                (status.authenticated ? 'authenticated' : status.detail ?? 'not ready'),
            ),
        );
      }
      note(theme.dim('  run `rookery doctor` for the full report'));
      return false;
    }

    case 'clear': {
      if (isTty) {
        process.stdout.write('\x1B[2J\x1B[3J\x1B[H');
      }
      return false;
    }

    case 'exit':
    case 'quit':
    case 'q': {
      rl.close();
      return true;
    }

    default:
      throw new CliError('Unknown command /' + command + '. Try /help.');
  }
}
