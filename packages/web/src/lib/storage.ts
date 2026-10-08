/**
 * Browser-local preferences that survive a reload.
 *
 * Storage can be absent or throw (private window, blocked cookies, quota).
 * Every preference here is a convenience, never state the server needs, so a
 * failure means only that the choice is not remembered.
 */

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** `null` forgets the key. */
export function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Not remembered; see the module comment.
  }
}
