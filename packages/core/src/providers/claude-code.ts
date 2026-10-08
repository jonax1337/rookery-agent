import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentEvent,
  McpServerSpec,
  PermissionLevel,
  Provider,
  ProviderProfile,
  ProviderQuota,
  ProviderStatus,
  ProviderTerminalHandlers,
  ConversationTerminalHandle,
  ProviderTurnOptions,
  TurnUsage,
} from '../types.js';
import {
  readJsonLines,
  resolveBinary,
  runCapture,
  spawnCli,
  type ResolvedBinary,
  type SpawnHandle,
} from './process.js';
import { discoverModels } from './catalogue.js';
import { parseClaudeWindows, rememberQuota } from './quota.js';
import { sharedRouterManager } from './router.js';
import { BRIDGE_TOKEN_HEADER, sharedCodexBridge } from './codex-bridge.js';
import { providerContextWindow } from './provider-catalog.js';
import { TOOL_INPUT_LIMIT, canonicalJson, hashCanonicalJson } from '../memory/dream/trajectory.js';
import {
  contextFileFor,
  loadPty,
  promptContextHookCommand,
  runTui,
  startConversationTerminal,
  stopHookCommand,
  tuiSessions,
} from './claude-tui.js';

/** The built-in `claude` provider: OAuth login, no endpoint override. */
const BUILTIN_PROFILE: ProviderProfile = {
  id: 'claude',
  displayName: 'Claude Code',
  baseUrl: '',
  authToken: '',
  via: 'direct',
};

