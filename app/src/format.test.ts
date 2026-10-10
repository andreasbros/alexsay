import { describe, expect, it } from "vitest";
import { ago, isUuid } from "./format";

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
});
