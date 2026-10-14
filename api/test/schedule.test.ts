import { describe, expect, it } from "vitest";
import { describeRepeat, localToUtc, nextOccurrence, occurrences, parseDays, parseLocal } from "../src/schedule";

const LONDON = "Europe/London";
const utc = (iso: string) => Date.parse(iso);

describe("schedule", () => {
  it("turns a London wall-clock time into UTC in winter and in summer", () => {
    expect(localToUtc({ year: 2026, month: 1, day: 15, hour: 7, minute: 0 }, LONDON)).toBe(utc("2026-01-15T07:00Z"));
    expect(localToUtc({ year: 2026, month: 7, day: 15, hour: 7, minute: 0 }, LONDON)).toBe(utc("2026-07-15T06:00Z"));
    expect(localToUtc({ year: 2026, month: 7, day: 15, hour: 7, minute: 0 }, "America/New_York")).toBe(
      utc("2026-07-15T11:00Z"),
    );
  });

  it("moves a time the clocks skip on by the jump, and takes the first of a time that happens twice", () => {
    // 29 Mar 2026: 01:00 GMT jumps to 02:00 BST
    expect(localToUtc({ year: 2026, month: 3, day: 29, hour: 1, minute: 30 }, LONDON)).toBe(utc("2026-03-29T01:30Z"));
    // 25 Oct 2026: 01:30 happens in BST (00:30Z) and again in GMT (01:30Z)
    expect(localToUtc({ year: 2026, month: 10, day: 25, hour: 1, minute: 30 }, LONDON)).toBe(utc("2026-10-25T00:30Z"));
  });

  it("keeps a daily 07:00 at 07:00 local across the change to winter time", () => {
    const rule = { kind: "repeat" as const, time: "07:00", days: [0, 1, 2, 3, 4, 5, 6], tz: LONDON };
    expect(occurrences(rule, utc("2026-10-23T12:00Z"), 4)).toEqual([
      utc("2026-10-24T06:00Z"),
      utc("2026-10-25T07:00Z"),
      utc("2026-10-26T07:00Z"),
      utc("2026-10-27T07:00Z"),
    ]);
  });

  it("finds the next weekday, skipping the weekend, and today when it is still ahead", () => {
    const rule = { kind: "repeat" as const, time: "07:30", days: [1, 2, 3, 4, 5], tz: LONDON };
    // Friday 16 Oct 2026, 08:00 BST: next is Monday
    expect(nextOccurrence(rule, utc("2026-10-16T07:00Z"))).toBe(utc("2026-10-19T06:30Z"));
    // Monday 05:00 BST: later the same morning
    expect(nextOccurrence(rule, utc("2026-10-19T04:00Z"))).toBe(utc("2026-10-19T06:30Z"));
  });

  it("fires a one-off once, and never again", () => {
    const rule = { kind: "at" as const, at: utc("2026-10-15T12:00Z") };
    expect(nextOccurrence(rule, utc("2026-10-15T11:59Z"))).toBe(rule.at);
    expect(nextOccurrence(rule, rule.at)).toBeNull();
    expect(occurrences(rule, 0, 3)).toEqual([rule.at]);
  });

  it("reads local times, days and presets, refusing nonsense", () => {
    expect(parseLocal("2026-10-15T13:00")).toEqual({ year: 2026, month: 10, day: 15, hour: 13, minute: 0 });
    expect(parseLocal("2026-02-30T13:00")).toBeNull();
    expect(parseLocal("tomorrow")).toBeNull();
    expect(parseDays("weekdays")).toEqual([1, 2, 3, 4, 5]);
    expect(parseDays(["Monday", "thu"])).toEqual([1, 4]);
    expect(parseDays(["someday"])).toBeNull();
    expect(describeRepeat({ kind: "repeat", time: "07:00", days: [1, 2, 3, 4, 5], tz: LONDON })).toBe(
      "weekdays at 07:00",
    );
    expect(describeRepeat({ kind: "repeat", time: "18:30", days: [1, 4], tz: LONDON })).toBe("Mon, Thu at 18:30");
  });
});
