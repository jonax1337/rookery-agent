/**
 * `item` in place of the entry with its id, or appended when the list has no
 * such entry yet. Broadcasts report the same record repeatedly as it
 * progresses; merging by id updates the row instead of growing the list.
 */
export function upsertById<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index === -1) return [...list, item];
  const next = [...list];
  next[index] = item;
  return next;
}
