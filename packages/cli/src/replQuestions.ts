/**
 * Questions the assistant asks mid-turn, served as a numbered list.
 *
 * There are no widgets down here, so the options are numbered and the answer
 * comes off stdin through the same readline every other line does - which
 * means type-ahead still works and a piped session can answer too. One at a
 * time: the turn only ever waits on a single question, and the chain keeps a
 * second one from racing the first for the same line.
 *
 * Answering is a direct call into the registry the waiting tool is parked
 * on. The CLI holds the assistant in its own process; there is no socket
 * between the answer and the turn it unblocks.
 */

import type { AgentEvent, Assistant } from '@rookery/core';
import type { LineQueue } from './replInput.js';
import { printDim, printFailure, printLine } from './replOutput.js';
import { shorten, untilTime } from './ui/render.js';
import { glyph, isTty, theme } from './ui/theme.js';

/** A question the assistant asked, exactly as core streamed it. */
type QuestionEvent = Extract<AgentEvent, { type: 'question' }>;

interface Answer {
  selected: number[];
  text?: string;
}

/** How much of a free-text answer the echo line repeats. */
const ECHO_WIDTH = 70;

/** Serve the assistant's questions on the terminal for as long as `assistant` lives. */
export function attachQuestionPrompt(assistant: Assistant, input: LineQueue): void {
  let openQuestionId: string | null = null;
  let chain: Promise<void> = Promise.resolve();

  const ask = async (event: QuestionEvent): Promise<void> => {
    // Lines typed *before* the question existed are next prompts, not
    // answers: without this, a line queued while the turn was running would
    // answer the question in the same instant it appears on screen. Stashed
    // and put back once the answer is in - typed ahead still works for a
    // person, and a piped session keeps its scripted replies, because a pipe
    // buffers everything up front and its lines are meant as answers.
    const typedAhead = process.stdin.isTTY ? input.takeQueued() : [];

    openQuestionId = event.id;
    printQuestion(event);

    const line = await input.nextAnswerLine();
    input.restore(typedAhead);

    if (openQuestionId !== event.id) {
      // Answered somewhere else, or given up on, while we waited. A line that
      // still arrived is the user's next prompt, not an answer to a question
      // nobody is asking any more.
      if (line !== null) input.putBack(line);
      return;
    }
    openQuestionId = null;

    deliverAnswer(assistant, event, line === null ? null : parseAnswer(line, event.options.length, event.multiSelect));
  };

  assistant.on('question', (event: QuestionEvent) => {
    chain = chain.then(() => ask(event)).catch(printFailure);
  });

  assistant.on('question-closed', (event: { id: string }) => {
    if (openQuestionId !== event.id) return;
    openQuestionId = null;
    // Stop waiting for a line that is no longer an answer; the prompt gets
    // the keyboard back instead.
    input.cancelAnswer();
  });
}

function deliverAnswer(assistant: Assistant, event: QuestionEvent, answer: Answer | null): void {
  if (!answer) {
    assistant.questions.cancel(event.id, 'cancelled');
    printDim('  ' + glyph.warn + ' skipped');
    return;
  }

  // The registry says whether the id was still open; `false` means somebody
  // else got there first, which is normal on a channel that is one of many.
  const delivered = assistant.questions.answer(event.id, { ...answer, source: 'tui', at: Date.now() });
  printDim(
    delivered
      ? '  ' + glyph.ok + ' ' + answerEcho(answer, event)
      : '  ' + glyph.warn + ' already answered elsewhere',
  );
}

/**
 * The question, as a numbered list.
 *
 * The block opens on a cleared line because a turn in flight may still be
 * drawing its spinner on the current one, and a question the reader cannot
 * read is worse than no question at all.
 */
function printQuestion(event: QuestionEvent): void {
  if (isTty) process.stdout.write('\r\x1B[2K');
  printLine();
  printLine(theme.accentBold(glyph.prompt + ' ' + event.header));
  printLine('  ' + theme.frost(event.question));
  event.options.forEach((option, index) => {
    printLine(
      '  ' + theme.accent(String(index + 1) + '.') + ' ' + theme.frost(option.label) +
        (option.description ? theme.dim('  ' + glyph.dot + ' ' + option.description) : ''),
    );
  });
  printDim(
    '  ' + (event.multiSelect ? 'numbers, e.g. "1 3"' : 'a number') +
      ', your own words, or blank to skip  ' + glyph.dot + '  expires ' + untilTime(event.expiresAt),
  );
}

/**
 * What a typed line means as an answer.
 *
 * Numbers pick options - one for a single choice, several when the question
 * allows it - and anything else is a free answer, which every channel is
 * allowed to give. A blank line is not an answer at all: it declines, and the
 * turn is told so rather than left to run out its clock.
 */
export function parseAnswer(line: string, optionCount: number, multiSelect: boolean): Answer | null {
  const input = line.trim();
  if (!input) return null;

  const parts = input.split(/[\s,]+/u).filter(Boolean);
  const numbers = parts.map((part) => Number(part));
  const picksOptions =
    parts.length > 0 &&
    numbers.every((value) => Number.isInteger(value) && value >= 1 && value <= optionCount);

  if (!picksOptions) return { selected: [], text: input };

  // A single-choice question takes the first number and ignores the rest
  // rather than rejecting the line: the intent is plain enough.
  const picked = multiSelect ? numbers : numbers.slice(0, 1);
  return { selected: [...new Set(picked.map((value) => value - 1))].sort((a, b) => a - b) };
}

/** The one line that says what was just sent back into the waiting turn. */
function answerEcho(answer: Answer, event: QuestionEvent): string {
  if (answer.text) return shorten(answer.text, ECHO_WIDTH);
  return answer.selected
    .map((index) => event.options[index]?.label ?? 'option ' + (index + 1))
    .join(', ');
}
