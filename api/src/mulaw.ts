/**
 * G.711 mu-law at 8 kHz, the format of a Twilio media stream and of the GPT-Live seat on a call: the
 * same tables as the speaker's `core::mulaw` and the app's `lib/mulaw.ts`, and the base64 the sockets carry.
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
