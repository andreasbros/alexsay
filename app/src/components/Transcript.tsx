import { Text } from "@radix-ui/themes";
import { useEffect, useState } from "react";

export interface Turn {
  id: number;
  role: "user" | "assistant";
  text: string;
  /** Set when the other side started talking, so the bubble can age out. */
  endedAt: number | null;
}

/** Bubbles stay this long after their turn ended, then fade; only the newest few are kept. */
const LINGER_MS = 20_000;
const KEEP = 4;

/** Your words on the right, the assistant's on the left; each bubble grows as the words arrive. */
export function Transcript({ turns, thinking }: { turns: Turn[]; thinking: boolean }) {
  const now = useClock(1000);
  const visible = turns.slice(-KEEP).filter((t) => t.endedAt === null || now - t.endedAt < LINGER_MS + 1000);
  return (
    <div className="transcript" aria-live="polite">
      {visible.map((turn) => {
        const fading = turn.endedAt !== null && now - turn.endedAt > LINGER_MS;
        return (
          <div key={turn.id} className={`bubble bubble-${turn.role}${fading ? " bubble-fading" : ""}`}>
            <Text size={turn.role === "assistant" ? "3" : "2"}>{turn.text}</Text>
          </div>
        );
      })}
      {thinking && (
        <div className="bubble bubble-assistant bubble-thinking" aria-label="Thinking">
          <span />
          <span />
          <span />
        </div>
      )}
    </div>
  );
}

function useClock(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Appends a fragment to the current bubble of that role, or opens a new bubble and closes the other side's. */
export function appendTurn(turns: Turn[], role: Turn["role"], delta: string, now = Date.now()): Turn[] {
  const last = turns[turns.length - 1];
  if (last && last.role === role && last.endedAt === null) {
    return [...turns.slice(0, -1), { ...last, text: last.text + delta }];
  }
  const closed = turns.map((t) => (t.endedAt === null ? { ...t, endedAt: now } : t));
  return [...closed, { id: now + turns.length, role, text: delta, endedAt: null }];
}
