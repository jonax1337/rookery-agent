/**
 * Cron expressions, the five-field Vixie dialect: minute, hour, day of month,
 * month, day of week. Everything is evaluated in the machine's local time,
 * which is what a person means by "every morning at eight".
 *
 *   * * * * *          every minute
 *   0,15,30,45 * * * *  every quarter hour (a step "star-slash-15" does the same)
 *   0 8 * * 1-5        08:00 on weekdays
 *   30 18 1,15 * *     18:30 on the 1st and 15th
 *   0 9 * * mon        Monday 09:00
 *   @daily             00:00 every day
 *
 * Day of month and day of week combine the way cron has always combined them:
 * when both are restricted, a date matches when either does.
 */

export interface CronSchedule {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** Whether the day-of-month / day-of-week field was a bare `*`. */
  anyDayOfMonth: boolean;
  anyDayOfWeek: boolean;
  /** The expression, normalised (aliases expanded, whitespace collapsed, lower case). */
  expression: string;
}

const ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** Offset of the first name relative to `min`, e.g. months are 1-based. */
  nameBase?: number;
}

const FIELDS: FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  { name: 'day of week', min: 0, max: 7, names: DAY_NAMES, nameBase: 0 },
];

export class CronSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronSyntaxError';
  }
}

/** Parse an expression; throws CronSyntaxError with a message a user can act on. */
export function parseCron(input: string): CronSchedule {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) throw new CronSyntaxError('The schedule is empty.');
  const expanded = ALIASES[trimmed] ?? trimmed;
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronSyntaxError(
      'A schedule has five fields (minute hour day-of-month month day-of-week), got ' + parts.length + '.',
    );
  }
  const sets = parts.map((part, index) => parseField(part, FIELDS[index]!));
  const daysOfWeek = new Set<number>();
  for (const day of sets[4]!) daysOfWeek.add(day === 7 ? 0 : day);
  return {
    minutes: sets[0]!,
    hours: sets[1]!,
    daysOfMonth: sets[2]!,
    months: sets[3]!,
    daysOfWeek,
    anyDayOfMonth: parts[2] === '*',
    anyDayOfWeek: parts[4] === '*',
    expression: parts.join(' '),
  };
}

/** True when the expression parses. */
export function isValidCron(input: string): boolean {
  try {
    parseCron(input);
    return true;
  } catch {
    return false;
  }
}

function parseField(field: string, spec: FieldSpec): Set<number> {
  const values = new Set<number>();
  for (const item of field.split(',')) {
    if (!item) throw new CronSyntaxError('Empty entry in the ' + spec.name + ' field.');
    const [rangePart, stepPart, extra] = item.split('/');
    if (extra !== undefined) throw new CronSyntaxError('Too many "/" in "' + item + '".');
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step < 1) {
        throw new CronSyntaxError('The step in "' + item + '" must be a whole number of at least 1.');
      }
    }
    let low: number;
    let high: number;
    if (rangePart === '*') {
      low = spec.min;
      high = spec.max;
    } else if (rangePart!.includes('-')) {
      const [a, b, more] = rangePart!.split('-');
      if (more !== undefined || !a || !b) throw new CronSyntaxError('Bad range "' + item + '" in the ' + spec.name + ' field.');
      low = parseValue(a, spec);
      high = parseValue(b, spec);
      if (low > high) throw new CronSyntaxError('Range "' + item + '" runs backwards in the ' + spec.name + ' field.');
    } else {
      low = parseValue(rangePart!, spec);
      // "5/10" means "from 5 to the end, every 10"; a plain "5" is just 5.
      high = stepPart !== undefined ? spec.max : low;
    }
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return values;
}

function parseValue(raw: string, spec: FieldSpec): number {
  if (spec.names) {
    const index = spec.names.indexOf(raw.slice(0, 3));
    if (index !== -1 && /^[a-z]+$/.test(raw)) return index + (spec.nameBase ?? 0);
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new CronSyntaxError('"' + raw + '" is not a valid value in the ' + spec.name + ' field.');
  }
  if (value < spec.min || value > spec.max) {
    throw new CronSyntaxError(
      'The ' + spec.name + ' field takes ' + spec.min + ' to ' + spec.max + ', got ' + value + '.',
    );
  }
  return value;
}

/** Whether one local date, to the minute, matches the schedule. */
export function matchesCron(schedule: CronSchedule, date: Date): boolean {
  return (
    schedule.minutes.has(date.getMinutes()) &&
    schedule.hours.has(date.getHours()) &&
    schedule.months.has(date.getMonth() + 1) &&
    matchesDay(schedule, date)
  );
}

