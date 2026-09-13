import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentEvent,
  EffortLevel,
  McpServerSpec,
  PermissionLevel,
  Provider,
  ProviderStatus,
  ProviderTurnOptions,
  TurnUsage,
} from '../types.js';
import { readJsonLines, resolveBinary, runCapture, spawnCli, type ResolvedBinary } from './process.js';
import { discoverModels } from './catalogue.js';

/**
 * Codex CLI adapter.
 *
 * Runs `codex exec --json`, which authenticates through the user's existing
 * `codex login` session (ChatGPT subscription). We never pass --with-api-key
 * and never read OPENAI_API_KEY.
 *
 * Codex has no --append-system-prompt equivalent, so the assembled Rookery
 * context is prepended to the prompt inside a clearly fenced block.
 */

/**
 * Codex keeps the model catalogue it fetched for the logged-in account in its
 * home directory. Reading it is the only way to offer names the account can
 * actually use: a ChatGPT login and an API key see different lists, and a
 * hard-coded table is stale within weeks.
 */
function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

interface CachedModel {
  slug: string;
  visibility?: string;
  priority?: number;
  context_window?: number;
  supported_reasoning_levels?: { effort?: string }[];
}

function readCatalogue(): CachedModel[] {
  try {
    const raw = JSON.parse(readFileSync(join(codexHome(), 'models_cache.json'), 'utf8')) as {
      models?: Partial<CachedModel>[];
    };
    return (raw.models ?? []).filter((model): model is CachedModel => typeof model.slug === 'string');
  } catch {
    return [];
  }
}

const EFFORT_LADDER: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The highest level at or below `effort` that the model accepts, according to
 * the catalogue. Codex rejects the turn outright otherwise, and "as much as
 * this model can" is what someone picking `max` meant.
 */
function clampEffort(effort: EffortLevel, model: string | undefined): EffortLevel {
  const entry = model ? readCatalogue().find((candidate) => candidate.slug === model) : undefined;
  const supported = entry?.supported_reasoning_levels?.map((level) => level.effort);
  if (!supported?.length || supported.includes(effort)) return effort;
  for (let index = EFFORT_LADDER.indexOf(effort); index >= 0; index -= 1) {
    const level = EFFORT_LADDER[index] as EffortLevel;
    if (supported.includes(level)) return level;
  }
  return effort;
}

/** The account's own default from config.toml, so the picker can name it. */
function configuredModel(): string | undefined {
  try {
    const match = /^\s*model\s*=\s*"([^"]+)"/m.exec(readFileSync(join(codexHome(), 'config.toml'), 'utf8'));
    return match?.[1];
  } catch {
    return undefined;
  }
}

/** Map the Rookery permission ladder onto Codex sandbox policies. */
function sandboxFor(level: PermissionLevel): string {
  switch (level) {
    case 'chat':
    case 'read':
      return 'read-only';
    case 'write':
      return 'workspace-write';
    case 'full':
      return 'danger-full-access';
  }
}

function composePrompt(prompt: string, systemPrompt?: string): string {
  if (!systemPrompt) return prompt;
  return (
    '<rookery-context>\n' +
    systemPrompt +
    '\n</rookery-context>\n\n' +
    'Answer the following as the assistant described above.\n\n' +
    prompt
  );
}

export class CodexProvider implements Provider {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex CLI';

  #binary: ResolvedBinary | null | undefined;

  #resolve(): ResolvedBinary | null {
    if (this.#binary === undefined) this.#binary = resolveBinary('codex');
    return this.#binary;
  }

  async models() {
    const binary = this.#resolve();
    if (!binary) throw new Error('The codex CLI is not installed.');
    const models = await discoverModels('codex', binary);
    const configured = configuredModel();
    return models.some((model) => model.id === configured)
      ? models.map((model) => ({ ...model, isDefault: model.id === configured }))
      : models;
  }

  async status(): Promise<ProviderStatus> {
    const binary = this.#resolve();
    if (!binary) {
      return {
        id: this.id,
        available: false,
        binary: 'codex',
        authenticated: false,
        detail: 'The codex CLI is not on PATH. Install it, then run: codex login',
      };
    }

    const version = await runCapture(binary, ['--version'], 20000);
    if (version.code !== 0) {
      return {
        id: this.id,
        available: false,
        binary: binary.path,
        authenticated: false,
        detail: 'codex --version failed: ' + (version.stderr.trim() || 'unknown error'),
      };
    }

    // `codex login status` prints how the session is authenticated, and exits
    // non-zero when there is none. Far cheaper than a probe turn.
    const login = await runCapture(binary, ['login', 'status'], 20000);
    const output = (login.stdout + login.stderr).trim();
    const authenticated = login.code === 0 && /logged in/i.test(output);

    return {
      id: this.id,
      available: true,
      binary: binary.path,
      version: version.stdout.trim().split('\n')[0],
      authenticated,
      detail: authenticated ? output.split('\n')[0] : 'Not logged in. Run: codex login',
    };
  }

