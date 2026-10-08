/**
 * Structural equality for plain JSON-like trees.
 *
 * `JSON.stringify` would do it only as long as every copy keeps its key
 * order, and a spread of a sub-object does not guarantee that. This does not
 * have to be fast: it runs once per keystroke over an object with about
 * thirty leaves.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!deepEqual(left[key], right[key])) return false;
  }
  return true;
}
