/**
 * The question a turn is blocked on, and answering it from this terminal.
 *
 * The CLI holds the assistant in its own process, so answering is a direct
 * call into the registry the waiting tool is parked on - no socket, no route,
 * nothing that could be offline while the turn is not.
 */

import { useCallback, useRef, useState } from 'react';
import type { Assistant } from '@rookery/core';
import type { OpenQuestion } from './useTurn.js';

export interface QuestionApi {
  /** The question to show, or null when there is none or it must wait. */
  question: OpenQuestion | null;
  answer: (selected: number[]) => void;
  skip: () => void;
}

/**
 * `open` is the question the turn reports. `deferred` holds the card back: a
 * watch owns the screen below the scrollback, so a question that lands while
 * one is open waits behind it - Esc closes the watch and the card is there,
 * still counting down.
 */
export function useQuestion(
  assistant: Assistant,
  open: OpenQuestion | null,
  deferred: boolean,
  onSettledElsewhere: () => void,
): QuestionApi {
  // The question this terminal has already acted on. Core closes the card by
  // streaming `question-closed`, but the surface must go the instant the key
  // is pressed - waiting a round trip, however short, invites a second answer.
  const [settled, setSettled] = useState<string | null>(null);

  const openRef = useRef(open);
  openRef.current = open;

  const question = !deferred && open && open.id !== settled ? open : null;

  const close = useCallback(
    (act: (id: string) => boolean) => {
      const current = openRef.current;
      if (!current) return;
      setSettled(current.id);
      // The registry says whether the id was still open. A `false` means the
      // question was settled somewhere else - the phone, a timeout - between
      // the keystroke and this call. Nothing is broken: the turn already has
      // its answer, so the card goes away and one dim line says why.
      if (!act(current.id)) onSettledElsewhere();
    },
    [onSettledElsewhere],
  );

  const answer = useCallback(
    (selected: number[]) => {
      close((id) => assistant.questions.answer(id, { selected, source: 'tui', at: Date.now() }));
    },
    [assistant, close],
  );

  const skip = useCallback(() => {
    close((id) => assistant.questions.cancel(id, 'cancelled'));
  }, [assistant, close]);

  return { question, answer, skip };
}
