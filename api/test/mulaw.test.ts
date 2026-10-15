import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, decodeMuLaw, encodeMuLaw } from "../src/mulaw";

describe("mu-law", () => {
  it("round-trips samples within quantisation and matches G.711's fixed points", () => {
    for (const sample of [0, 100, -100, 1_000, -1_000, 8_000, 30_000, -32_768]) {
      expect(Math.abs(decodeMuLaw(encodeMuLaw(sample)) - sample)).toBeLessThanOrEqual(
        Math.max(8, Math.abs(sample) / 16),
      );
    }
    expect(encodeMuLaw(0)).toBe(0xff);
    expect(decodeMuLaw(0x00)).toBe(-32_124);
  });

  it("carries bytes through base64 both ways", () => {
    const bytes = Uint8Array.from([0, 255, 128, 7]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual([0, 255, 128, 7]);
  });
});
