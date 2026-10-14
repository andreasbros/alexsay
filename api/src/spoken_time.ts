import { DAY_NAMES, localParts, PRESETS, type Rule } from "./schedule";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const FULL_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "1 minute", "1 hour 30 minutes": how long until something, or how long a timer runs. */
export function duration(seconds: number): string {
  const parts: string[] = [];
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? "" : "s"}`;
  if (h) parts.push(unit(h, "hour"));
  if (m) parts.push(unit(m, "minute"));
  if (s && !h) parts.push(unit(s, "second"));
  return parts.join(" ") || unit(0, "second");
}

/** The clock in the user's own style: "21:00" in en-GB, "9:00 PM" in en-US. */
export function clockIn(utc: number, locale: string, tz: string): string {
  const twelveHour = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hour12 === true;
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    hour: twelveHour ? "numeric" : "2-digit",
    minute: "2-digit",
  }).format(new Date(utc));
}

/** "today", "tomorrow", "on Friday" (within a week), "on Friday 24 October". */
function dayWords(utc: number, now: number, locale: string, tz: string): string {
  const day = (ms: number) => {
    const p = localParts(ms, tz);
    return Date.UTC(p.year, p.month - 1, p.day);
  };
  const ahead = Math.round((day(utc) - day(now)) / DAY_MS);
  if (ahead === 0) return "today";
  if (ahead === 1) return "tomorrow";
  const weekday = FULL_DAYS[new Date(day(utc)).getUTCDay()] ?? "";
  if (ahead > 1 && ahead < 7) return `on ${weekday}`;
  const date = new Intl.DateTimeFormat(locale, { timeZone: tz, day: "numeric", month: "long" }).format(new Date(utc));
  return `on ${weekday} ${date}`;
}

/** "every day", "every weekday", "every weekend day", "every Monday and Thursday". */
export function everyWords(days: number[]): string {
  const preset = Object.entries(PRESETS).find(([, d]) => d.join() === days.join())?.[0];
  if (preset === "daily") return "every day";
  if (preset === "weekdays") return "every weekday";
  if (preset === "weekends") return "every Saturday and Sunday";
  const names = days.map((d) => FULL_DAYS[d] ?? DAY_NAMES[d] ?? "");
  const last = names.pop();
  return `every ${names.length ? `${names.join(", ")} and ${last}` : last}`;
}

/**
 * What the assistant says back: "today at 21:00", "tomorrow at 07:00", "in 5 minutes (today at 18:47)",
 * "every weekday at 07:00, next tomorrow at 07:00". Timers and anything within the hour count down.
 */
export function spokenWhen(
  next: number | null,
  rule: Rule | null,
  kind: string,
  now: number,
  locale: string,
  tz: string,
): string {
  if (next === null) {
    return "not scheduled";
  }
  const at = `${dayWords(next, now, locale, tz)} at ${clockIn(next, locale, tz)}`;
  if (rule?.kind === "repeat") {
    return `${everyWords(rule.days)} at ${clockIn(next, locale, tz)}, next ${at}`;
  }
  const left = next - now;
  if (left > 0 && (left < HOUR_MS || (kind === "timer" && left < DAY_MS))) {
    return `in ${duration(Math.round(left / 1000))} (${at})`;
  }
  return at;
}
