import { describe, expect, it } from "vitest";
import { applyMute, callerOf } from "./phone_line";

describe("applyMute", () => {
  it("silences every track of the call at the source and restores them", () => {
    const tracks = [{ enabled: true }, { enabled: true }];
    applyMute(tracks, true);
    expect(tracks.map((t) => t.enabled)).toEqual([false, false]);
    applyMute(tracks, false);
    expect(tracks.map((t) => t.enabled)).toEqual([true, true]);
  });
});

describe("callerOf", () => {
  it("names the assistant's own conference legs and otherwise the caller", () => {
    expect(
      callerOf({ parameters: { From: "client:alexsay-app" }, customParameters: new Map([["conference", "ay-1"]]) }),
    ).toBe("the assistant's call");
    expect(callerOf({ parameters: { From: "+447700900123" }, customParameters: new Map() })).toBe("+447700900123");
    expect(callerOf({ parameters: {}, customParameters: new Map() })).toBe("unknown number");
  });
});
