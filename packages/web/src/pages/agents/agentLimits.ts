/** The server's own ceilings on `GET /api/org/agents/:id` - see routes/org.ts. */
export const ASSIGNMENT_LIMIT = 30;
export const MEMORY_LIMIT = 100;

/**
 * Both lists come back capped, so every number on the page rests on what the
 * server handed over - never on "all of them". A list sitting exactly on its
 * ceiling may have more behind it.
 */
export function isAtLimit(loaded: readonly unknown[], limit: number): boolean {
  return loaded.length >= limit;
}
