import { z } from 'zod';

/**
 * The one rule for a conversation title.
 *
 * It was written twice with two different strictnesses: the chat dialog
 * enforced 1–120 characters, the conversations drawer only `title.trim()`.
 * The same title could be set through one surface and refused by the other.
 *
 * The server has no upper bound (`packages/server/src/schemas.ts` asks for
 * `z.string().min(1)`), so the 120 are the client's own line - kept, because a
 * title longer than that is truncated in every list that shows it anyway, and
 * a rejection with a reason beats a silent ellipsis.
 */

export const SESSION_TITLE_MAX = 120;

export const sessionTitleSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'A conversation needs a title.')
    .max(SESSION_TITLE_MAX, 'No more than ' + SESSION_TITLE_MAX + ' characters.'),
});

export type SessionTitleInput = z.infer<typeof sessionTitleSchema>;
