import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runCallTool } from "../src/call_agent";
import { actingFor } from "../src/types";
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
      [`GET ${TWILIO}/IncomingPhoneNumbers/PN1.json`]: () =>
        reply(200, { sid: "PN1", phone_number: TWILIO_NUMBER, voice_url: `${APP}/v1/twilio/voice` }),
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
      VoiceApplicationSid: "",
      TrunkSid: "",
      SmsUrl: `${APP}/v1/twilio/messages`,
      StatusCallback: `${APP}/v1/twilio/status`,
    });
    expect(upstream.calls[0]?.headers.get("authorization")).toBe(
      `Basic ${btoa(`${TWILIO_SID}:fedcba9876543210fedcba9876543210`)}`,
    );
  });

  it("reports a number that still routes calls elsewhere, and repairs it on request", async () => {
    const stuck = mockUpstream({
      [`GET ${TWILIO}.json`]: () => reply(200, { friendly_name: "Alexsay" }),
      [`GET ${TWILIO}/IncomingPhoneNumbers.json?PageSize=100`]: () =>
        reply(200, { incoming_phone_numbers: [{ sid: "PN1", phone_number: TWILIO_NUMBER, friendly_name: "Home" }] }),
      [`POST ${TWILIO}/IncomingPhoneNumbers/PN1.json`]: () => reply(200, {}),
      [`GET ${TWILIO}/IncomingPhoneNumbers/PN1.json`]: () =>
        reply(200, { sid: "PN1", phone_number: TWILIO_NUMBER, voice_url: "", trunk_sid: "TK123" }),
    });
    const res = await json(
      `${APP}/api/connections/twilio`,
      "PUT",
      {
        account_sid: TWILIO_SID,
        auth_token: "fedcba9876543210fedcba9876543210",
        settings: { from_number: TWILIO_NUMBER },
      },
      maria,
    );
    stuck.done();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "twilio_rejected",
      detail: expect.stringContaining("SIP trunk TK123"),
    });

    await connectTwilio(maria);
    const repaired = mockUpstream({
      [`GET ${TWILIO}/IncomingPhoneNumbers.json?PageSize=100`]: () =>
        reply(200, { incoming_phone_numbers: [{ sid: "PN1", phone_number: TWILIO_NUMBER, friendly_name: "Home" }] }),
      [`POST ${TWILIO}/IncomingPhoneNumbers/PN1.json`]: () => reply(200, {}),
      [`GET ${TWILIO}/IncomingPhoneNumbers/PN1.json`]: () =>
        reply(200, { sid: "PN1", phone_number: TWILIO_NUMBER, voice_url: `${APP}/v1/twilio/voice` }),
    });
    const fixed = await call(`${APP}/api/twilio/numbers/repair`, { method: "POST" }, maria);
    repaired.done();
    expect(await fixed.json()).toMatchObject({ phone_number: TWILIO_NUMBER, voice_url: `${APP}/v1/twilio/voice` });
  });

  it("keeps a number's earlier routing and puts it back when the user switches away or removes Twilio", async () => {
    const studio = `https://webhooks.twilio.com/v1/Accounts/${TWILIO_SID}/Flows/FW123`;
    const numbers = [
      { sid: "PN1", phone_number: TWILIO_NUMBER, friendly_name: "Support", voice_url: studio, status_callback: "" },
      { sid: "PN2", phone_number: "+447700900001", friendly_name: "Spare", voice_url: "" },
    ];
    const writes: { sid: string; form: Record<string, string> }[] = [];
    const routes = {
      [`GET ${TWILIO}.json`]: () => reply(200, { friendly_name: "Alexsay" }),
      [`GET ${TWILIO}/IncomingPhoneNumbers.json?PageSize=100`]: () => reply(200, { incoming_phone_numbers: numbers }),
      [`POST ${TWILIO}/IncomingPhoneNumbers/*`]: (req: Request, body: string) => {
        writes.push({ sid: req.url.split("/").pop()?.replace(".json", "") ?? "", form: formOf(body) });
        return reply(200, {});
      },
      [`GET ${TWILIO}/IncomingPhoneNumbers/*`]: (req: Request) => {
        const sid = req.url.split("/").pop()?.replace(".json", "");
        return reply(200, { sid, phone_number: TWILIO_NUMBER, voice_url: `${APP}/v1/twilio/voice` });
      },
    };
    const first = mockUpstream(routes);
    const taken = await json(
      `${APP}/api/connections/twilio`,
      "PUT",
      {
        account_sid: TWILIO_SID,
        auth_token: "fedcba9876543210fedcba9876543210",
        settings: { from_number: TWILIO_NUMBER },
      },
      maria,
    );
    first.done();
    expect(await taken.json()).toMatchObject({
      settings: { number_backup: expect.objectContaining({ sid: "PN1", voice_url: studio }) },
    });
    expect(writes.map((w) => w.sid)).toEqual(["PN1"]);

    // Switching to the spare number writes the Studio flow back onto the support line first
    writes.length = 0;
    const { [`GET ${TWILIO}.json`]: _verify, ...withoutVerify } = routes;
    const second = mockUpstream(withoutVerify);
    const switched = await json(
      `${APP}/api/connections/twilio`,
      "PUT",
      {
        settings: {
          from_number: "+447700900001",
          number_backup: {
            sid: "PNX",
            phone_number: "+440000000000",
            voice_url: "spoofed",
            voice_method: "POST",
            voice_application_sid: "",
            trunk_sid: "",
            sms_url: "",
            sms_method: "POST",
            sms_application_sid: "",
            status_callback: "",
          },
        },
      },
      maria,
    );
    second.done();
    expect(writes.map((w) => w.sid)).toEqual(["PN1", "PN2"]);
    expect(writes[0]?.form).toMatchObject({ VoiceUrl: studio, VoiceApplicationSid: "", TrunkSid: "" });
    expect(writes[1]?.form).toMatchObject({ VoiceUrl: `${APP}/v1/twilio/voice` });
    // The spare number's empty routing is kept too, so leaving it later clears our URLs; a client cannot plant one
    expect(await switched.json()).toMatchObject({
      settings: { from_number: "+447700900001", number_backup: expect.objectContaining({ sid: "PN2", voice_url: "" }) },
    });

    // A settings-only save with the same number touches nothing at Twilio
    const quiet = mockUpstream({});
    expect(
      (
        await json(
          `${APP}/api/connections/twilio`,
          "PUT",
          { settings: { from_number: "+447700900001", my_number: MY_NUMBER } },
          maria,
        )
      ).status,
    ).toBe(200);
    quiet.done();
  });

  it("restores the number when Twilio is removed", async () => {
    await connectTwilio(maria);
    await env.DB.prepare(
      `UPDATE connections SET settings = json_set(settings, '$.number_backup', json(?)) WHERE provider = 'twilio'`,
    )
      .bind(
        JSON.stringify({
          sid: "PN1",
          phone_number: TWILIO_NUMBER,
          voice_url: "https://handler.twilio.com/twiml/EH1",
          voice_method: "POST",
          voice_application_sid: "",
          trunk_sid: "",
          sms_url: "",
          sms_method: "POST",
          sms_application_sid: "",
          status_callback: "",
        }),
      )
      .run();
    let restored: Record<string, string> = {};
    const upstream = mockUpstream({
      [`POST ${TWILIO}/IncomingPhoneNumbers/PN1.json`]: (_req, body) => {
        restored = formOf(body);
        return reply(200, {});
      },
    });
    expect((await call(`${APP}/api/connections/twilio`, { method: "DELETE" }, maria)).status).toBe(204);
    upstream.done();
    expect(restored).toMatchObject({ VoiceUrl: "https://handler.twilio.com/twiml/EH1" });
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
      expect.objectContaining({
        sid: "PN1",
        phone_number: TWILIO_NUMBER,
        friendly_name: "Home",
        voice: true,
        sms: true,
      }),
    ]);
    // Dropping the number hands its earlier routing back to Twilio
    const released = mockUpstream({ [`POST ${TWILIO}/IncomingPhoneNumbers/PN1.json`]: () => reply(200, {}) });
    const changed = await json(
      `${APP}/api/connections/twilio`,
      "PUT",
      { settings: { my_number: "+447700900998", country_code: "+49" } },
      maria,
    );
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ settings: { my_number: "+447700900998", from_number: "" } });
    released.done();
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

  it("refuses to ring the mobile unasked when the page has no phone line", async () => {
    await connectTwilio(maria);
    const quiet = mockUpstream({});
    const result = (await tool(maria, "place_call", { name: "mum" })) as { error: string };
    quiet.done();
    expect(result.error).toContain("no phone line where the user is talking from");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM calls").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("rings the user's mobile first and dials Mum once they are on, when asked for the mobile", async () => {
    await connectTwilio(maria);
    const legs: Record<string, string>[] = [];
    const upstream = mockUpstream({
      [`POST ${TWILIO}/Conferences/*`]: (_req, body) => {
        legs.push(formOf(body));
        return reply(201, { call_sid: `CA${legs.length}`, status: "queued" });
      },
    });
    const result = await tool(maria, "place_call", { name: "mum", via: "mobile" });
    expect(result).toMatchObject({ ok: true, host: "mobile", assistant: false, pending: ["Mum"] });
    expect((result as { note: string }).note).toContain("the user's mobile is ringing");
    expect(legs.map((l) => l.To)).toEqual([MY_NUMBER]);
    expect(legs[0]).toMatchObject({
      Label: "host",
      EndConferenceOnExit: "true",
      StatusCallback: `${APP}/v1/twilio/status`,
      StatusCallbackEvent: "answered completed",
    });

    // The mobile picks up: only now is Mum dialled
    expect((await twilioWebhook("/v1/twilio/status", { CallSid: "CA1", CallStatus: "in-progress" })).status).toBe(204);
    expect(legs.map((l) => l.To)).toEqual([MY_NUMBER, MUM]);
    expect(legs[1]).toMatchObject({ From: TWILIO_NUMBER, StatusCallbackEvent: "answered completed" });
    // A repeated callback does not dial her twice
    await twilioWebhook("/v1/twilio/status", { CallSid: "CA1", CallStatus: "in-progress" });
    upstream.done();
    expect(legs).toHaveLength(2);
    const contact = await env.DB.prepare("SELECT last_called_at FROM contacts WHERE phone = ?").bind(MUM).first();
    expect(contact?.last_called_at).toBeTypeOf("number");

    const done = await twilioWebhook("/v1/twilio/status", { CallSid: "CA1", CallStatus: "completed" });
    expect(done.status).toBe(204);
    const row = await env.DB.prepare("SELECT status, kind, role FROM calls WHERE sid = 'CA1'").first();
    expect(row).toEqual({ status: "completed", kind: "conference", role: "host" });
  });

  it("calling the user's own number rings the mobile once and seats the assistant with them alone", async () => {
    await connectTwilio(maria);
    await connectOpenaiForCalls();
    const legs: Record<string, string>[] = [];
    const upstream = mockUpstream({
      [`POST ${TWILIO}/Conferences/*`]: (_req, body) => {
        legs.push(formOf(body));
        return reply(201, { call_sid: `CA${legs.length}`, status: "queued" });
      },
    });
    const placed = await json(`${APP}/api/twilio/calls`, "POST", { to: MY_NUMBER }, maria);
    expect(placed.status).toBe(201);
    expect(await placed.json()).toMatchObject({ host: "mobile", pending: [], assistant: true });
    expect(legs.map((l) => l.To)).toEqual([MY_NUMBER]);

    // The mobile picks up: nobody else is dialled, the assistant joins with a briefing for a call alone
    await twilioWebhook("/v1/twilio/status", { CallSid: "CA1", CallStatus: "in-progress" });
    expect(legs).toHaveLength(2);
    expect(legs[1]?.To).toContain("sip:proj_abc12345@sip.api.openai.com");
    const seat = await env.DB.prepare("SELECT brief FROM calls WHERE role = 'assistant'").first<{ brief: string }>();
    expect(seat?.brief).toContain("called their own number");
    await twilioWebhook("/v1/twilio/status", { CallSid: "CA1", CallStatus: "in-progress" });
    expect(legs).toHaveLength(2);
    upstream.done();
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
    expect(await tool(maria, "place_call", { name: "mum", via: "mobile" })).toEqual({
      error: "Twilio is not connected",
    });
    await connectTwilio(maria, { my_number: "" });
    expect(await tool(maria, "place_call", { name: "mum", via: "mobile" })).toEqual({
      error: "the user's own mobile number is not set in Connections",
    });
    expect(await tool(maria, "send_whatsapp", { name: "mum", body: "hi" })).toEqual({
      error: "no WhatsApp sender is set in Connections",
    });
    expect(await tool(maria, "add_to_call", { name: "mum" })).toEqual({
      error: "there is no call in progress; start one first",
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
    const started = (await tool(maria, "start_conference", {
      participants: [{ name: "Mum" }, { name: "Dad" }],
      via: "mobile",
    })) as { ok: boolean; conference: string; pending: string[] };
    expect(started.ok).toBe(true);
    expect(started.pending).toEqual(["Mum", "Dad"]);
    expect(legs).toHaveLength(1);
    expect(legs[0]?.url).toBe(`${TWILIO}/Conferences/${started.conference}/Participants.json`);
    expect(legs[0]?.form).toMatchObject({ To: MY_NUMBER, Label: "host", EndConferenceOnExit: "true" });

    await twilioWebhook("/v1/twilio/status", { CallSid: "CA1", CallStatus: "in-progress" });
    expect(legs.map((l) => l.form.To)).toEqual([MY_NUMBER, MUM, "+447700900124"]);
    expect(legs[1]?.form).toMatchObject({ From: TWILIO_NUMBER, EndConferenceOnExit: "false" });

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

  it("takes a call to the number into a conference and gives the speaker its SIP details", async () => {
    await connectTwilio(maria, { sip_domain: "alexsay.sip.twilio.com" });
    await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID, name: "Kitchen" }, maria);
    const unsigned = await call(`${APP}/v1/twilio/voice`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: TWILIO_NUMBER, From: MUM, CallSid: "CA9" }).toString(),
    });
    expect(unsigned.status).toBe(403);
    const unknown = await twilioWebhook("/v1/twilio/voice", { To: "+447700900555", From: MUM, CallSid: "CA9" });
    expect(unknown.status).toBe(403);

    const upstream = mockUpstream({
      [`POST ${TWILIO}/Conferences/*`]: () => reply(201, { call_sid: "CA-ring", status: "ringing" }),
    });
    const res = await twilioWebhook("/v1/twilio/voice", {
      To: TWILIO_NUMBER,
      From: MUM,
      CallSid: "CA9",
      CallStatus: "ringing",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    const twiml = await res.text();
    expect(twiml).toContain("<Say");
    expect(twiml).toContain("<Conference");
    const row = await env.DB.prepare("SELECT direction, phone, contact_id FROM calls WHERE sid = 'CA9'").first();
    expect(row).toMatchObject({ direction: "in", phone: MUM });
    expect(row?.contact_id).toBe(await mumId());
    upstream.done();

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

  it("signs a voice token for the browser, creating the API key once", async () => {
    await connectTwilio(maria);
    const first = mockUpstream({
      [`POST ${TWILIO}/Keys.json`]: () => reply(201, { sid: "SK1", secret: "key-secret-0123456789" }),
    });
    const res = await call(`${APP}/api/twilio/voice-token`, {}, maria);
    first.done();
    const { token, identity } = (await res.json()) as { token: string; identity: string };
    expect(identity).toBe("alexsay-app");
    const [header, payload] = token
      .split(".")
      .slice(0, 2)
      .map((part) => JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))));
    expect(header).toMatchObject({ alg: "HS256", cty: "twilio-fpa;v=1" });
    expect(payload).toMatchObject({
      iss: "SK1",
      sub: TWILIO_SID,
      grants: { identity: "alexsay-app", voice: { incoming: { allow: true } } },
    });
    const second = mockUpstream({});
    expect((await call(`${APP}/api/twilio/voice-token`, {}, maria)).status).toBe(200);
    second.done();
  });

  it("opens a browser call in stages: the page, then Mum, then the assistant once she answered", async () => {
    await connectTwilio(maria);
    await connectOpenaiForCalls();
    const legs: { url: string; form: Record<string, string> }[] = [];
    const upstream = mockUpstream({
      [`POST ${TWILIO}/Conferences/*`]: (req, body) => {
        legs.push({ url: req.url, form: formOf(body) });
        return reply(201, { call_sid: `CA${legs.length}`, status: "queued" });
      },
    });
    const result = (await (
      await json(
        `${APP}/api/tools/call`,
        "POST",
        {
          name: "place_call",
          arguments: { name: "Mum", task: "ask whether Sunday lunch is still on" },
          client: { voice: "browser" },
        },
        maria,
      )
    ).json()) as { output: { ok: boolean; conference: string; assistant: boolean; host: string; note: string } };
    expect(result.output).toMatchObject({ ok: true, assistant: true, host: "browser" });
    expect(result.output.note).toContain("it answers the moment you stop talking");
    expect(result.output.note).toContain("You join the call yourself");
    const name = result.output.conference;
    expect(legs.map((l) => l.form.To)).toEqual([`client:alexsay-app?conference=${name}`]);
    expect(legs[0]?.form).toMatchObject({
      Label: "host",
      EndConferenceOnExit: "true",
      ConferenceStatusCallback: `${APP}/v1/twilio/conference`,
      ConferenceStatusCallbackEvent: "start end join leave",
    });

    // The page answered and says so itself: Mum is dialled and the assistant right behind her.
    expect((await call(`${APP}/api/twilio/conferences/${name}/answered`, { method: "POST" }, maria)).status).toBe(200);
    expect(legs.map((l) => l.form.To)).toEqual([
      `client:alexsay-app?conference=${name}`,
      MUM,
      `sip:proj_abc12345@sip.api.openai.com;transport=tls?X-Alexsay-Conference=${name}`,
    ]);
    expect(legs[2]?.form).toMatchObject({ Label: "assistant", From: "alexsay" });
    // Twilio's own callbacks then find nothing left to do
    await twilioWebhook("/v1/twilio/status", { CallSid: "CA1", CallStatus: "in-progress" });
    await twilioWebhook("/v1/twilio/status", { CallSid: "CA2", CallStatus: "in-progress" });
    expect(legs).toHaveLength(3);
    expect((await call(`${APP}/api/twilio/conferences/ay-unknown00/answered`, { method: "POST" }, maria)).status).toBe(
      404,
    );
    const brief = await env.DB.prepare("SELECT brief FROM calls WHERE role = 'assistant'").first<{ brief: string }>();
    expect(brief?.brief).toContain("Mum (+447700900123)");
    expect(brief?.brief).toContain("never say it is ringing");
    expect(brief?.brief).toContain("press_digits");
    expect(brief?.brief).toContain("we are in a queue");
    expect(brief?.brief).toContain("without your name");
    expect(brief?.brief).toContain("ask whether Sunday lunch is still on");
    expect(brief?.brief).toContain("end_call");

    // A menu answered: the assistant presses 2, which plays the tones on Mum's leg and returns it to the call
    const pressed = mockUpstream({
      [`POST ${TWILIO}/Calls/CA2.json`]: (_req, body) => {
        const twiml = formOf(body).Twiml ?? "";
        expect(twiml).toContain('<Play digits="ww2"/>');
        expect(twiml).toContain(`>${name}</Conference>`);
        return reply(200, {});
      },
    });
    expect(await tool(maria, "press_digits", { digits: "2" })).toEqual({ ok: true, digits: "2" });
    pressed.done();
    upstream.done();

    // A late callback cannot bring a finished leg back, and a guest whose line ends unanswered is reported
    await twilioWebhook("/v1/twilio/status", { CallSid: "CA2", CallStatus: "busy" });
    await twilioWebhook("/v1/twilio/status", { CallSid: "CA2", CallStatus: "in-progress" });
    expect(await env.DB.prepare("SELECT status FROM calls WHERE sid = 'CA2'").first()).toEqual({ status: "busy" });
    const logged = await env.DB.prepare("SELECT message FROM server_log ORDER BY id").all<{ message: string }>();
    expect(logged.results.map((r) => r.message)).toContain(`call ${name}: ${MUM} busy`);

    // Without the OpenAI SIP setup, the same call still opens in the browser, just without the assistant
    await json(
      `${APP}/api/connections/openai`,
      "PUT",
      { settings: { project_id: "", call_engine: "realtime" } },
      maria,
    );
    const plain = mockUpstream({
      [`POST ${TWILIO}/Conferences/*`]: () => reply(201, { call_sid: `CA${crypto.randomUUID()}`, status: "queued" }),
    });
    const second = (await (
      await json(
        `${APP}/api/tools/call`,
        "POST",
        { name: "place_call", arguments: { name: "Mum" }, client: { voice: "browser" } },
        maria,
      )
    ).json()) as { output: { assistant: boolean; note: string } };
    plain.done();
    expect(second.output).toMatchObject({ assistant: false });
    expect(second.output.note).toContain("You are not on the line");
  });

  it("accepts OpenAI's SIP webhook for a known conference with the briefing and every tool", async () => {
    await connectTwilio(maria);
    await connectOpenaiForCalls();
    let n = 0;
    const legs = mockUpstream({
      [`POST ${TWILIO}/Conferences/*`]: () => reply(201, { call_sid: `CA${++n}`, status: "queued" }),
    });
    const placedCall = (await (
      await json(
        `${APP}/api/tools/call`,
        "POST",
        { name: "place_call", arguments: { name: "Mum" }, client: { voice: "browser" } },
        maria,
      )
    ).json()) as { output: { conference: string } };
    await twilioWebhook("/v1/twilio/status", { CallSid: "CA1", CallStatus: "in-progress" });
    legs.done();
    const conference = placedCall.output.conference;
    const event = {
      type: "realtime.call.incoming",
      data: { call_id: "rtc_1", sip_headers: [{ name: "x-alexsay-conference", value: conference }] },
    };
    let accepted: { instructions: string; tools: { name: string }[]; model: string } | null = null;
    const upstream = mockUpstream({
      "POST https://api.openai.com/v1/realtime/calls/rtc_1/accept": (_req, body) => {
        accepted = JSON.parse(body);
        return reply(200, {});
      },
    });
    const res = await openaiWebhook(event);
    upstream.done();
    expect(res.status).toBe(200);
    const session = accepted as { instructions: string; tools: { name: string }[]; model: string } | null;
    expect(session).toMatchObject({ model: "gpt-realtime" });
    expect(session?.instructions).toContain("never say it is ringing");
    expect(session?.instructions).toContain("Do not introduce yourself and do not speak first");
    expect(session?.instructions).toContain("you give way: stop at once");
    expect(accepted).toMatchObject({
      audio: {
        input: {
          turn_detection: { type: "server_vad", threshold: 0.75, silence_duration_ms: 650, interrupt_response: true },
          noise_reduction: { type: "near_field" },
        },
      },
    });
    const toolNames = session?.tools.map((t) => t.name) ?? [];
    expect(toolNames).toEqual(
      expect.arrayContaining(["end_call", "add_to_call", "find_contact", "remember", "send_text"]),
    );
    expect(toolNames).not.toContain("end_conversation");

    expect((await openaiWebhook(event, `whsec_${btoa("wrong-secret-0123456789")}`)).status).toBe(403);
    expect(
      (
        await openaiWebhook({
          ...event,
          data: { ...event.data, sip_headers: [{ name: "X-Alexsay-Conference", value: "ay-nope" }] },
        })
      ).status,
    ).toBe(404);
    expect((await openaiWebhook({ type: "realtime.something.else" })).status).toBe(200);
    // A conference that is over cannot be joined again with the owner's key
    await env.DB.prepare("UPDATE calls SET status = 'completed' WHERE role = 'assistant'").run();
    expect((await openaiWebhook(event)).status).toBe(404);
  });

  it("tells users of the shared WhatsApp sandbox sender apart by the signature", async () => {
    await addUser("anna", "anna-pass", "user");
    const anna = await signIn("anna", "anna-pass");
    const sandbox = "whatsapp:+14155238886";
    await connectTwilio(maria, { whatsapp_from: sandbox });
    await connectTwilio(anna, { whatsapp_from: sandbox }, "0123456789abcdef0123456789abcdef");
    const forAnna = await twilioWebhook(
      "/v1/twilio/messages",
      { To: sandbox, From: "whatsapp:+447700900777", Body: "hi anna", MessageSid: "SM-anna" },
      "0123456789abcdef0123456789abcdef",
    );
    expect(forAnna.status).toBe(200);
    const stored = await env.DB.prepare("SELECT home_id FROM messages WHERE sid = 'SM-anna'").first<{
      home_id: string;
    }>();
    expect(stored?.home_id).toBe("anna");
    const forged = await twilioWebhook(
      "/v1/twilio/messages",
      { To: sandbox, From: "whatsapp:+447700900777", Body: "x", MessageSid: "SM-x" },
      "ffffffffffffffffffffffffffffffff",
    );
    expect(forged.status).toBe(403);
  });

  it("dials the guests on the conference join event when the leg callbacks go missing, and reports progress", async () => {
    await connectTwilio(maria);
    await connectOpenaiForCalls();
    const legs: Record<string, string>[] = [];
    const upstream = mockUpstream({
      [`POST ${TWILIO}/Conferences/*`]: (_req, body) => {
        legs.push(formOf(body));
        return reply(201, { call_sid: `CA${legs.length}`, status: "queued" });
      },
      [`GET ${TWILIO}/Calls/*`]: (req) => {
        const sid = req.url.split("/").pop()?.replace(".json", "");
        return reply(
          200,
          sid === "CA2" ? { status: "ringing", duration: null } : { status: "in-progress", duration: "8" },
        );
      },
    });
    const placed = (await tool(maria, "place_call", { name: "Mum", via: "mobile" })) as { conference: string };
    expect(legs).toHaveLength(1);
    const joined = await twilioWebhook("/v1/twilio/conference", {
      FriendlyName: placed.conference,
      StatusCallbackEvent: "participant-join",
      CallSid: "CA1",
    });
    expect(joined.status).toBe(204);
    expect(legs.map((l) => l.Label)).toEqual(["host", "Mum", "assistant"]);
    expect(await tool(maria, "call_status", {})).toEqual({
      in_call: true,
      conference: placed.conference,
      legs: [
        { who: "the user, on their mobile", role: "host", status: "in-progress", seconds: 8 },
        { who: `Mum (${MUM})`, role: "guest", status: "ringing", seconds: 0 },
        { who: "you, the assistant", role: "assistant", status: "in-progress", seconds: 8 },
      ],
    });
    const ended = await twilioWebhook("/v1/twilio/conference", {
      FriendlyName: placed.conference,
      StatusCallbackEvent: "conference-end",
    });
    expect(ended.status).toBe(204);
    expect(await tool(maria, "call_status", {})).toEqual({ in_call: false });
    expect(await tool(maria, "end_call", {})).toEqual({ error: "there is no call in progress" });
    const unknown = await twilioWebhook("/v1/twilio/conference", {
      FriendlyName: "ay-nobody",
      StatusCallbackEvent: "conference-end",
    });
    expect(unknown.status).toBe(404);
    upstream.done();
  });

  it("reports a finished call: who answered, who hung up, how long, and what was said", async () => {
    await connectTwilio(maria);
    await connectOpenaiForCalls();
    const seconds: Record<string, string> = { CA1: "65", CA2: "60", CA3: "58" };
    const upstream = mockUpstream({
      [`POST ${TWILIO}/Conferences/*`]: (_req, body) => {
        const label = formOf(body).Label;
        return reply(201, { call_sid: label === "host" ? "CA1" : label === "Mum" ? "CA2" : "CA3", status: "queued" });
      },
      [`GET ${TWILIO}/Calls/*`]: (req) => {
        const sid = req.url.split("/").pop()?.replace(".json", "") ?? "";
        return reply(200, { status: "completed", duration: seconds[sid] ?? "0" });
      },
    });
    const placed = (await tool(maria, "place_call", {
      name: "Mum",
      task: "ask about Sunday lunch",
      via: "mobile",
    })) as {
      conference: string;
    };
    const name = placed.conference;
    await twilioWebhook("/v1/twilio/conference", {
      FriendlyName: name,
      StatusCallbackEvent: "participant-join",
      CallSid: "CA1",
    });
    const before = (await tool(maria, "call_report", {})) as { ready: boolean; ended_at: number | null };
    expect(before).toMatchObject({ ready: false, ended_at: null });
    await env.DB.prepare("INSERT INTO call_turns (conference, at, speaker, text) VALUES (?, ?, 'line', 'Hello?')")
      .bind(name, Date.UTC(2026, 9, 11, 15, 0, 10))
      .run();
    await env.DB.prepare(
      "INSERT INTO call_turns (conference, at, speaker, text) VALUES (?, ?, 'assistant', 'Hi Mum, is Sunday lunch on?')",
    )
      .bind(name, Date.UTC(2026, 9, 11, 15, 0, 12))
      .run();
    // Mum hangs up first, then the user's leg drops and Twilio closes the conference
    await twilioWebhook("/v1/twilio/conference", {
      FriendlyName: name,
      StatusCallbackEvent: "participant-leave",
      CallSid: "CA2",
    });
    await twilioWebhook("/v1/twilio/conference", {
      FriendlyName: name,
      StatusCallbackEvent: "participant-leave",
      CallSid: "CA1",
    });
    await twilioWebhook("/v1/twilio/conference", { FriendlyName: name, StatusCallbackEvent: "conference-end" });
    const report = (await (await call(`${APP}/api/twilio/conferences/${name}/report`, {}, maria)).json()) as {
      ready: boolean;
      ended_by: string;
      seconds: number;
      task: string;
      participants: { who: string; answered: boolean; seconds: number }[];
      transcript: { speaker: string; text: string }[];
    };
    expect(report).toMatchObject({ ready: true, ended_by: "other side", seconds: 65, task: "ask about Sunday lunch" });
    expect(report.participants).toEqual([
      expect.objectContaining({ who: "the user, on their mobile", answered: true, seconds: 65 }),
      expect.objectContaining({ who: `Mum (${MUM})`, answered: true, seconds: 60 }),
      expect.objectContaining({ who: "you, the assistant", answered: true, seconds: 58 }),
    ]);
    expect(report.transcript.map((t) => `${t.speaker}: ${t.text}`)).toEqual([
      "line: Hello?",
      "assistant: Hi Mum, is Sunday lunch on?",
    ]);
    const told = (await tool(maria, "call_report", {})) as { transcript: string[] };
    expect(told.transcript).toEqual(["15:00:10 line: Hello?", "15:00:12 assistant: Hi Mum, is Sunday lunch on?"]);
    expect((await call(`${APP}/api/twilio/conferences/ay-nobody/report`, {}, maria)).status).toBe(412);
    upstream.done();
  });

  it("places a rehearsal call answered by a scripted agent, adds a second one, and lets it leave", async () => {
    await connectTwilio(maria);
    await connectOpenaiForCalls();
    await json(`${APP}/api/session/settings`, "PATCH", { ai_call_test: true }, maria);
    const legs: Record<string, string>[] = [];
    const upstream = mockUpstream({
      [`POST ${TWILIO}/Conferences/*`]: (_req, body) => {
        legs.push(formOf(body));
        return reply(201, { call_sid: `CA${legs.length}`, status: "queued" });
      },
    });
    const placed = (await (
      await json(
        `${APP}/api/tools/call`,
        "POST",
        {
          name: "call_test",
          arguments: {
            role: "a GP receptionist",
            scenario: "The next free appointment is Thursday at 9:40; ask for the patient's date of birth.",
            task: "book me a GP appointment this week",
            voice: "male",
          },
          client: { voice: "browser" },
        },
        maria,
      )
    ).json()) as { output: { ok: boolean; conference: string; note: string } };
    expect(placed.output.ok).toBe(true);
    expect(placed.output.note).toContain("a GP receptionist");
    const name = placed.output.conference;
    await call(`${APP}/api/twilio/conferences/${name}/answered`, { method: "POST" }, maria);
    expect(legs.map((l) => l.Label)).toEqual(["host", "a test agent playing a GP receptionist", "assistant"]);
    const agentTo = legs[1]?.To ?? "";
    expect(agentTo).toMatch(/^sip:proj_abc12345@sip.api.openai.com;transport=tls\?X-Alexsay-Conference=ay-/);
    const agentId = new URLSearchParams(agentTo.split("?")[1]).get("X-Alexsay-Agent") ?? "";
    expect(agentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(legs[2]?.To).not.toContain("X-Alexsay-Agent");

    // OpenAI rings back for the agent's leg: it gets the part, the scenario, its voice and only leave_call
    let accepted: {
      instructions: string;
      tools: { name: string }[];
      audio: { input: { turn_detection: unknown }; output: { voice: string } };
    } | null = null;
    const openai = mockUpstream({
      "POST https://api.openai.com/v1/realtime/calls/rtc_agent/accept": (_req, body) => {
        accepted = JSON.parse(body);
        return reply(200, {});
      },
    });
    const res = await openaiWebhook({
      type: "realtime.call.incoming",
      data: {
        call_id: "rtc_agent",
        sip_headers: [
          { name: "X-Alexsay-Conference", value: name },
          { name: "X-Alexsay-Agent", value: agentId },
        ],
      },
    });
    expect(res.status).toBe(200);
    openai.done();
    const session = accepted as {
      instructions: string;
      tools: { name: string }[];
      audio: { input: { turn_detection: unknown }; output: { voice: string } };
    } | null;
    expect(session?.instructions).toContain("Your part: a GP receptionist");
    expect(session?.instructions).toContain("Thursday at 9:40");
    expect(session?.instructions).toContain("call leave_call");
    expect(session?.tools.map((t) => t.name)).toEqual(["leave_call"]);
    expect(session?.instructions).toContain("you keep talking and they will wait");
    expect(session?.audio.input.turn_detection).toEqual({
      type: "server_vad",
      threshold: 0.75,
      silence_duration_ms: 450,
      prefix_padding_ms: 300,
      create_response: true,
      interrupt_response: false,
    });
    expect(["cedar", "ash", "ballad", "echo", "verse"]).toContain(session?.audio.output.voice);

    // The assistant's own briefing names the agent as who is on the line
    const brief = await env.DB.prepare("SELECT brief FROM calls WHERE role = 'assistant'").first<{ brief: string }>();
    expect(brief?.brief).toContain("a test agent playing a GP receptionist");

    expect(
      await tool(maria, "add_test_agent", { role: "a pharmacist", scenario: "The prescription is ready." }),
    ).toMatchObject({
      ok: true,
    });
    expect(legs).toHaveLength(4);
    expect(legs[3]?.Label).toBe("a test agent playing a pharmacist");
    upstream.done();

    // Told to hang up, the agent leaves its own line; the call goes on
    const left = mockUpstream({
      [`POST ${TWILIO}/Calls/CA2.json`]: (_req, body) => {
        expect(formOf(body)).toEqual({ Status: "completed" });
        return reply(200, {});
      },
    });
    const context = {
      env,
      user: actingFor("maria"),
      origin: APP,
      voice: "browser" as const,
      onCall: true,
      legId: agentId,
    };
    expect(JSON.parse(await runCallTool(context, { call_id: "c1", name: "leave_call", arguments: "{}" }))).toEqual({
      ok: true,
      left: true,
    });
    left.done();
    const agentLeg = await env.DB.prepare("SELECT status FROM calls WHERE id = ?")
      .bind(agentId)
      .first<{ status: string }>();
    expect(agentLeg?.status).toBe("completed");
  });

  it("hangs up the call in progress by ending the host leg", async () => {
    await connectTwilio(maria);
    const legs = mockUpstream({
      [`POST ${TWILIO}/Conferences/*`]: (_req, body) =>
        reply(201, { call_sid: `CA-${formOf(body).Label}`, status: "in-progress" }),
    });
    await json(
      `${APP}/api/tools/call`,
      "POST",
      { name: "place_call", arguments: { name: "Mum" }, client: { voice: "browser" } },
      maria,
    );
    legs.done();
    const ended = mockUpstream({
      [`POST ${TWILIO}/Calls/CA-host.json`]: (_req, body) => {
        expect(formOf(body)).toEqual({ Status: "completed" });
        return reply(200, { status: "completed" });
      },
    });
    expect(await tool(maria, "end_call", {})).toMatchObject({ ok: true });
    ended.done();
    const report = await env.DB.prepare("SELECT ended_by FROM call_reports").first<{ ended_by: string }>();
    expect(report?.ended_by).toBe("user");
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM calls WHERE status != 'completed'").first<{
      n: number;
    }>();
    expect(open?.n).toBe(0);
    expect(await tool(maria, "end_call", {})).toEqual({ error: "there is no call in progress" });
  });

  const WEBHOOK_SECRET = `whsec_${btoa("openai-webhook-secret-0123456789")}`;

  async function connectOpenaiForCalls(): Promise<void> {
    const res = await json(
      `${APP}/api/connections/openai`,
      "PUT",
      {
        api_key: "sk-test-0123456789abcdefghijklmnop",
        webhook_secret: WEBHOOK_SECRET,
        settings: { project_id: "proj_abc12345", call_engine: "realtime" },
      },
      maria,
    );
    expect(await res.json()).toMatchObject({ calls: true });
  }

  async function openaiWebhook(event: unknown, secret = WEBHOOK_SECRET): Promise<Response> {
    const body = JSON.stringify(event);
    const id = "wh_1";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const raw = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (ch) => ch.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
    return call(`${APP}/v1/openai/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`,
      },
      body,
    });
  }

  async function mumId(): Promise<string> {
    const row = await env.DB.prepare("SELECT id FROM contacts WHERE phone = ?").bind(MUM).first<{ id: string }>();
    return row?.id ?? "";
  }
});
