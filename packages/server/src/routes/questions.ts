import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AgentEvent, QuestionAnswer } from '@rookery/core';
import type { ServerContext } from '../context.js';
import { answerQuestionSchema, formatIssues } from '../schemas.js';

/**
 * The `ask_user` question, over HTTP.
 *
 * A question is global, never bound to the turn that asked it: the person may
 * have started the turn in one tab and be looking at another screen - or at
 * their phone - by the time the assistant needs an answer. So the id is the
 * question's own, GET lists whatever is open no matter who asked, and anyone
 * who can reach the API may answer.
 *
 * The websocket carries the same two operations (`answer` frame in and the
 * `question`/`question-closed` broadcasts out). These routes exist for the
 * clients that have no socket to answer on - the SSE path - and for the case
 * a socket cannot cover at all: a reload, which drops every frame that was
 * ever sent and needs the open questions read back.
 */

/** One open question, in the same shape the `question` event carries. */
export type OpenQuestion = Extract<AgentEvent, { type: 'question' }>;

/**
 * The open questions as wire frames.
 *
 * Mapped field by field rather than passed through, so what a reload reads is
 * byte-identical to what the live `question` frame delivered and a client can
 * feed both into one handler.
 */
export function openQuestions(context: ServerContext): OpenQuestion[] {
  return context.assistant.questions.pending().map((question) => ({
    type: 'question' as const,
    id: question.id,
    header: question.header,
    question: question.question,
    options: question.options,
    multiSelect: question.multiSelect,
    expiresAt: question.expiresAt,
  }));
}

/** Is this id still waiting for an answer? */
export function isOpenQuestion(context: ServerContext, id: string): boolean {
  return context.assistant.questions.pending().some((question) => question.id === id);
}

/**
 * Complete a validated answer payload.
 *
 * An answer with neither a picked option nor text says nothing, and the tool
 * would report an empty choice back to the model as if the person had spoken,
 * so it is refused at the edge instead - `null` means "do not deliver this".
 */
export function buildAnswer(
  payload: { selected: number[]; text?: string },
  source: NonNullable<QuestionAnswer['source']>,
): QuestionAnswer | null {
  const text = payload.text?.trim();
  if (payload.selected.length === 0 && !text) return null;
  return {
    selected: payload.selected,
    ...(text ? { text } : {}),
    source,
    at: Date.now(),
  };
}

export async function registerQuestionRoutes(
  app: FastifyInstance,
  context: ServerContext,
): Promise<void> {
  /**
   * Everything the assistant is waiting on right now. A surface calls this on
   * mount and after a reconnect; between those two moments the socket
   * broadcast is what keeps it current.
   */
  app.get('/api/questions', async () => openQuestions(context));

  /** Answer one. The id is the question's, not a turn's. */
  app.post(
    '/api/questions/:id/answer',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = answerQuestionSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Bad Request', message: formatIssues(parsed.error) };
      }

      const answer = buildAnswer(parsed.data, 'api');
      if (!answer) {
        reply.code(400);
        return { error: 'Bad Request', message: 'An answer needs a selected option or some text.' };
      }

      // A question that is no longer open is the normal race, not a fault:
      // it timed out, the turn was aborted, or somebody else answered first
      // from another surface. Saying so is the whole point - the caller's
      // card is stale and it should drop it.
      if (!isOpenQuestion(context, request.params.id)) {
        reply.code(404);
        return { error: 'Not Found', message: 'No open question with that id.' };
      }

      context.assistant.questions.answer(request.params.id, answer);
      return { answered: true, id: request.params.id };
    },
  );
}
