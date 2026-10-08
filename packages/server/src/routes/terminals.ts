import type { FastifyInstance } from 'fastify';
import { tuiSessions, type TuiSessionInfo } from '@rookery/core';
import type { ServerContext } from '../context.js';

/**
 * Every Claude Code terminal that is open right now, for the workspace page.
 *
 * The registry only knows keys - an assignment id, or `chat:<session id>` -
 * so this puts the names on them a person recognises: the conversation's
 * title, or the run's title and the agent working on it. The screen bytes
 * themselves still travel over the websocket (`tui-watch`); this is the list
 * of tabs, nothing more.
 */
export interface TerminalView {
  key: string;
  kind: 'chat' | 'run';
  /** The conversation's session id, or the run's assignment id. */
  id: string;
  title: string;
  /** Who is at the other end: the agent's name for a run, empty for a conversation. */
  subtitle: string;
  state: TuiSessionInfo['state'];
  startedAt: number;
}

/** Terminal registry keys of a conversation start with this; any other key is an assignment id. */
const CHAT_KEY_PREFIX = 'chat:';
/** A run without a title is named by the start of its task. */
const RUN_TITLE_CHARS = 80;

export async function registerTerminalRoutes(app: FastifyInstance, context: ServerContext): Promise<void> {
  const { store } = context.assistant;

  const chatView = (info: TuiSessionInfo): TerminalView => {
    const id = info.key.slice(CHAT_KEY_PREFIX.length);
    return {
      key: info.key,
      kind: 'chat',
      id,
      title: store.getSession(id)?.title ?? 'Conversation',
      subtitle: '',
      state: info.state,
      startedAt: info.startedAt,
    };
  };

  const runView = (info: TuiSessionInfo): TerminalView => {
    const assignment = store.org.getAssignment(info.key);
    const agent = assignment ? store.org.getAgent(assignment.agentId) : null;
    return {
      key: info.key,
      kind: 'run',
      id: info.key,
      title: assignment?.title || assignment?.task.slice(0, RUN_TITLE_CHARS) || 'Run',
      subtitle: agent?.name ?? '',
      state: info.state,
      startedAt: info.startedAt,
    };
  };

  const view = (info: TuiSessionInfo): TerminalView => (info.key.startsWith(CHAT_KEY_PREFIX) ? chatView(info) : runView(info));

  // Oldest first: a tab keeps its place when others open after it.
  app.get('/api/terminals', async () =>
    tuiSessions
      .list()
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(view),
  );
}
