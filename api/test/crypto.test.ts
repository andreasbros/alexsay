import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/crypto";
import { open, seal } from "../src/secrets";

const KEY = "11".repeat(32);

describe("crypto", () => {
  it("hashes passwords with a fresh salt and verifies them", async () => {
    const a = await hashPassword("correct horse");
    const b = await hashPassword("correct horse");
    expect(a).not.toBe(b);
    expect(await verifyPassword("correct horse", a)).toBe(true);
    expect(await verifyPassword("wrong", a)).toBe(false);
    expect(await verifyPassword("correct horse", "garbage")).toBe(false);
  });

  it("seals and opens secrets, refusing a different key", async () => {
    const sealed = await seal(KEY, { api_key: "sk-secret" });
    expect(sealed).not.toContain("sk-secret");
    expect(await open(KEY, sealed)).toEqual({ api_key: "sk-secret" });
    await expect(open("22".repeat(32), sealed)).rejects.toThrow();
  });
});
