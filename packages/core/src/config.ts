import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import type {
  EffortLevel,
  ExternalConfig,
  GatewaysConfig,
  PermissionLevel,
  ProviderId,
  RookeryConfig,
} from './types.js';
import { ensureProfile } from './profile.js';

/**
 * Config resolution order, later wins:
 *   defaults -> ~/.rookery/config.json -> environment -> explicit overrides
 *
 * The two built-in providers, `claude` and `codex`, take no API key: model
 * access is borrowed from the login sessions already on this machine.
 * `providerProfiles` is the opt-in exception - each entry is a named API key
 * plus endpoint for the `claude` binary, stored the same way as
 * `gateways.telegram.token` (see `normaliseSecrets` in the server package).
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
    gate: {
      // Three a turn, not eight: a conversation that yields more than three
      // durable facts is rare, and this cap is what stops the bank drifting.
      maxPerTurn: 3,
      minImportance: 0.4,
      duplicateThreshold: 0.82,
      clusterThreshold: 0.55,
    },
    graph: {
      hopEntity: 0.45,
      hopEdge: 0.6,
      maxNodes: 300,
    },
    sleep: {
      enabled: true,
      // Half past three: late enough that nobody is working, early enough
      // that the machine is usually still awake.
      schedule: '30 3 * * *',
      scope: 'assistant',
      // The night's wallet for the consolidation phases. Each phase measures
      // its own workload first - clusters, open contradictions, fresh
      // memories, suspect skills - and only that demand gets funded, up to
      // this ceiling. A quiet week sleeps shallow and cheap; after a loud
      // day the night runs long, but never past the cap. The replay pass
      // lives outside the wallet: its deep reads are capped by
      // `replaySessions`, and its triage runs on the cheap model.
      nightBudget: 70,
      // Per-phase ceilings inside that wallet. The allocation never spends
      // more than the work there is, and never more than these.
      maxMergeCalls: 24,
      maxResolveCalls: 8,
      maxLinkCalls: 8,
      dormantAfterDays: 45,
      minStrength: 0.25,
      insights: 3,
      // Patterns need distance: one week can be a coincidence, two are a habit.
      insightWindowDays: 14,
      // Thirty-six deep reads a night at most. The cheap triage pass runs
      // over every conversation since the last night, so this caps only the
      // expensive half - a talkative day costs a handful of small calls plus
      // up to thirty-six proper ones, and anything beyond that waits for
      // tomorrow.
      replaySessions: 36,
      // One a night. A skill that gets rewritten every night is not a skill,
      // it is noise with a folder of its own; `write_skill` covers the case
      // where something needs writing down in the moment.
      skills: 1,
      // Two repairs against one invention. A skill whose ground has shifted
      // is actively misleading whoever opens it next, which is worse than a
      // skill that was never written at all.
      skillRevisions: 2,
      agentThreshold: 20,
      // Two cycles: the second one sees the bank the first one tidied, so
      // dream sleep connects what deep sleep just made connectable.
      cycles: 2,
      // Sonnet, not haiku. Seventy calls once a night are cheap; a merge
      // that throws two different facts into one sentence is not.
      model: 'sonnet',
      insightModel: 'sonnet',
    },
  },
  voice: {
    enabled: true,
    wakeWord: 'rookery',
    lang: 'en-GB',
    voiceName: '',
    rate: 1.02,
    pitch: 0.95,
    speakCleanText: true,
    engine: 'edge',
    edgeVoice: 'en-GB-RyanNeural',
    elevenLabsVoiceId: '',
    elevenLabsModel: 'eleven_multilingual_v2',
    openaiVoice: 'onyx',
    jarvisEffect: false,
    style: 'neutral',
  },
  org: {
    maxConcurrentAssignments: 4,
    maxDelegationDepth: 3,
    assignmentTimeoutMs: 45 * 60 * 1000,
    lazyCoding: true,
    autoReview: true,
  },
  // Nothing is watched until somebody adds a mailbox on the settings page: a
  // listener holds a credential and an open socket, which is not something a
  // fresh install should do on its own.
  listeners: {
    imap: [],
  },
  gateways: {
    telegram: {
      enabled: false,
      token: '',
      pairing: false,
      allowedUserIds: [],
      permission: 'full',
      // On, because a phone without a camera button is half a phone, and
      // what arrives is a file the allowlist itself sent. Transcription
      // starts at `auto`, which ends at the local model: a voice note has
      // to work on a machine that holds no key for anything.
      media: true,
      transcribe: 'auto',
      transcribeModel: 'onnx-community/whisper-base',
      maxAttachmentMb: 20,
      // On: an answer that appears as it is written reads like someone
      // typing, which is the closest Telegram gets to a live answer.
      stream: true,
      // Mail first, machinery quiet: the phone hears from the assistant and
      // the team leads, the way a person would be told. What ran, when and
      // for how long is what the web app is open for - a buzz per finished
      // assignment is the fastest way to get a channel muted.
      push: {
        enabled: true,
        assignments: false,
        cron: false,
        sleep: false,
        tasks: false,
        mail: true,
        mailFrom: 'leads',
        // Both off: they are the two switches that turn a phone into a log
        // viewer, and that has to be a decision somebody makes on purpose.
        activity: false,
        tools: false,
        quietFrom: '22:00',
        quietUntil: '08:00',
        maxPerHour: 12,
        recipients: [],
      },
    },
  },
  tools: { servers: [] },
  providerProfiles: [],
  router: { enabled: false },
  // On unless switched off: a provider that runs out of quota should cost a
  // switch, not a failed run. The threshold stays just under the wall because
  // windows lag a little behind the turns that fill them.
  providerFallback: { enabled: true, thresholdPercent: 95, order: [] },
  // Looking is free and always on; what is found stays out of the way until
  // a person switches it on. See `ExternalConfig`. The three newer shelves -
  // subagents, hook sets, whole plugins - start empty, which means off: a
  // subagent carries its own prompt into a turn, a hook set carries command
  // lines around every tool call, and neither arrives without a click.
  external: { enabled: true, skillSources: {}, servers: {}, agents: {}, hooks: {}, plugins: {} },
  // Ten minutes. Long enough to walk away from the desk and come back, short
  // enough that a forgotten question does not hold a provider process open -
  // and far under Claude Code's own six-hour MCP tool timeout, which is what
  // the waiting call is actually sitting in.
  questions: { timeoutMs: 10 * 60 * 1000 },
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
  // The bot token normally lives in config.json, set from the gateway page.
  // The environment still wins where it is set, like every other setting
  // here - a headless install can hand it in without writing a config file,
  // and the page says so rather than letting the variable shadow the field
  // silently.
  if (env.TELEGRAM_BOT_TOKEN) {
    patch.gateways = { telegram: { token: env.TELEGRAM_BOT_TOKEN.trim() } } as GatewaysConfig;
  }
  return patch as Partial<RookeryConfig>;
}

/**
 * What each config object was loaded with on top of the file.
 *
 * The file is not the whole truth: a host can start Rookery with settings
 * that were never written to it - `rookery-server --port 4318`, a test with
 * its own home directory. Saving re-reads the file, so without this the
 * first tool switch would quietly put the port back to what config.json
 * says. Keyed by object identity, so nothing shows up in the config shape
 * or in what the browser is handed.
 */
