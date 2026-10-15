import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  base64ToPcm16,
  bytesToBase64,
  decodeMuLaw,
  encodeMuLaw,
  liveToTwilio,
  muLawToPcm16k,
  pcm16kToMuLaw,
  pcm16ToBase64,
  twilioToLive,
} from "../src/mulaw";

describe("mu-law and the rate steps around it", () => {
  it("round-trips samples within quantisation and matches G.711's fixed points", () => {
    for (const sample of [0, 100, -100, 1_000, -1_000, 8_000, 30_000, -32_768]) {
      expect(Math.abs(decodeMuLaw(encodeMuLaw(sample)) - sample)).toBeLessThanOrEqual(
        Math.max(8, Math.abs(sample) / 16),
      );
    }
    expect(encodeMuLaw(0)).toBe(0xff);
    expect(decodeMuLaw(0x00)).toBe(-32_124);
  });

  it("doubles 8 kHz to 16 kHz with midpoints and halves back by averaging", () => {
    const up = muLawToPcm16k(Uint8Array.from([encodeMuLaw(0), encodeMuLaw(1_000)]));
    expect(up.length).toBe(4);
    expect(up[0]).toBe(0);
    expect(up[1]).toBeGreaterThan(400);
    expect(up[1]).toBeLessThan(600);
    const down = pcm16kToMuLaw(Int16Array.from([1_000, 3_000, 500, 500]));
    expect(down.length).toBe(2);
    expect(Math.abs(decodeMuLaw(down[0] ?? 0) - 2_000)).toBeLessThan(140);
  });

  it("carries PCM and bytes through base64 both ways", () => {
    const samples = Int16Array.from([0, 1, -1, 32_767, -32_768]);
    expect(Array.from(base64ToPcm16(pcm16ToBase64(samples)))).toEqual(Array.from(samples));
    const bytes = Uint8Array.from([0, 255, 128]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual([0, 255, 128]);
  });

  it("turns a Twilio frame into twice as many PCM samples and a GPT-Live delta into half as many bytes", () => {
    const frame = bytesToBase64(new Uint8Array(160).fill(0xff));
    expect(base64ToPcm16(twilioToLive(frame)).length).toBe(320);
    const delta = pcm16ToBase64(new Int16Array(1_600));
    expect(base64ToBytes(liveToTwilio(delta)).length).toBe(800);
  });
});
