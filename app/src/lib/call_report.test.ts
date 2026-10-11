import { describe, expect, it } from "vitest";
import type { CallReport } from "../api";
import { callReportNote } from "./call_report";

const report: CallReport = {
  conference: "ay-1",
  started_at: Date.UTC(2026, 9, 11, 15, 0, 0),
  ended_at: Date.UTC(2026, 9, 11, 15, 1, 5),
  ended_by: "other side",
  ready: true,
  task: "ask whether Sunday lunch is on",
  seconds: 65,
  participants: [
    { who: "the user, in the app", role: "host", status: "completed", seconds: 65, answered: true },
    { who: "Mum (+447700900123)", role: "guest", status: "completed", seconds: 60, answered: true },
    { who: "you, the assistant", role: "assistant", status: "completed", seconds: 58, answered: true },
  ],
  transcript: [
    { at: Date.UTC(2026, 9, 11, 15, 0, 10), speaker: "line", text: "Hello?" },
    { at: Date.UTC(2026, 9, 11, 15, 0, 12), speaker: "assistant", text: "Hi, this is Alexsay calling for Andreas." },
  ],
};

describe("call report note", () => {
  it("states the facts, then the transcript with times and speakers", () => {
    const note = callReportNote(report);
    expect(note).toContain("not spoken by the user");
    expect(note).toContain("lasted 1 min 5 s, ended by other side");
    expect(note).toContain("Mum (+447700900123): answered");
    expect(note).toContain("Task given: ask whether Sunday lunch is on");
    expect(note).toMatch(/\d\d:\d\d:\d\d the line \(user or the other side\): Hello\?/);
    expect(note).toMatch(/Alexsay \(on the call\): Hi, this is Alexsay/);
    expect(note).not.toContain("missing its last words");
  });

  it("says when nobody answered and when the transcript may be short", () => {
    const note = callReportNote({
      ...report,
      ready: false,
      ended_by: "user",
      seconds: 20,
      transcript: [],
      participants: [
        report.participants[0] as CallReport["participants"][number],
        { who: "+447700900999", role: "guest", status: "no-answer", seconds: 0, answered: false },
      ],
    });
    expect(note).toContain("lasted 20 s, ended by user");
    expect(note).toContain("+447700900999: did not answer (no-answer)");
    expect(note).toContain("Assistant on the line: no");
    expect(note).toContain("missing its last words");
    expect(note).toContain("No transcript was recorded.");
  });
});