function matchesDay(schedule: CronSchedule, date: Date): boolean {
  const dom = schedule.daysOfMonth.has(date.getDate());
  const dow = schedule.daysOfWeek.has(date.getDay());
  if (schedule.anyDayOfMonth && schedule.anyDayOfWeek) return true;
  if (schedule.anyDayOfMonth) return dow;
  if (schedule.anyDayOfWeek) return dom;
  return dom || dow;
}

/** How far ahead to look before giving up: an impossible date like Feb 30. */
const HORIZON_YEARS = 5;

/**
 * The first minute strictly after `after` that matches, in local time, or
 * null when nothing matches within a few years. Walks the calendar rather than
 * every minute: a mismatched month skips to the next month, a mismatched day
 * to the next day, and so on.
 */
export function nextCronRun(schedule: CronSchedule | string, after: Date = new Date()): Date | null {
  const parsed = typeof schedule === 'string' ? parseCron(schedule) : schedule;
  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = after.getFullYear() + HORIZON_YEARS;

  // Each step moves forward by at least a minute; the loop is bounded by the
  // horizon rather than an iteration count so a sparse schedule still resolves.
  while (cursor.getFullYear() <= limit) {
    if (!parsed.months.has(cursor.getMonth() + 1)) {
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!matchesDay(parsed, cursor)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!parsed.hours.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!parsed.minutes.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }
    return cursor;
  }
  return null;
}

/** The next `count` runs after `after`. */
export function upcomingCronRuns(schedule: CronSchedule | string, count: number, after: Date = new Date()): Date[] {
  const parsed = typeof schedule === 'string' ? parseCron(schedule) : schedule;
  const runs: Date[] = [];
  let cursor = after;
  for (let index = 0; index < count; index += 1) {
    const next = nextCronRun(parsed, cursor);
    if (!next) break;
    runs.push(next);
    cursor = next;
  }
  return runs;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const two = (value: number): string => String(value).padStart(2, '0');

/**
 * An English one-liner for the common shapes ("daily at 08:00", "every 15
 * minutes", "Monday to Friday at 09:30"). Anything more elaborate falls
 * back to the expression itself, which is still exact.
 */
export function describeCron(input: string | CronSchedule): string {
  let schedule: CronSchedule;
  try {
    schedule = typeof input === 'string' ? parseCron(input) : input;
  } catch {
    return typeof input === 'string' ? input : input.expression;
  }
  const [minuteField, hourField, , monthField] = schedule.expression.split(' ') as [string, string, string, string, string];
  const everyMinute = minuteField === '*';
  const everyHour = hourField === '*';
  const anyMonth = monthField === '*';

  const time = (): string | null => {
    if (schedule.minutes.size !== 1 || schedule.hours.size > 4) return null;
    const minute = [...schedule.minutes][0]!;
    return [...schedule.hours].sort((a, b) => a - b).map((hour) => two(hour) + ':' + two(minute)).join(', ');
  };

  if (schedule.anyDayOfMonth && schedule.anyDayOfWeek && anyMonth) {
    if (everyHour) {
      const step = /^\*\/(\d+)$/.exec(minuteField);
      if (everyMinute) return 'every minute';
      if (step) return 'every ' + step[1] + ' minutes';
      if (schedule.minutes.size === 1) return 'hourly at minute ' + [...schedule.minutes][0];
    } else if (schedule.minutes.size === 1 && [...schedule.minutes][0] === 0) {
      const step = /^\*\/(\d+)$/.exec(hourField);
      if (step) return 'every ' + step[1] + ' hours';
    }
    const at = time();
    if (at) return 'daily at ' + at;
  }

  if (schedule.anyDayOfMonth && !schedule.anyDayOfWeek && anyMonth) {
    const days = [...schedule.daysOfWeek].sort((a, b) => a - b);
    const at = time();
    if (at) {
      const weekdays = days.join() === '1,2,3,4,5';
      const weekend = days.join() === '0,6';
      const label = weekdays
        ? 'Monday to Friday'
        : weekend
          ? 'weekends'
          : days.map((day) => WEEKDAYS[day] + 's').join(', ');
      return label + ' at ' + at;
    }
  }

  if (!schedule.anyDayOfMonth && schedule.anyDayOfWeek && !everyMinute && !everyHour) {
    const at = time();
    const days = [...schedule.daysOfMonth].sort((a, b) => a - b);
    if (at && days.length <= 4) {
      const dayLabel = days.join(', ');
      if (anyMonth) return 'monthly on day ' + dayLabel + ' at ' + at;
      const months = [...schedule.months].sort((a, b) => a - b);
      if (months.length === 1) return 'on ' + dayLabel + ' ' + MONTHS[months[0]! - 1] + ' at ' + at;
    }
  }

  return schedule.expression;
}
