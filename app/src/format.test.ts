import { describe, expect, it } from "vitest";
import { atLeastVersion } from "./format";

describe("atLeastVersion", () => {
  it("compares speaker versions numerically and treats unknown ones as too old", () => {
    expect(atLeastVersion("0.1.4", "0.1.4")).toBe(true);
    expect(atLeastVersion("0.1.10", "0.1.4")).toBe(true);
    expect(atLeastVersion("v1.0.0", "0.1.4")).toBe(true);
    expect(atLeastVersion("0.1.3", "0.1.4")).toBe(false);
    expect(atLeastVersion("0.1", "0.1.4")).toBe(false);
    expect(atLeastVersion(null, "0.1.4")).toBe(false);
    expect(atLeastVersion("dev", "0.1.4")).toBe(false);
  });
});

import { ago, alarmTitle, isUuid } from "./format";

describe("format", () => {
  it("words a last-seen stamp", () => {
    const now = 10_000_000;
    expect(ago(null, now)).toBe("never");
    expect(ago(now - 5_000, now)).toBe("just now");
    expect(ago(now - 180_000, now)).toBe("3 min ago");
    expect(ago(now - 7_200_000, now)).toBe("2 h ago");
  });

  it("accepts UUIDs in any case", () => {
    expect(isUuid(" 7D1D6E2E-7c7b-4f6a-9d0a-1d2e3f4a5b6c ")).toBe(true);
    expect(isUuid("speaker-1")).toBe(false);
  });
  it("names an alarm by its label, or by what it is", () => {
    expect(alarmTitle({ kind: "alarm", label: "gym" })).toBe("Gym");
    expect(alarmTitle({ kind: "timer", label: "" })).toBe("Timer");
    expect(alarmTitle({ kind: "reminder", label: "", message: "take the bins out" })).toBe(
      "Reminder: take the bins out",
    );
  });
});
