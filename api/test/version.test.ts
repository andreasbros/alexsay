import { describe, expect, it } from "vitest";
import { atLeastVersion, speakerCarriesAssistant } from "../src/version";

describe("speaker versions", () => {
  it("compares numerically and treats unknown versions as too old", () => {
    expect(atLeastVersion("0.1.6", "0.1.6")).toBe(true);
    expect(atLeastVersion("0.1.10", "0.1.6")).toBe(true);
    expect(atLeastVersion("v1.0.0", "0.1.6")).toBe(true);
    expect(atLeastVersion("0.1.5", "0.1.6")).toBe(false);
    expect(atLeastVersion(null, "0.1.6")).toBe(false);
    expect(atLeastVersion("dev", "0.1.6")).toBe(false);
    expect(speakerCarriesAssistant("0.1.5")).toBe(false);
    expect(speakerCarriesAssistant("0.2.0")).toBe(true);
  });
});
