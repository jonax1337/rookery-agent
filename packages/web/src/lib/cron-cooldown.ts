/** A day; past that the rest is longer than any timetable the form can write. */
export const MAX_COOLDOWN_SECONDS = 86_400;

export const MS_PER_SECOND = 1000;

/** The whole seconds typed into the cooldown field, or `null` while the text is not a valid rest. */
export function parseCooldownSeconds(text: string): number | null {
  if (text.trim() === '') return null;
  const seconds = Number(text);
  const inRange = seconds >= 0 && seconds <= MAX_COOLDOWN_SECONDS;
  return Number.isInteger(seconds) && inRange ? seconds : null;
}

/** The one-line rule the schedule page states for an event-driven job's rest. */
export function describeEventCooldown(cooldownMs: number): string {
  const seconds = Math.round(cooldownMs / MS_PER_SECOND);
  return seconds === 0
    ? 'Every event starts a run'
    : 'Rests ' + seconds + ' s after a run, then fires once for everything that arrived';
}
