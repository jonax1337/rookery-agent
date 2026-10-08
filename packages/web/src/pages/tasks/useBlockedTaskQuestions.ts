import { useEffect, useMemo, useState } from 'react';

import { api } from '@/lib/api';
import { openQuestion, plainSnippet } from '@/lib/notifications';
import type { RookerySocket } from '@/lib/socket';
import type { Task, TaskEvent } from '@/lib/types';

export interface BlockedQuestion {
  subject: string;
  at: number;
}

type QuestionsByTask = ReadonlyMap<string, BlockedQuestion>;

/**
 * The open question of each blocked task. A blocked card should say what it
 * is waiting for, and the card's own activity is the source: its newest
 * `question` event with no answer after it. Only blocked tasks are read - one
 * detail call each, and there are rarely more than a handful - and a question
 * or an answer arriving over the socket patches the map in place.
 */
export function useBlockedTaskQuestions(
  socket: RookerySocket,
  tasks: readonly Task[],
): QuestionsByTask {
  const [questions, setQuestions] = useState<QuestionsByTask>(() => new Map());

  const blockedKey = useMemo(
    () =>
      tasks
        .filter((task) => task.status === 'blocked')
        .map((task) => task.id)
        .sort()
        .join(','),
    [tasks],
  );

  useEffect(() => {
    const ids = blockedKey ? blockedKey.split(',') : [];
    if (ids.length === 0) {
      setQuestions(new Map());
      return;
    }
    let live = true;
    void Promise.all(ids.map(loadOpenQuestion)).then((entries) => {
      if (!live) return;
      const next = new Map<string, BlockedQuestion>();
      for (const [id, question] of entries) {
        if (question) next.set(id, toBlockedQuestion(question.text, question.at));
      }
      setQuestions(next);
    });
    return () => {
      live = false;
    };
  }, [blockedKey]);

  useEffect(
    () =>
      socket.onTaskEvent((event) => {
        if (event.kind !== 'question' && event.kind !== 'answer') return;
        setQuestions((current) => {
          const next = new Map(current);
          if (event.kind === 'question') {
            next.set(event.taskId, toBlockedQuestion(event.text, event.at));
          } else {
            next.delete(event.taskId);
          }
          return next;
        });
      }),
    [socket],
  );

  return questions;
}

function toBlockedQuestion(text: string, at: number): BlockedQuestion {
  return { subject: plainSnippet(text), at };
}

async function loadOpenQuestion(taskId: string): Promise<readonly [string, TaskEvent | null]> {
  try {
    const detail = await api.task(taskId);
    return [taskId, openQuestion(detail.events ?? [])];
  } catch {
    // A missing question line is a missing line, never an error banner.
    return [taskId, null];
  }
}
