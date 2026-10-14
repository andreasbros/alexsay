import {
  ALARM_KINDS,
  type AlarmKind,
  alarms,
  createAlarm,
  DEFAULT_SNOOZE_MINUTES,
  defaultSpeaker,
  deleteAlarm,
  presenter,
  signalRinging,
  updateAlarm,
} from "./alarms";
import { homes } from "./db";
import {
  clockText,
  DAY_NAMES,
  localIso,
  localParts,
  nextClock,
  parseClock,
  parseDays,
  parseInstant,
  parseRule,
  type Rule,
} from "./schedule";
import { duration } from "./spoken_time";
import type { Tool } from "./tools";
import type { ToolContext } from "./types";

const text = (args: Record<string, unknown>, key: string, max = 200): string =>
  typeof args[key] === "string" ? (args[key] as string).trim().slice(0, max) : "";
const int = (args: Record<string, unknown>, key: string): number | null =>
  typeof args[key] === "number" && Number.isFinite(args[key]) ? Math.round(args[key] as number) : null;

const MAX_TIMER_S = 7 * 86_400;
const NO_REPEAT = new Set(["none", "no", "never", "once", "one-off", "one off", "false"]);

type TimingResult = { rule: Rule; seconds?: number } | { error: string };

/** Models fill every field of a strict schema; 0, "", [] and "none" mean the field was not meant. */
const blank = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === 0 ||
  value === false ||
  (typeof value === "string" && (value.trim() === "" || value.trim() === "0")) ||
  (Array.isArray(value) && value.length === 0);

const wantsRepeat = (repeat: unknown): boolean =>
  !blank(repeat) && !(typeof repeat === "string" && NO_REPEAT.has(repeat.trim().toLowerCase()));

/** True when the arguments say anything about when, so update_alarm knows whether to reschedule. */
export const hasTiming = (args: Record<string, unknown>): boolean =>
  ["in_seconds", "at", "time"].some((key) => !blank(args[key])) || wantsRepeat(args.repeat);

const nowText = (now: number, timezone: string) => `it is now ${localIso(now, timezone)} in ${timezone}`;

function fromSeconds(value: unknown, now: number): TimingResult {
  const seconds = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return { error: "in_seconds must be a number of seconds from now" };
  }
  const whole = Math.round(seconds);
  if (whole < 1 || whole > MAX_TIMER_S) {
    return { error: "in_seconds must be between 1 and 604800 (a week)" };
  }
  return { rule: { kind: "at", at: now + whole * 1000 }, seconds: whole };
}

/** `at` as a date and time (local, or with an offset), or a bare clock time meaning its next occurrence. */
function fromAt(at: string, timezone: string, now: number): TimingResult {
  const clock = parseClock(at);
  if (clock) {
    return { rule: { kind: "at", at: nextClock(clock, timezone, now) } };
  }
  const instant = parseInstant(at, timezone);
  if (instant === null) {
    return { error: `at must be a local date and time, YYYY-MM-DDTHH:MM (${nowText(now, timezone)})` };
  }
  if (instant <= now) {
    return { error: `${at} has already passed (${nowText(now, timezone)}): ask the user which day they meant` };
  }
  return { rule: { kind: "at", at: instant } };
}

function fromTime(time: string, timezone: string, now: number): TimingResult {
  const clock = parseClock(time);
  return clock
    ? { rule: { kind: "at", at: nextClock(clock, timezone, now) } }
    : { error: "time must be a time of day such as 07:00 or 9pm" };
}

/** A repeat: the time of day from `time` or `at`; "weekly" takes its day from `at`, else today. */
function fromRepeat(args: Record<string, unknown>, timezone: string, now: number): TimingResult {
  const at = text(args, "at");
  const instant = at ? parseInstant(at, timezone) : null;
  const clock =
    parseClock(text(args, "time")) ??
    (at ? parseClock(at) : null) ??
    (instant === null ? null : localParts(instant, timezone));
  if (!clock) {
    return { error: "a repeating alarm needs time, the local time of day such as 07:00" };
  }
  const repeat = args.repeat;
  const weekly = typeof repeat === "string" && /^(weekly|every week)$/i.test(repeat.trim());
  const weekday = (ms: number) => {
    const p = localParts(ms, timezone);
    return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  };
  const days = weekly ? [weekday(instant ?? now)] : parseDays(repeat);
  if (!days) {
    return {
      error: 'repeat must be daily, weekdays, weekends, weekly or days such as ["mon", "thu"] or "every Friday"',
    };
  }
  return { rule: { kind: "repeat", time: clockText(clock), days, tz: timezone } };
}

