/**
 * The Rookery REPL.
 *
 * Design notes that matter:
 *  - One turn is one AbortController. Ctrl+C during a turn cancels that turn
 *    and returns to the prompt; Ctrl+C at an idle prompt leaves cleanly.
 *  - Background memory extraction finishes after the turn, so its notice is
 *    buffered and printed just before the next prompt rather than on top of
 *    whatever the user is typing.
 *  - Voice is opt-in and isolated: a missing speech engine prints one dim
 *    line and the REPL carries on.
 *  - There is no working directory to set. The assistant runs in its own
 *    workspace; `/project` only says which project its agents work in.
 */

import { createInterface, type Interface } from 'node:readline/promises';
import { Assistant, loadConfig } from '@rookery/core';
import type { ChatInput, ProviderStatus, RookeryConfig } from '@rookery/core';
import { runTurn } from './commands/chat.js';
import { LineQueue } from './replInput.js';
import { printDim, printFailure, printLine } from './replOutput.js';
import { attachQuestionPrompt } from './replQuestions.js';
import { handleSlash } from './replSlash.js';
import { startingState } from './replState.js';
import type { ReplOptions, ReplState } from './replState.js';
import { providerHealth, shorten } from './ui/render.js';
import { SPEECH_ABORTED, speak, stopSpeaking } from './ui/speech.js';
import { glyph, isTty, theme } from './ui/theme.js';

/** How many lines of earlier input readline remembers for the up arrow. */
const PROMPT_HISTORY_SIZE = 250;
/** How much of a learned memory `/verbose` shows. */
const LEARNED_MEMORY_WIDTH = 88;

export async function startRepl(options: ReplOptions = {}): Promise<number> {
  const config = loadConfig();
  const assistant = new Assistant();
  const state = startingState(assistant, options, config);

  await new Repl(assistant, config, state).run();

  printDim('bye');
  return 0;
}

class Repl {
  readonly #assistant: Assistant;
  readonly #config: RookeryConfig;
  readonly #state: ReplState;
  readonly #input = new LineQueue();
  readonly #rl: Interface;
  /** Notices produced off the turn's critical path, shown before the next prompt. */
  readonly #notices: string[] = [];
  #activeTurn: AbortController | null = null;

