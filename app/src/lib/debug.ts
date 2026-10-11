/**
 * A debug log the user can switch on, copy and paste back: every event, status change, level
 * reading and bar movement goes through here. Off by default; nothing is kept while it is off.
 */
const KEY = "ay-debug";
const MAX_LINES = 3000;

let enabled = read();
const lines: string[] = [];
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export const isDebug = () => enabled;

export function setDebug(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {}
  notify();
}

export function debugLog(line: string): void {
  if (!enabled) {
    return;
  }
  const at = new Date();
  const stamp = `${at.toLocaleTimeString(undefined, { hour12: false })}.${String(at.getMilliseconds()).padStart(3, "0")}`;
  lines.push(`${stamp} ${line}`);
  if (lines.length > MAX_LINES) {
    lines.splice(0, lines.length - MAX_LINES);
  }
  notify();
}

export const debugLines = () => lines;

export function clearDebug(): void {
  lines.length = 0;
  notify();
}

export function subscribeDebug(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** A compact one-line rendering of an event for the log. */
export function brief(value: unknown, max = 240): string {
  try {
    const text = JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return String(value);
  }
}
