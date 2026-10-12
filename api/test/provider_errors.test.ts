import { describe, expect, it } from "vitest";
import { redactKeys } from "../src/provider_errors";

describe("provider errors", () => {
  it("never repeats a key fragment", () => {
    expect(redactKeys("Incorrect API key provided: sk-proj-abc****xyz1. You can find")).toBe(
      "Incorrect API key provided: sk-***. You can find",
    );
    expect(redactKeys("rate limited")).toBe("rate limited");
  });
});