/**
 * The rule from whatever the model passed. Blank fields are ignored; a repeat wins when one is asked for;
 * otherwise each given field is tried, the likeliest first (in_seconds for a timer, the clock time for
 * anything else), and the first that makes sense is used. `in_seconds` is added to the server's clock,
 * so the model never does clock arithmetic.
 */
export function ruleFrom(args: Record<string, unknown>, timezone: string, now: number): TimingResult {
  if (wantsRepeat(args.repeat)) {
    return fromRepeat(args, timezone, now);
  }
  const at = text(args, "at");
  const time = text(args, "time");
  const clockTries = [
    ...(at ? [() => fromAt(at, timezone, now)] : []),
    ...(time ? [() => fromTime(time, timezone, now)] : []),
  ];
  const secondTries = blank(args.in_seconds) ? [] : [() => fromSeconds(args.in_seconds, now)];
  const tries = text(args, "kind") === "timer" ? [...secondTries, ...clockTries] : [...clockTries, ...secondTries];
  let first: TimingResult | null = null;
  for (const attempt of tries) {
    const result = attempt();
    if (!("error" in result)) {
      return result;
    }
    first ??= result;
  }
  return (
    first ?? { error: "say when: in_seconds for a timer ('in 10 minutes'), at for a clock time, or time with repeat" }
  );
}

const kindOf = (args: Record<string, unknown>): AlarmKind | null => {
  const kind = text(args, "kind");
  return kind === "" ? null : (ALARM_KINDS as readonly string[]).includes(kind) ? (kind as AlarmKind) : null;
};

const TIMING = {
  in_seconds: {
    type: "integer",
    description:
      "For a timer or anything relative ('in 10 minutes', 'in an hour'): seconds from now. The server adds it " +
      "to its own clock, so never work out the clock time yourself.",
  },
  at: {
    type: "string",
    description:
      "A one-off at a clock time: the user's LOCAL date and time, YYYY-MM-DDTHH:MM ('tomorrow at 1pm'). A bare " +
      "time such as 21:00 means the next 21:00.",
  },
  time: {
    type: "string",
    description: "The local time of day, HH:MM (24 hour): with repeat, or alone for the next time the clock shows it.",
  },
  repeat: {
    description:
      'For repeating alarms, with time: daily, weekdays, weekends, weekly, or days such as ["mon", "thu"]. ' +
      "Leave it out for a one-off.",
    anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
  },
};

const ID = { type: "string", description: "The alarm's id, from list_alarms or set_alarm" };

