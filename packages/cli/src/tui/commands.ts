/**
 * Slash commands for the TUI.
 *
 * Kept out of App.tsx so the commands stay ordinary async functions over
 * plain data: they return what should change instead of touching React state
 * themselves. `src/repl.ts` keeps its own copy for the non-TTY fallback,
 * because that path prints line by line and never builds entries.
 */

import { EFFORT_LEVELS, providerQuota, recall, renderBoard, renderOrgOverview } from '@rookery/core';
import type { Assistant, Assignment, ScoredMemory } from '@rookery/core';
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
} from '../commands/shared.js';
import { memoryLine, relativeTime, sessionLine, shorten, shortId, untilTime } from '../ui/render.js';
import { describeSpeech, stopSpeaking } from '../ui/speech.js';
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

/** "14.9k of 200k (7%)", or just the count when the window is unknown. */
export function contextLabel(tokens: number, window: number | undefined): string {
  const short = (value: number): string =>
    value >= 1000 ? (value / 1000).toFixed(value >= 10000 ? 0 : 1) + 'k' : String(value);
  if (!window) return short(tokens);
  return short(tokens) + ' of ' + short(window) + ' (' + Math.round((tokens / window) * 100) + '%)';
}

/** Run one `/command`. Throws `CliError` for anything the user got wrong. */
export async function runSlashCommand(input: string, ctx: SlashContext): Promise<SlashOutcome> {
  const body = input.trim().slice(1);
  const [rawCommand = ''] = body.split(/\s+/u);
  const command = rawCommand.toLowerCase();
  const argument = body.slice(rawCommand.length).trim();
  const { assistant, session } = ctx;

  const notice = (lines: NoticeLine[]): SlashOutcome => ({
    entries: [{ kind: 'notice', id: ctx.nextId(), lines }],
  });
  const ok = (text: string): SlashOutcome => notice([{ text: glyph.ok + ' ' + text, dim: true }]);

  switch (command) {
    case 'help':
    case '?': {
      const lines: NoticeLine[] = [{ text: 'Commands', color: ui.accent, bold: true }];
      for (const entry of SLASH_COMMANDS) {
        const label = entry.name + (entry.args ? ' ' + entry.args : '');
        lines.push({ text: '  ' + label.padEnd(24) + entry.description, dim: true });
      }
      lines.push({ text: '' });
      lines.push({
        text:
          'Enter sends ' + glyph.dot + ' Shift+Enter (or a \\ at the end of the line) adds a newline ' +
          glyph.dot + ' Ctrl+C interrupts ' + glyph.dot + ' Ctrl+D exits',
        dim: true,
      });
      return notice(lines);
    }

    case 'new':
      return {
        patch: { sessionId: undefined, title: 'New conversation', contextTokens: undefined },
        ...ok('new conversation'),
      };

    case 'sessions': {
      const sessions = assistant.store.listSessions({ limit: 10 });
      if (!sessions.length) return notice([{ text: 'No conversations yet.', dim: true }]);
      const lines: NoticeLine[] = sessions.map((item) => ({
        text:
          (item.id === session.sessionId ? glyph.bullet + ' ' : '  ') +
          sessionLine(item, counterpartLabel(assistant, item.agentId)),
      }));
      lines.push({ text: '/switch <id> resumes a conversation', dim: true });
      return notice(lines);
    }

    case 'switch': {
      if (!argument) throw new CliError('Usage: /switch <session id>');
      const found = resolveSession(assistant, argument);
      // The conversation decides who it is with, not the prompt you came from.
      const agent = found.agentId ? assistant.store.org.getAgent(found.agentId) : null;
      const counterpart = agent ? agent.slug : session.assistantName;
      // The history speaks with the conversation's own voice, so the target
      // counterpart has to be in place before the entries are built.
      const target = { ...session, agentId: found.agentId, counterpart };
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
          ...historyEntries(assistant.store.getMessages(found.id, 50), target, ctx.nextId),
          {
            kind: 'notice',
            id: ctx.nextId(),
            lines: [
              {
                text:
                  glyph.ok + ' ' + shortId(found.id) + '  ' + shorten(found.title, 50) + '  with ' +
                  counterpart + '  ' + relativeTime(found.updatedAt),
                dim: true,
              },
            ],
          },
        ],
      };
    }

    case 'talk': {
      if (!argument) {
        return notice([{ text: 'talking to ' + session.counterpart, dim: true }]);
      }
      if (['assistant', 'rookery', 'off', 'none'].includes(argument.toLowerCase())) {
        return {
          // A counterpart owns its own thread, so switching always starts fresh.
          patch: {
            agentId: undefined,
            agentTitle: undefined,
            counterpart: session.assistantName,
            sessionId: undefined,
            title: 'New conversation',
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
          title: 'New conversation',
        },
        ...ok('talking to ' + agent.name + ', ' + agent.title + '  (new conversation)'),
      };
    }

    case 'provider': {
      if (!argument) {
        return notice([{ text: 'Provider: ' + PROVIDER_IDS.join(', '), dim: true }]);
      }
      const provider = parseProvider(argument);
      if (!provider) return {};
      // The other CLI cannot resume this one's thread, so start fresh.
      return {
        patch: { provider, sessionId: undefined, title: 'New conversation' },
        ...ok('Provider ' + provider + ' (new conversation)'),
      };
    }

    case 'model': {
      if (!argument) {
        const fallback = modelName(ctx.catalogue ?? EMPTY_MODEL_CATALOGUE, session.provider, undefined);
        return {
          patch: { model: undefined },
          ...ok('Model: provider default' + (fallback ? ' (' + fallback + ')' : '')),
        };
      }
      const display = modelName(ctx.catalogue ?? EMPTY_MODEL_CATALOGUE, session.provider, argument) ?? argument;
      return { patch: { model: argument }, ...ok('Model ' + display) };
    }

    case 'effort': {
      if (!argument) {
        return notice([
          {
            text:
              'effort is ' + (session.effort ?? 'provider default') + '  (' +
              EFFORT_LEVELS.join(', ') + ', or `off`)',
            dim: true,
          },
        ]);
      }
      if (['off', 'default', 'none'].includes(argument.toLowerCase())) {
        return { patch: { effort: undefined }, ...ok('Effort: provider default') };
      }
      const level = parseEffort(argument);
      if (!level) return {};
      return { patch: { effort: level }, ...ok('Effort ' + level) };
    }

    case 'usage': {
      const quota = await providerQuota(session.provider);
      const lines: NoticeLine[] = [
        {
          text: session.provider + (quota.plan ? '  ' + quota.plan : '') + '  ' + glyph.dot + '  subscription usage',
          color: ui.accent,
          bold: true,
        },
      ];
      for (const window of quota.windows) {
        const filled = Math.round(window.percent / 5);
        const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
        const reset = window.resetsAt ? '  resets ' + untilTime(new Date(window.resetsAt).getTime()) : '';
        lines.push({
          text: '  ' + window.label.padEnd(14) + bar + '  ' + String(window.percent).padStart(3) + '%' + reset,
          color: window.percent >= 90 ? ui.danger : window.percent >= 70 ? ui.warn : undefined,
        });
      }
      if (quota.error) lines.push({ text: '  ' + quota.error, dim: true });
      if (session.contextTokens !== undefined) {
        lines.push({ text: '  Context ' + contextLabel(session.contextTokens, session.contextWindow), dim: true });
      }
      return notice(lines);
    }

    case 'permission': {
      if (!argument) {
        return notice([
          {
            text: 'Permission is ' + session.permission + '  (' + PERMISSION_LEVELS.join(', ') + ')',
            dim: true,
          },
        ]);
      }
      const level = parsePermission(argument);
      if (!level) return {};
      return { patch: { permission: level }, ...ok('Permission ' + level) };
    }

    case 'org': {
      const organization = assistant.org.activeOrganization();
      const overview = renderOrgOverview(assistant.org.snapshot(organization.id));
      return notice(overview.split('\n').map((text) => ({ text, dim: true })));
    }

    case 'agents': {
      const organization = assistant.org.activeOrganization();
      const agents = assistant.store.org.listAgents(organization.id);
      if (!agents.length) {
        return notice([
          { text: 'No staff yet. Use `rookery org hire` to hire an agent.', dim: true },
        ]);
      }
      const byId = new Map(agents.map((agent) => [agent.id, agent]));
      const lines: NoticeLine[] = agents.map((agent) => {
        const manager = agent.managerId ? byId.get(agent.managerId) : undefined;
        return {
          text:
            '  ' + shorten(agent.slug, 17).padEnd(18) + shorten(agent.title, 27).padEnd(28) +
            'reports to ' + (manager ? manager.slug : 'the assistant'),
          dim: true,
        };
      });
      lines.push({ text: '/assign <agent> <task> hands an agent a task', dim: true });
      return notice(lines);
    }

    case 'assign': {
      const [agentRef = ''] = argument.split(/\s+/u);
      const task = argument.slice(agentRef.length).trim();
      if (!agentRef || !task) throw new CliError('Usage: /assign <agent> <task>');
      const organization = assistant.org.activeOrganization();
      const agent = assistant.store.org.findAgent(organization.id, agentRef);
      if (!agent) throw new CliError('No agent "' + agentRef + '". Try /agents.');
      return {
        entries: [{ kind: 'user', id: ctx.nextId(), text: agent.slug + ': ' + task }],
        run: { kind: 'assign', agent: agent.id, text: task, projectId: session.projectId },
      };
    }

    case 'watch': {
      const organization = assistant.org.activeOrganization();
      const running = assistant.store.org.listAssignments(organization.id, {
        status: ['pending', 'running'],
        limit: 50,
      });
      if (!argument) {
        if (!running.length) return notice([{ text: 'Nothing is running.', dim: true }]);
        const agents = new Map(
          assistant.store.org
            .listAgents(organization.id, { includeArchived: true })
            .map((agent) => [agent.id, agent]),
        );
        const lines: NoticeLine[] = running.map((assignment) => {
          const slug = agents.get(assignment.agentId)?.slug ?? shortId(assignment.agentId);
          return {
            text: '  ' + shortId(assignment.id).padEnd(10) + shorten(slug, 15).padEnd(16) +
              shorten(assignment.task, 52),
            dim: true,
          };
        });
        lines.push({ text: '/watch <id> follows one live', dim: true });
        return notice(lines);
      }
      const found = resolveAssignment(running, argument);
      return { watch: { assignmentId: found.id } };
    }

    case 'tasks': {
      const organization = assistant.org.activeOrganization();
      const status = parseTaskStatuses(argument || undefined) ?? [...ACTIVE_TASK_STATUSES];
      const board = assistant.store.org.listTasks(organization.id, { status });
      const rendered = renderBoard(board, assistant.org.snapshot(organization.id), assistant.store.org);
      const lines: NoticeLine[] = rendered.split('\n').map((text) => ({ text, dim: true }));
      lines.push({ text: '/task <title> creates a task', dim: true });
      return notice(lines);
    }

    case 'task': {
      if (!argument) throw new CliError('Usage: /task <title>');
      const organization = assistant.org.activeOrganization();
      const task = assistant.store.org.createTask({
        orgId: organization.id,
        title: argument,
        // A one-line task is its own brief; planning reads the description.
        description: argument,
        projectId: session.projectId,
        createdBy: 'user',
      });
      return notice([
        { text: glyph.ok + ' task ' + shortId(task.id) + '  ' + shorten(task.title, 60), dim: true },
        { text: '  rookery tasks plan ' + shortId(task.id), dim: true },
      ]);
    }

    case 'project': {
      if (!argument) {
        return notice([
          { text: session.projectName ? 'project: ' + session.projectName : 'no project set', dim: true },
        ]);
      }
      if (argument.toLowerCase() === 'off' || argument.toLowerCase() === 'none') {
        return {
          patch: { projectId: undefined, projectName: undefined },
          ...ok('Project detached'),
        };
      }
      const project = resolveProject(assistant, argument);
      if (!project) return {};
      return {
        patch: { projectId: project.id, projectName: project.name },
        ...ok('Project ' + project.name + '  ' + (project.path ?? 'no directory')),
      };
    }

    case 'inbox': {
      const organization = assistant.org.activeOrganization();
      // Read-only on purpose: the turn that actually uses the inbox is the one
      // allowed to mark it read.
      const messages = assistant.store.org.inbox(organization.id, null, { unreadOnly: true });
      if (!messages.length) return notice([{ text: 'No unread messages.', dim: true }]);
      const agents = new Map(
        assistant.store.org
          .listAgents(organization.id, { includeArchived: true })
          .map((agent) => [agent.id, agent]),
      );
      return notice(
        messages.map((message) => {
          const from = message.fromAgentId
            ? (agents.get(message.fromAgentId)?.slug ?? shortId(message.fromAgentId))
            : 'the assistant';
          return {
            text:
              '  ' + shorten(from, 15).padEnd(16) + shorten(message.content, 68) +
              '  ' + relativeTime(message.createdAt),
            dim: true,
          };
        }),
      );
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
        return notice([{ text: 'no matches for "' + shorten(argument, 50) + '"', dim: true }]);
      }
      return notice(hits.map((hit) => ({ text: '  ' + memoryLine(hit) })));
    }

    case 'remember': {
      if (!argument) throw new CliError('Usage: /remember <text>');
      const record = assistant.rememberFact({ content: argument, kind: 'fact', importance: 0.7 });
      return ok('remembered: ' + shortId(record.id));
    }

    case 'forget': {
      if (!argument) throw new CliError('Usage: /forget <memory id>');
      const id = resolveMemoryId(assistant, argument);
      const record = assistant.store.getMemory(id);
      assistant.store.forgetMemory(id);
      return ok('forgotten: ' + shorten(record?.content ?? id, 60));
    }

    case 'voice': {
      const voice = !session.voice;
      if (!voice) {
        stopSpeaking();
        return { patch: { voice }, ...ok('Voice off') };
      }
      const backend = await describeSpeech();
      const lines: NoticeLine[] = [
        { text: glyph.ok + ' voice on  ' + glyph.dot + ' ' + backend, dim: true },
      ];
      if (backend.startsWith('unavailable')) {
        lines.push({ text: '  Replies remain speech-friendly but will not be read aloud.', dim: true });
      }
      return { patch: { voice }, entries: [{ kind: 'notice', id: ctx.nextId(), lines }] };
    }

    case 'verbose':
      return { patch: { verbose: !session.verbose }, ...ok('Verbose ' + (session.verbose ? 'off' : 'on')) };

    case 'doctor': {
      const statuses = await assistant.providers.statuses(true);
      const lines: NoticeLine[] = statuses.map((status) => {
        const healthy = status.available && status.authenticated;
        const mark = healthy ? glyph.ok : status.available ? glyph.warn : glyph.fail;
        return {
          text:
            '  ' + mark + ' ' + status.id.padEnd(8) + (status.version ?? 'unknown') + '  ' +
            (status.authenticated ? 'authenticated' : status.detail ?? 'not ready'),
          color: healthy ? ui.ok : status.available ? ui.warn : ui.danger,
        };
      });
      lines.push({ text: '  `rookery doctor` shows the full report', dim: true });
      return notice(lines);
    }

    case 'clear':
      return { clear: true };

    case 'exit':
    case 'quit':
    case 'q':
      return { exit: true };

    default:
      throw new CliError('Unknown command /' + command + '. Try /help.');
  }
}

/** Accept a full assignment id or any unambiguous prefix of one. */
function resolveAssignment(running: Assignment[], idOrPrefix: string): Assignment {
  const needle = idOrPrefix.trim().toLowerCase();
  const matches = running.filter((assignment) => assignment.id.toLowerCase().startsWith(needle));

  if (matches.length === 1) return matches[0] as Assignment;
  if (matches.length === 0) {
    throw new CliError(
      'No running task matches "' + idOrPrefix + '". Try /watch with no argument.',
    );
  }
  throw new CliError(
    'Ambiguous run id "' + idOrPrefix + '": ' +
      matches.map((assignment) => shortId(assignment.id)).join(', '),
  );
}
