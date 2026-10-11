import type { CallReport } from "../api";

const MAX_LINES = 80;
const MAX_CHARS = 6000;

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

/**
 * The note handed to the page's assistant the moment a call is over: the facts first, then what was
 * said, trimmed to what a spoken summary needs. It reads as a message from the app, not the user.
 */
export function callReportNote(report: CallReport): string {
  const minutes = Math.floor(report.seconds / 60);
  const seconds = report.seconds % 60;
  const length = minutes > 0 ? `${minutes} min ${seconds} s` : `${seconds} s`;
  const people = report.participants
    .filter((p) => p.role !== "assistant")
    .map((p) => `${p.who}: ${p.answered ? "answered" : `did not answer (${p.status})`}`)
    .join("; ");
  const assistant = report.participants.find((p) => p.role === "assistant");
  const lines = report.transcript.slice(-MAX_LINES).map((t) => {
    const who = t.speaker === "assistant" ? "Alexsay (on the call)" : "the line (user or the other side)";
    return `${clock(t.at)} ${who}: ${t.text}`;
  });
  let transcript = lines.join("\n");
  if (transcript.length > MAX_CHARS) {
    transcript = `...\n${transcript.slice(-MAX_CHARS)}`;
  }
  return [
    "Note from the app, not spoken by the user: the phone call has just ended. Tell the user in two or three " +
      "sentences how it went and what was agreed, then answer questions from the details below.",
    `Started ${clock(report.started_at)}${report.ended_at ? `, ended ${clock(report.ended_at)}` : ""}, lasted ${length}, ended by ${report.ended_by ?? "unknown"}.`,
    `Participants: ${people || "nobody was dialled"}. Assistant on the line: ${assistant ? (assistant.answered ? "yes" : "no") : "no"}.`,
    report.task ? `Task given: ${report.task}` : "",
    report.ready ? "" : "The transcript may be missing its last words.",
    transcript ? `Transcript:\n${transcript}` : "No transcript was recorded.",
  ]
    .filter(Boolean)
    .join("\n");
}
