import type { AgentEvent, Message, TurnUsage } from '../types.js';
import { TurnBlocks } from '../util/blocks.js';

export type ToolEvent = Extract<AgentEvent, { type: 'tool' }>;
export type RecallEvent = Extract<AgentEvent, { type: 'memory' }>;

/** Add up what two passes of one turn cost; the last pass owns the context gauge. */
export function mergeUsage(base: TurnUsage | undefined, next: TurnUsage | undefined): TurnUsage | undefined {
  if (!base) return next;
  if (!next) return base;
  const sum = (a?: number, b?: number): number | undefined => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
  return {
    inputTokens: sum(base.inputTokens, next.inputTokens),
    outputTokens: sum(base.outputTokens, next.outputTokens),
    cachedInputTokens: sum(base.cachedInputTokens, next.cachedInputTokens),
    reasoningTokens: sum(base.reasoningTokens, next.reasoningTokens),
    costUsd: sum(base.costUsd, next.costUsd),
    contextTokens: next.contextTokens ?? base.contextTokens,
    contextWindow: next.contextWindow ?? base.contextWindow,
  };
}

/**
 * What one turn produced, in the three shapes it is stored in: the answer
 * text, the flat list of tool calls, and the ordered transcript of text,
 * thinking and tools in arrival order. One instance spans every pass of
 * every attempt of a turn; a provider fallback is the only reset.
 */
export class TurnTranscript {
  readonly toolCalls: ToolEvent[] = [];
  readonly #blocks = new TurnBlocks();
  #answer = '';
  #usage: TurnUsage | undefined;

  /**
   * `recall` is what was put in front of the answer: first in the transcript
   * because it was first in the turn, and it survives `restart()`, so a
   * fallback attempt keeps it too.
   */
  constructor(recall?: RecallEvent) {
    if (recall) this.#blocks.apply(recall);
  }

  get answer(): string {
    return this.#answer;
  }

  get usage(): TurnUsage | undefined {
    return this.#usage;
  }

  /** Whether anything usable came back: a dead attempt has neither text nor tool calls. */
  get hasOutput(): boolean {
    return Boolean(this.#answer) || this.toolCalls.length > 0;
  }

  /** Fold one streaming event into the tool list and the ordered transcript. */
  record(event: AgentEvent): void {
    if (event.type === 'tool') this.toolCalls.push(event);
    this.#blocks.apply(event);
  }

  /** The provider's final text of a pass, offered as a correction of the deltas. */
  reconcile(doneText: string): void {
    this.#blocks.reconcile(doneText);
  }

  /** Join another pass's answer to the answer so far. */
  appendAnswer(text: string): void {
    this.#answer = this.#answer && text ? this.#answer + '\n\n' + text : this.#answer || text;
  }

  addUsage(next: TurnUsage | undefined): void {
    this.#usage = mergeUsage(this.#usage, next);
  }

  /**
   * The dead attempt of a provider switch belongs to no transcript; the next
   * one starts clean rather than appending to a half-told story.
   */
  restart(): void {
    this.#blocks.clear();
  }

  /** The three stored views of the turn, for `addMessage`. */
  storedViews(): Pick<Message, 'content' | 'toolCalls' | 'blocks'> {
    return {
      content: this.#answer,
      toolCalls: this.toolCalls,
      blocks: this.#blocks.blocks.length ? this.#blocks.blocks : undefined,
    };
  }
}
