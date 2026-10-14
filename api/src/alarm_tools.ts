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
import { users } from "./db";
import { localToUtc, parseDays, parseLocal, type Rule, validTime } from "./schedule";
import type { Tool } from "./tools";
import type { ToolContext } from "./types";

const text = (args: Record<string, unknown>, key: string, max = 200): string =>
  typeof args[key] === "string" ? (args[key] as string).trim().slice(0, max) : "";
const int = (args: Record<string, unknown>, key: string): number | null =>
  typeof args[key] === "number" && Number.isFinite(args[key]) ? Math.round(args[key] as number) : null;

const MAX_TIMER_S = 7 * 86_400;

/** "1 minute", "1 hour 30 minutes": how long a timer runs, for its default label. */
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

/**
 * The rule from what the model passed: `in_seconds` (the server adds it to its own clock, so the model
 * never does clock arithmetic), `at` (a local date and time) or `time` with `repeat`.
 */
export function ruleFrom(
  args: Record<string, unknown>,
  timezone: string,
  now: number,
): { rule: Rule; seconds?: number } | { error: string } {
  const seconds = int(args, "in_seconds");
  const at = text(args, "at");
  const time = text(args, "time");
  const repeat = args.repeat;
  const given = [seconds !== null, at !== "", time !== "" || repeat !== undefined].filter(Boolean).length;
  if (given !== 1) {
    return { error: "give exactly one of in_seconds, at, or time with repeat" };
  }
  if (seconds !== null) {
    if (seconds < 1 || seconds > MAX_TIMER_S) {
      return { error: "in_seconds must be between 1 and 604800 (a week)" };
    }
    return { rule: { kind: "at", at: now + seconds * 1000 }, seconds };
  }
  if (at) {
    const local = parseLocal(at);
    if (!local) {
      return { error: "at must be a local date and time, YYYY-MM-DDTHH:MM" };
    }
    const instant = localToUtc(local, timezone);
    if (instant <= now) {
      return { error: `${at} has already passed in ${timezone}: ask the user which day they meant` };
    }
    return { rule: { kind: "at", at: instant } };
  }
  if (!validTime(time)) {
    return { error: "time must be HH:MM (24 hour) when repeating" };
  }
  const days = parseDays(repeat);
  if (!days) {
    return { error: 'repeat must be daily, weekdays, weekends or a list of days such as ["mon", "thu"]' };
  }
  return { rule: { kind: "repeat", time, days, tz: timezone } };
}

const kindOf = (args: Record<string, unknown>): AlarmKind | null => {
  const kind = text(args, "kind");
  return kind === "" ? null : (ALARM_KINDS as readonly string[]).includes(kind) ? (kind as AlarmKind) : null;
};

const TIMING = {
  in_seconds: {
    type: "integer",
    description:
      "For a timer or anything relative ('in 10 minutes'): seconds from now. The server does the clock maths.",
  },
  at: {
    type: "string",
    description: "A one-off at a clock time: the user's LOCAL date and time, YYYY-MM-DDTHH:MM ('tomorrow at 1pm').",
  },
  time: { type: "string", description: "With repeat: the local time of day, HH:MM (24 hour)." },
  repeat: {
    description: "With time, for repeating alarms: daily, weekdays, weekends, or a list of days.",
    anyOf: [
      { type: "string", enum: ["daily", "weekdays", "weekends"] },
      { type: "array", items: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] } },
    ],
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
        "message at the time. When the user has several speakers and is not talking from one, the result asks " +
        "which: ask them, then call again with speaker. Confirm briefly with the time from the result.",
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
      const where = await users.locale(c.env.DB, c.user.username);
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
      const speaker = await defaultSpeaker(c, c.user.username, c.device, text(args, "speaker"));
      if ("error" in speaker) {
        return speaker;
      }
      const label =
        text(args, "label") || (kind === "timer" && timing.seconds ? `${duration(timing.seconds)} timer` : "");
      const row = await createAlarm(
        c,
        c.user.username,
        { kind, rule: timing.rule, label, message, deviceId: speaker.device.id, via: viaOf(c) },
        now,
      );
      const show = await presenter(c, c.user.username);
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
      const show = await presenter(c, c.user.username);
      return (await alarms.list(c.env.DB, c.user.username)).map(show.alarm);
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
      if (typeof args.label === "string") {
        changes.label = text(args, "label");
      }
      if (typeof args.message === "string") {
        changes.message = text(args, "message", 500);
      }
      if (text(args, "speaker")) {
        const speaker = await defaultSpeaker(c, c.user.username, undefined, text(args, "speaker"));
        if ("error" in speaker) {
          return speaker;
        }
        changes.deviceId = speaker.device.id;
      }
      if (
        args.in_seconds !== undefined ||
        args.at !== undefined ||
        args.time !== undefined ||
        args.repeat !== undefined
      ) {
        const where = await users.locale(c.env.DB, c.user.username);
        const timing = ruleFrom(args, where.timezone, Date.now());
        if ("error" in timing) {
          return timing;
        }
        changes.rule = timing.rule;
      }
      const row = await updateAlarm(c, c.user.username, id, changes);
      if (!row) {
        return { error: "no such alarm: call list_alarms for the ids" };
      }
      return { ok: true, ...(await presenter(c, c.user.username)).alarm(row) };
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
      (await deleteAlarm(c, c.user.username, text(args, "id")))
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
      ...(await signalRinging(c, c.user.username, text(args, "id") || null, null)),
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
      return { ok: true, minutes, ...(await signalRinging(c, c.user.username, text(args, "id") || null, minutes)) };
    },
  },
];

const viaOf = (c: ToolContext): string => (c.device ? "speaker" : c.onCall ? "call" : "app");
