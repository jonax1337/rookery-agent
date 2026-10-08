/**
 * What the REPL remembers between lines: who it is talking to, on which
 * provider, in which project - and the ways that selection changes.
 */

import type {
  Agent,
  Assistant,
  EffortLevel,
  PermissionLevel,
  Project,
  ProviderId,
  RookeryConfig,
  Session,
} from '@rookery/core';
import {
  counterpartLabel,
  parseEffort,
  parsePermission,
  parseProvider,
  resolveAgent,
  resolveProject,
  resolveSession,
} from './commands/shared.js';
import { printWarning } from './replOutput.js';

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

export interface ReplState {
  /** What the assistant is called, for when the conversation is with the assistant. */
  readonly assistantName: string;
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

/**
 * The state a REPL starts in: the command line over the config defaults,
 * then the session, agent and project it asked for. A selection that cannot
 * be honoured is a warning, not the end of the REPL.
 */
export function startingState(assistant: Assistant, options: ReplOptions, config: RookeryConfig): ReplState {
  const assistantName = config.assistantName || 'Rookery';
  const state: ReplState = {
    assistantName,
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

  attempt(() => {
    const project = resolveProject(assistant, options.project);
    if (project) adoptProject(state, project);
  });
  if (options.agent) {
    const agentRef = options.agent;
    attempt(() => adoptAgent(state, resolveAgent(assistant, agentRef)));
  }
  if (state.sessionId) {
    const sessionRef = state.sessionId;
    const resumed = attempt(() => {
      const existing = resolveSession(assistant, sessionRef);
      adoptSession(assistant, state, existing);
      if (existing.projectId && !state.projectId) adoptSessionProject(assistant, state, existing.projectId);
    });
    if (!resumed) state.sessionId = undefined;
  }
  return state;
}

/** Run one startup step; a failure is shown as a warning and reported as false. */
function attempt(step: () => void): boolean {
  try {
    step();
    return true;
  } catch (error) {
    printWarning(error);
    return false;
  }
}

export function adoptProject(state: ReplState, project: Project): void {
  state.projectId = project.id;
  state.projectName = project.name;
}

/** The project a session belongs to, which may have been deleted since. */
export function adoptSessionProject(assistant: Assistant, state: ReplState, projectId: string): void {
  state.projectId = projectId;
  state.projectName = assistant.store.org.getProject(projectId)?.name;
}

/** Talk to `agent`, on the provider and model it is set up with. */
export function adoptAgent(state: ReplState, agent: Agent): void {
  state.agentId = agent.id;
  state.counterpart = agent.slug;
  state.provider = agent.provider ?? state.provider;
  state.model = agent.model ?? state.model;
}

/**
 * Continue `session`. The conversation decides who it is with, not the
 * prompt you came from: core will not let `--agent` re-point a session that
 * already has a counterpart.
 */
export function adoptSession(assistant: Assistant, state: ReplState, session: Session): void {
  state.sessionId = session.id;
  state.provider = session.provider;
  state.model = session.model ?? state.model;
  state.agentId = session.agentId;
  state.counterpart = session.agentId ? counterpartLabel(assistant, session.agentId) : state.assistantName;
}