const VERSION_PROBE_TIMEOUT_MS = 20000;
const AUTH_PROBE_TIMEOUT_MS = 60000;
/** An assignment can run for many minutes; the default tool timeout would cut it off long before that. */
const MCP_TOOL_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MCP_STARTUP_TIMEOUT_MS = 60 * 1000;
const TOOL_RESULT_LIMIT = 16000;
const TOOL_DETAIL_LIMIT = 120;
const TOOL_INPUT_DETAIL_LIMIT = 4000;
const EXIT_STDERR_TAIL_CHARS = 600;
const PRINT_MODE_ARGS = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
/** Discovery guarantees this shape; rechecked wherever a name becomes a file name. */
const HANDOFF_AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Claude Code adapter.
 *
 * Runs `claude -p --output-format stream-json`. With no profile (the default,
 * built-in `claude` provider) this authenticates with the user's existing
 * Claude Code login (subscription or console session): we never read or set
 * ANTHROPIC_API_KEY, and we never pass --bare, because that flag deliberately
 * forces API-key auth instead of the OAuth session.
 *
 * A `ProviderProfile` swaps that for ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN
 * pointed at another Anthropic-compatible endpoint (z.ai's GLM, for example).
 * Same binary, same event parsing - just different env at spawn time.
 */

/**
 * Map the Rookery permission ladder onto Claude Code's own flags.
 *
 * `--restricted` is what actually removes the command-running tools (Bash,
 * PowerShell, REPL). Disallowing Edit and Write alone is not enough: a shell
 * redirect writes a file just as well as the Write tool does, so every level
 * below `full` that must not mutate the machine passes `--restricted` too.
 */
function permissionArgs(level: PermissionLevel): string[] {
  const noPrompting = ['--permission-mode', 'dontAsk'];

  switch (level) {
    case 'chat':
      // A purely conversational turn: nothing that touches the filesystem.
      return [
        '--restricted', ...noPrompting,
        '--disallowedTools', 'Edit', 'Write', 'NotebookEdit',
        'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task',
      ];
    case 'read':
      // May read and search, but neither edit nor execute.
      return [
        '--restricted', ...noPrompting,
        '--disallowedTools', 'Edit', 'Write', 'NotebookEdit',
      ];
    case 'write':
      // May change files in the working directory, still without a shell.
      return ['--restricted', '--permission-mode', 'acceptEdits'];
    case 'full':
      return ['--dangerously-skip-permissions'];
  }
}

/** The files a terminal run lives on; they outlive the generator that started it. */
interface TerminalFiles {
  dir: string;
  /** Written by the Stop hook: how the terminal learns that the agent is done. */
  markerFile: string;
  /** Only a conversation terminal: per-message context its prompt hook reads. */
  contextFile?: string;
}

interface CommandLine {
  args: string[];
  env: NodeJS.ProcessEnv;
  model: string | undefined;
  pinnedSessionId: string;
  handoff: Handoff;
}

export class ClaudeCodeProvider implements Provider {
  readonly id: string;
  readonly displayName: string;
  readonly #profile: ProviderProfile;

  constructor(profile: ProviderProfile = BUILTIN_PROFILE) {
    this.#profile = profile;
    this.id = profile.id;
    this.displayName = profile.displayName;
  }

  #binary: ResolvedBinary | null | undefined;

  /** Cached PATH lookup; undefined means "not probed yet". */
  #resolve(): ResolvedBinary | null {
    if (this.#binary === undefined) this.#binary = resolveBinary('claude');
    return this.#binary;
  }

  /**
   * Env override for a non-default profile; `{}` for the built-in OAuth
   * login. `via: 'router'` starts (or confirms) the shared `ccr` process
   * first and points at that instead of the profile's own backend base URL.
   */
  async #resolveEnv(): Promise<NodeJS.ProcessEnv> {
    if (this.#profile.via === 'codex-bridge') {
      const { baseUrl, token } = await sharedCodexBridge.start();
      return {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: token,
      };
    }
    if (this.#profile.via === 'router') {
      await sharedRouterManager.ensureRunning([this.#profile]);
      return {
        ANTHROPIC_BASE_URL: sharedRouterManager.baseUrl,
        ANTHROPIC_AUTH_TOKEN: this.#profile.authToken || 'local',
      };
    }
    if (!this.#profile.baseUrl) return {};
    return { ANTHROPIC_BASE_URL: this.#profile.baseUrl, ANTHROPIC_AUTH_TOKEN: this.#profile.authToken };
  }

  /**
   * Why a turn would not go through. The built-in provider's answer is its
   * own login; a profile's is whatever it is still missing, because telling
   * someone to run `/login` when their GLM key is blank sends them nowhere.
   */
  #unauthenticatedDetail(): string {
    if (this.#profile.id === 'claude') {
      return 'Claude Code is installed but not logged in. Run claude and complete /login.';
    }
    if (this.#profile.via === 'codex-bridge') {
      return 'No ChatGPT session yet, or it expired. Run `codex login` once.';
    }
    if (!this.#profile.authToken) return 'No API key set for this provider yet.';
    return 'The endpoint rejected the key. Check it is valid and has quota.';
  }

  async models() {
    const binary = this.#resolve();
    if (!binary) throw new Error('The claude CLI is not installed.');
    return discoverModels('claude', binary, await this.#resolveEnv());
  }

  async status(): Promise<ProviderStatus> {
    const binary = this.#resolve();
    if (!binary) {
      return this.#unavailable(
        'claude',
        'The claude CLI is not on PATH. Install Claude Code, then run it once to log in.',
      );
    }

    const version = await runCapture(binary, ['--version'], VERSION_PROBE_TIMEOUT_MS);
    if (version.code !== 0) {
      return this.#unavailable(binary.path, 'claude --version failed: ' + (version.stderr.trim() || 'unknown error'));
    }

    // Reporting a provider as unusable is this method's job, so a backend that
    // cannot be reached at all - an unstarted proxy, a router that will not
    // come up - is an answer here, never an exception. Throwing would take the
    // whole provider list down with it, and with it the settings page and the
    // model picker.
    let env: NodeJS.ProcessEnv;
    try {
      env = await this.#resolveEnv();
    } catch (error) {
      return this.#unavailable(binary.path, (error as Error).message);
    }

    // A one-token print turn is the only reliable proof that the login is live;
    // --version succeeds even when logged out.
    const probe = await runCapture(
      binary,
      ['-p', 'ok', '--output-format', 'json', '--restricted', '--permission-mode', 'dontAsk'],
      AUTH_PROBE_TIMEOUT_MS,
      env,
    );
    const authenticated = probe.code === 0;

    return {
      id: this.id,
      displayName: this.displayName,
      available: true,
      binary: binary.path,
      version: version.stdout.trim().split('\n')[0],
      authenticated,
      detail: authenticated ? undefined : this.#unauthenticatedDetail(),
    };
  }

  #unavailable(binary: string, detail: string): ProviderStatus {
    return {
      id: this.id,
      displayName: this.displayName,
      available: false,
      binary,
      authenticated: false,
      detail,
    };
  }

  /**
   * The command line and environment of one Claude Code process, shared by a
   * print run, a terminal run and a conversation terminal. With `files` it is
   * a terminal: the print-mode flags are left out and the Stop hook the
   * terminal modes read is added.
   */
  async #commandLine(options: ProviderTurnOptions, files?: TerminalFiles): Promise<CommandLine> {
    // Pinned up front so the caller can resume even if the turn is cut short,
    // and so a terminal knows which transcript file is its own. An
    // interactive `--resume` keeps writing to that same session.
    const pinnedSessionId = options.providerSessionId ?? randomUUID();
    const model = options.model ?? this.#profile.defaultModel;

    const args = [
      ...(files ? [] : PRINT_MODE_ARGS),
      ...sessionArgs(options, pinnedSessionId, model),
      ...permissionArgs(options.permission ?? 'read'),
      // Rookery is the whole environment: no user or project settings, and no
      // MCP servers except the one Rookery hands over for this turn. The
      // working directory's own CLAUDE.md is still read, which is why the
      // workspace carries one of Rookery's own.
      '--setting-sources', '',
      ...mcpArgs(options),
    ];

    // Three further channels of their own, all paths, all unaffected by the
    // empty `--setting-sources` above - which is exactly why they are usable:
    // Rookery keeps composing the environment, and what a person approved out
    // of the Claude Code installation travels here rather than by letting
    // that installation's own settings back in.
    //
    // Everything foreign travels as a file, never as argv. On Windows a shim
    // spawn goes through `cmd.exe` in verbatim mode, where a quote inside a
    // JSON argument cannot be escaped in any way both sides agree on, so text
    // a plugin wrote would be able to break out of its argument and run as a
    // command of its own. `--settings` takes a path by contract; approved
    // agents and hooks are laid down as a generated plugin folder that
    // `--plugin-dir` loads. Both also keep the command line well clear of the
    // 8191 characters `cmd.exe` allows.
    //
    // `--settings` carries Rookery's own `permissions.deny` floor even when
    // nobody approved a single hook, so a `full` turn finally has limits
    // between it and `--dangerously-skip-permissions`.
    const handoff = await writeHandoffDir({ ...options, settings: composeSettings(options, files) });
    try {
      if (handoff.settingsFile) args.push('--settings', handoff.settingsFile);
      // A plugin trusted outright comes in whole, folder and all; the curated
      // skills, agents and hooks of that same source are left out upstream.
      for (const dir of [...(options.pluginDirs ?? []), ...(handoff.dir ? [handoff.dir] : [])]) {
        args.push('--plugin-dir', dir);
      }
      return { args, env: await this.#commandEnv(options, model), model, pinnedSessionId, handoff };
    } catch (error) {
      handoff.cleanup();
      throw error;
    }
  }

  async #commandEnv(options: ProviderTurnOptions, model: string | undefined): Promise<NodeJS.ProcessEnv> {
    const contextWindow = providerContextWindow(this.#profile, model);
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CODE_ENTRYPOINT: 'rookery',
      MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS),
      MCP_TIMEOUT: String(MCP_STARTUP_TIMEOUT_MS),
      ...(await this.#resolveEnv()),
      ...(contextWindow ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindow) } : {}),
    };
    if (options.gateway) {
      // One endpoint for every model. No credential of our own: Claude Code
      // then keeps sending the person's Claude login, which the gateway
      // passes on for Claude models; its own token rides in a header.
      env.ANTHROPIC_BASE_URL = options.gateway.baseUrl;
      delete env.ANTHROPIC_AUTH_TOKEN;
      delete env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
      env.ANTHROPIC_CUSTOM_HEADERS = BRIDGE_TOKEN_HEADER + ': ' + options.gateway.token;
    }
    return env;
  }

  /** A terminal's command line; its files are removed again when the command line cannot be built. */
  async #terminalCommandLine(
    options: ProviderTurnOptions,
    files: TerminalFiles,
  ): Promise<CommandLine & { files: TerminalFiles }> {
    try {
      return { ...(await this.#commandLine(options, files)), files };
    } catch (error) {
      removeQuietly(files.dir);
      throw error;
    }
  }

  /**
   * A conversation in Claude Code's own terminal (see `startConversationTerminal`).
   * The same command line a turn of that conversation would get, minus the
   * prompt: the person types into the terminal instead.
   */
  async openTerminal(
    options: ProviderTurnOptions,
    handlers: ProviderTerminalHandlers,
  ): Promise<{ providerSessionId: string; terminal: ConversationTerminalHandle }> {
    const binary = this.#resolve();
    if (!binary) throw new Error('The claude CLI is not on PATH.');
    if (!options.tui) throw new Error('A terminal needs a key.');
    if (!(await loadPty())) throw new Error('Terminal support is not available on this system.');

    const { args, env, pinnedSessionId, handoff, files } = await this.#terminalCommandLine(
      options,
      await createConversationFiles(),
    );
    const cleanup = releaseTerminalFiles(handoff, files.dir);
    let terminal: ConversationTerminalHandle;
    try {
      terminal = await startConversationTerminal(
        {
          key: options.tui.key,
          binary,
          args,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          env,
          sessionId: pinnedSessionId,
          workDir: files.dir,
          markerFile: files.markerFile,
          mapEntry: transcriptMapper(),
          cleanup,
        },
        Boolean(options.providerSessionId),
        handlers,
      );
    } catch (error) {
      cleanup();
      throw error;
    }
    return { providerSessionId: pinnedSessionId, terminal };
  }

  async *run(options: ProviderTurnOptions): AsyncGenerator<AgentEvent, void, unknown> {
    const binary = this.#resolve();
    if (!binary) {
      yield { type: 'error', message: 'The claude CLI is not on PATH.', fatal: true };
      return;
    }

    // A terminal run is the same command line minus the print-mode flags:
    // the TUI paints for a person, the transcript and a Stop hook tell
    // Rookery what happened (see claude-tui.ts). Without the pty binding it
    // quietly stays a print run.
    const tui = options.tui && (await loadPty()) ? options.tui : undefined;
    if (tui) yield* this.#runTerminal(binary, options, tui);
    else yield* this.#runPrint(binary, options);
  }

  async *#runTerminal(
    binary: ResolvedBinary,
    options: ProviderTurnOptions,
    tui: NonNullable<ProviderTurnOptions['tui']>,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const { args, env, model, pinnedSessionId, handoff, files } = await this.#terminalCommandLine(
      options,
      await createTerminalFiles(),
    );
    yield {
      type: 'session',
      sessionId: pinnedSessionId,
      providerSessionId: pinnedSessionId,
      provider: this.id,
      ...(model ? { model } : {}),
    };
    // The terminal outlives this generator, so its files do too: they go
    // when the process exits, not when the work is reported done.
    const cleanup = releaseTerminalFiles(handoff, files.dir);
    let failed = false;
    try {
      yield* runTui({
        key: tui.key,
        binary,
        args,
        prompt: options.prompt,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env,
        ...(options.signal ? { signal: options.signal } : {}),
        sessionId: pinnedSessionId,
        workDir: files.dir,
        markerFile: files.markerFile,
        mapEntry: transcriptMapper(),
        cleanup,
        ...(tui.lingerMs !== undefined ? { lingerMs: tui.lingerMs } : {}),
        ...(tui.onLateEvent ? { onLateEvent: tui.onLateEvent } : {}),
      });
    } catch (error) {
      failed = true;
      cleanup();
      yield { type: 'error', message: (error as Error).message, fatal: true };
    } finally {
      // Walked away from before the terminal existed: nobody else will
      // ever remove these folders. Once it exists, its exit does.
      if (!failed && tuiSessions.info(tui.key)?.providerSessionId !== pinnedSessionId) cleanup();
    }
  }

  async *#runPrint(binary: ResolvedBinary, options: ProviderTurnOptions): AsyncGenerator<AgentEvent, void, unknown> {
    const { args, env, handoff } = await this.#commandLine(options);
    const handle = spawnCli(binary, {
      args,
      cwd: options.cwd,
      // The prompt travels over stdin so a long turn never hits the OS argv limit.
      stdin: options.prompt,
      signal: options.signal,
      env,
    });
    const stream = new PrintTurnStream(this.id);

    try {
      for await (const event of readJsonLines(handle.child.stdout)) yield* stream.map(event);
      const { code, stderr } = await handle.done;
      yield* stream.finish(code, stderr);
    } catch (error) {
      yield { type: 'error', message: (error as Error).message, fatal: true };
    } finally {
      reap(handle);
      handoff.cleanup();
    }
  }
}

