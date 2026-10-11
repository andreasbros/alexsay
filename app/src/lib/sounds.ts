/**
 * Conversation earcons as small WAV clips generated in the browser and played through plain
 * audio elements. No Web Audio anywhere: a Web Audio context next to WebRTC playback, even a
 * suspended one, clicked on iPhone Safari.
 */
const KEY = "ay-sounds";
const RATE = 24_000;

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

interface Note {
  hz: number;
  at: number;
  length: number;
  gain?: number;
}

/** One pulse of the connecting tone; the clip loops until the line is ready. */
const CONNECTING: Note[] = [
  { hz: 523.25, at: 0, length: 0.1, gain: 0.7 },
  { hz: 659.25, at: 0.14, length: 0.14, gain: 0.7 },
];
const CONNECTING_CLIP_S = 0.7;
const READY: Note[] = [{ hz: 783.99, at: 0, length: 0.16 }];
const END: Note[] = [
  { hz: 659.25, at: 0, length: 0.14 },
  { hz: 440, at: 0.16, length: 0.22 },
  { hz: 330, at: 0.46, length: 0.12, gain: 0.6 },
];

const clips = {
  connecting: lazyClip(CONNECTING, CONNECTING_CLIP_S),
  ready: lazyClip(READY, 0.25),
  end: lazyClip(END, 0.7),
};

function lazyClip(notes: Note[], seconds: number): () => HTMLAudioElement {
  let element: HTMLAudioElement | null = null;
  return () => {
    if (!element) {
      element = new Audio(wavUrl(notes, seconds));
      element.preload = "auto";
      element.load();
    }
    return element;
  };
}

/** Generates and loads every clip ahead of time, so the first play is instant. */
export function preloadSounds(): void {
  if (!soundsEnabled()) {
    return;
  }
  clips.connecting();
  clips.ready();
  clips.end();
}

/**
 * Call from the Start tap. iOS only lets a media element play without a tap once it has played
 * inside one, so each clip gets a silent nudge here.
 */
export function primeSounds(): void {
  if (!soundsEnabled()) {
    return;
  }
  for (const clip of [clips.ready(), clips.end()]) {
    clip.muted = true;
    clip
      .play()
      .then(() => {
        clip.pause();
        clip.currentTime = 0;
        clip.muted = false;
      })
      .catch(() => {
        clip.muted = false;
      });
  }
}

function playClip(clip: HTMLAudioElement): void {
  if (!soundsEnabled()) {
    return;
  }
  clip.loop = false;
  clip.currentTime = 0;
  clip.play().catch(() => {});
}

export const playReady = () => playClip(clips.ready());
export const playEnd = () => playClip(clips.end());

/** Starts the connecting pulse at once; the returned function stops it and plays the ready tick. */
export function startConnecting(): () => void {
  if (!soundsEnabled()) {
    return () => {};
  }
  const pulse = clips.connecting();
  pulse.loop = true;
  pulse.currentTime = 0;
  pulse.play().catch(() => {});
  let stopped = false;
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    pulse.pause();
    pulse.currentTime = 0;
    playReady();
  };
}

/** Renders the notes to 16-bit mono PCM and wraps them in a WAV header, as an object URL. */
export function wavUrl(notes: Note[], seconds: number): string {
  const samples = renderNotes(notes, seconds);
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => {
    view.setInt16(44 + i * 2, Math.round(sample * 32767), true);
  });
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

/** Sine notes with a short attack, an exponential release and a clean fade to silence, summed into one clip. */
export function renderNotes(notes: Note[], seconds: number): Float32Array {
  const out = new Float32Array(Math.ceil(seconds * RATE));
  const fadeSamples = Math.floor(0.01 * RATE);
  for (const note of notes) {
    const start = Math.floor(note.at * RATE);
    const length = Math.floor(note.length * RATE);
    const peak = 0.3 * (note.gain ?? 1);
    for (let i = 0; i < length && start + i < out.length; i++) {
      const t = i / RATE;
      const attack = Math.min(1, i / (0.012 * RATE));
      const release = Math.exp((-4 * i) / length);
      const fade = Math.min(1, (length - i) / fadeSamples);
      out[start + i] = (out[start + i] ?? 0) + Math.sin(2 * Math.PI * note.hz * t) * peak * attack * release * fade;
    }
  }
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.max(-1, Math.min(1, out[i] ?? 0));
  }
  return out;
}
