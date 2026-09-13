import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  McpServerSpec,
  PermissionLevel,
  Provider,
  ProviderQuota,
  ProviderStatus,
  ProviderTurnOptions,
  TurnUsage,
} from '../types.js';
import { readJsonLines, resolveBinary, runCapture, spawnCli, type ResolvedBinary } from './process.js';
import { discoverModels } from './catalogue.js';
import { parseClaudeWindows, rememberQuota } from './quota.js';

/**
 * Claude Code adapter.
 *
 * Runs `claude -p --output-format stream-json`, which authenticates with the
 * user's existing Claude Code login (subscription or console session). We
 * never read or set ANTHROPIC_API_KEY, and we never pass --bare, because that
 * flag deliberately forces API-key auth instead of the OAuth session.
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

export class ClaudeCodeProvider implements Provider {
  readonly id = 'claude' as const;
  readonly displayName = 'Claude Code';

  #binary: ResolvedBinary | null | undefined;

  /** Cached PATH lookup; undefined means "not probed yet". */
  #resolve(): ResolvedBinary | null {
    if (this.#binary === undefined) this.#binary = resolveBinary('claude');
    return this.#binary;
  }

  async models() {
    const binary = this.#resolve();
    if (!binary) throw new Error('The claude CLI is not installed.');
    return discoverModels('claude', binary);
  }

  async status(): Promise<ProviderStatus> {
    const binary = this.#resolve();
    if (!binary) {
      return {
        id: this.id,
        available: false,
        binary: 'claude',
        authenticated: false,
        detail: 'The claude CLI is not on PATH. Install Claude Code, then run it once to log in.',
      };
    }

    const version = await runCapture(binary, ['--version'], 20000);
    if (version.code !== 0) {
      return {
        id: this.id,
        available: false,
        binary: binary.path,
        authenticated: false,
        detail: 'claude --version failed: ' + (version.stderr.trim() || 'unknown error'),
      };
    }

    // A one-token print turn is the only reliable proof that the login is live;
    // --version succeeds even when logged out.
    const probe = await runCapture(
      binary,
      ['-p', 'ok', '--output-format', 'json', '--restricted', '--permission-mode', 'dontAsk'],
      60000,
    );
    const authenticated = probe.code === 0;

    return {
      id: this.id,
      available: true,
      binary: binary.path,
      version: version.stdout.trim().split('\n')[0],
      authenticated,
      detail: authenticated
        ? undefined
        : 'Claude Code is installed but not logged in. Run claude and complete /login.',
    };
  }

  async *run(options: ProviderTurnOptions): AsyncGenerator<AgentEvent, void, unknown> {
    const binary = this.#resolve();
    if (!binary) {
      yield { type: 'error', message: 'The claude CLI is not on PATH.', fatal: true };
      return;
    }

    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

    if (options.providerSessionId) {
      args.push('--resume', options.providerSessionId);
    } else {
      // Pin the id up front so the caller can resume even if the turn is cut short.
      args.push('--session-id', randomUUID());
    }
    if (options.model) args.push('--model', options.model);
    if (options.effort) args.push('--effort', options.effort);
    if (options.systemPrompt) {
      // The assistant replaces Claude Code's own coding-agent prompt so it is
      // a person rather than a tool; agents keep it because they work in code.
      args.push(
        options.systemPromptMode === 'replace' ? '--system-prompt' : '--append-system-prompt',
        options.systemPrompt,
      );
    }
    args.push(...permissionArgs(options.permission ?? 'read'));

    // Rookery is the whole environment: no user or project settings, and no
    // MCP servers except the one Rookery hands over for this turn. The
    // working directory's own CLAUDE.md is still read, which is why the
    // workspace carries one of Rookery's own.
    args.push('--setting-sources', '');
    const servers = [...(options.mcp ? [options.mcp] : []), ...(options.mcpExtra ?? [])];
    if (servers.length) {
      args.push('--mcp-config', JSON.stringify(mcpConfig(servers)));
      args.push('--strict-mcp-config');
      args.push('--allowedTools', servers.map((server) => 'mcp__' + server.name).join(','));
    }

    const handle = spawnCli(binary, {
      args,
      cwd: options.cwd,
      // The prompt travels over stdin so a long turn never hits the OS argv limit.
      stdin: options.prompt,
      signal: options.signal,
      env: {
        CLAUDE_CODE_ENTRYPOINT: 'rookery',
        // An assignment can run for many minutes; the default tool timeout
        // would cut the assistant's `assign` call off long before that.
        MCP_TOOL_TIMEOUT: String(6 * 60 * 60 * 1000),
        MCP_TIMEOUT: String(60 * 1000),
      },
    });

    const started = Date.now();
    let sessionId: string | undefined;
    let accumulated = '';
    let emittedDone = false;
    /** Context size of the latest request: prompt cache plus fresh input. */
    let contextTokens: number | undefined;

    try {
      for await (const event of readJsonLines(handle.child.stdout)) {
        const type = event.type as string | undefined;

        if (type === 'rate_limit_event') {
          // The CLI reports the account's windows with every turn; the same
          // numbers its /usage panel shows, without another request.
          const info = asRecordOf(event.rate_limit_info);
          const windows = parseClaudeWindows(info?.unifiedWindows, true);
          if (windows.length) {
            const quota: ProviderQuota = { provider: this.id, windows, fetchedAt: Date.now() };
            rememberQuota(quota);
            yield { type: 'quota', quota };
          }
          continue;
        }

        if (type === 'system' && event.subtype === 'init') {
          sessionId = event.session_id as string;
          yield {
            type: 'session',
            sessionId: sessionId ?? '',
            providerSessionId: sessionId,
            provider: this.id,
            model: event.model as string | undefined,
          };
          continue;
        }

        if (type === 'stream_event') {
          const inner = event.event as Record<string, unknown> | undefined;
          if (inner?.type === 'content_block_delta') {
            const delta = inner.delta as Record<string, unknown> | undefined;
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
              accumulated += delta.text;
              yield { type: 'text', delta: delta.text };
            } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              yield { type: 'thinking', delta: delta.thinking };
            }
          }
          continue;
        }

        if (type === 'assistant') {
          // Tool calls only; the text already arrived as partial deltas.
          const message = event.message as Record<string, unknown> | undefined;
          contextTokens = contextSize(message?.usage) ?? contextTokens;
          for (const block of asArray(message?.content)) {
            if (block.type === 'tool_use') {
              yield {
                type: 'tool',
                name: String(block.name ?? 'tool'),
                status: 'start',
                id: block.id as string | undefined,
                detail: summariseInput(block.input),
              };
            }
          }
          continue;
        }

        if (type === 'user') {
          const message = event.message as Record<string, unknown> | undefined;
          for (const block of asArray(message?.content)) {
            if (block.type === 'tool_result') {
              yield {
                type: 'tool',
                name: 'tool',
                status: 'end',
                id: block.tool_use_id as string | undefined,
                result: typeof block.content === 'string' ? block.content.slice(0, 16000) : JSON.stringify(block.content)?.slice(0, 16000),
                isError: block.is_error === true,
              };
            }
          }
          continue;
        }

        if (type === 'result') {
          const text = typeof event.result === 'string' ? event.result : accumulated;
          if (event.is_error) {
            yield { type: 'error', message: text || 'Claude Code reported an error.', fatal: true };
          }
          emittedDone = true;
          yield {
            type: 'done',
            text,
            providerSessionId: (event.session_id as string) ?? sessionId,
            usage: mapUsage(event, started, contextTokens),
          };
        }
      }

      const { code, stderr } = await handle.done;
      if (!emittedDone) {
        if (code !== 0) {
          yield {
            type: 'error',
            message: 'Claude Code exited with code ' + code + '. ' + stderr.trim().slice(-600),
            fatal: true,
          };
        } else {
          yield { type: 'done', text: accumulated, providerSessionId: sessionId };
        }
      }
    } catch (error) {
      yield { type: 'error', message: (error as Error).message, fatal: true };
    }
  }
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

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/** One short line describing a tool call, for the activity feed. */
function summariseInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const candidate =
    record.file_path ?? record.command ?? record.pattern ?? record.query ?? record.path;
  if (typeof candidate !== 'string') return JSON.stringify(input).slice(0, 4000);
  return candidate.length > 120 ? candidate.slice(0, 117) + '...' : candidate;
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
