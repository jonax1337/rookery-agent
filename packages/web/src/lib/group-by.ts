/**
 * Buckets items by a key, keeping their order inside each bucket.
 *
 * Items for which `keyOf` answers `null` or `undefined` belong to no bucket
 * and are left out - "agents without a team" are not a team.
 */
export function groupBy<T>(
  items: readonly T[],
  keyOf: (item: T) => string | null | undefined,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null || key === undefined) continue;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}