/**
 * Stops a process the consumer walked away from, and observes its exit so a
 * late spawn error cannot surface as an unhandled rejection. Does nothing to
 * a process that already finished.
 */
function reap(handle: SpawnHandle): void {
  handle.child.kill();
  void handle.done.catch(() => {});
}

/** Session, model, effort and system prompt: what identifies and steers the conversation. */
function sessionArgs(options: ProviderTurnOptions, pinnedSessionId: string, model: string | undefined): string[] {
  const args = options.providerSessionId
    ? ['--resume', options.providerSessionId]
    : ['--session-id', pinnedSessionId];
  if (model) args.push('--model', model);
  if (options.effort) args.push('--effort', options.effort);
  if (options.systemPrompt) {
    // The assistant replaces Claude Code's own coding-agent prompt so it is
    // a person rather than a tool; agents keep it because they work in code.
    args.push(
      options.systemPromptMode === 'replace' ? '--system-prompt' : '--append-system-prompt',
      options.systemPrompt,
    );
  }
  return args;
}

function mcpArgs(options: ProviderTurnOptions): string[] {
  const servers = [...(options.mcp ? [options.mcp] : []), ...(options.mcpExtra ?? [])];
  if (!servers.length) return [];
  return [
    '--mcp-config', JSON.stringify(mcpConfig(servers)),
    '--strict-mcp-config',
    '--allowedTools', servers.map((server) => 'mcp__' + server.name).join(','),
  ];
}