  async *run(options: ProviderTurnOptions): AsyncGenerator<AgentEvent, void, unknown> {
    const binary = this.#resolve();
    if (!binary) {
      yield { type: 'error', message: 'The codex CLI is not on PATH.', fatal: true };
      return;
    }

    const args: string[] = ['exec'];
    if (options.providerSessionId) args.push('resume', options.providerSessionId);

    args.push('--json', '--skip-git-repo-check', '--color', 'never');
    args.push('-s', sandboxFor(options.permission ?? 'read'));
    if (options.model) args.push('-m', options.model);
    if (options.effort) {
      const effort = clampEffort(options.effort, options.model ?? configuredModel());
      if (effort !== options.effort) {
        yield {
          type: 'status',
          label: 'effort',
          detail: options.effort + ' is not offered by this model, using ' + effort,
        };
      }
      args.push('-c', 'model_reasoning_effort="' + effort + '"');
    }
    if (options.cwd) args.push('-C', options.cwd);
    if (options.mcp) args.push(...mcpArgs(options.mcp));
    for (const extra of options.mcpExtra ?? []) args.push(...mcpArgs(extra));
    // No prompt argument: Codex then reads the prompt from stdin. The older
    // explicit `-` is rejected by codex-cli 0.153 ("unexpected argument").

    const handle = spawnCli(binary, {
      args,
      cwd: options.cwd,
      stdin: composePrompt(options.prompt, options.systemPrompt),
      signal: options.signal,
    });

    const started = Date.now();
    let threadId: string | undefined = options.providerSessionId;
    let accumulated = '';
    let emittedDone = false;
    /** Text already streamed per item, so item.completed only emits the remainder. */
    const streamed = new Map<string, string>();

    try {
      for await (const event of readJsonLines(handle.child.stdout)) {
        const type = event.type as string | undefined;

        if (type === 'thread.started') {
          threadId = event.thread_id as string;
          yield {
            type: 'session',
            sessionId: threadId ?? '',
            providerSessionId: threadId,
            provider: this.id,
            model: options.model,
          };
          continue;
        }

        if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
          const item = event.item as Record<string, unknown> | undefined;
          if (!item) continue;
          const itemId = String(item.id ?? '');
          const itemType = item.type as string | undefined;

          if (itemType === 'agent_message') {
            const text = typeof item.text === 'string' ? item.text : '';
            // Codex may send the same item several times as it grows; only
            // forward what has not been streamed yet.
            const already = streamed.get(itemId) ?? '';
            if (text.length > already.length && text.startsWith(already)) {
              const delta = text.slice(already.length);
              streamed.set(itemId, text);
              accumulated += delta;
              yield { type: 'text', delta };
            } else if (text && text !== already) {
              streamed.set(itemId, text);
              accumulated += text;
              yield { type: 'text', delta: text };
            }
            continue;
          }

          if (itemType === 'reasoning') {
            const text = typeof item.text === 'string' ? item.text : '';
            const already = streamed.get(itemId) ?? '';
            if (text.length > already.length) {
              streamed.set(itemId, text);
              yield { type: 'thinking', delta: text.slice(already.length) };
            }
            continue;
          }

          if (itemType === 'command_execution') {
            yield {
              type: 'tool',
              name: 'shell',
              status: type === 'item.completed' ? 'end' : 'start',
              id: itemId,
              detail: typeof item.command === 'string' ? item.command.slice(0, 120) : undefined,
              result: type === 'item.completed' && typeof item.aggregated_output === 'string' ? item.aggregated_output.slice(0, 16000) : undefined,
              isError: type === 'item.completed' && typeof item.exit_code === 'number' && item.exit_code !== 0,
            };
            continue;
          }

          if (itemType === 'file_change') {
            yield {
              type: 'tool',
              name: 'edit',
              status: type === 'item.completed' ? 'end' : 'start',
              id: itemId,
              detail: typeof item.path === 'string' ? item.path : undefined,
              isError: item.status === 'failed',
            };
            continue;
          }

          if (itemType === 'mcp_tool_call' || itemType === 'web_search') {
            yield {
              type: 'tool',
              name: itemType === 'web_search' ? 'web_search' : String(item.tool ?? 'mcp'),
              status: type === 'item.completed' ? 'end' : 'start',
              id: itemId,
              detail: typeof item.query === 'string' ? item.query.slice(0, 120) : JSON.stringify(item.arguments)?.slice(0, 4000),
              result: type === 'item.completed' ? JSON.stringify(item.result ?? item.error)?.slice(0, 16000) : undefined,
              isError: item.status === 'failed' || Boolean(item.error),
            };
            continue;
          }

          if (itemType === 'error' && type === 'item.completed') {
            const message = typeof item.message === 'string' ? item.message : 'Codex error';
            // Codex reports non-fatal notices (context budget, skill trimming)
            // through the same channel, so surface them without killing the turn.
            yield { type: 'status', label: 'codex', detail: message };
          }
          continue;
        }

        if (type === 'turn.failed') {
          const error = event.error as Record<string, unknown> | undefined;
          yield {
            type: 'error',
            message: unwrapApiError(String(error?.message ?? 'Codex turn failed.')),
            fatal: true,
          };
          continue;
        }

        if (type === 'turn.completed') {
          emittedDone = true;
          yield {
            type: 'done',
            text: accumulated,
            providerSessionId: threadId,
            usage: mapUsage(event.usage, started, options.model ?? configuredModel()),
          };
        }
      }

      const { code, stderr } = await handle.done;
      if (!emittedDone) {
        if (code !== 0) {
          yield {
            type: 'error',
            message: 'Codex exited with code ' + code + '. ' + cleanStderr(stderr),
            fatal: true,
          };
        } else {
          yield { type: 'done', text: accumulated, providerSessionId: threadId };
        }
      }
    } catch (error) {
      yield { type: 'error', message: (error as Error).message, fatal: true };
    }
  }
}

