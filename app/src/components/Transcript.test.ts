import { describe, expect, it } from "vitest";
import { appendTurn, type Turn } from "./Transcript";

describe("appendTurn", () => {
  it("grows the current bubble and switches bubbles when the other side talks", () => {
    let turns: Turn[] = [];
    turns = appendTurn(turns, "user", "Turn on ", 1000);
    turns = appendTurn(turns, "user", "the lights", 1001);
    expect(turns).toEqual([{ id: 1000, role: "user", text: "Turn on the lights", endedAt: null }]);
    turns = appendTurn(turns, "assistant", "Done.", 2000);
    expect(turns[0]?.endedAt).toBe(2000);
    expect(turns[1]).toMatchObject({ role: "assistant", text: "Done.", endedAt: null });
    turns = appendTurn(turns, "user", "Thanks", 3000);
    expect(turns.map((t) => t.endedAt)).toEqual([2000, 3000, null]);
  });
});
