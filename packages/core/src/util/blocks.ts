import type { AgentEvent, MessageBlock } from '../types.js';
import { clip } from './queue.js';

/**
 * The same clip budget the Claude Code adapter puts on a tool result. Applied
 * here to block text, thinking and results alike: a transcript that survives
 * a reload is worth more than a verbatim one nobody can afford to store.
 */
const BLOCK_CLIP = 16000;

/**
 * Folds a turn's streaming events into the ordered transcript the original
 * Claude Code window shows: text, thinking and tool calls interleaved in the
 * order they actually arrived.
 *
 * One instance lives for the whole turn (all of its provider passes); the
 * runtime writes `blocks` out with the answer and keeps writing the flat
 * `content`/`toolCalls` view beside it. Pure - no clock, no I/O - so the CLI
 * shares it with the core runtime.
 */
export class TurnBlocks {
  #blocks: MessageBlock[] = [];
  /** Set by every `reconcile`: the pass ended, the next delta opens a block. */
  #sealed = false;

  /** The transcript so far, in arrival order. Live view; do not mutate. */
  get blocks(): MessageBlock[] {
    return this.#blocks;
  }

  /** Forget everything - a provider fallback restarts the turn from zero. */
  clear(): void {
    this.#blocks = [];
    this.#sealed = false;
  }

  /** Fold one streaming event in. Text, thinking and tool events only. */
  apply(event: AgentEvent): void {
    if (event.type === 'text') {
      this.#appendDelta('text', event.delta);
      return;
    }
    if (event.type === 'thinking') {
      this.#appendDelta('thinking', event.delta);
      return;
    }
    if (event.type === 'tool') this.#applyTool(event);
  }

  /**
   * The provider's final text, offered as a correction of what the deltas
   * added up to. Accepted only in the one case where the deltas cannot lie
   * about order because there is nothing to order: exactly one text block,
   * and no tool ran after it. Anything else - tools after the text, several
   * text blocks - keeps the deltas, and the flat `content` stays
   * authoritative for consumers that never look at `blocks`.
   *
   * Either way the pass ends here: the first delta of the next one opens a
   * new block instead of merging into this pass's trailing text, the same
   * way a multi-pass turn's answers stay separate in `content`. An empty
   * text only ends the pass - the dead attempt of a provider switch, whose
   * partial text stands as it streamed.
   */
  reconcile(doneText: string): void {
    this.#sealed = true;
    if (!doneText) return;
    let textIndex = -1;
    let textCount = 0;
    for (let i = 0; i < this.#blocks.length; i += 1) {
      if (this.#blocks[i]?.type !== 'text') continue;
      textCount += 1;
      textIndex = i;
    }
    if (textCount !== 1 || textIndex < 0) return;
    if (this.#blocks.slice(textIndex + 1).some((block) => block.type === 'tool')) return;
    this.#blocks[textIndex] = { type: 'text', text: doneText };
  }

  /** Deltas of one kind merge into the trailing block of that kind only. */
  #appendDelta(kind: 'text' | 'thinking', delta: string): void {
    if (!delta) return;
    const last = this.#blocks.at(-1);
    if (!this.#sealed && last && last.type === kind) {
      last.text = clip(last.text + delta, BLOCK_CLIP);
      return;
    }
    this.#sealed = false;
    this.#blocks.push({ type: kind, text: clip(delta, BLOCK_CLIP) });
  }

  #applyTool(event: Extract<AgentEvent, { type: 'tool' }>): void {
    if (event.status === 'start') {
      this.#blocks.push({ type: 'tool', call: event });
      return;
    }

    // An end event matches the newest open call with the same id - or, when
    // the provider sends no ids, the newest open call that has none. Start
    // events carry the tool's real name; end events from Claude Code all say
    // 'tool', so the start's name is the one that survives the merge.
    let open: { type: 'tool'; call: Extract<AgentEvent, { type: 'tool' }> } | undefined;
    let openIndex = -1;
    for (let i = this.#blocks.length - 1; i >= 0; i -= 1) {
      const block = this.#blocks[i];
      if (block?.type !== 'tool' || block.call.status !== 'start') continue;
      const matches =
        event.id !== undefined ? block.call.id === event.id : block.call.id === undefined;
      if (matches) {
        open = block;
        openIndex = i;
        break;
      }
    }

    if (!open) {
      // An end without a start - a result for a call whose start never made
      // it onto the stream. Kept as a self-contained completed call rather
      // than dropped, the same fallback the TUI's live view applies.
      this.#blocks.push({
        type: 'tool',
        call: {
          type: 'tool',
          name: event.name,
          status: 'end',
          ...(event.id !== undefined ? { id: event.id } : {}),
          ...(event.result !== undefined ? { result: clip(event.result, BLOCK_CLIP) } : {}),
          ...(event.isError !== undefined ? { isError: event.isError } : {}),
        },
      });
      return;
    }

    const start = open.call;
    this.#blocks[openIndex] = {
      type: 'tool',
      call: {
        ...start,
        status: 'end',
        ...(event.result !== undefined ? { result: clip(event.result, BLOCK_CLIP) } : {}),
        ...(event.isError !== undefined ? { isError: event.isError } : {}),
      },
    };
  }
}
