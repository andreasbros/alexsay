import { describe, expect, it } from "vitest";
import { levelFromHistory } from "./speech";

describe("speech level", () => {
  it("is zero for room noise below -50 dBFS and for a lone spike", () => {
    expect(levelFromHistory([-70, -68, -72, -69, -71, -70])).toBe(0);
    expect(levelFromHistory([-70, -68, -30, -69, -71, -70])).toBe(0);
  });

  it("rises with speech that holds above the threshold", () => {
    expect(levelFromHistory([-40, -38, -42, -39, -70, -41])).toBeGreaterThan(0.2);
    expect(levelFromHistory([-20, -18, -16, -15, -17, -19])).toBe(1);
  });
});