/**
 * Rookery's MCP server as `-c` overrides. Values are parsed as TOML, so
 * strings are quoted and paths use forward slashes to stay out of escaping.
 */
export function mcpArgs(mcp: McpServerSpec): string[] {
  const key = 'mcp_servers.' + mcp.name;
  const toml = (value: string): string => JSON.stringify(value.replace(/\\/g, '/'));
  // Assignments run for minutes; the default tool timeout is far too short.
  const timeout = ['-c', key + '.tool_timeout_sec = 21600'];

  // A hosted endpoint. Codex speaks streamable HTTP itself (`codex mcp add
  // --url`), but it has no place for arbitrary headers - only a bearer token
  // from an environment variable - so a header a plugin declared is dropped
  // here rather than faked.
  if (mcp.transport === 'http' || mcp.transport === 'sse') {
    return ['-c', key + '.url = ' + JSON.stringify(mcp.url ?? ''), ...timeout];
  }

  const env = Object.entries(mcp.env)
    .map(([name, value]) => name + ' = ' + toml(value))
    .join(', ');
  return [
    '-c', key + '.command = ' + toml(mcp.command ?? ''),
    '-c', key + '.args = [' + mcp.args.map(toml).join(', ') + ']',
    '-c', key + '.env = {' + env + '}',
    ...timeout,
  ];
}

/**
 * A failed turn often carries the raw API error body as its message, e.g.
 * `{"type":"error","status":400,"error":{"message":"..."}}`. The sentence
 * inside is what a person can act on.
 */
function unwrapApiError(message: string): string {
  const trimmed = message.trim();
  if (!trimmed.startsWith('{')) return message;
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: string }; message?: string };
    return parsed.error?.message ?? parsed.message ?? message;
  } catch {
    return message;
  }
}

/** Codex logs MCP transport noise to stderr; keep only lines that look actionable. */
function cleanStderr(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => line.trim() && !/rmcp::transport|Reading additional input/.test(line))
    .join(' ')
    .trim()
    .slice(-600);
}

function mapUsage(raw: unknown, started: number, model: string | undefined): TurnUsage {
  const usage = (raw ?? {}) as Record<string, unknown>;
  const input = numberOr(usage.input_tokens);
  const cached = numberOr(usage.cached_input_tokens);
  // Codex reports totals per turn, not per request; for the usual one-shot
  // turn the input side is exactly what the model had in front of it.
  const contextTokens = input !== undefined ? input + (cached ?? 0) : undefined;
  const entry = model ? readCatalogue().find((candidate) => candidate.slug === model) : undefined;
  const contextWindow = entry?.context_window;
  return {
    inputTokens: input,
    outputTokens: numberOr(usage.output_tokens),
    cachedInputTokens: cached,
    reasoningTokens: numberOr(usage.reasoning_output_tokens),
    durationMs: Date.now() - started,
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
  };
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
