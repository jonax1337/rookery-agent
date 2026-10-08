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
  EXIT_INTERRUPTED,
  agentSlugOf,
  parseEffort,
  parsePermission,
  parseProvider,
  printInterrupted,
  resolveAgent,
  resolveProject,
  withAssistant,
  withInterruptSignal,
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
  const renderer = new EventRenderer({
    json: options.json ?? false,
    quiet: options.quiet ?? false,
    verbose: options.verbose ?? false,
    spinner: decorated ? new Spinner(options.spinnerLabel ?? 'thinking') : null,
    agentSlug: agentSlugOf(assistant),
  });

  const { sessionId, failed } = await renderer.consume(assistant.chat(input), input.signal);

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

  return withInterruptSignal((signal) =>
    withAssistant(async (assistant) => {
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
        signal,
      };

      const result = await runTurn(assistant, input, {
        json: options.json ?? false,
        quiet: options.quiet ?? false,
        verbose: options.verbose ?? false,
        // Whose desk the question landed on, while it is being answered.
        ...(agent ? { spinnerLabel: agent.slug + ' thinking' } : {}),
      });

      const decorated = !options.json && !options.quiet;
      if (result.aborted) {
        if (decorated) printInterrupted();
        return EXIT_INTERRUPTED;
      }
      if (result.failed) return 1;

      if (decorated && result.sessionId) {
        process.stderr.write(
          theme.dim(glyph.dot + ' session ' + shortId(result.sessionId)) + '\n',
        );
      }
      return 0;
    }),
  );
}
