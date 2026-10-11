import { describe, expect, it } from "vitest";
import { parseVcf } from "./contacts";
import { toE164 } from "./phone";

const VCF = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "N:Smith;Anna;;;",
  "FN:Anna Smith",
  "TEL;type=CELL;type=VOICE;type=pref:+44 7700 900123",
  "item1.TEL;type=HOME:020 7946 0958",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "N:O'Brien;Tom;;;",
  "TEL;TYPE=WORK,VOICE:+1 415 555",
  " 2671",
  "NOTE:Met at the\\, conference",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:No Number",
  "EMAIL:nobody@example.com",
  "END:VCARD",
  "",
].join("\r\n");

describe("vCard import", () => {
  it("takes every number with its label, names from FN or N, and joins folded lines", () => {
    expect(parseVcf(VCF)).toEqual([
      { name: "Anna Smith", phone: "+44 7700 900123", label: "mobile" },
      { name: "Anna Smith", phone: "020 7946 0958", label: "home" },
      { name: "Tom O'Brien", phone: "+1 415 5552671", label: "work" },
    ]);
  });

  it("gives up gracefully on anything that is not a vCard", () => {
    expect(parseVcf("hello")).toEqual([]);
  });
});

describe("toE164", () => {
  it("matches the server's rules", () => {
    expect(toE164("07700 900123")).toBe("+447700900123");
    expect(toE164("+44 (0)7700 900123")).toBe("+447700900123");
    expect(toE164("030 1234567", "+49")).toBe("+49301234567");
    expect(toE164("12")).toBeNull();
  });
});
