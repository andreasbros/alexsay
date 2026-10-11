import { describe, expect, it } from "vitest";
import { ASSISTANT_FAREWELL, isSignOff, NoiseGate, USER_FAREWELL } from "./live";

describe("NoiseGate", () => {
  it("keeps a steady room hum at zero and lets speech through", () => {
    const gate = new NoiseGate();
    for (let i = 0; i < 50; i++) {
      expect(gate.pass(0.04 + (i % 3) * 0.003)).toBe(0);
    }
    expect(gate.pass(0.25)).toBe(0);
    expect(gate.pass(0.25)).toBeGreaterThan(0.4);
    expect(gate.pass(0.04)).toBe(0);
  });

  it("ignores a single spike such as a click", () => {
    const gate = new NoiseGate();
    expect(gate.pass(0.5)).toBe(0);
    expect(gate.pass(0.02)).toBe(0);
  });

  it("does not learn speech as the floor", () => {
    const gate = new NoiseGate();
    for (let i = 0; i < 100; i++) {
      gate.pass(0.3);
    }
    expect(gate.pass(0.3)).toBeGreaterThan(0.5);
  });
});

describe("farewells", () => {
  it("hears the user signing off in many ways", () => {
    for (const said of [
      "ok bye",
      "Goodbye Alexsay",
      "thanks, that's all",
      "see you later",
      "good night",
      "end the conversation",
    ]) {
      expect(USER_FAREWELL.test(said)).toBe(true);
    }
    expect(USER_FAREWELL.test("by the way, what time is it")).toBe(false);
    expect(USER_FAREWELL.test("turn the hall light on")).toBe(false);
  });

  it("ends on the assistant's short sign-off, or any sign-off right after the user's goodbye", () => {
    expect(isSignOff("Bye for now, Andreas.", null)).toBe(true);
    expect(isSignOff("Good night, sleep well.", null)).toBe(true);
    const long =
      "Sure. The kitchen lights are on, the hall light is off, and the thermostat is set to twenty. Take care if you head out later, it is cold.";
    expect(isSignOff(long, null)).toBe(false);
    expect(isSignOff(long, 3000)).toBe(true);
    expect(isSignOff("The lights are on now.", 1000)).toBe(false);
    expect(ASSISTANT_FAREWELL.test("Have a great evening!")).toBe(true);
  });
});