/**
 * Rookery's settings for the turn. A terminal run adds its Stop hook to the
 * same settings file - the hook is how it learns that the agent is done - and
 * a conversation terminal also takes per-message context, the recall and the
 * fresh company block, through its prompt hook (T2).
 */
function composeSettings(options: ProviderTurnOptions, files?: TerminalFiles): ProviderTurnOptions['settings'] {
  let settings = options.settings;
  if (files) {
    settings = withHook(settings, 'Stop', stopHookCommand(files.markerFile));
    if (files.contextFile) {
      settings = withHook(settings, 'UserPromptSubmit', promptContextHookCommand(files.contextFile));
    }
  }
  if (options.gateway?.picker.length) {
    // The TUI's `/model` menu: Claude's own entries stay, the gateway's
    // other models are appended. `--settings` is one of the sources this
    // key is read from even with every settings file switched off.
    settings = {
      ...(settings ?? {}),
      modelPicker: { options: options.gateway.picker, replaceBuiltInOptions: false },
    };
  }
  return settings;
}

async function createTerminalFiles(): Promise<TerminalFiles> {
  const dir = await mkdtemp(join(tmpdir(), 'rookery-tui-'));
  const markerFile = join(dir, 'stop.json');
  try {
    await writeFile(markerFile, '');
  } catch (error) {
    removeQuietly(dir);
    throw error;
  }
  return { dir, markerFile };
}

