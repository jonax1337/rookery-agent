/**
 * Everything the TUI needs before the first frame: the runtime, the session it
 * opens in, the model catalogue and the scrollback it starts with.
 *
 * Problems met on the way (an unknown project, an agent that does not exist, a
 * session that cannot be loaded) never stop the boot - they are collected as
 * warnings and shown on the banner.
 */

import { Assistant, loadConfig } from '@rookery/core';
import type { RookeryConfig } from '@rookery/core';
import {
  parseEffort,
  parsePermission,
  parseProvider,
  resolveAgent,
  resolveProject,
  resolveSession,
} from '../commands/shared.js';
import { loadModelCatalogue, modelName } from '../ui/modelNames.js';
import type { ModelCatalogue } from '../ui/modelNames.js';
import { historyEntries } from './history.js';
import { EMPTY_USAGE } from './types.js';
import type { BannerState, Entry, SessionState } from './types.js';

export interface TuiOptions {
  session?: string;
  provider?: string;
  model?: string;
  effort?: string;
  permission?: string;
  /** Project name or id this conversation is about. */
  project?: string;
  /** Agent slug or name to talk to instead of the assistant. */
  agent?: string;
  voice?: boolean;
  verbose?: boolean;
}

export interface TuiBoot {
  assistant: Assistant;
  config: RookeryConfig;
  state: SessionState;
  catalogue: ModelCatalogue;
  initialEntries: Entry[];
}

/** How much of a resumed conversation is replayed into the scrollback. */
const RESUMED_MESSAGE_COUNT = 50;

export async function bootTui(options: TuiOptions): Promise<TuiBoot> {
  const config = loadConfig();
  const assistant = new Assistant();
  const warnings: string[] = [];

  const state = initialState(config, options);
  attempt(warnings, () => applyProject(assistant, state, options.project));
  if (options.agent) {
    const agent = options.agent;
    attempt(warnings, () => applyAgent(assistant, state, agent));
  }
  const { sessionId } = state;
  if (sessionId && !attempt(warnings, () => resumeSession(assistant, state, sessionId))) {
    state.sessionId = undefined;
  }

  // A resumed conversation starts with its scrollback, not with amnesia: the
  // ordered blocks rebuild the turns the way they happened.
  const history = resumedScrollback(assistant, state, warnings);

  // The banner needs model display names, and so does everything live; one
  // catalogue load serves both. It is cached on disk, so this only spawns the
  // CLIs once a day.
  const catalogue = await loadModelCatalogue(assistant.providers, config.home);
  const banner: Entry = {
    kind: 'banner',
    id: 'b1',
    banner: await bannerState(assistant, state, warnings, catalogue),
  };

  return { assistant, config, state, catalogue, initialEntries: [banner, ...history] };
}

/** Run one boot step; a failure becomes a warning. Returns whether it succeeded. */
function attempt(warnings: string[], step: () => void): boolean {
  try {
    step();
    return true;
  } catch (error) {
    warnings.push((error as Error).message);
    return false;
  }
}

function initialState(config: RookeryConfig, options: TuiOptions): SessionState {
  const assistantName = config.assistantName || 'Rookery';
  return {
    sessionId: options.session,
    title: 'New conversation',
    assistantName,
    counterpart: assistantName,
    provider: parseProvider(options.provider) ?? config.defaultProvider,
    model: options.model ?? config.defaultModel,
    effort: parseEffort(options.effort) ?? config.defaultEffort,
    permission: parsePermission(options.permission) ?? config.defaultPermission,
    usage: EMPTY_USAGE,
    voice: options.voice ?? false,
    verbose: options.verbose ?? false,
  };
}

function applyProject(assistant: Assistant, state: SessionState, name: string | undefined): void {
  const project = resolveProject(assistant, name);
  if (!project) return;
  state.projectId = project.id;
  state.projectName = project.name;
}

function applyAgent(assistant: Assistant, state: SessionState, name: string): void {
  const agent = resolveAgent(assistant, name);
  state.agentId = agent.id;
  state.counterpart = agent.slug;
  state.agentTitle = agent.title;
  state.provider = agent.provider ?? state.provider;
  state.model = agent.model ?? state.model;
}

/** Adopt the stored conversation `sessionId` names. */
function resumeSession(assistant: Assistant, state: SessionState, sessionId: string): void {
  const existing = resolveSession(assistant, sessionId);
  state.sessionId = existing.id;
  state.title = existing.title;
  state.provider = existing.provider;
  state.model = existing.model ?? state.model;
  // A resumed conversation keeps its own counterpart: core will not let
  // `--agent` re-point a session that already has one.
  const agent = existing.agentId ? assistant.store.org.getAgent(existing.agentId) : null;
  state.agentId = existing.agentId;
  state.counterpart = agent ? agent.slug : state.assistantName;
  state.agentTitle = agent?.title;
  if (existing.projectId && !state.projectId) {
    state.projectId = existing.projectId;
    state.projectName = assistant.store.org.getProject(existing.projectId)?.name;
  }
}

function resumedScrollback(
  assistant: Assistant,
  state: SessionState,
  warnings: string[],
): Entry[] {
  const { sessionId } = state;
  if (!sessionId) return [];

  let entries: Entry[] = [];
  attempt(warnings, () => {
    let sequence = 0;
    const nextId = () => 'h' + (sequence += 1);
    entries = historyEntries(assistant.store.getMessages(sessionId, RESUMED_MESSAGE_COUNT), state, nextId);
  });
  return entries;
}

/** What the boot banner shows beside the mark: the counterpart, the logins. */
async function bannerState(
  assistant: Assistant,
  state: SessionState,
  warnings: string[],
  catalogue: ModelCatalogue,
): Promise<BannerState> {
  const statuses = await assistant.providers.statuses();
  const isReady = (status: (typeof statuses)[number]) => status.available && status.authenticated;
  const model = modelName(catalogue, state.provider, state.model);

  return {
    assistantName: state.assistantName,
    ready: statuses.filter(isReady).map((status) => status.id),
    offline: statuses.filter((status) => !isReady(status)).map((status) => status.id),
    provider: state.provider,
    ...(model ? { model } : {}),
    permission: state.permission,
    ...(state.projectName ? { project: state.projectName } : {}),
    ...(state.agentId ? { agent: state.counterpart } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}
