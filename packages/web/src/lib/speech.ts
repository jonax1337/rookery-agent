/**
 * Turning a streamed markdown answer into speech-sized pieces.
 *
 * The voice screen reads the answer aloud while it is still arriving. Two
 * things make that work: markdown has to become plain prose, and the prose
 * has to be cut into sentences early enough that the first one plays while
 * the model is still writing the third.
 */

/** Markdown to something a voice can read. The code notice is German, like the UI. */
export function cleanForSpeech(markdown: string): string {
  let text = markdown;
  // An unclosed fence is still streaming: hold it back until it closes.
  const fences = text.match(/```/g)?.length ?? 0;
  if (fences % 2 === 1) text = text.slice(0, text.lastIndexOf('```'));
  return text
    .replace(/```[\s\S]*?```/g, ' The code is shown on screen. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/https?:\/\/\S+/g, 'Link')
    .replace(/[*#_~>|]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** A full stop after one of these is not the end of a sentence. */
const ABBREVIATION =
  /(?:\b(?:z\.B|bzw|ca|Nr|Dr|Prof|usw|etc|vs|Mr|Mrs|Ms|St|bspw|evtl|ggf|inkl|zzgl|sog|u\.a|d\.h|o\.ä|Hr|Fr)|\b[A-Z]|\d)\.$/i;

export interface SplitOptions {
  /** Shorter sentences are merged into the next one. */
  minChars?: number;
  /** Cut at a comma or a space after this many characters without a full stop. */
  maxChars?: number;
  /**
   * Clause length at which the very first piece of a turn is released. The
   * voice starts on the first clause instead of waiting for a full stop, so
   * the answer is heard about a second earlier.
   */
  firstChars?: number;
}

/**
 * Incremental sentence splitter. Feed it the whole text so far, every time
 * it grows; it hands back only the sentences that became complete since the
 * last call. `flush` releases the trailing fragment once the stream is done.
 */
export class SentenceSplitter {
  private consumed = 0;
  private lastText = '';

  reset(): void {
    this.consumed = 0;
    this.lastText = '';
  }

  feed(fullText: string, options: SplitOptions = {}): string[] {
    const minChars = options.minChars ?? 24;
    const maxChars = options.maxChars ?? 260;
    const firstChars = options.firstChars ?? 60;
    // The stream restarted (a new turn), so start over rather than skipping.
    if (fullText.length < this.consumed) this.consumed = 0;
    this.lastText = fullText;

    const sentences: string[] = [];
    let rest = fullText.slice(this.consumed);
    for (;;) {
      // Nothing spoken yet: a clause is enough to get the voice going.
      const eager = this.consumed === 0;
      const cut = findBoundary(rest, eager ? 12 : minChars, eager ? firstChars : maxChars);
      if (cut === -1) break;
      const sentence = rest.slice(0, cut).trim();
      this.consumed += cut;
      rest = rest.slice(cut);
      if (sentence) sentences.push(sentence);
    }
    return sentences;
  }

  flush(): string[] {
    const rest = this.lastText.slice(this.consumed).trim();
    this.consumed = this.lastText.length;
    return rest ? [rest] : [];
  }
}

function findBoundary(text: string, minChars: number, maxChars: number): number {
  const boundary = /[.!?…]+["“”'»)\]]*\s+|\n/g;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text))) {
    const end = match.index + match[0].length;
    const hardBreak = match[0].includes('\n');
    if (!hardBreak) {
      if (end < minChars) continue;
      if (ABBREVIATION.test(text.slice(Math.max(0, match.index - 6), match.index + 1))) continue;
    } else if (end < 2) {
      continue;
    }
    return end;
  }
  // A long run without a full stop: cut at a clause so the voice does not wait.
  if (text.length > maxChars) {
    const window = text.slice(0, maxChars);
    const clause = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '));
    if (clause > minChars) return clause + 2;
    const space = window.lastIndexOf(' ');
    if (space > minChars) return space + 1;
  }
  return -1;
}
