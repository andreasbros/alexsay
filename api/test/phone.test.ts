import { describe, expect, it } from "vitest";
import { bareNumber, normalisePhone, searchName, toWhatsapp } from "../src/phone";
import { announceTwiml, bridgeTwiml, escapeXml, ringTwiml } from "../src/twiml";

describe("phone numbers", () => {
  it("turns the ways people write a UK number into E.164", () => {
    expect(normalisePhone("07700 900123")).toBe("+447700900123");
    expect(normalisePhone("+44 (0)7700 900123")).toBe("+447700900123");
    expect(normalisePhone("0044 7700 900123")).toBe("+447700900123");
    expect(normalisePhone("44 7700 900123")).toBe("+447700900123");
    expect(normalisePhone("+1 (415) 555-2671")).toBe("+14155552671");
    expect(normalisePhone("020 7946 0958", "+44")).toBe("+442079460958");
  });

  it("uses the user's own country for local numbers", () => {
    expect(normalisePhone("030 1234567", "+49")).toBe("+49301234567");
    expect(normalisePhone("0612345678", "+33")).toBe("+33612345678");
  });

  it("rejects what cannot be a number", () => {
    expect(normalisePhone("")).toBeNull();
    expect(normalisePhone("12345")).toBeNull();
    expect(normalisePhone("+1234567890123456")).toBeNull();
    expect(normalisePhone("call me")).toBeNull();
  });

  it("strips and adds the WhatsApp prefix", () => {
    expect(toWhatsapp("+447700900123")).toBe("whatsapp:+447700900123");
    expect(toWhatsapp("whatsapp:+447700900123")).toBe("whatsapp:+447700900123");
    expect(bareNumber("whatsapp:+447700900123")).toBe("+447700900123");
    expect(bareNumber("+447700900123")).toBe("+447700900123");
  });

  it("normalises names for lookup", () => {
    expect(searchName("  Zoë O'Brien-Smith ")).toBe("zoe o brien smith");
    expect(searchName("MUM")).toBe("mum");
  });
});

describe("TwiML", () => {
  it("escapes whatever the user said before it enters the XML", () => {
    expect(escapeXml(`Tom & "Jerry" <3`)).toBe("Tom &amp; &quot;Jerry&quot; &lt;3");
    const twiml = announceTwiml("Dinner's at 7 <tonight>");
    expect(twiml).toContain("Dinner&apos;s at 7 &lt;tonight&gt;");
    expect(twiml).not.toContain("<tonight>");
  });

  it("bridges to the person with the user's Twilio number as caller id", () => {
    expect(bridgeTwiml("+447700900123", "+447700900000")).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="+447700900000"><Number>+447700900123</Number></Dial></Response>',
    );
  });

  it("rings the speakers and the mobile together, or explains that nobody is available", () => {
    const ring = ringTwiml(["sip:abc@home.sip.twilio.com"], "+447700900999");
    expect(ring).toContain(
      '<Dial timeout="25"><Sip>sip:abc@home.sip.twilio.com</Sip><Number>+447700900999</Number></Dial>',
    );
    expect(ringTwiml([], null)).toContain("Nobody is available");
    expect(ringTwiml([], null)).toContain("<Hangup/>");
  });
});
