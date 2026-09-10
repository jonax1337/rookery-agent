/**
 * One-shot chat.
 *
 * `runTurn` is the single place a turn is streamed to a terminal; the REPL
 * calls it too, so both paths render identically and abort identically.
 *
 * A turn has no working directory of its own any more: the assistant always
 * runs in the Rookery workspace, and a project only says which directory the
 * agents it delegates to will work in.
 */

import { Assistant } from '@rookery/core';
import type { ChatInput } from '@rookery/core';
import { EventRenderer, shortId } from '../ui/render.js';
import { Spinner } from '../ui/spinner.js';
import { glyph, theme } from '../ui/theme.js';
import {
  parseEffort,
  parsePermission,
  parseProvider,
  resolveAgent,
  resolveProject,
  withAssistant,
} from './shared.js';

export interface TurnOptions {
  /** Emit raw AgentEvent JSON lines. */
  json?: boolean;
  /** Print only the final answer. */
  quiet?: boolean;
  /** Show thinking traces and tool completions. */
  verbose?: boolean;
  spinnerLabel?: string;
}

export interface TurnResult {
  text: string;
  sessionId?: string;
  /** The user interrupted this turn. */
  aborted: boolean;
  /** The turn ended in a fatal error. */
  failed: boolean;
}

/** Stream one assistant turn to the terminal. Never throws. */
export async function runTurn(
  assistant: Assistant,
  input: ChatInput,
  options: TurnOptions = {},
): Promise<TurnResult> {
  const decorated = !options.json && !options.quiet;
  const spinner = decorated ? new Spinner(options.spinnerLabel ?? 'thinking') : null;
  const renderer = new EventRenderer({
    json: options.json ?? false,
    quiet: options.quiet ?? false,
    verbose: options.verbose ?? false,
    spinner,
    agentSlug: (id) => assistant.store.org.getAgent(id)?.slug ?? shortId(id),
  });

  let sessionId: string | undefined;
  let failed = false;

  spinner?.start();
  try {
    for await (const event of assistant.chat(input)) {
      if (event.type === 'session') sessionId = event.sessionId;
      if (event.type === 'error') {
        // A killed provider reports its own death; the user already knows
        // they pressed Ctrl+C, so do not shout at them about it.
        if (input.signal?.aborted) continue;
        if (event.fatal) failed = true;
      }
      renderer.handle(event);
    }
  } catch (error) {
    if (!input.signal?.aborted) {
      failed = true;
      renderer.handle({ type: 'error', message: (error as Error).message, fatal: true });
    }
  } finally {
    spinner?.stop();
  }

  const aborted = Boolean(input.signal?.aborted);
  const text = renderer.finish();

  return { text, sessionId, aborted, failed: failed && !aborted };
}

export interface ChatCommandOptions {
  session?: string;
  provider?: string;
  model?: string;
  effort?: string;
  permission?: string;
  /** Project name or id this conversation is about. */
  project?: string;
  /**
   * Talk to one agent instead of the assistant. Only honoured for a new
   * conversation: a session resumed with `-s` keeps its own counterpart.
   */
  agent?: string;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  voice?: boolean;
}

/** `rookery chat <prompt...>` - run a single turn and exit. */
export async function chatCommand(
  promptParts: string[],
  options: ChatCommandOptions,
): Promise<number> {
  const text = promptParts.join(' ').trim();
  if (!text) throw new Error('Nothing to send. Pass a prompt, or run `rookery` for the REPL.');

  const controller = new AbortController();
  const onInterrupt = (): void => {
    controller.abort();
  };
  process.on('SIGINT', onInterrupt);

  try {
    return await withAssistant(async (assistant) => {
      const agent = options.agent ? resolveAgent(assistant, options.agent) : null;
      const input: ChatInput = {
        text,
        sessionId: options.session,
        provider: parseProvider(options.provider),
        model: options.model,
        effort: parseEffort(options.effort),
        permission: parsePermission(options.permission),
        projectId: resolveProject(assistant, options.project)?.id,
        agentId: agent?.id,
        voice: options.voice ?? false,
        signal: controller.signal,
      };

      const result = await runTurn(assistant, input, {
        json: options.json ?? false,
        quiet: options.quiet ?? false,
        verbose: options.verbose ?? false,
        // Whose desk the question landed on, while it is being answered.
        ...(agent ? { spinnerLabel: agent.slug + ' thinking' } : {}),
      });

      if (result.aborted) {
        if (!options.json && !options.quiet) {
          process.stderr.write(theme.dim(glyph.warn + ' interrupted') + '\n');
        }
        return 130;
      }
      if (result.failed) return 1;

      if (!options.json && !options.quiet && result.sessionId) {
        process.stderr.write(
          theme.dim(glyph.dot + ' session ' + result.sessionId.slice(0, 8)) + '\n',
        );
      }
      return 0;
    });
  } finally {
    process.off('SIGINT', onInterrupt);
  }
}