async function createConversationFiles(): Promise<TerminalFiles> {
  const files = await createTerminalFiles();
  const contextFile = contextFileFor(files.dir);
  try {
    await writeFile(contextFile, '');
  } catch (error) {
    removeQuietly(files.dir);
    throw error;
  }
  return { ...files, contextFile };
}

function releaseTerminalFiles(handoff: Handoff, dir: string): () => void {
  return () => {
    handoff.cleanup();
    removeQuietly(dir);
  };
}

/** Best effort: a leftover temp folder is untidy, not a failed turn. */
function removeQuietly(dir: string): void {
  void rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * The files one turn hands the CLI outside of argv. `cleanup` is wired into
 * the turn's `finally` and always exists, even when nothing was written.
 */
interface Handoff {
  dir?: string;
  settingsFile?: string;
  cleanup: () => void;
}

const HANDOFF_PLUGIN_JSON = JSON.stringify({
  name: 'rookery-handoff',
  version: '1.0.0',
  description: 'Subagents and hooks a person approved for this one Rookery turn.',
});

/**
 * Lay down what a person approved as plain files under one temp folder.
 *
 * The settings document holds only Rookery's own words, so it could safely be
 * inline; it goes to a file anyway, to keep the command line short. The agents
 * and hooks are copied verbatim from the files the approval named, which is
 * the whole point: their bytes are foreign, and foreign bytes never enter the
 * command line, where a Windows shim spawn cannot be trusted to keep them
 * inside one argument.
 *
 * A file that vanished or turned unreadable between approval and spawn is
 * left out, exactly as an approval that no longer matches should behave.
 */
async function writeHandoffDir(options: ProviderTurnOptions): Promise<Handoff> {
  const agents = options.handoffAgents ?? [];
  const hooks =
    options.hooks && Object.keys(options.hooks).length ? (options.hooks as Record<string, unknown[]>) : undefined;
  const wantsSettings = Boolean(options.settings && Object.keys(options.settings).length);

  if (!agents.length && !hooks && !wantsSettings) return { cleanup: () => {} };

  const root = await mkdtemp(join(tmpdir(), 'rookery-handoff-'));
  const cleanup = (): void => removeQuietly(root);

  try {
    const dir = agents.length || hooks ? await writeHandoffPlugin(join(root, 'plugin'), agents, hooks) : undefined;

    let settingsFile: string | undefined;
    if (wantsSettings && options.settings) {
      settingsFile = join(root, 'settings.json');
      await writeFile(settingsFile, JSON.stringify(options.settings));
    }

    return { dir, settingsFile, cleanup };
  } catch {
    cleanup();
    throw new Error('The approved hand-off files could not be written.');
  }
}

async function writeHandoffPlugin(
  dir: string,
  agents: NonNullable<ProviderTurnOptions['handoffAgents']>,
  hooks: Record<string, unknown[]> | undefined,
): Promise<string> {
  await mkdir(join(dir, 'agents'), { recursive: true });
  await mkdir(join(dir, 'hooks'), { recursive: true });
  await writeFile(join(dir, 'plugin.json'), HANDOFF_PLUGIN_JSON);
  for (const agent of agents) {
    // A name that slipped past discovery's own check must not write the
    // plugin somewhere it was never meant to go.
    if (!HANDOFF_AGENT_NAME.test(agent.name)) continue;
    await copyFile(agent.path, join(dir, 'agents', agent.name + '.md')).catch(() => {});
  }
  if (hooks) await writeFile(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks }));
  return dir;
}

