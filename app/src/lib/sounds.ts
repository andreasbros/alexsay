/**
 * Conversation earcons, synthesised with Web Audio so nothing is downloaded: a rising chime when
 * the line opens, a falling hang-up and a short end blip when it closes. They only ever play
 * through their own oscillators; the call's streams are never touched.
 */
const KEY = "ay-sounds";
let context: AudioContext | null = null;

export function soundsEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function setSoundsEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {}
}

/** Call from a click so iOS lets the context run; later tones then play without a gesture. */
export function primeSounds(): void {
  if (!soundsEnabled()) {
    return;
  }
  try {
    context ??= new AudioContext();
    if (context.state === "suspended") {
      void context.resume();
    }
  } catch {}
}

interface Note {
  hz: number;
  at: number;
  length: number;
  gain?: number;
  type?: OscillatorType;
}

/** One pulse of the connecting tone: two soft notes, repeated until the line is ready. */
const CONNECTING: Note[] = [
  { hz: 523.25, at: 0, length: 0.1, gain: 0.7 },
  { hz: 659.25, at: 0.14, length: 0.14, gain: 0.7 },
];
const CONNECTING_PERIOD_MS = 700;

/** The ready tick that replaces the pulse the moment the assistant is listening. */
const READY: Note[] = [{ hz: 783.99, at: 0, length: 0.16 }];

const END: Note[] = [
  { hz: 659.25, at: 0, length: 0.14 },
  { hz: 440, at: 0.16, length: 0.22 },
  { hz: 220, at: 0.5, length: 0.09, gain: 0.5, type: "square" },
];

export const playReady = () => play(READY);
export const playEnd = () => play(END);

/** Starts the connecting pulse at once; the returned function stops it and plays the ready tick. */
export function startConnecting(): () => void {
  if (!soundsEnabled()) {
    return () => {};
  }
  play(CONNECTING);
  const timer = window.setInterval(() => play(CONNECTING), CONNECTING_PERIOD_MS);
  let stopped = false;
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    window.clearInterval(timer);
    playReady();
  };
}

function play(notes: Note[]): void {
  if (!soundsEnabled()) {
    return;
  }
  try {
    context ??= new AudioContext();
    const ctx = context;
    const now = ctx.currentTime + 0.02;
    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = note.type ?? "sine";
      osc.frequency.value = note.hz;
      const peak = 0.18 * (note.gain ?? 1);
      gain.gain.setValueAtTime(0.0001, now + note.at);
      gain.gain.exponentialRampToValueAtTime(peak, now + note.at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + note.at + note.length);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + note.at);
      osc.stop(now + note.at + note.length + 0.02);
    }
  } catch {}
}
