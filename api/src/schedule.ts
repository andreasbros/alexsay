/**
 * When things happen: a rule is a single UTC instant, or a local wall-clock time on some days of the
 * week in an IANA zone. Repeats are computed in local time, so 07:00 stays 07:00 across clock changes.
 */

export type Rule = { kind: "at"; at: number } | { kind: "repeat"; time: string; days: number[]; tz: string };

/** Sunday is 0, as Date.getUTCDay counts. */
export const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export const PRESETS: Record<string, number[]> = {
  daily: [0, 1, 2, 3, 4, 5, 6],
  weekdays: [1, 2, 3, 4, 5],
  weekends: [0, 6],
};

const DAY_MS = 86_400_000;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall clock in `tz` at a UTC instant. */
export function localParts(utc: number, tz: string): LocalTime & { second: number } {
  const parts = Object.fromEntries(
    formatter(tz)
      .formatToParts(new Date(utc))
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** How far `tz` is ahead of UTC at an instant, in ms. */
function offsetAt(utc: number, tz: string): number {
  const p = localParts(utc, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utc / 1000) * 1000;
}

/**
 * The UTC instant of a wall-clock time in `tz`. A time that happens twice (clocks going back) is the
 * first; one that never happens (clocks going forward) moves on by the jump, as 01:30 becomes 02:30.
 */
export function localToUtc(t: LocalTime, tz: string): number {
  const naive = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute);
  const candidates = [naive - offsetAt(naive - 6 * 3_600_000, tz), naive - offsetAt(naive + 6 * 3_600_000, tz)];
  const valid = candidates.filter((c) => {
    const p = localParts(c, tz);
    return p.year === t.year && p.month === t.month && p.day === t.day && p.hour === t.hour && p.minute === t.minute;
  });
  return valid.length > 0 ? Math.min(...valid) : (candidates[0] ?? naive);
}

export function parseLocal(text: string): LocalTime | null {
  const m = LOCAL.exec(text.trim());
  if (!m) {
    return null;
  }
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59) {
    return null;
  }
  return { year, month, day, hour, minute };
}

export const validTime = (time: string) => TIME.test(time);

/** Days of the week from a preset ("weekdays") or names ("mon", "friday"); null when none are valid. */
export function parseDays(value: unknown): number[] | null {
  if (typeof value === "string" && PRESETS[value.toLowerCase()]) {
    return PRESETS[value.toLowerCase()] ?? null;
  }
  const names = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[ ,]+/) : [];
  const days = new Set<number>();
  for (const name of names) {
    const index = DAY_NAMES.indexOf(String(name).toLowerCase().slice(0, 3) as (typeof DAY_NAMES)[number]);
    if (index < 0) {
      return null;
    }
    days.add(index);
  }
  return days.size > 0 ? [...days].sort() : null;
}

/** The first occurrence strictly after `after`, or null when the rule has none left. */
export function nextOccurrence(rule: Rule, after: number): number | null {
  if (rule.kind === "at") {
    return rule.at > after ? rule.at : null;
  }
  const m = TIME.exec(rule.time);
  if (!m || rule.days.length === 0) {
    return null;
  }
  const [hour, minute] = [Number(m[1]), Number(m[2])];
  const today = localParts(after, rule.tz);
  for (let i = 0; i <= 8; i++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day) + i * DAY_MS);
    if (!rule.days.includes(date.getUTCDay())) {
      continue;
    }
    const at = localToUtc(
      { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute },
      rule.tz,
    );
    if (at > after) {
      return at;
    }
  }
  return null;
}

/** Up to `count` occurrences after `after`. */
export function occurrences(rule: Rule, after: number, count: number): number[] {
  const found: number[] = [];
  let from = after;
  while (found.length < count) {
    const next = nextOccurrence(rule, from);
    if (next === null) {
      break;
    }
    found.push(next);
    from = next;
  }
  return found;
}

/** "weekdays at 07:00", "Mon and Thu at 18:30", or null for a one-off. */
export function describeRepeat(rule: Rule): string | null {
  if (rule.kind === "at") {
    return null;
  }
  const preset = Object.entries(PRESETS).find(([, days]) => days.join() === rule.days.join())?.[0];
  const days = preset ?? rule.days.map((d) => (DAY_NAMES[d] ?? "").replace(/^./, (c) => c.toUpperCase())).join(", ");
  return `${days} at ${rule.time}`;
}

export function parseRule(text: string): Rule | null {
  try {
    const value = JSON.parse(text) as Rule;
    return value && (value.kind === "at" || value.kind === "repeat") ? value : null;
  } catch {
    return null;
  }
}