/**
 * The `--mcp-config` document for the turn's servers, paths in forward
 * slashes. A hosted endpoint - what a plugin like `context7` declares - is
 * written the way Claude Code's own `.mcp.json` writes it.
 */
export function mcpConfig(servers: McpServerSpec[]): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {};
  for (const mcp of servers) {
    mcpServers[mcp.name] =
      mcp.transport === 'http' || mcp.transport === 'sse'
        ? {
            type: mcp.transport,
            url: mcp.url,
            ...(Object.keys(mcp.headers ?? {}).length ? { headers: mcp.headers } : {}),
          }
        : {
            command: (mcp.command ?? '').replace(/\\/g, '/'),
            args: mcp.args.map((arg) => arg.replace(/\\/g, '/')),
            env: mcp.env,
          };
  }
  return { mcpServers };
}

/** Rookery's settings for the turn, with one more handler appended for `event`. */
function withHook(
  settings: ProviderTurnOptions['settings'],
  event: 'Stop' | 'UserPromptSubmit',
  command: string,
): NonNullable<ProviderTurnOptions['settings']> {
  const base = settings ?? {};
  const hooks = (base.hooks && typeof base.hooks === 'object' ? base.hooks : {}) as Record<string, unknown[]>;
  const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
  return {
    ...base,
    hooks: { ...hooks, [event]: [...existing, { hooks: [{ type: 'command', command }] }] },
  };
}

/**
 * Tool events with the real tool name on the `end` side (concept S28). The
 * CLI names the tool only on the `tool_use` block; its `tool_result`
 * counterpart carries the id alone, and a divergence judge cannot compare
 * names it never saw - so the name is remembered by tool-use id.
 */
class ToolEvents {
  readonly #names = new Map<string, string>();

  start(block: Record<string, unknown>): AgentEvent {
    const name = String(block.name ?? 'tool');
    const id = block.id as string | undefined;
    if (id) this.#names.set(id, name);
    return {
      type: 'tool',
      name,
      status: 'start',
      id,
      detail: summariseInput(block.input),
      ...recordedInput(block.input),
    };
  }

