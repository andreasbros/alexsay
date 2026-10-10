import type { LiveHandlers, LiveSession } from "./live";

const SCRIPT: [role: "user" | "assistant", text: string][] = [
  ["user", "Alexsay, turn on the kitchen lights"],
  ["assistant", "Done, both kitchen lights are on."],
  ["user", "What is the weather in London tonight?"],
  ["assistant", "Clear and about nine degrees, so a light jacket will do."],
];

/**
 * A pretend conversation for `/assistant?demo`: synthetic levels, states and transcript, so the
 * screen can be seen and tuned without an OpenAI key. Nothing leaves the browser.
 */
export function startDemo(handlers: LiveHandlers): LiveSession {
  let level = 0;
  let role: "user" | "assistant" | null = null;
  const timers: number[] = [];
  const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
  const speak = (who: "user" | "assistant", text: string, startMs: number): number => {
    const words = text.split(" ");
    at(startMs, () => {
      role = who;
      handlers.onStatus(who === "assistant" ? "speaking" : "listening");
    });
    words.forEach((word, i) => at(startMs + i * 260, () => handlers.onTranscript(who, `${i ? " " : ""}${word}`)));
    const end = startMs + words.length * 260 + 300;
    at(end, () => {
      role = null;
      handlers.onStatus(who === "user" ? "thinking" : "listening");
    });
    return end;
  };
  handlers.onStatus("connecting");
  at(400, () => {
    handlers.onStatus("listening");
    handlers.onActivity("info", "Demo conversation, nothing is sent anywhere");
  });
  let cursor = 1200;
  for (const [who, text] of SCRIPT) {
    cursor = speak(who, text, cursor) + (who === "user" ? 900 : 1500);
    if (who === "user") {
      at(cursor - 700, () => handlers.onActivity("tool", 'set_lights {"match":"kitchen","on":true}'));
      at(cursor - 300, () =>
        handlers.onActivity("result", 'set_lights: {"ok":true,"lights":["Kitchen 1","Kitchen 2"]}'),
      );
    }
  }
  at(cursor, () => handlers.onStatus("listening"));
  const ticker = window.setInterval(() => {
    const t = Date.now() / 1000;
    const talking = role !== null;
    const target = talking ? 0.35 + 0.45 * Math.abs(Math.sin(t * 7.3) * Math.sin(t * 2.1)) : 0.02;
    level += (target - level) * 0.6;
  }, 50);
  return {
    id: "demo",
    micLevel: () => level,
    voiceLevel: () => level,
    setMuted: (muted) => handlers.onActivity("info", muted ? "Microphone muted" : "Microphone live"),
    stop: () => {
      window.clearInterval(ticker);
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
      handlers.onStatus("closed");
    },
  };
}
