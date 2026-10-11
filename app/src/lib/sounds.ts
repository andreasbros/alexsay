/**
 * Conversation earcons, synthesised with Web Audio so nothing is downloaded: a connecting pulse,
 * a ready tick, a falling hang-up and an end blip. The audio context is only awake while a sound
 * plays and sleeps for the whole call: a running context next to WebRTC playback clicks on iOS.
 */
const KEY = "ay-sounds";
let context: AudioContext | null = null;
let sleepTimer = 0;

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

/** Puts the context to sleep once the last note has faded, so nothing renders during the call. */
function sleepAfter(ms: number): void {
  window.clearTimeout(sleepTimer);
  sleepTimer = window.setTimeout(() => {
    if (context?.state === "running") {
      void context.suspend();
    }
  }, ms);
}

function play(notes: Note[]): void {
  if (!soundsEnabled()) {
    return;
  }
  try {
    context ??= new AudioContext();
    const ctx = context;
    window.clearTimeout(sleepTimer);
    if (ctx.state === "suspended") {
      void ctx.resume();
    }
    const now = ctx.currentTime + 0.02;
    const lastEnd = Math.max(...notes.map((n) => n.at + n.length));
    sleepAfter(lastEnd * 1000 + 150);
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