  end(block: Record<string, unknown>): AgentEvent {
    const id = block.tool_use_id as string | undefined;
    const name = (id !== undefined ? this.#names.get(id) : undefined) ?? 'tool';
    if (id !== undefined) this.#names.delete(id);
    return {
      type: 'tool',
      name,
      status: 'end',
      id,
      result:
        typeof block.content === 'string'
          ? block.content.slice(0, TOOL_RESULT_LIMIT)
          : JSON.stringify(block.content)?.slice(0, TOOL_RESULT_LIMIT),
      isError: block.is_error === true,
    };
  }
}

/** Translates the lines of one `claude -p --output-format stream-json` run into agent events. */
class PrintTurnStream {
  readonly #provider: string;
  readonly #tools = new ToolEvents();
  readonly #startedAt = Date.now();
  #sessionId: string | undefined;
  #accumulated = '';
  #emittedDone = false;
  /** Context size of the latest request: prompt cache plus fresh input. */
  #contextTokens: number | undefined;

  constructor(provider: string) {
    this.#provider = provider;
  }

  map(event: Record<string, unknown>): AgentEvent[] {
    switch (event.type) {
      case 'rate_limit_event':
        return this.#rateLimit(event);
      case 'system':
        return event.subtype === 'init' ? this.#init(event) : [];
      case 'stream_event':
        return this.#partial(event);
      case 'assistant':
        return this.#assistant(event);
      case 'user':
        return this.#toolResults(event);
      case 'result':
        return this.#result(event);
      default:
        return [];
    }
  }

  /** What the run still owes once stdout is closed and the process has exited. */
  finish(code: number | null, stderr: string): AgentEvent[] {
    if (this.#emittedDone) return [];
    if (code !== 0) {
      return [
        {
          type: 'error',
          message: 'Claude Code exited with code ' + code + '. ' + stderr.trim().slice(-EXIT_STDERR_TAIL_CHARS),
          fatal: true,
        },
      ];
    }
    return [{ type: 'done', text: this.#accumulated, providerSessionId: this.#sessionId }];
  }

  /**
   * The CLI reports the account's windows with every turn; the same numbers
   * its /usage panel shows, without another request.
   */
  #rateLimit(event: Record<string, unknown>): AgentEvent[] {
    const info = asRecordOf(event.rate_limit_info);
    const windows = parseClaudeWindows(info?.unifiedWindows, true);
    if (!windows.length) return [];
    const quota: ProviderQuota = { provider: this.#provider, windows, fetchedAt: Date.now() };
    rememberQuota(quota);
    return [{ type: 'quota', quota }];
  }

  #init(event: Record<string, unknown>): AgentEvent[] {
    this.#sessionId = event.session_id as string;
    return [
      {
        type: 'session',
        sessionId: this.#sessionId ?? '',
        providerSessionId: this.#sessionId,
        provider: this.#provider,
        model: event.model as string | undefined,
      },
    ];
  }

  #partial(event: Record<string, unknown>): AgentEvent[] {
    const inner = event.event as Record<string, unknown> | undefined;
    if (inner?.type !== 'content_block_delta') return [];
    const delta = inner.delta as Record<string, unknown> | undefined;
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      this.#accumulated += delta.text;
      return [{ type: 'text', delta: delta.text }];
    }
    if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      return [{ type: 'thinking', delta: delta.thinking }];
    }
    return [];
  }

  /** Tool calls only; the text already arrived as partial deltas. */
  #assistant(event: Record<string, unknown>): AgentEvent[] {
    const message = event.message as Record<string, unknown> | undefined;
    this.#contextTokens = contextSize(message?.usage) ?? this.#contextTokens;
    return asArray(message?.content)
      .filter((block) => block.type === 'tool_use')
      .map((block) => this.#tools.start(block));
  }

  #toolResults(event: Record<string, unknown>): AgentEvent[] {
    const message = event.message as Record<string, unknown> | undefined;
    return asArray(message?.content)
      .filter((block) => block.type === 'tool_result')
      .map((block) => this.#tools.end(block));
  }

  #result(event: Record<string, unknown>): AgentEvent[] {
    const text = typeof event.result === 'string' ? event.result : this.#accumulated;
    // An errored result is not a finished turn: the error ends it, and a
    // done on top would make callers store the error text as the answer.
    if (event.is_error) return [{ type: 'error', message: text || 'Claude Code reported an error.', fatal: true }];
    this.#emittedDone = true;
    return [
      {
        type: 'done',
        text,
        providerSessionId: (event.session_id as string) ?? this.#sessionId,
        usage: mapUsage(event, this.#startedAt, this.#contextTokens),
      },
    ];
  }
}