const OVERRIDES = new WeakMap<RookeryConfig, Partial<RookeryConfig>>();
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

  // Rookery used to read a second installation, `~/.codex`, beside Claude
  // Code's. A shelf or server that only existed there is gone with the CLI, so
  // its switch is dropped rather than left as a key nothing will ever match
  // again. Two shelves found in both were folded under a bare `plugin/<key>`
  // and one server under `ext-both-`; those still exist, under the Claude Code
  // id they now carry alone - so the decision travels rather than silently
  // reverting a three-hundred-skill plugin to off.
  const sources: Record<string, boolean> = {};
  for (const [id, on] of Object.entries(config.external.skillSources)) {
    if (id.startsWith('codex:')) continue;
    const key = id.startsWith('plugin/') ? 'claude-code:' + id : id;
    if (!(key in sources)) sources[key] = on;
  }
  config.external.skillSources = sources;

  const servers: ExternalConfig['servers'] = {};
  for (const [id, decided] of Object.entries(config.external.servers)) {
    if (id.startsWith('ext-codex-')) continue;
    const key = id.startsWith('ext-both-') ? 'ext-claude-code-' + id.slice('ext-both-'.length) : id;
    if (!(key in servers)) servers[key] = decided;
  }
  config.external.servers = servers;

  // Clearing a setting from the UI stores an empty string, because the merge
  // skips undefined; downstream an empty model or effort must mean "unset".
  if (!config.defaultModel) delete config.defaultModel;
  if (!config.defaultEffort) delete config.defaultEffort;

  const upgradingLegacy = existsSync(join(config.home, 'rookery.db')) || existsSync(join(config.workspace, 'CLAUDE.md'));
  // Existing users keep the previous persona and spoken register when upgrading.
  if (upgradingLegacy && !existsSync(join(config.workspace, 'SOUL.md'))) {
    const previous = merge(merge(merge({ voice: { jarvisEffect: true, style: 'jarvis' } }, fileConfig), envPatch), overrides);
    config.voice = merge(config.voice, previous.voice);
    // Persist the previous defaults once, so subsequent loads preserve the old voice too.
    mkdirSync(config.home, { recursive: true });
    writeFileSync(path, JSON.stringify(merge(fileConfig, { voice: { jarvisEffect: config.voice.jarvisEffect, style: config.voice.style } }), null, 2) + '\n', 'utf8');
  }
  ensureHome(config.home, config.workspace);
  ensureProfile(config, upgradingLegacy);
  OVERRIDES.set(config, overrides);
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
  loadConfig({ home: root });
  ensureHome(root);
  const path = configPath(root);
  const existing: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const next = merge(existing as Record<string, unknown>, patch);
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8');
  // Read back from the same home; without it a non-default home (a test's
  // temp directory, or ROOKERY_HOME) would save to one file and load another.
  return loadConfig({ home: root });
}