export const ALARM_TOOLS: Tool[] = [
  {
    skill: "alarms",
    definition: {
      type: "function",
      name: "set_alarm",
      description:
        "Set an alarm, timer or reminder that rings on a speaker at the exact time, Alexa style. A timer is " +
        "'for N minutes' (in_seconds); an alarm is a clock time (at, or time + repeat); a reminder speaks its " +
        "message at the time. Every 'remind me to X' is this tool with kind reminder and message X, never a " +
        "memory; if the user gave no time, ask when first. Pass only the fields you need. It rings on the speaker the user is talking from, " +
        "or the home's only speaker; otherwise the result asks which: ask them, then call again with speaker. " +
        "Confirm in a few words with the result's `say`, such as 'Alarm set for today at 21:00'.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...ALARM_KINDS], description: "alarm (default), timer or reminder" },
          ...TIMING,
          label: { type: "string", description: "Optional name, such as 'gym' or 'pasta'" },
          message: { type: "string", description: "For a reminder: what to say, such as 'take the bins out'" },
          speaker: { type: "string", description: "The speaker's name, when the user chose one" },
        },
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const where = await homes.locale(c.env.DB, c.user.home);
      const now = Date.now();
      const timing = ruleFrom(args, where.timezone, now);
      if ("error" in timing) {
        return timing;
      }
      const kind = kindOf(args) ?? (timing.seconds !== undefined ? "timer" : "alarm");
      const message = text(args, "message", 500);
      if (kind === "reminder" && !message && !text(args, "label")) {
        return { error: "a reminder needs a message: ask the user what to remind them of" };
      }
      const speaker = await defaultSpeaker(c, c.user.home, c.device, text(args, "speaker"));
      if ("error" in speaker) {
        return speaker;
      }
      const label =
        text(args, "label") || (kind === "timer" && timing.seconds ? `${duration(timing.seconds)} timer` : "");
      const row = await createAlarm(
        c,
        c.user.home,
        { kind, rule: timing.rule, label, message, deviceId: speaker.device.id, via: viaOf(c) },
        now,
      );
      const show = await presenter(c, c.user.home);
      return { ok: true, ...show.alarm(row) };
    },
  },
  {
    skill: "alarms",
    definition: {
      type: "function",
      name: "list_alarms",
      description: "The user's alarms, timers and reminders still to come (and switched-off ones), soonest first.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    run: async (c) => {
      const show = await presenter(c, c.user.home);
      return (await alarms.list(c.env.DB, c.user.home)).map(show.alarm);
    },
  },
  {
    skill: "alarms",
    definition: {
      type: "function",
      name: "update_alarm",
      description:
        "Change an alarm: switch it on or off, rename it, move it to another speaker, or change when it rings " +
        "(the same timing fields as set_alarm).",
      parameters: {
        type: "object",
        properties: {
          id: ID,
          enabled: { type: "boolean" },
          label: { type: "string" },
          message: { type: "string" },
          speaker: { type: "string", description: "Move it to the speaker with this name" },
          ...TIMING,
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const id = text(args, "id");
      const changes: Parameters<typeof updateAlarm>[3] = {};
      if (typeof args.enabled === "boolean") {
        changes.enabled = args.enabled;
      }
      if (text(args, "label")) {
        changes.label = text(args, "label");
      }
      if (text(args, "message", 500)) {
        changes.message = text(args, "message", 500);
      }
      if (text(args, "speaker")) {
        const speaker = await defaultSpeaker(c, c.user.home, undefined, text(args, "speaker"));
        if ("error" in speaker) {
          return speaker;
        }
        changes.deviceId = speaker.device.id;
      }
      if (hasTiming(args)) {
        const where = await homes.locale(c.env.DB, c.user.home);
        const current = await alarms.get(c.env.DB, c.user.home, id);
        const rule = current ? parseRule(current.rule) : null;
        // A new time for a repeating alarm keeps its days unless new ones are given
        const keepDays = rule?.kind === "repeat" && !wantsRepeat(args.repeat) && blank(args.in_seconds);
        const timing = ruleFrom(
          keepDays ? { ...args, repeat: rule.days.map((d) => DAY_NAMES[d]) } : args,
          where.timezone,
          Date.now(),
        );
        if ("error" in timing) {
          return timing;
        }
        changes.rule = timing.rule;
      }
      const row = await updateAlarm(c, c.user.home, id, changes);
      if (!row) {
        return { error: "no such alarm: call list_alarms for the ids" };
      }
      return { ok: true, ...(await presenter(c, c.user.home)).alarm(row) };
    },
  },
  {
    skill: "alarms",
    definition: {
      type: "function",
      name: "delete_alarm",
      description: "Delete an alarm, timer or reminder for good.",
      parameters: { type: "object", properties: { id: ID }, required: ["id"], additionalProperties: false },
    },
    run: async (c, args) =>
      (await deleteAlarm(c, c.user.home, text(args, "id")))
        ? { ok: true }
        : { error: "no such alarm: call list_alarms for the ids" },
  },
  {
    skill: "alarms",
    definition: {
      type: "function",
      name: "stop_alarm",
      description: "Stop an alarm or timer that is ringing now (all of them when no id is given).",
      parameters: { type: "object", properties: { id: ID }, additionalProperties: false },
    },
    run: async (c, args) => ({
      ok: true,
      ...(await signalRinging(c, c.user.home, text(args, "id") || null, null)),
    }),
  },
  {
    skill: "alarms",
    definition: {
      type: "function",
      name: "snooze_alarm",
      description:
        "Snooze what is ringing now. If the user said only 'snooze', ask for how long before calling; 9 minutes " +
        "if they leave it to you.",
      parameters: {
        type: "object",
        properties: { id: ID, minutes: { type: "integer", minimum: 1, maximum: 120 } },
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const minutes = Math.min(120, Math.max(1, int(args, "minutes") ?? DEFAULT_SNOOZE_MINUTES));
      return { ok: true, minutes, ...(await signalRinging(c, c.user.home, text(args, "id") || null, minutes)) };
    },
  },
];

const viaOf = (c: ToolContext): string => (c.device ? "speaker" : c.onCall ? "call" : "app");
