import { describe, expect, it } from "vitest";
import {
  decodeFrame,
  decodeMuLaw,
  encodeFrame,
  encodeMuLaw,
  FRAME_SAMPLES,
  Framer,
  fromBase64,
  level,
  Resampler,
  toBase64,
  toFloat,
  toInt16,
} from "./mulaw";

describe("mu-law", () => {
  it("round-trips within quantisation and matches the speaker's tables", () => {
    for (const sample of [0, 1, -1, 100, -100, 1_000, -1_000, 8_000, -8_000, 30_000, -30_000, 32_767, -32_768]) {
      const back = decodeMuLaw(encodeMuLaw(sample));
      const tolerance = Math.max(8, Math.abs(sample) / 16);
      expect(Math.abs(back - sample)).toBeLessThanOrEqual(tolerance);
    }
    // Silence is 0xff, full scale negative is 0x00 (as G.711 defines them)
    expect(encodeMuLaw(0)).toBe(0xff);
    expect(encodeMuLaw(-32_768)).toBe(0x00);
    expect(decodeMuLaw(0xff)).toBe(0);
    expect(decodeMuLaw(0x00)).toBe(-32_124);
    expect(decodeMuLaw(0x80)).toBe(32_124);
  });

  it("encodes and decodes whole frames, in base64 for the socket", () => {
    const frame = Int16Array.from([0, 1_000, -1_000, 20_000]);
    const bytes = encodeFrame(frame);
    expect(bytes.length).toBe(4);
    const text = toBase64(bytes);
    expect(fromBase64(text)).toEqual(bytes);
    const back = decodeFrame(bytes);
    expect(back[0]).toBe(0);
    expect(Math.abs((back[1] ?? 0) - 1_000)).toBeLessThan(70);
    expect(Math.abs((back[3] ?? 0) - 20_000)).toBeLessThan(1_300);
  });

  it("converts between float and 16-bit audio with clipping", () => {
    const ints = toInt16(Float32Array.from([0, 0.5, -0.5, 1.5, -1.5]));
    expect(Array.from(ints)).toEqual([0, 16_384, -16_384, 32_767, -32_767]);
    const floats = toFloat(Int16Array.from([0, 16_384, -32_768]));
    expect(floats[1]).toBeCloseTo(0.5);
    expect(floats[2]).toBe(-1);
  });

  it("resamples continuously across short blocks", () => {
    const resampler = new Resampler(48_000, 8_000);
    // A ramp pushed in blocks of 128 (as the audio worklet delivers) comes out as the same ramp, 6 times shorter
    const total = 48_000 / 50;
    const ramp = Float32Array.from({ length: total }, (_, i) => i / total);
    const out: number[] = [];
    for (let at = 0; at < total; at += 128) {
      out.push(...resampler.push(ramp.subarray(at, Math.min(total, at + 128))));
    }
    expect(out.length).toBe(FRAME_SAMPLES);
    for (let i = 1; i < out.length; i += 1) {
      const step = (out[i] ?? 0) - (out[i - 1] ?? 0);
      expect(step).toBeCloseTo(6 / total, 6);
    }
    // 44.1 kHz does not divide: still 160 per 20 ms over time
    const odd = new Resampler(44_100, 8_000);
    let count = 0;
    for (let i = 0; i < 100; i += 1) {
      count += odd.push(new Float32Array(441)).length;
    }
    expect(count).toBe(8_000);
    expect(odd.push(new Float32Array(0)).length).toBe(0);
  });

  it("gathers samples into whole frames", () => {
    const framer = new Framer(4);
    expect(framer.push(Float32Array.from([1, 2, 3]))).toEqual([]);
    const frames = framer.push(Float32Array.from([4, 5, 6, 7, 8, 9]));
    expect(frames.map((f) => Array.from(f))).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    expect(framer.push(Float32Array.from([10, 11, 12])).map((f) => Array.from(f))).toEqual([[9, 10, 11, 12]]);
  });

  it("measures a frame's level", () => {
    expect(level(new Int16Array(0))).toBe(0);
    expect(level(new Int16Array(160))).toBe(0);
    expect(level(Int16Array.from({ length: 160 }, (_, i) => (i % 2 ? 16_384 : -16_384)))).toBeCloseTo(0.5, 3);
  });
});