/**
 * Transcript entries to the events a print run streams. The transcript holds
 * whole content blocks rather than deltas, so each text block arrives as one
 * `text` event; blocks after the first get a paragraph break in front, where
 * the stream would have started a new message.
 */
function transcriptMapper(): (entry: Record<string, unknown>) => AgentEvent[] {
  const tools = new ToolEvents();
  let hadText = false;

  const assistantEvents = (block: Record<string, unknown>): AgentEvent[] => {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      const delta = (hadText ? '\n\n' : '') + block.text;
      hadText = true;
      return [{ type: 'text', delta }];
    }
    if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
      return [{ type: 'thinking', delta: block.thinking }];
    }
    if (block.type === 'tool_use') return [tools.start(block)];
    return [];
  };

  return (entry) => {
    const message = entry.message as Record<string, unknown> | undefined;
    const blocks = asArray(message?.content);
    if (entry.type === 'assistant') return blocks.flatMap(assistantEvents);
    if (entry.type === 'user') {
      return blocks.filter((block) => block.type === 'tool_result').map((block) => tools.end(block));
    }
    return [];
  };
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/** One short line describing a tool call, for the activity feed. */
function summariseInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const candidate =
    record.file_path ?? record.command ?? record.pattern ?? record.query ?? record.path;
  if (typeof candidate !== 'string') return JSON.stringify(input).slice(0, TOOL_INPUT_DETAIL_LIMIT);
  const ellipsis = '...';
  return candidate.length > TOOL_DETAIL_LIMIT
    ? candidate.slice(0, TOOL_DETAIL_LIMIT - ellipsis.length) + ellipsis
    : candidate;
}

/**
 * The recorder half of Phase 6's precondition (concept S28).
 *
 * `summariseInput` above picks one of five keys and cuts it at 120
 * characters, so an `Edit(file_path, old_string, new_string)` is journalled
 * as a path alone - one cannot detect a divergence on arguments one never
 * recorded. This pair is the fix, and it is additive: `detail` stays exactly
 * what it was, because the activity feed renders off it.
 *
 * `argsHash` covers the whole canonical JSON even when `input` is truncated,
 * and both come from `memory/dream/trajectory.ts` rather than from a copy
 * here: the judge keys its observations on that same hash, and two
 * implementations that drifted apart would make every episode look as if it
 * diverged at step 0.
 */
function recordedInput(input: unknown): { argsHash?: string; input?: string } {
  if (input === undefined || input === null) return {};
  const canonical = canonicalJson(input);
  return {
    argsHash: hashCanonicalJson(canonical),
    input: canonical.length > TOOL_INPUT_LIMIT ? canonical.slice(0, TOOL_INPUT_LIMIT) : canonical,
  };
}

function mapUsage(
  event: Record<string, unknown>,
  started: number,
  contextTokens: number | undefined,
): TurnUsage {
  const usage = (event.usage ?? {}) as Record<string, unknown>;
  // `modelUsage` is keyed by model id; the largest window wins when a turn
  // touched several (a subagent on Haiku next to the main model).
  const windows = Object.values(asRecordOf(event.modelUsage) ?? {})
    .map((entry) => numberOr(asRecordOf(entry)?.contextWindow))
    .filter((value): value is number => value !== undefined);
  const contextWindow = windows.length ? Math.max(...windows) : undefined;
  return {
    inputTokens: numberOr(usage.input_tokens),
    outputTokens: numberOr(usage.output_tokens),
    cachedInputTokens: numberOr(usage.cache_read_input_tokens),
    costUsd: numberOr(event.total_cost_usd),
    durationMs: numberOr(event.duration_ms) ?? Date.now() - started,
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

/**
 * What one request put in front of the model: fresh input plus everything
 * served from or written to the prompt cache. That sum is the context size.
 */
function contextSize(usage: unknown): number | undefined {
  const record = asRecordOf(usage);
  if (!record) return undefined;
  const parts = [record.input_tokens, record.cache_read_input_tokens, record.cache_creation_input_tokens]
    .map(numberOr)
    .filter((value): value is number => value !== undefined);
  return parts.length ? parts.reduce((sum, value) => sum + value, 0) : undefined;
}

function asRecordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
