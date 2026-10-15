/**
 * G.711 mu-law at 8 kHz, the format of a Twilio media stream, and the steps to and from the 16 kHz
 * PCM GPT-Live speaks: the same tables as the speaker's `core::mulaw` and the app's `lib/mulaw.ts`.
 */

const BIAS = 0x84;
const CLIP = 32_635;

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

/** 8 kHz mu-law bytes to 16 kHz PCM16: each sample followed by its midpoint with the next (the last is held). */
export function muLawToPcm16k(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const sample = decodeMuLaw(bytes[i] ?? 0xff);
    const next = i + 1 < bytes.length ? decodeMuLaw(bytes[i + 1] ?? 0xff) : sample;
    out[2 * i] = sample;
    out[2 * i + 1] = Math.trunc((sample + next) / 2);
  }
  return out;
}

/** 16 kHz PCM16 to 8 kHz mu-law: each pair averaged, which also damps what would alias. */
export function pcm16kToMuLaw(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(samples.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    const a = samples[2 * i] ?? 0;
    const b = samples[2 * i + 1] ?? a;
    out[i] = encodeMuLaw(Math.trunc((a + b) / 2));
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** PCM16 samples as the little-endian bytes GPT-Live carries in base64. */
export function pcm16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(2 * i, samples[i] ?? 0, true);
  }
  return bytesToBase64(bytes);
}

export function base64ToPcm16(text: string): Int16Array {
  const bytes = base64ToBytes(text);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength - (bytes.byteLength % 2));
  const out = new Int16Array(view.byteLength / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = view.getInt16(2 * i, true);
  }
  return out;
}

/** A Twilio media payload (20 ms of mu-law) as the base64 PCM GPT-Live takes. */
export const twilioToLive = (payload: string): string => pcm16ToBase64(muLawToPcm16k(base64ToBytes(payload)));

/** A GPT-Live audio delta as the mu-law payload Twilio plays. */
export const liveToTwilio = (delta: string): string => bytesToBase64(pcm16kToMuLaw(base64ToPcm16(delta)));
