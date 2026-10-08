import type { Logger } from '../logger.js';
import type { Store } from '../memory/store.js';
import type { ProviderId, RookeryConfig, Session, SessionKind } from '../types.js';
import type { ChatInput } from './types.js';

/** What a new conversation can be told about itself. */
export interface NewSessionInput {
  title?: string;
  kind?: SessionKind;
  provider?: ProviderId;
  model?: string;
  projectId?: string;
  agentId?: string;
}

/** The parts of a chat request that decide which conversation it lands in. */
export type SessionRequest = Pick<
  ChatInput,
  'sessionId' | 'voice' | 'provider' | 'model' | 'projectId' | 'agentId'
>;

/** What a conversation is called until its first message names it (the store's own default). */
export const DEFAULT_SESSION_TITLE = 'New conversation';

/** Where the rights a conversation was last used with are kept. */
export function sessionPermissionKey(sessionId: string): string {
  return 'session:permission:' + sessionId;
}

/** A conversation sticks to the project a caller names for it. */
export function pinProject(store: Store, session: Session, projectId: string | undefined): void {
  if (!projectId || projectId === session.projectId) return;
  store.updateSession(session.id, { projectId });
  session.projectId = projectId;
}

export function createSession(
  context: { store: Store; config: RookeryConfig },
  input: NewSessionInput = {},
): Session {
  const { store, config } = context;
  const agent = input.agentId ? store.org.getAgent(input.agentId) : null;
  if (input.agentId && !agent) throw new Error('No agent ' + input.agentId + '.');
  return store.createSession({
    title: input.title,
    kind: input.kind,
    provider: input.provider ?? agent?.provider ?? config.defaultProvider,
    model: input.model ?? agent?.model ?? config.defaultModel,
    cwd: config.workspace,
    projectId: input.projectId,
    agentId: agent?.id,
  });
}

/** The conversation a request names, or a new one when it names none that exists. */
export function resolveSession(
  context: { store: Store; config: RookeryConfig; log: Logger },
  request: SessionRequest,
): Session {
  if (request.sessionId) {
    const existing = context.store.getSession(request.sessionId);
    if (existing) return existing;
    context.log.warn('Unknown session, starting a new one', { sessionId: request.sessionId });
  }
  return createSession(context, {
    // A spoken first turn opens a voice session, so the hands-free screen
    // never has to create one by hand.
    kind: request.voice ? 'voice' : 'chat',
    provider: request.provider,
    model: request.model,
    projectId: request.projectId,
    agentId: request.agentId,
  });
}

/**
 * The turn each conversation is running or waiting to run, chained: one
 * conversation answers one message at a time. A report-back arriving while
 * the user's own message is being answered waits its turn instead of
 * talking over it - and a conversation's terminal could not take two at
 * once anyway.
 */
export class SessionTurnQueue {
  readonly #tails = new Map<string, Promise<void>>();

  /** Wait for this conversation's turn; the returned function hands it on. */
  async take(sessionId: string): Promise<() => void> {
    const previous = this.#tails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.#tails.set(sessionId, tail);
    await previous;
    return () => {
      release();
      // Only the last in line clears the entry, or a conversation's map slot
      // would live as long as the process.
      if (this.#tails.get(sessionId) === tail) this.#tails.delete(sessionId);
    };
  }
}
