import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { EffortLevel, PermissionLevel, ProviderId, RookeryConfig } from './types.js';

/**
 * Config resolution order, later wins:
 *   defaults -> ~/.rookery/config.json -> environment -> explicit overrides
 *
 * There is deliberately no API-key setting. Model access is borrowed from
 * whatever the `claude` and `codex` CLIs are already logged into.
 */

const DEFAULT_HOME = join(homedir(), '.rookery');

export const DEFAULT_CONFIG: RookeryConfig = {
  home: DEFAULT_HOME,
  workspace: join(DEFAULT_HOME, 'workspace'),
  port: 4317,
  host: '127.0.0.1',
  defaultProvider: 'claude',
  defaultPermission: 'read',
  token: '',
  logLevel: 'info',
  assistantName: 'Rookery',
  formalAddress: false,
  honorific: '',
  memory: {
    enabled: true,
    recallLimit: 8,
    recallThreshold: 0.12,
    autoExtract: true,
    workingWindow: 12,
    contextBudget: 6000,
  },
  voice: {
    enabled: true,
    wakeWord: 'rookery',
    lang: 'de-DE',
    voiceName: '',
    rate: 1.02,
    pitch: 0.95,
    speakCleanText: true,
    engine: 'edge',
    edgeVoice: 'de-DE-FlorianMultilingualNeural',
    elevenLabsVoiceId: '',
    elevenLabsModel: 'eleven_multilingual_v2',
    openaiVoice: 'onyx',
    jarvisEffect: true,
    style: 'jarvis',
  },
  org: {
    maxConcurrentAssignments: 4,
    maxDelegationDepth: 3,
    assignmentTimeoutMs: 45 * 60 * 1000,
  },
  tools: { servers: [] },
  skillsDir: join(DEFAULT_HOME, 'skills'),
};

/**
 * The instructions file the assistant's provider CLI finds in its workspace.
 * Claude Code reads a CLAUDE.md from the working directory whatever the
 * setting sources say, so this is what it sees instead of a repo's file.
 */
const WORKSPACE_NOTES = `# Rookery workspace

This directory belongs to Rookery, the personal assistant running here.
It is a scratch space, not a software project. There is nothing to build
or test in it. Work on real projects happens through assignments to the
assistant's agents, in the project's own directory.
`;

function configPath(home: string): string {
  return join(home, 'config.json');
}

/** Deep-merge plain objects; arrays and scalars from patch replace the base. */
function merge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] =
      current && typeof current === 'object' && !Array.isArray(current)
        ? merge(current, value)
        : value;
  }
  return out as T;
}

function envOverrides(): Partial<RookeryConfig> {
  const env = process.env;
  const patch: Record<string, unknown> = {};
  if (env.ROOKERY_HOME) patch.home = resolve(env.ROOKERY_HOME);
  if (env.ROOKERY_WORKSPACE) patch.workspace = resolve(env.ROOKERY_WORKSPACE);
  if (env.ROOKERY_PORT) patch.port = Number(env.ROOKERY_PORT);
  if (env.ROOKERY_HOST) patch.host = env.ROOKERY_HOST;
  if (env.ROOKERY_TOKEN) patch.token = env.ROOKERY_TOKEN;
  if (env.ROOKERY_LOG_LEVEL) patch.logLevel = env.ROOKERY_LOG_LEVEL;
  if (env.ROOKERY_ASSISTANT_NAME) patch.assistantName = env.ROOKERY_ASSISTANT_NAME;
  if (env.ROOKERY_USER_NAME) patch.userName = env.ROOKERY_USER_NAME;
  if (env.ROOKERY_DEFAULT_PROVIDER) patch.defaultProvider = env.ROOKERY_DEFAULT_PROVIDER as ProviderId;
  if (env.ROOKERY_DEFAULT_MODEL) patch.defaultModel = env.ROOKERY_DEFAULT_MODEL;
  if (env.ROOKERY_DEFAULT_EFFORT) patch.defaultEffort = env.ROOKERY_DEFAULT_EFFORT as EffortLevel;
  if (env.ROOKERY_PERMISSION) patch.defaultPermission = env.ROOKERY_PERMISSION as PermissionLevel;
  const voice: Record<string, unknown> = {};
  if (env.ROOKERY_VOICE_LANG) voice.lang = env.ROOKERY_VOICE_LANG;
  if (env.ROOKERY_VOICE_ENGINE) voice.engine = env.ROOKERY_VOICE_ENGINE;
  if (env.ROOKERY_VOICE_EDGE_VOICE) voice.edgeVoice = env.ROOKERY_VOICE_EDGE_VOICE;
  if (Object.keys(voice).length) patch.voice = voice;
  return patch as Partial<RookeryConfig>;
}

/**
 * Load the effective config, creating ~/.rookery on first run.
 * A malformed config.json is reported rather than silently ignored, so a
 * typo never quietly reverts the assistant to defaults.
 */
export function loadConfig(overrides: Partial<RookeryConfig> = {}): RookeryConfig {
  const envPatch = envOverrides();
  const home = (overrides.home ?? envPatch.home ?? DEFAULT_CONFIG.home) as string;

  let fileConfig: unknown = {};
  const path = configPath(home);
  if (existsSync(path)) {
    try {
      fileConfig = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new Error(
        'Rookery config at ' + path + ' is not valid JSON: ' + (error as Error).message +
          '. Fix or delete the file to fall back to defaults.',
      );
    }
  }

  // The workspace follows the home directory unless something names it.
  let config = merge(DEFAULT_CONFIG, { home, workspace: join(home, 'workspace'), skillsDir: join(home, 'skills') });
  config = merge(config, fileConfig);
  config = merge(config, envPatch);
  config = merge(config, overrides);

  // Before the hub, computer control had its own block. Carry an old file's
  // choice over once, so switching it on survives the upgrade.
  const legacy = (config as { computer?: { enabled?: boolean; profile?: string } }).computer;
  if (legacy && !config.tools.servers.some((server) => server.id === 'computer')) {
    config.tools.servers.push({
      id: 'computer',
      enabled: Boolean(legacy.enabled),
      audience: 'assistant',
      options: { profile: legacy.profile ?? 'ax' },
      env: {},
    });
  }
  delete (config as { computer?: unknown }).computer;

  // Clearing a setting from the UI stores an empty string, because the merge
  // skips undefined; downstream an empty model or effort must mean "unset".
  if (!config.defaultModel) delete config.defaultModel;
  if (!config.defaultEffort) delete config.defaultEffort;

  ensureHome(config.home, config.workspace);
  return config;
}

/** Create the data directory tree and the workspace. Safe to call repeatedly. */
export function ensureHome(home: string, workspace = join(home, 'workspace')): string {
  for (const dir of [home, join(home, 'logs'), join(home, 'sessions'), join(home, 'run'), join(home, 'skills'), workspace]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const notes = join(workspace, 'CLAUDE.md');
  if (!existsSync(notes)) writeFileSync(notes, WORKSPACE_NOTES, 'utf8');
  return home;
}

/** Persist a partial config back to ~/.rookery/config.json. */
export function saveConfig(patch: Partial<RookeryConfig>, home?: string): RookeryConfig {
  const root = home ?? loadConfig().home;
  ensureHome(root);
  const path = configPath(root);
  const existing: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const next = merge(existing as Record<string, unknown>, patch);
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8');
  // Read back from the same home; without it a non-default home (a test's
  // temp directory, or ROOKERY_HOME) would save to one file and load another.
  return loadConfig({ home: root });
}

export function databasePath(config: RookeryConfig): string {
  return join(config.home, 'rookery.db');
}
