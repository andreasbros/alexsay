import { describe, expect, it } from "vitest";
import { hasTiming, ruleFrom } from "../src/alarm_tools";
import { localIso, parseClock, parseDays, parseInstant } from "../src/schedule";
import { everyWords, spokenWhen } from "../src/spoken_time";

const LONDON = "Europe/London";
// Tuesday 14 Oct 2026, 18:42:07 in London (BST, +01:00)
const NOW = Date.parse("2026-10-14T17:42:07Z");
const utc = (iso: string) => Date.parse(iso);
const at = (instant: number) => ({ rule: { kind: "at", at: instant } });
const repeat = (time: string, days: number[], tz = LONDON) => ({ rule: { kind: "repeat", time, days, tz } });
const FILLED = { kind: "alarm", in_seconds: 0, at: "", time: "", repeat: [], label: "", message: "", speaker: "" };

describe("ruleFrom: what the model may send", () => {
  it.each([
    ["a local date and time", { at: "2026-10-14T21:00" }, at(utc("2026-10-14T20:00:00Z"))],
    ["seconds on the time", { at: "2026-10-14T21:00:00" }, at(utc("2026-10-14T20:00:00Z"))],
    ["a space instead of T", { at: "2026-10-14 21:00" }, at(utc("2026-10-14T20:00:00Z"))],
    ["UTC with Z", { at: "2026-10-14T20:00:00Z" }, at(utc("2026-10-14T20:00:00Z"))],
    ["an explicit offset", { at: "2026-10-14T21:00:00+01:00" }, at(utc("2026-10-14T20:00:00Z"))],
    ["a bare clock in at, still ahead today", { at: "21:00" }, at(utc("2026-10-14T20:00:00Z"))],
    ["a bare clock in at, already gone today", { at: "07:00" }, at(utc("2026-10-15T06:00:00Z"))],
    ["9pm in at", { at: "9pm" }, at(utc("2026-10-14T20:00:00Z"))],
    ["time alone is a one-off", { time: "21:30" }, at(utc("2026-10-14T20:30:00Z"))],
    ["time alone, gone today, is tomorrow", { time: "6:15 am" }, at(utc("2026-10-15T05:15:00Z"))],
    ["seconds", { in_seconds: 60 }, at(NOW + 60_000)],
    ["seconds as a string", { in_seconds: "90" }, at(NOW + 90_000)],
    ["seconds with a fraction", { in_seconds: 59.6 }, at(NOW + 60_000)],
    ["every field filled, the clock given", { ...FILLED, at: "2026-10-14T21:00" }, at(utc("2026-10-14T20:00:00Z"))],
    ["every field filled, seconds given", { ...FILLED, in_seconds: 8340 }, at(NOW + 8_340_000)],
    ["repeat none is a one-off", { at: "2026-10-14T21:00", repeat: "none" }, at(utc("2026-10-14T20:00:00Z"))],
    ["an alarm prefers the clock over seconds", { in_seconds: 60, at: "21:00" }, at(utc("2026-10-14T20:00:00Z"))],
    ["a timer prefers seconds over the clock", { kind: "timer", in_seconds: 60, at: "21:00" }, at(NOW + 60_000)],
    ["a passed clock falls back to seconds", { at: "2026-10-14T09:00", in_seconds: 600 }, at(NOW + 600_000)],
    ["a bad clock falls back to seconds", { at: "soon", in_seconds: 600 }, at(NOW + 600_000)],
  ])("one-off from %s", (_, args, expected) => {
    expect(ruleFrom(args, LONDON, NOW)).toMatchObject(expected);
  });

  it.each([
    ["daily", { time: "07:00", repeat: "daily" }, repeat("07:00", [0, 1, 2, 3, 4, 5, 6])],
    ["every day", { time: "07:00", repeat: "every day" }, repeat("07:00", [0, 1, 2, 3, 4, 5, 6])],
    ["weekdays", { time: "7am", repeat: "weekdays" }, repeat("07:00", [1, 2, 3, 4, 5])],
    ["weekends", { time: "09:30", repeat: "weekends" }, repeat("09:30", [0, 6])],
    ["a list of short names", { time: "18:30", repeat: ["mon", "thu"] }, repeat("18:30", [1, 4])],
    ["a list of full names", { time: "18:30", repeat: ["Monday", "Thursday"] }, repeat("18:30", [1, 4])],
    ["a sentence", { time: "18:30", repeat: "every Monday and Thursday" }, repeat("18:30", [1, 4])],
    ["plural days", { time: "18:30", repeat: "Fridays" }, repeat("18:30", [5])],
    ["comma separated", { time: "18:30", repeat: "tue,thu" }, repeat("18:30", [2, 4])],
    ["the time taken from at", { at: "2026-10-16T08:00", repeat: "daily" }, repeat("08:00", [0, 1, 2, 3, 4, 5, 6])],
    ["weekly takes the day from at", { at: "2026-10-16T08:00", repeat: "weekly" }, repeat("08:00", [5])],
    ["weekly with time alone is today's weekday", { time: "08:00", repeat: "weekly" }, repeat("08:00", [3])],
    [
      "repeat wins over seconds",
      { ...FILLED, in_seconds: 60, time: "07:00", repeat: "daily" },
      repeat("07:00", [0, 1, 2, 3, 4, 5, 6]),
    ],
  ])("repeat from %s", (_, args, expected) => {
    expect(ruleFrom(args, LONDON, NOW)).toEqual(expected);
  });

  it("keeps the seconds for a timer's label", () => {
    expect(ruleFrom({ in_seconds: 300 }, LONDON, NOW)).toEqual({ ...at(NOW + 300_000), seconds: 300 });
  });

  it("reads local times across the clock change", () => {
    // 25 Oct 2026 the UK goes back to GMT
    expect(ruleFrom({ at: "2026-10-26T07:00" }, LONDON, NOW)).toEqual(at(utc("2026-10-26T07:00:00Z")));
    expect(ruleFrom({ at: "2026-10-15T07:00" }, "America/New_York", NOW)).toEqual(at(utc("2026-10-15T11:00:00Z")));
  });

  it.each([
    ["nothing", {}, "say when"],
    ["every field blank", FILLED, "say when"],
    [
      "a date in the past",
      { at: "2026-10-14T09:00" },
      "already passed (it is now 2026-10-14T18:42:07+01:00 in Europe/London)",
    ],
    ["a date that is not one", { at: "2026-02-30T09:00" }, "YYYY-MM-DDTHH:MM"],
    ["words for a date", { at: "next tuesday" }, "YYYY-MM-DDTHH:MM"],
    ["a time that is not one", { time: "25:00" }, "time of day"],
    ["a bare number for a time", { time: "9" }, "time of day"],
    ["negative seconds", { in_seconds: -5 }, "between 1 and 604800"],
    ["more than a week", { in_seconds: 700_000 }, "between 1 and 604800"],
    ["seconds that are not a number", { in_seconds: "ten" }, "number of seconds"],
    ["a repeat with no time", { repeat: "daily" }, "needs time"],
    ["a repeat with seconds only", { in_seconds: 60, repeat: "daily" }, "needs time"],
    ["an unknown repeat", { time: "07:00", repeat: "fortnightly" }, "repeat must be"],
    ["a word that only starts like a day", { time: "07:00", repeat: ["month"] }, "repeat must be"],
    ["the first failure when every try fails", { at: "2026-10-14T09:00", in_seconds: -1 }, "already passed"],
  ])("refuses %s", (_, args, message) => {
    const result = ruleFrom(args, LONDON, NOW);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain(message);
  });

  it("knows when update_alarm was given a time at all", () => {
    expect(hasTiming(FILLED)).toBe(false);
    expect(hasTiming({ ...FILLED, repeat: "none" })).toBe(false);
    expect(hasTiming({ ...FILLED, time: "07:00" })).toBe(true);
    expect(hasTiming({ ...FILLED, repeat: "daily" })).toBe(true);
    expect(hasTiming({ in_seconds: 60 })).toBe(true);
  });
});

