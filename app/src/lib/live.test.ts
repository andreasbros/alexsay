import { describe, expect, it } from "vitest";
import { NoiseGate } from "./live";

describe("NoiseGate", () => {
  it("keeps a steady room hum at zero and lets speech through", () => {
    const gate = new NoiseGate();
    for (let i = 0; i < 50; i++) {
      expect(gate.pass(0.04 + (i % 3) * 0.003)).toBe(0);
    }
    expect(gate.pass(0.25)).toBeGreaterThan(0.4);
    expect(gate.pass(0.04)).toBe(0);
  });

  it("does not learn speech as the floor", () => {
    const gate = new NoiseGate();
    for (let i = 0; i < 100; i++) {
      gate.pass(0.3);
    }
    expect(gate.pass(0.3)).toBeGreaterThan(0.5);
  });
});