/**
 * Persist a patch and bring one live config object up to date, in place.
 *
 * The runtime, the company controller and the server routes all hold the
 * same object, so a setting change has to mutate it rather than replace it:
 * whoever captured a reference must keep seeing current settings. Three
 * things a plain `Object.assign(config, saveConfig(...))` gets wrong and this
 * does not. A setting cleared to "unset" is absent from the reloaded config
 * and would otherwise survive the assign. The overrides the object was
 * started with would be lost to the file, so the first tool switch would put
 * a `--port` flag back to whatever config.json says. And an override must not
 * outrank the change being made: the layering is file, then what the host
 * started with, then this patch, so an explicit change always wins and only
 * the keys it leaves alone keep the host's value.
 */
export function applyConfig(config: RookeryConfig, patch: Partial<RookeryConfig>): RookeryConfig {
  const overrides = merge(OVERRIDES.get(config) ?? {}, patch);
  const next = merge(saveConfig(patch, config.home), overrides);
  // The rule loadConfig uses, applied again because the patch reintroduces
  // the empty string the UI sends for "use the default".
  if (!next.defaultModel) delete next.defaultModel;
  if (!next.defaultEffort) delete next.defaultEffort;
  const live = config as unknown as Record<string, unknown>;
  for (const key of Object.keys(live)) if (!(key in next)) delete live[key];
  Object.assign(config, next);
  OVERRIDES.set(config, overrides);
  return config;
}
export function databasePath(config: RookeryConfig): string {
  return join(config.home, 'rookery.db');
}

/** Projectless staff must not auto-load the assistant's private AGENTS.md or profile. */
export function agentWorkspace(config: RookeryConfig, id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid agent workspace ID.');
  const path = join(config.home, 'agent-workspaces', id);
  mkdirSync(path, { recursive: true });
  const fromAssistant = relative(realpathSync(config.workspace), realpathSync(path));
  if (!fromAssistant || (!isAbsolute(fromAssistant) && fromAssistant !== '..' && !fromAssistant.startsWith('..' + sep))) {
    throw new Error('Agent workspaces must be outside the assistant workspace. Configure a separate assistant workspace.');
  }
  return path;
}