describe("parsing helpers", () => {
  it.each([
    ["21:00", { hour: 21, minute: 0 }],
    ["7:05", { hour: 7, minute: 5 }],
    ["07:00:00", { hour: 7, minute: 0 }],
    ["9pm", { hour: 21, minute: 0 }],
    ["9 PM", { hour: 21, minute: 0 }],
    ["9.30 p.m.", { hour: 21, minute: 30 }],
    ["12am", { hour: 0, minute: 0 }],
    ["12pm", { hour: 12, minute: 0 }],
    ["21h30", { hour: 21, minute: 30 }],
    ["9", null],
    ["13pm", null],
    ["24:00", null],
    ["10:60", null],
    ["noon-ish", null],
  ])("clock %s", (text, expected) => {
    expect(parseClock(text)).toEqual(expected);
  });

  it("instants, local and absolute", () => {
    expect(parseInstant("2026-10-14T21:00", LONDON)).toBe(utc("2026-10-14T20:00:00Z"));
    expect(parseInstant("2026-10-14T21:00:00-04:00", LONDON)).toBe(utc("2026-10-15T01:00:00Z"));
    expect(parseInstant("2026-10-14T21:00+0530", LONDON)).toBe(utc("2026-10-14T15:30:00Z"));
    expect(parseInstant("2026-13-01T21:00", LONDON)).toBeNull();
    expect(parseInstant("tomorrow", LONDON)).toBeNull();
  });

  it("days", () => {
    expect(parseDays("Weekdays")).toEqual([1, 2, 3, 4, 5]);
    expect(parseDays("weekend")).toEqual([0, 6]);
    expect(parseDays("every weekday")).toEqual([1, 2, 3, 4, 5]);
    expect(parseDays(["sun", "Saturday"])).toEqual([0, 6]);
    expect(parseDays("thurs and tues")).toEqual([2, 4]);
    expect(parseDays([])).toBeNull();
    expect(parseDays("someday")).toBeNull();
  });

  it("ISO 8601 in the user's zone, offset included", () => {
    expect(localIso(utc("2026-10-14T20:00:00Z"), LONDON)).toBe("2026-10-14T21:00:00+01:00");
    expect(localIso(utc("2026-12-01T07:00:00Z"), LONDON)).toBe("2026-12-01T07:00:00+00:00");
    expect(localIso(utc("2026-10-15T11:00:00Z"), "America/New_York")).toBe("2026-10-15T07:00:00-04:00");
    expect(localIso(utc("2026-10-14T20:00:00Z"), "Asia/Kolkata")).toBe("2026-10-15T01:30:00+05:30");
  });
});

