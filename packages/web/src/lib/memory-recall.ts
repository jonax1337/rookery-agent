import type { RecalledMemory } from './types';

/**
 * What the chat does with the memories a turn was given (concept 4.2b, S6):
 * the name the card rides into the transcript under, and the rule its two
 * buttons follow.
 *
 * A verdict is the one signal about retrieval quality that retrieval itself
 * cannot cause - everything else the system learns about a memory it learned
 * after delivering it. Two surfaces collect it, the card in the transcript and
 * the highlighted rows on the memory page, and both post the same claim about
 * the same turn, so the rule lives here rather than in either of them.
 */

/**
 * The name the memory block travels under as a message part.
 *
 * assistant-ui renders a transcript out of parts, and the only part that
 * carries a component of its own is a tool call - so the recall rides in as
 * one, under a name no provider can produce. The model is never told about
 * it: `memory-call.tsx` registers a renderer, not a tool.
 */
export const MEMORY_RECALL_TOOL = 'rookery:memory-recall';

/** What `useRookeryRuntime` puts into that part's `args`. */
export interface MemoryRecallArgs {
  /** The journal's turn id - what a verdict is a claim about. */
  turnId?: string | undefined;
  memories: RecalledMemory[];
}

export type MemoryFeedbackVerdict = 'point' | 'ballast';

/** The key one turn's judgement of one memory is tracked under. */
export function feedbackKey(turnId: string, memoryId: string): string {
  return turnId + ':' + memoryId;
}

/**
 * Records a judgement. An already-judged key is left untouched: a second
 * click reads back what was already said instead of silently writing a
 * second label - the client-side half of what the store's `(turn_id,
 * target, source)` key already guarantees server-side.
 */
export function applyJudgement(
  judged: Record<string, MemoryFeedbackVerdict>,
  turnId: string,
  memoryId: string,
  verdict: MemoryFeedbackVerdict,
): Record<string, MemoryFeedbackVerdict> {
  const key = feedbackKey(turnId, memoryId);
  if (key in judged) return judged;
  return { ...judged, [key]: verdict };
}

/**
 * `POST /api/memories/:id/feedback` - the click target. Throws like every
 * other write, so the caller's try/catch and `reportFailure` handle it the
 * same way the memory page's `patch` and `forget` do.
 */
export async function postMemoryFeedback(
  id: string,
  turnId: string,
  verdict: MemoryFeedbackVerdict,
): Promise<void> {
  const response = await fetch('/api/memories/' + encodeURIComponent(id) + '/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnId, verdict }),
  });
  if (!response.ok) throw new Error('The feedback could not be saved.');
}
