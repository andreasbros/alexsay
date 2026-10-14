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
export function offsetAt(utc: number, tz: string): number {
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

const CLOCK = /^(\d{1,2})(?:[:.h](\d{2}))?(?::\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?$/i;

/** A time of day as people and models write it: "21:00", "9:30", "9pm", "9.30 p.m.", "07:00:00". */
export function parseClock(text: string): { hour: number; minute: number } | null {
  const m = CLOCK.exec(text.trim());
  if (!m) {
    return null;
  }
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? "0");
  const half = m[3]?.toLowerCase().replaceAll(".", "");
  if (half) {
    if (hour < 1 || hour > 12) {
      return null;
    }
    hour = (hour % 12) + (half === "pm" ? 12 : 0);
  } else if (m[2] === undefined) {
    // A bare number is only a time with am or pm: "9" alone could be anything
    return null;
  }
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

export const clockText = ({ hour, minute }: { hour: number; minute: number }) =>
  `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

const INSTANT = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * A date and time: local to `tz` when it has no offset ("2026-10-14T21:00", seconds allowed), the exact
 * instant when it has one ("...Z", "...+01:00"). Null when it is neither.
 */
export function parseInstant(text: string, tz: string): number | null {
  const m = INSTANT.exec(text.trim());
  if (!m) {
    return null;
  }
  const local = parseLocal(`${m[1]}T${m[2]}`);
  if (!local) {
    return null;
  }
  if (!m[3]) {
    return localToUtc(local, tz);
  }
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  if (m[3].toUpperCase() === "Z") {
    return naive;
  }
  const sign = m[3].startsWith("-") ? -1 : 1;
  const digits = m[3].slice(1).replace(":", "");
  return naive - sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000;
}

/** The next time the wall clock in `tz` shows this time, strictly after `after`: today, else tomorrow. */
export function nextClock(clock: { hour: number; minute: number }, tz: string, after: number): number {
  return nextOccurrence({ kind: "repeat", time: clockText(clock), days: PRESETS.daily ?? [], tz }, after) ?? after;
}

/** ISO 8601 in `tz` with its offset at that instant: "2026-10-14T21:00:00+01:00". */
export function localIso(utc: number, tz: string): string {
  const p = localParts(utc, tz);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const offset = Math.round(offsetAt(utc, tz) / 60_000);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return (
    `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

const DAY_ALIASES: Record<string, string> = {
  "every day": "daily",
  everyday: "daily",
  weekday: "weekdays",
  weekend: "weekends",
  "monday to friday": "weekdays",
  "mon-fri": "weekdays",
};
const FULL_DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const FILLER = new Set(["every", "each", "on", "and", "&", ""]);

/**
 * Days of the week from a preset ("weekdays", "every day") or names ("mon", "Fridays", "every Monday and
 * Thursday", ["Mon", "thu"]); null when any part is not a day.
 */
export function parseDays(value: unknown): number[] | null {
  if (typeof value === "string") {
    const phrase = value.trim().toLowerCase();
    const preset = PRESETS[DAY_ALIASES[phrase] ?? phrase] ?? PRESETS[DAY_ALIASES[phrase.replace(/^every /, "")] ?? ""];
    if (preset) {
      return preset;
    }
  }
  const names = (Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [])
    .map((name) => String(name).trim().toLowerCase())
    .filter((name) => !FILLER.has(name));
  if (names.length === 1 && names[0] && PRESETS[DAY_ALIASES[names[0]] ?? names[0]]) {
    return PRESETS[DAY_ALIASES[names[0]] ?? names[0]] ?? null;
  }
  const days = new Set<number>();
  for (const name of names) {
    const index = FULL_DAY_NAMES.findIndex((day) => (name.length >= 3 && day.startsWith(name)) || name === `${day}s`);
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
