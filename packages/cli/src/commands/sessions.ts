/**
 * Session browsing: list them, read one back, throw one away.
 */

import { createInterface } from 'node:readline/promises';
import { glyph, theme } from '../ui/theme.js';
import { heading, keyValue, listHeader, sessionLine, relativeTime, shortId, transcriptBlock } from '../ui/render.js';
import {
  CliError,
  counterpartLabel,
  parseLimit,
  printJson,
  resolveSession,
  withAssistant,
} from './shared.js';

const out = process.stdout;

export interface ListOptions {
  limit?: string;
  json?: boolean;
  all?: boolean;
}

export async function sessionsCommand(options: ListOptions = {}): Promise<number> {
  return withAssistant((assistant) => {
    const limit = parseLimit(options.limit, 20);
    const sessions = assistant.store.listSessions({ limit, includeArchived: options.all ?? false });

    if (options.json) {
      printJson(sessions);
      return 0;
    }

    if (!sessions.length) {
      out.write(theme.dim('No sessions yet. Run `rookery` and say something.') + '\n');
      return 0;
    }

    out.write(listHeader('Sessions', sessions.length));
    for (const session of sessions) {
      out.write(sessionLine(session, counterpartLabel(assistant, session.agentId)) + '\n');
    }
    out.write('\n' + theme.dim('rookery session <id>  to read one') + '\n\n');
    return 0;
  });
}

export interface ShowOptions {
  json?: boolean;
}

export async function sessionShowCommand(id: string, options: ShowOptions = {}): Promise<number> {
  return withAssistant((assistant) => {
    const session = resolveSession(assistant, id);
    const messages = assistant.store.getMessages(session.id);

    if (options.json) {
      printJson({ session, messages });
      return 0;
    }

    out.write('\n' + heading(session.title) + '\n');
    out.write(keyValue('id', session.id) + '\n');
    // Who the conversation is with. An agent chat runs in that agent's voice
    // and its memory, so this is not decoration - it says whose words these are.
    const agent = session.agentId ? assistant.store.org.getAgent(session.agentId) : null;
    out.write(
      keyValue(
        'with',
        agent
          ? agent.slug + theme.dim('  ' + agent.name + ', ' + agent.title)
          : counterpartLabel(assistant, session.agentId),
      ) + '\n',
    );
    out.write(
      keyValue('provider', session.provider + (session.model ? theme.dim('  ' + session.model) : '')) + '\n',
    );
    // The session's cwd is always the workspace, so it says nothing. What the
    // conversation is about does: the project its assignments default to.
    const project = session.projectId ? assistant.store.org.getProject(session.projectId) : null;
    if (project) {
      out.write(keyValue('project', project.name + (project.path ? theme.dim('  ' + project.path) : '')) + '\n');
    }
    out.write(
      keyValue('updated', relativeTime(session.updatedAt) + theme.dim('  ' + session.messageCount + ' messages')) +
        '\n\n',
    );

    if (!messages.length) {
      out.write(theme.dim('This session has no messages.') + '\n\n');
      return 0;
    }

    for (const message of messages) {
      out.write(transcriptBlock(message) + '\n');
    }
    return 0;
  });
}

export interface RemoveOptions {
  yes?: boolean;
}

export async function sessionRemoveCommand(id: string, options: RemoveOptions = {}): Promise<number> {
  return withAssistant(async (assistant) => {
    const session = resolveSession(assistant, id);

    if (!options.yes) {
      if (!process.stdin.isTTY) {
        throw new CliError('Refusing to delete without confirmation. Re-run with --yes.');
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(
          theme.yellow(glyph.warn + ' Delete "' + session.title + '" (' + session.messageCount + ' messages)? ') +
            theme.dim('[y/N] '),
        );
        if (!/^y(es)?$/i.test(answer.trim())) {
          process.stdout.write(theme.dim('Cancelled.') + '\n');
          return 0;
        }
      } finally {
        rl.close();
      }
    }

    assistant.deleteSession(session.id);
    out.write(theme.green(glyph.ok + ' Deleted session ' + shortId(session.id)) + '\n');
    return 0;
  });
}
