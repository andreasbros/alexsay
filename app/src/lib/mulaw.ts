/**
 * G.711 mu-law at 8 kHz in 20 ms frames: what the speaker's line bridge carries (Twilio's format),
 * so a drop-in from the browser speaks it too. The same tables as the speaker's `core::mulaw`.
 */

export const LINE_RATE = 8_000;
/** 20 ms at 8 kHz: one frame on the line. */
export const FRAME_SAMPLES = 160;

const BIAS = 0x84;
const CLIP = 32_635;

/** One 16-bit sample to mu-law, the ITU G.711 way. */
export function encodeMuLaw(sample: number): number {
  let pcm = Math.max(-32_768, Math.min(32_767, Math.round(sample)));
  let sign = 0;
  if (pcm < 0) {
    pcm = -pcm;
    sign = 0x80;
  }
  pcm = Math.min(pcm, CLIP) + BIAS;
  let exponent = 7;
  let mask = 0x4000;
  while (exponent > 0 && (pcm & mask) === 0) {
    exponent -= 1;
    mask >>= 1;
  }
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function decodeMuLaw(byte: number): number {
  const value = ~byte & 0xff;
  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;
  const pcm = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -pcm : pcm;
}

export function encodeFrame(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    out[i] = encodeMuLaw(samples[i] ?? 0);
  }
  return out;
}

export function decodeFrame(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    out[i] = decodeMuLaw(bytes[i] ?? 0);
  }
  return out;
}

export function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    // Rounded away from zero, so negative and positive halves come out symmetric
    out[i] = Math.trunc(clamped * 32_767 + (clamped < 0 ? -0.5 : 0.5));
  }
  return out;
}

export function toFloat(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    out[i] = (samples[i] ?? 0) / 32_768;
  }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Linear resampling that carries its position across pushes, so a stream of short blocks (the
 * audio worklet's 128 frames) comes out continuous at the new rate.
 */
export class Resampler {
  private readonly step: number;
  /** Position of the next output sample, in input samples, where 0 is `last` and 1 the next push's first. */
  private position = 1;
  private last = 0;
  private primed = false;

  constructor(from: number, to: number) {
    this.step = from / to;
  }

  push(input: Float32Array): Float32Array {
    if (input.length === 0) {
      return new Float32Array(0);
    }
    // The window is the last sample of the previous push followed by this input
    const window = new Float32Array(input.length + 1);
    window[0] = this.primed ? this.last : (input[0] ?? 0);
    window.set(input, 1);
    this.primed = true;
    const out: number[] = [];
    let at = this.position;
    while (at < input.length) {
      const index = Math.floor(at);
      const fraction = at - index;
      const a = window[index] ?? 0;
      const b = window[index + 1] ?? a;
      out.push(a + (b - a) * fraction);
      at += this.step;
    }
    this.position = at - input.length;
    this.last = input[input.length - 1] ?? 0;
    return Float32Array.from(out);
  }
}

/** Gathers samples into whole frames, keeping the remainder for the next push. */
export class Framer {
  private pending: number[] = [];

  constructor(private readonly size = FRAME_SAMPLES) {}

  push(samples: Float32Array): Float32Array[] {
    this.pending.push(...samples);
    const frames: Float32Array[] = [];
    while (this.pending.length >= this.size) {
      frames.push(Float32Array.from(this.pending.splice(0, this.size)));
    }
    return frames;
  }
}

/** RMS of a frame, 0 to 1, for a level meter. */
export function level(samples: Int16Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const sample of samples) {
    const s = sample / 32_768;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}
