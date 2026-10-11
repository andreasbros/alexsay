import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  APP,
  addUser,
  call,
  connectTwilio,
  DEVICE_ID,
  formOf,
  heartbeat,
  json,
  MY_NUMBER,
  mockUpstream,
  reply,
  resetDb,
  signIn,
  TWILIO,
  TWILIO_NUMBER,
  TWILIO_SID,
  twilioWebhook,
} from "./helpers";

const MUM = "+447700900123";
const tool = async (cookie: string, name: string, args: Record<string, unknown>) =>
  (
    (await (await json(`${APP}/api/tools/call`, "POST", { name, arguments: args }, cookie)).json()) as {
      output: unknown;
    }
  ).output;

describe("twilio", () => {
  let maria: string;

  beforeEach(async () => {
    await resetDb();
    await addUser("maria", "maria-pass", "user");
    maria = await signIn("maria", "maria-pass");
    await json(`${APP}/api/contacts`, "POST", { name: "Mum", phone: MUM, label: "mobile" }, maria);
  });

  it("verifies the credentials, stores them sealed and points the number's webhooks here", async () => {
    const res = await connectTwilio(maria, { whatsapp_from: "+14155238886" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ provider: "twilio", settings: { from_number: TWILIO_NUMBER } });
    const row = await env.DB.prepare("SELECT secret, settings FROM connections WHERE provider = 'twilio'").first<{
      secret: string;
      settings: string;
    }>();
    expect(row?.secret).not.toContain(TWILIO_SID);
    expect(JSON.parse(row?.settings ?? "{}")).toMatchObject({ my_number: MY_NUMBER, country_code: "+44" });
    const listed = (await (await call(`${APP}/api/connections`, {}, maria)).json()) as { provider: string }[];
    expect(listed.map((c) => c.provider)).toEqual(["twilio"]);
  });

  it("configures the chosen number with this app's voice, messaging and status URLs", async () => {
    let configured: Record<string, string> = {};
    const upstream = mockUpstream({
      [`GET ${TWILIO}.json`]: () => reply(200, { friendly_name: "Alexsay", status: "active" }),
      [`GET ${TWILIO}/IncomingPhoneNumbers.json?PageSize=100`]: () =>
        reply(200, { incoming_phone_numbers: [{ sid: "PN1", phone_number: TWILIO_NUMBER, friendly_name: "Home" }] }),
      [`POST ${TWILIO}/IncomingPhoneNumbers/PN1.json`]: (_req, body) => {
        configured = formOf(body);
        return reply(200, {});
      },
    });
    await json(
      `${APP}/api/connections/twilio`,
      "PUT",
      {
        account_sid: TWILIO_SID,
        auth_token: "fedcba9876543210fedcba9876543210",
        settings: { from_number: TWILIO_NUMBER },
      },
      maria,
    );
    upstream.done();
    expect(configured).toMatchObject({
      VoiceUrl: `${APP}/v1/twilio/voice`,
      SmsUrl: `${APP}/v1/twilio/messages`,
      StatusCallback: `${APP}/v1/twilio/status`,
    });
    expect(upstream.calls[0]?.headers.get("authorization")).toBe(
      `Basic ${btoa(`${TWILIO_SID}:fedcba9876543210fedcba9876543210`)}`,
    );
  });

  it("refuses credentials Twilio rejects and numbers the account does not own", async () => {
    const upstream = mockUpstream({
      [`GET ${TWILIO}.json`]: () => reply(401, { code: 20003, message: "Authenticate" }),
    });
    const refused = await json(
      `${APP}/api/connections/twilio`,
      "PUT",
      { account_sid: TWILIO_SID, auth_token: "fedcba9876543210fedcba9876543210", settings: {} },
      maria,
    );
    upstream.done();
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "twilio_rejected", detail: "Authenticate (20003)" });
    expect((await call(`${APP}/api/connections`, {}, maria)).status).toBe(200);
    expect(await (await call(`${APP}/api/connections`, {}, maria)).json()).toEqual([]);

    const other = mockUpstream({
      [`GET ${TWILIO}.json`]: () => reply(200, { friendly_name: "Alexsay" }),
      [`GET ${TWILIO}/IncomingPhoneNumbers.json?PageSize=100`]: () => reply(200, { incoming_phone_numbers: [] }),
    });
    const missing = await json(
      `${APP}/api/connections/twilio`,
      "PUT",
      {
        account_sid: TWILIO_SID,
        auth_token: "fedcba9876543210fedcba9876543210",
        settings: { from_number: "+447700900001" },
      },
      maria,
    );
    other.done();
    expect(await missing.json()).toEqual({ error: "number_not_found" });
  });

  it("changes settings without the credentials and lists the account's numbers", async () => {
    await connectTwilio(maria);
    const upstream = mockUpstream({
      [`GET ${TWILIO}/IncomingPhoneNumbers.json?PageSize=100`]: () =>
        reply(200, {
          incoming_phone_numbers: [
            {
              sid: "PN1",
              phone_number: TWILIO_NUMBER,
              friendly_name: "Home",
              capabilities: { voice: true, sms: true },
            },
          ],
        }),
    });
    const numbers = await call(`${APP}/api/twilio/numbers`, {}, maria);
    upstream.done();
    expect(await numbers.json()).toEqual([
      { sid: "PN1", phone_number: TWILIO_NUMBER, friendly_name: "Home", voice: true, sms: true },
    ]);
    const changed = await json(
      `${APP}/api/connections/twilio`,
      "PUT",
      { settings: { my_number: "+447700900998", country_code: "+49" } },
      maria,
    );
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ settings: { my_number: "+447700900998", from_number: "" } });
  });

  it("offers the phone tools to the assistant once Twilio is connected", async () => {
    await connectTwilio(maria);
    await json(`${APP}/api/connections/openai`, "PUT", { api_key: "sk-test-0123456789abcdefghijklmnop" }, maria);
    interface SessionBody {
      session: { instructions: string; delegation: { responses: { tools: { name?: string }[] } } };
    }
    const captured: { body: SessionBody | null } = { body: null };
    const upstream = mockUpstream({
      "POST https://api.openai.com/v1/live/sessions": (_req, body) => {
        captured.body = JSON.parse(body) as SessionBody;
        return reply(200, { session: { id: "sess_1" }, transport: { sdp: "v=0\r\nanswer" } });
      },
    });
    const res = await json(`${APP}/api/assistant/sessions`, "POST", { sdp: "v=0\r\noffer-offer-offer" }, maria);
    upstream.done();
    expect(await res.json()).toMatchObject({ tools: ["phone"] });
    const names = (captured.body?.session.delegation.responses.tools ?? []).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["find_contact", "place_call", "start_conference", "send_text", "send_whatsapp"]),
    );
    expect(names).not.toContain("set_lights");
    expect(captured.body?.session.instructions).toContain("wait for a yes");
  });

  it("phones Mum by ringing the user's own phone first, then bridging", async () => {
    await connectTwilio(maria);
    let form: Record<string, string> = {};
    const upstream = mockUpstream({
      [`POST ${TWILIO}/Calls.json`]: (_req, body) => {
        form = formOf(body);
        return reply(201, { sid: "CA1", status: "queued" });
      },
    });
    const result = await tool(maria, "place_call", { name: "mum" });
    upstream.done();
    expect(result).toMatchObject({ ok: true, sid: "CA1", contact: "Mum", phone: MUM });
    expect(form).toMatchObject({ To: MY_NUMBER, From: TWILIO_NUMBER, StatusCallback: `${APP}/v1/twilio/status` });
    expect(form.Twiml).toContain(`<Dial callerId="${TWILIO_NUMBER}"><Number>${MUM}</Number></Dial>`);
    const contact = await env.DB.prepare("SELECT last_called_at FROM contacts WHERE phone = ?").bind(MUM).first();
    expect(contact?.last_called_at).toBeTypeOf("number");

    const done = await twilioWebhook("/v1/twilio/status", { CallSid: "CA1", CallStatus: "completed" });
    expect(done.status).toBe(204);
    const row = await env.DB.prepare("SELECT status, kind FROM calls WHERE sid = 'CA1'").first();
    expect(row).toEqual({ status: "completed", kind: "call" });
  });

  it("reads a message out instead when one is given", async () => {
    await connectTwilio(maria);
    let form: Record<string, string> = {};
    const upstream = mockUpstream({
      [`POST ${TWILIO}/Calls.json`]: (_req, body) => {
        form = formOf(body);
        return reply(201, { sid: "CA2", status: "queued" });
      },
    });
    const result = await tool(maria, "place_call", {
      contact_id: await mumId(),
      message: "I'm running 10 minutes late",
    });
    upstream.done();
    expect(result).toMatchObject({ ok: true, note: "the message is being delivered" });
    expect(form.To).toBe(MUM);
    expect(form.Twiml).toContain("I&apos;m running 10 minutes late");
    expect(form.Twiml).not.toContain(MY_NUMBER);
  });

  it("tells the model what is missing instead of failing", async () => {
    expect(await tool(maria, "place_call", { name: "mum" })).toEqual({ error: "Twilio is not connected" });
    await connectTwilio(maria, { my_number: "" });
    expect(await tool(maria, "place_call", { name: "mum" })).toEqual({
      error: "the user's own mobile number is not set in Connections",
    });
    expect(await tool(maria, "send_whatsapp", { name: "mum", body: "hi" })).toEqual({
      error: "no WhatsApp sender is set in Connections",
    });
    expect(await tool(maria, "add_to_call", { name: "mum" })).toEqual({
      error: "there is no group call in progress; start one first",
    });
    await json(`${APP}/api/contacts`, "POST", { name: "John Smith", phone: "07700900200" }, maria);
    await json(`${APP}/api/contacts`, "POST", { name: "John Doe", phone: "07700900201" }, maria);
    expect(await tool(maria, "place_call", { name: "John" })).toMatchObject({
      error: 'several contacts match "John"; ask which one',
      options: expect.arrayContaining([expect.objectContaining({ name: "John Doe" })]),
    });
  });

  it("sends texts and WhatsApp messages and keeps them in the contact's history", async () => {
    await connectTwilio(maria, { whatsapp_from: "+14155238886" });
    const forms: Record<string, string>[] = [];
    const upstream = mockUpstream({
      [`POST ${TWILIO}/Messages.json`]: (_req, body) => {
        forms.push(formOf(body));
        return reply(201, { sid: `SM${forms.length}`, status: "queued" });
      },
    });
    expect(await tool(maria, "send_text", { name: "Mum", body: "On my way" })).toMatchObject({ ok: true, sid: "SM1" });
    expect(await tool(maria, "send_whatsapp", { number: "07700900123", body: "Home soon" })).toMatchObject({
      ok: true,
      sid: "SM2",
      contact: "Mum",
    });
    upstream.done();
    expect(forms[0]).toMatchObject({ To: MUM, From: TWILIO_NUMBER, Body: "On my way" });
    expect(forms[1]).toMatchObject({ To: `whatsapp:${MUM}`, From: "whatsapp:+14155238886", Body: "Home soon" });

    const direct = await json(`${APP}/api/twilio/messages`, "POST", { to: "07700900123", body: "From the app" }, maria);
    expect(direct.status).toBe(502);

    const detail = (await (await call(`${APP}/api/contacts/${await mumId()}`, {}, maria)).json()) as {
      messages: { body: string; channel: string; direction: string }[];
      last_messaged_at: number | null;
    };
    expect(detail.messages.map((m) => `${m.direction} ${m.channel} ${m.body}`)).toEqual([
      "out whatsapp Home soon",
      "out sms On my way",
    ]);
    expect(detail.last_messaged_at).toBeTypeOf("number");
    const recent = (await tool(maria, "recent_messages", { name: "mum", limit: 1 })) as {
      text: string;
      with: string;
    }[];
    expect(recent).toEqual([expect.objectContaining({ text: "Home soon", with: "Mum", direction: "sent" })]);
  });

  it("starts a group call with the user as host and adds people to it", async () => {
    await connectTwilio(maria);
    await json(`${APP}/api/contacts`, "POST", { name: "Dad", phone: "07700900124" }, maria);
    const legs: { url: string; form: Record<string, string> }[] = [];
    const upstream = mockUpstream({
      [`POST ${TWILIO}/Conferences/*`]: (req, body) => {
        legs.push({ url: req.url, form: formOf(body) });
        return reply(201, { call_sid: `CA${legs.length}`, status: "queued" });
      },
    });
    const started = (await tool(maria, "start_conference", { participants: [{ name: "Mum" }, { name: "Dad" }] })) as {
      ok: boolean;
      conference: string;
      joined: { contact: string }[];
    };
    expect(started.ok).toBe(true);
    expect(started.joined.map((j) => j.contact)).toEqual(["Mum", "Dad"]);
    expect(legs).toHaveLength(3);
    expect(legs[0]?.url).toBe(`${TWILIO}/Conferences/${started.conference}/Participants.json`);
    expect(legs[0]?.form).toMatchObject({ To: MY_NUMBER, Label: "host", EndConferenceOnExit: "true" });
    expect(legs[1]?.form).toMatchObject({ To: MUM, From: TWILIO_NUMBER, EndConferenceOnExit: "false" });

    await json(`${APP}/api/contacts`, "POST", { name: "Sam", phone: "07700900125" }, maria);
    const added = await tool(maria, "add_to_call", { name: "Sam" });
    upstream.done();
    expect(added).toMatchObject({ ok: true, contact: "Sam" });
    expect(legs[3]?.url).toBe(legs[0]?.url);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM calls WHERE kind = 'conference'").first<{
      n: number;
    }>();
    expect(rows?.n).toBe(4);
  });

  it("rings every speaker and the mobile when someone calls the number", async () => {
    await connectTwilio(maria, { sip_domain: "alexsay.sip.twilio.com" });
    await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID, name: "Kitchen" }, maria);
    const unsigned = await call(`${APP}/v1/twilio/voice`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: TWILIO_NUMBER, From: MUM, CallSid: "CA9" }).toString(),
    });
    expect(unsigned.status).toBe(403);
    const unknown = await twilioWebhook("/v1/twilio/voice", { To: "+447700900555", From: MUM, CallSid: "CA9" });
    expect(unknown.status).toBe(404);

    const res = await twilioWebhook("/v1/twilio/voice", {
      To: TWILIO_NUMBER,
      From: MUM,
      CallSid: "CA9",
      CallStatus: "ringing",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    const twiml = await res.text();
    expect(twiml).toContain(`<Sip>sip:${DEVICE_ID}@alexsay.sip.twilio.com</Sip>`);
    expect(twiml).toContain(`<Number>${MY_NUMBER}</Number>`);
    const row = await env.DB.prepare("SELECT direction, phone, contact_id FROM calls WHERE sid = 'CA9'").first();
    expect(row).toMatchObject({ direction: "in", phone: MUM });
    expect(row?.contact_id).toBe(await mumId());

    const beat = await heartbeat(DEVICE_ID);
    expect(await beat.json()).toMatchObject({
      telephony: { sip_domain: "alexsay.sip.twilio.com", sip_username: DEVICE_ID, from_number: TWILIO_NUMBER },
    });
  });

  it("lets a speaker dial out through the SIP domain with the user's number as caller id", async () => {
    await connectTwilio(maria, { sip_domain: "alexsay.sip.twilio.com" });
    await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID, name: "Kitchen" }, maria);
    const res = await twilioWebhook("/v1/twilio/voice/outbound", {
      From: `sip:${DEVICE_ID}@alexsay.sip.twilio.com`,
      To: "sip:07700900123@alexsay.sip.twilio.com",
      CallSid: "CA10",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`<Dial callerId="${TWILIO_NUMBER}"><Number>${MUM}</Number></Dial>`);
    const stranger = await twilioWebhook("/v1/twilio/voice/outbound", {
      From: "sip:00000000-0000-0000-0000-000000000000@alexsay.sip.twilio.com",
      To: "sip:07700900123@alexsay.sip.twilio.com",
      CallSid: "CA11",
    });
    expect(stranger.status).toBe(404);
  });

  it("stores incoming texts and WhatsApp messages against the contact", async () => {
    await connectTwilio(maria, { whatsapp_from: "whatsapp:+14155238886" });
    const sms = await twilioWebhook("/v1/twilio/messages", {
      To: TWILIO_NUMBER,
      From: MUM,
      Body: "Call me when you can",
      MessageSid: "SM9",
    });
    expect(sms.status).toBe(200);
    const wa = await twilioWebhook("/v1/twilio/messages", {
      To: "whatsapp:+14155238886",
      From: `whatsapp:${MUM}`,
      Body: "Dinner at 7?",
      MessageSid: "SM10",
    });
    expect(wa.status).toBe(200);
    expect(
      (await twilioWebhook("/v1/twilio/messages", { To: TWILIO_NUMBER, From: MUM, Body: "x" }, "0".repeat(32))).status,
    ).toBe(403);
    const recent = (await tool(maria, "recent_messages", {})) as { text: string; channel: string; direction: string }[];
    expect(recent.map((m) => `${m.direction} ${m.channel} ${m.text}`)).toEqual([
      "received whatsapp Dinner at 7?",
      "received sms Call me when you can",
    ]);
  });

  async function mumId(): Promise<string> {
    const row = await env.DB.prepare("SELECT id FROM contacts WHERE phone = ?").bind(MUM).first<{ id: string }>();
    return row?.id ?? "";
  }
});
