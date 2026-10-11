import { describe, expect, it } from "vitest";
import { applyMuteState } from "./mute";

const recorder = () => {
  const calls: boolean[] = [];
  return { calls, setMuted: (muted: boolean) => calls.push(muted) };
};

describe("applyMuteState", () => {
  it("mutes the conversation during a call, and both when the user muted", () => {
    const session = recorder();
    const line = recorder();
    applyMuteState({ muted: false, onCall: false }, session, line);
    applyMuteState({ muted: false, onCall: true }, session, line);
    applyMuteState({ muted: true, onCall: true }, session, line);
    applyMuteState({ muted: true, onCall: false }, session, line);
    expect(session.calls).toEqual([false, true, true, true]);
    expect(line.calls).toEqual([false, false, true, true]);
  });

  it("copes with either side missing", () => {
    const line = recorder();
    applyMuteState({ muted: true, onCall: false }, null, line);
    applyMuteState({ muted: false, onCall: false }, null, null);
    expect(line.calls).toEqual([true]);
  });
});