describe("what the assistant says back", () => {
  const say = (next: number, kind = "alarm", locale = "en-GB", tz = LONDON) =>
    spokenWhen(next, { kind: "at", at: next }, kind, NOW, locale, tz);

  it.each([
    ["later today", utc("2026-10-14T20:00:00Z"), "alarm", "today at 21:00"],
    ["tomorrow", utc("2026-10-15T06:00:00Z"), "alarm", "tomorrow at 07:00"],
    ["this week", utc("2026-10-17T06:00:00Z"), "alarm", "on Saturday at 07:00"],
    ["further off", utc("2026-10-24T06:00:00Z"), "alarm", "on Saturday 24 October at 07:00"],
    ["within the hour", NOW + 600_000, "alarm", "in 10 minutes (today at 18:52)"],
    ["a one minute timer", NOW + 60_000, "timer", "in 1 minute (today at 18:43)"],
    ["a long timer", NOW + 5_400_000, "timer", "in 1 hour 30 minutes (today at 20:12)"],
    ["a timer past midnight", NOW + 7 * 3_600_000, "timer", "in 7 hours (tomorrow at 01:42)"],
  ])("%s", (_, next, kind, expected) => {
    expect(say(next, kind)).toBe(expected);
  });

  it("in the user's locale and zone", () => {
    expect(say(utc("2026-10-15T01:00:00Z"), "alarm", "en-US", "America/New_York")).toBe("today at 9:00 PM");
    expect(say(utc("2026-10-15T06:00:00Z"), "alarm", "de-DE", "Europe/Berlin")).toBe("tomorrow at 08:00");
  });

  it("repeats with their days and the next ring", () => {
    const rule = { kind: "repeat" as const, time: "07:00", days: [1, 2, 3, 4, 5], tz: LONDON };
    expect(spokenWhen(utc("2026-10-15T06:00:00Z"), rule, "alarm", NOW, "en-GB", LONDON)).toBe(
      "every weekday at 07:00, next tomorrow at 07:00",
    );
    expect(everyWords([0, 1, 2, 3, 4, 5, 6])).toBe("every day");
    expect(everyWords([0, 6])).toBe("every Saturday and Sunday");
    expect(everyWords([1, 3, 5])).toBe("every Monday, Wednesday and Friday");
    expect(everyWords([4])).toBe("every Thursday");
  });

  it("an alarm that is switched off", () => {
    expect(spokenWhen(null, null, "alarm", NOW, "en-GB", LONDON)).toBe("not scheduled");
  });
});
