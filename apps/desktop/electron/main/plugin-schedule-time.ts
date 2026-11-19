const MINUTE = 60_000;

export type ScheduleExpression = { every?: string; cron?: string };

type CronField = { values: Set<number>; unrestricted: boolean };
type Cron = { minute: CronField; hour: CronField; day: CronField; month: CronField; weekday: CronField };

function field(text: string, minimum: number, maximum: number, weekday = false): CronField {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText, extra] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (extra !== undefined || !Number.isInteger(step) || step < 1 || !range) throw new Error(`Invalid cron field: ${text}`);
    let start: number;
    let end: number;
    if (range === "*") {
      start = minimum;
      end = maximum;
    } else {
      const pieces = range.split("-");
      if (pieces.length > 2 || pieces.some((value) => !/^\d+$/.test(value))) throw new Error(`Invalid cron field: ${text}`);
      start = Number(pieces[0]);
      end = pieces.length === 2 ? Number(pieces[1]) : stepText === undefined ? start : maximum;
    }
    if (start < minimum || end > maximum || start > end) throw new Error(`Invalid cron field: ${text}`);
    for (let value = start; value <= end; value += step) values.add(weekday && value === 7 ? 0 : value);
  }
  return { values, unrestricted: text.startsWith("*") };
}

function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("Cron must contain five fields");
  return {
    minute: field(parts[0], 0, 59),
    hour: field(parts[1], 0, 23),
    day: field(parts[2], 1, 31),
    month: field(parts[3], 1, 12),
    weekday: field(parts[4], 0, 7, true),
  };
}

function dayMatches(cron: Cron, date: Date): boolean {
  const day = cron.day.values.has(date.getDate());
  const weekday = cron.weekday.values.has(date.getDay());
  const dayMatch = cron.day.unrestricted || cron.weekday.unrestricted ? day && weekday : day || weekday;
  return cron.month.values.has(date.getMonth() + 1) && dayMatch;
}

function nextDay(date: Date, cursor: number): number {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  return next > cursor ? next : cursor + MINUTE;
}

function matches(cron: Cron, date: Date): boolean {
  return cron.minute.values.has(date.getMinutes()) && cron.hour.values.has(date.getHours()) && dayMatches(cron, date);
}

export function intervalMs(expression: string): number {
  const match = /^([1-9]\d*)([smhd])$/.exec(expression.trim());
  if (!match) throw new Error("Invalid schedule interval");
  const result = Number(match[1]) * ({ s: 1_000, m: MINUTE, h: 3_600_000, d: 86_400_000 } as const)[match[2] as "s" | "m" | "h" | "d"];
  if (!Number.isSafeInteger(result) || result < MINUTE) throw new Error("Invalid schedule interval");
  return result;
}

/** Search actual elapsed minutes, so local DST gaps and repeated hours are respected. */
export function nextCron(expression: string, after: number): number {
  const cron = parseCron(expression);
  let cursor = (Math.floor(after / MINUTE) + 1) * MINUTE;
  // Gregorian dates repeat within eight years, including leap-day expressions.
  const limit = cursor + 8 * 366 * 24 * 60 * MINUTE;
  while (cursor <= limit) {
    const date = new Date(cursor);
    if (!dayMatches(cron, date)) cursor = nextDay(date, cursor);
    else if (matches(cron, date)) return cursor;
    else cursor += MINUTE;
  }
  throw new Error("Cron expression has no matching date within eight years");
}

/** Number of matching cron ticks in (after, through]. */
export function countCron(expression: string, after: number, through: number): number {
  const cron = parseCron(expression);
  let count = 0;
  let cursor = (Math.floor(after / MINUTE) + 1) * MINUTE;
  while (cursor <= through) {
    const date = new Date(cursor);
    const end = Math.min(nextDay(date, cursor), through + 1);
    if (!dayMatches(cron, date)) cursor = end;
    else if (cron.minute.values.size === 60 && cron.hour.values.size === 24) {
      count += Math.ceil((end - cursor) / MINUTE);
      cursor = end;
    } else {
      while (cursor < end) {
        if (matches(cron, new Date(cursor))) count++;
        cursor += MINUTE;
      }
    }
  }
  return count;
}

export function nextSchedule(expression: ScheduleExpression, lastRunAt: number | null, now: number): number {
  if (expression.every !== undefined) {
    const interval = intervalMs(expression.every);
    return lastRunAt === null ? now : lastRunAt + interval;
  }
  if (expression.cron !== undefined) return nextCron(expression.cron, lastRunAt ?? now);
  throw new Error("Schedule must declare every or cron");
}

export function missedTicks(expression: ScheduleExpression, lastRunAt: number | null, now: number): number {
  if (lastRunAt === null) return 0;
  const count = expression.every !== undefined
    ? Math.floor((now - lastRunAt) / intervalMs(expression.every))
    : countCron(expression.cron!, lastRunAt, now);
  return Math.max(0, count - 1);
}
