import { describe, expect, it } from "vitest";
import { renderNotes } from "./sounds";

describe("earcons", () => {
  it("renders notes into a bounded clip that starts and ends in silence", () => {
    const clip = renderNotes([{ hz: 440, at: 0.05, length: 0.1 }], 0.3);
    expect(clip.length).toBe(7200);
    expect(clip[0]).toBe(0);
    expect(clip[clip.length - 1]).toBe(0);
    const peak = Math.max(...Array.from(clip).map(Math.abs));
    expect(peak).toBeGreaterThan(0.15);
    expect(peak).toBeLessThanOrEqual(1);
  });
});
