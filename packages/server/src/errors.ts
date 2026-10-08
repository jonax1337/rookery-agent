/** What to log or send for anything a `catch` or a rejected promise hands over. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
