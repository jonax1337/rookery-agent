/**
 * Session browsing: list them, read one back, throw one away.
 */

import { createInterface } from 'node:readline/promises';
import { glyph, theme } from '../ui/theme.js';
import { heading, keyValue, sessionLine, relativeTime, transcriptBlock } from '../ui/render.js';
import { CliError, counterpartLabel, parseLimit, resolveSession, withAssistant } from './shared.js';

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
      process.stdout.write(JSON.stringify(sessions, null, 2) + '\n');
      return 0;
    }

    if (!sessions.length) {
      process.stdout.write(theme.dim('No sessions yet. Run `rookery` and say something.') + '\n');
      return 0;
    }

    process.stdout.write('\n' + heading('Sessions') + theme.dim('  (' + sessions.length + ')') + '\n\n');
    for (const session of sessions) {
      process.stdout.write(sessionLine(session, counterpartLabel(assistant, session.agentId)) + '\n');
    }
    process.stdout.write('\n' + theme.dim('rookery session <id>  to read one') + '\n\n');
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
      process.stdout.write(JSON.stringify({ session, messages }, null, 2) + '\n');
      return 0;
    }

    process.stdout.write('\n' + heading(session.title) + '\n');
    process.stdout.write(keyValue('id', session.id) + '\n');
    // Who the conversation is with. An agent chat runs in that agent's voice
    // and its memory, so this is not decoration - it says whose words these are.
    const agent = session.agentId ? assistant.store.org.getAgent(session.agentId) : null;
    process.stdout.write(
      keyValue(
        'with',
        agent
          ? agent.slug + theme.dim('  ' + agent.name + ', ' + agent.title)
          : counterpartLabel(assistant, session.agentId),
      ) + '\n',
    );
    process.stdout.write(
      keyValue('provider', session.provider + (session.model ? theme.dim('  ' + session.model) : '')) + '\n',
    );
    // The session's cwd is always the workspace, so it says nothing. What the
    // conversation is about does: the project its assignments default to.
    const project = session.projectId ? assistant.store.org.getProject(session.projectId) : null;
    if (project) {
      process.stdout.write(
        keyValue('project', project.name + (project.path ? theme.dim('  ' + project.path) : '')) + '\n',
      );
    }
    process.stdout.write(
      keyValue('updated', relativeTime(session.updatedAt) + theme.dim('  ' + session.messageCount + ' messages')) +
        '\n\n',
    );

    if (!messages.length) {
      process.stdout.write(theme.dim('This session has no messages.') + '\n\n');
      return 0;
    }

    for (const message of messages) {
      process.stdout.write(transcriptBlock(message) + '\n');
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
    process.stdout.write(theme.green(glyph.ok + ' Deleted session ' + session.id.slice(0, 8)) + '\n');
    return 0;
  });
}