  constructor(assistant: Assistant, config: RookeryConfig, state: ReplState) {
    this.#assistant = assistant;
    this.#config = config;
    this.#state = state;
    this.#rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY),
      history: [],
      historySize: PROMPT_HISTORY_SIZE,
      removeHistoryDuplicates: true,
    });
  }

  /** Read and answer lines until the user leaves or the input ends. */
  async run(): Promise<void> {
    this.#rl.on('line', (line: string) => this.#input.push(line));
    this.#rl.on('close', () => this.#input.close());
    this.#rl.on('SIGINT', this.#interrupt);
    process.on('SIGINT', this.#interrupt);

    this.#bufferMemoryNotices();
    attachQuestionPrompt(this.#assistant, this.#input);

    try {
      await printBanner(this.#assistant, this.#state);
      await this.#readEvalPrintLoop();
    } finally {
      process.off('SIGINT', this.#interrupt);
      stopSpeaking();
      this.#rl.close();
      this.#assistant.close();
    }
  }

  async #readEvalPrintLoop(): Promise<void> {
    while (!this.#input.leaving) {
      this.#flushNotices();
      this.#drawPrompt();

      const line = await this.#input.nextLine();
      if (line === null) return;

      const text = line.trim();
      if (!text) continue;

      if (!text.startsWith('/')) {
        await this.#say(text);
        continue;
      }
      if (await this.#runSlash(text)) return;
    }
  }

  /** Ctrl+C: cancel the turn in flight, or - at an idle prompt - leave. */
  readonly #interrupt = (): void => {
    if (this.#activeTurn) {
      // Killing the turn kills the question with it, so stop waiting for an
      // answer nobody needs any more.
      this.#input.cancelAnswer();
      this.#activeTurn.abort();
      stopSpeaking();
      return;
    }
    this.#input.leave();
    this.#rl.close();
  };

  #bufferMemoryNotices(): void {
    this.#assistant.on('memory', (event: { stored: { content: string }[] }) => {
      if (!event.stored.length) return;
      this.#notices.push(
        glyph.memory + ' learned ' + event.stored.length +
          (event.stored.length === 1 ? ' memory' : ' memories'),
      );
      if (!this.#state.verbose) return;
      for (const item of event.stored) {
        this.#notices.push('  ' + glyph.dot + ' ' + shorten(item.content, LEARNED_MEMORY_WIDTH));
      }
    });
  }

  #flushNotices(): void {
    for (const notice of this.#notices.splice(0)) printDim(notice);
  }

  #drawPrompt(): void {
    // Piped input reaches EOF before the first prompt is ever drawn; the
    // queued commands still run, they just do not get a prompt line.
    if (this.#input.closed) return;
    printLine();
    this.#rl.setPrompt(promptText(this.#state));
    this.#rl.prompt();
  }

  /** Run one `/command`; true when it asked to leave. */
  async #runSlash(text: string): Promise<boolean> {
    try {
      return await this.#withTurnSignal((signal) =>
        handleSlash(text, {
          assistant: this.#assistant,
          state: this.#state,
          signal,
          home: this.#config.home,
        }),
      );
    } catch (error) {
      printFailure(error);
      return false;
    }
  }

  /** Send `text` to whoever the conversation is with, and speak the reply when voice is on. */
  async #say(text: string): Promise<void> {
    const state = this.#state;
    await this.#withTurnSignal(async (signal) => {
      const result = await runTurn(this.#assistant, turnInput(state, text, signal), {
        verbose: state.verbose,
        ...(state.agentId ? { spinnerLabel: state.counterpart + ' thinking' } : {}),
      });

      if (result.sessionId) state.sessionId = result.sessionId;

      if (result.aborted) printDim(glyph.warn + ' interrupted');
      else if (state.voice && result.text.trim()) await this.#speakReply(result.text, signal);
    });
  }

  async #speakReply(text: string, signal: AbortSignal): Promise<void> {
    const { lang, rate, voiceName } = this.#config.voice;
    const spoken = await speak(text, { lang, rate, voiceName, signal });
    if (!spoken.ok && spoken.detail !== SPEECH_ABORTED) {
      printDim(glyph.warn + ' voice: ' + spoken.detail);
    }
  }

  /** Run `work` as the current turn, so that Ctrl+C has something to cancel. */
  async #withTurnSignal<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const turn = new AbortController();
    this.#activeTurn = turn;
    try {
      return await work(turn.signal);
    } finally {
      this.#activeTurn = null;
    }
  }
}

function turnInput(state: ReplState, text: string, signal: AbortSignal): ChatInput {
  return {
    text,
    sessionId: state.sessionId,
    provider: state.provider,
    model: state.model,
    effort: state.effort,
    permission: state.permission,
    projectId: state.projectId,
    agentId: state.agentId,
    voice: state.voice,
    signal,
  };
}

function promptText(state: ReplState): string {
  // Who you are talking to comes first: in a company chat that is the one
  // thing you must not lose track of.
  const bits: string[] = [state.counterpart, state.provider];
  if (state.projectName) bits.push(state.projectName);
  if (state.voice) bits.push('voice');
  // Single line on purpose: readline's cursor math breaks on multi-line prompts.
  return theme.accentBold(bits.join(glyph.dot) + ' ' + glyph.prompt + ' ');
}

async function printBanner(assistant: Assistant, state: ReplState): Promise<void> {
  printLine(
    '\n' + theme.accentBold('Rookery') +
      theme.dim((state.agentId ? '  with ' + state.counterpart : '') + '  via ' + state.provider),
  );

  const statuses = await assistant.providers.statuses();
  const isReady = (status: ProviderStatus): boolean => providerHealth(status) === 'ok';
  const ready = statuses.filter(isReady);
  if (!ready.length) {
    printLine(theme.red(glyph.fail + ' No provider is logged in - run `rookery doctor` for the fix.'));
  } else {
    const missing = statuses.filter((status) => !isReady(status));
    printDim(
      glyph.ok + ' ' + ready.map((status) => status.id).join(' + ') +
        (missing.length ? '  (' + missing.map((status) => status.id + ' offline').join(', ') + ')' : ''),
    );
  }
  printDim('/help for commands' + (isTty ? '  ·  Ctrl+C to interrupt or exit' : ''));
}
