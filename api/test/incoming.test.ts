import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { allowed, greetingFor, ownerName, RING_MS, spokenNumber, UNANSWERED_JOB, unansweredFor } from "../src/incoming";
import { runDue } from "../src/scheduler";
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
  twilioWebhook,
} from "./helpers";

const MUM = "+447700900123";
const STRANGER = "+447700900777";
const device = { "x-device-id": DEVICE_ID };

/** The speaker's line, with every message kept from the moment it opens. */
class Line {
  private readonly inbox: Record<string, unknown>[] = [];
  private waiting: ((m: Record<string, unknown>) => void) | null = null;
  constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = null;
        resolve(message);
      } else {
        this.inbox.push(message);
      }
    });
  }
  next(timeoutMs = 2_000): Promise<Record<string, unknown>> {
    const queued = this.inbox.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    const nothing = new Error("no message");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(nothing), timeoutMs);
      this.waiting = (m) => {
        clearTimeout(timer);
        resolve(m);
      };
    });
  }
}

async function openLine(): Promise<Line> {
  const res = await SELF.fetch(`${APP}/v1/device/line`, { headers: { upgrade: "websocket", ...device } });
  expect(res.status).toBe(101);
  if (!res.webSocket) {
    throw new Error("no websocket");
  }
  return new Line(res.webSocket);
}

const tool = (cookie: string, name: string, args: Record<string, unknown> = {}) =>
  json(`${APP}/api/tools/call`, "POST", { name, arguments: args }, cookie).then(
    async (r) => ((await r.json()) as { output: unknown }).output,
  );

const ring = (from = MUM, sid = "CA-in") =>
  twilioWebhook("/v1/twilio/voice", { To: TWILIO_NUMBER, From: from, CallSid: sid, CallStatus: "ringing" });

const OPENAI_SECRET = `whsec_${btoa("openai-webhook-secret-0123456789")}`;

/** Changes the Twilio settings of a connected account; the number stays, so Twilio is not called. */
const setTwilio = (cookie: string, changes: Record<string, unknown>) =>
  json(
    `${APP}/api/connections/twilio`,
    "PUT",
    { settings: { from_number: TWILIO_NUMBER, my_number: MY_NUMBER, ...changes } },
    cookie,
  );

describe("incoming calls and messages", () => {
  let maria: string;

  beforeEach(async () => {
    await resetDb();
    await addUser("maria", "maria-pass", "user");
    maria = await signIn("maria", "maria-pass");
    await heartbeat(DEVICE_ID, { firmware: "0.2.0" });
    await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID, name: "Kitchen" }, maria);
    await json(`${APP}/api/contacts`, "POST", { name: "Mum", phone: MUM, label: "mobile" }, maria);
  });

  it("knows the policies, the owner's name, the greeting and how to read a number out", () => {
    expect(allowed("everyone", false)).toBe(true);
    expect(allowed("contacts", false)).toBe(false);
    expect(allowed("contacts", true)).toBe(true);
    expect(allowed("off", true)).toBe(false);
    expect(ownerName({ owner_name: "" }, "andreas")).toBe("Andreas");
    expect(ownerName({ owner_name: "Andy B" }, "andreas")).toBe("Andy B");
    expect(greetingFor({ owner_name: "", greeting: "" }, "maria")).toBe(
      "Hi, this is Aleksei, Maria's assistant. Please stay on the line while I'm connecting you.",
    );
    expect(greetingFor({ owner_name: "Mo", greeting: "{name} here, hold on" }, "maria")).toBe("Mo here, hold on");
    expect(unansweredFor({ unanswered: "" })).toContain("try again later");
    expect(unansweredFor({ unanswered: "Bye now" })).toBe("Bye now");
    expect(spokenNumber("+447700900123")).toBe("+44 7700 900 123");
    expect(spokenNumber("+14155552671")).toBe("+14 155 552 671");
    expect(spokenNumber("12345")).toBe("12345");
  });

  it("refuses calls when they are off or from strangers under contacts only, and keeps a record", async () => {
    await connectTwilio(maria, { incoming_calls: "off" });
    const off = await ring();
    expect(await off.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect((await setTwilio(maria, { incoming_calls: "contacts" })).status).toBe(200);
    const stranger = await ring(STRANGER, "CA-stranger");
    expect(await stranger.text()).toContain("only takes calls from people it knows");
    const rows = await env.DB.prepare("SELECT phone, status FROM calls ORDER BY at").all();
    expect(rows.results).toEqual([
      { phone: MUM, status: "rejected" },
      { phone: STRANGER, status: "rejected" },
    ]);
  });

  it("greets the caller, parks them with music, rings the speakers, the app and the mobile, and times out after 40 s", async () => {
    await connectTwilio(maria, { incoming_calls: "contacts", owner_name: "Maria", voice: "Polly.Brian-Neural" });
    const line = await openLine();
    const participants: Record<string, string>[] = [];
    const completed: string[] = [];
    let redirected: Record<string, string> | null = null;
    const upstream = mockUpstream({
      [`POST ${TWILIO}/Conferences/*`]: (_req, body) => {
        participants.push(formOf(body));
        return reply(201, { call_sid: `CA-host-${participants.length}`, status: "ringing" });
      },
      [`POST ${TWILIO}/Calls/*`]: (req, body) => {
        const sid = req.url.split("/").pop()?.replace(".json", "") ?? "";
        const form = formOf(body);
        if (form.Status === "completed") {
          completed.push(sid);
        } else {
          redirected = { sid, ...form };
        }
        return reply(200, {});
      },
    });
    const res = await ring();
    const twiml = await res.text();
    expect(twiml).toContain("Hi, this is Aleksei, Maria&apos;s assistant.");
    expect(twiml).toContain('<Say voice="Polly.Brian-Neural" language="en-GB">');
    expect(twiml).toContain('startConferenceOnEnter="false"');
    const conference = /<Conference[^>]*>(in-[a-z0-9]+)<\/Conference>/.exec(twiml)?.[1] ?? "";
    expect(conference).toMatch(/^in-[a-z0-9]{20}$/);

    // Every side rings at once: the speakers by push, the app and the mobile as conference hosts
    expect(await line.next()).toEqual({
      type: "call.incoming",
      conference,
      from: MUM,
      name: "Mum",
      say: "Call from Mum",
    });
    expect(participants.map((p) => p.To)).toEqual([`client:alexsay-app?incoming=${conference}&from=Mum`, MY_NUMBER]);
    // They start the conference when answered, but one failing (the app not open) must not end it for the caller
    expect(participants.every((p) => p.StartConferenceOnEnter === "true" && p.EndConferenceOnExit === "false")).toBe(
      true,
    );
    const legs = await env.DB.prepare(
      "SELECT role, phone, status, direction FROM calls WHERE conference = ? ORDER BY at",
    )
      .bind(conference)
      .all();
    expect(legs.results).toEqual([
      { role: "guest", phone: MUM, status: "ringing", direction: "in" },
      { role: "host", phone: "browser", status: "ringing", direction: "out" },
      { role: "host", phone: MY_NUMBER, status: "ringing", direction: "out" },
    ]);
    const job = await env.DB.prepare("SELECT topic, next_at FROM jobs WHERE home_id = 'maria'").first<{
      topic: string;
      next_at: number;
    }>();
    expect(job?.topic).toBe(UNANSWERED_JOB);
    expect((job?.next_at ?? 0) - Date.now()).toBeGreaterThan(RING_MS - 2_000);

    // Nobody picks up: the caller is told to try later, the rest stop ringing, the home hears of the missed call
    expect(await runDue({ env }, "maria", Date.now() + RING_MS + 1_000)).toBe(1);
    expect(redirected).toMatchObject({ sid: "CA-in" });
    expect((redirected as Record<string, string> | null)?.Twiml).toContain("Please try again later.");
    expect(completed.sort()).toEqual(["CA-host-1", "CA-host-2"]);
    expect(await line.next()).toEqual({ type: "call.incoming.cancel", conference });
    const told = await line.next();
    expect(told).toMatchObject({ type: "notify", kind: "call", say: "Missed call from Mum." });
    const after = await env.DB.prepare("SELECT sid, status FROM calls WHERE conference = ? ORDER BY at")
      .bind(conference)
      .all();
    expect(after.results).toEqual([
      { sid: "CA-in", status: "no-answer" },
      { sid: "CA-host-1", status: "canceled" },
      { sid: "CA-host-2", status: "canceled" },
    ]);
    const missed = (await tool(maria, "recent_calls", {})) as { with: string; status: string; direction: string }[];
    expect(missed).toEqual([{ ...missed[0], with: "Mum", status: "no-answer", direction: "incoming" }]);
    const notes = (await tool(maria, "list_notifications", {})) as { id: string; kind: string; title: string }[];
    expect(notes).toMatchObject([{ kind: "call", title: "Missed call from Mum" }]);
    // Running the job again changes nothing more
    expect(await runDue({ env }, "maria", Date.now() + RING_MS + 1_000)).toBe(0);
    upstream.done();
  });

  it("lets a speaker take the call: its line streams it, the others stop ringing and the assistant joins quietly", async () => {
    await connectTwilio(maria);
    await connectOpenaiForCalls(maria);
    const line = await openLine();
    const participants: Record<string, string>[] = [];
    const completed: string[] = [];
    const pinned: string[] = [];
    let selfCall: Record<string, string> | null = null;
    const upstream = mockUpstream({
      [`POST ${TWILIO}/Conferences/*`]: (req, body) => {
        if (/\/Participants\/[^/]+\.json$/.test(req.url)) {
          pinned.push(req.url.split("/").pop()?.replace(".json", "") ?? "");
          return reply(200, {});
        }
        participants.push(formOf(body));
        return reply(201, { call_sid: `CA-p${participants.length}`, status: "ringing" });
      },
      [`POST ${TWILIO}/Calls.json`]: (_req, body) => {
        selfCall = formOf(body);
        return reply(201, { sid: "CA-self", status: "queued" });
      },
      [`POST ${TWILIO}/Calls/*`]: (req) => {
        completed.push(req.url.split("/").pop()?.replace(".json", "") ?? "");
        return reply(200, {});
      },
    });
    const twiml = await (await ring()).text();
    const conference = /<Conference[^>]*>(in-[a-z0-9]+)<\/Conference>/.exec(twiml)?.[1] ?? "";
    await line.next();

    // The speaker says yes: the number calls itself for the stream, as for a call placed on the speaker
    const answered = await call(`${APP}/v1/device/calls/${conference}/answer`, {
      method: "POST",
      headers: device,
      body: JSON.stringify({ mode: "speaker" }),
    });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ conference, host: "speaker", caller: "Mum" });
    expect(selfCall).toMatchObject({ To: TWILIO_NUMBER, From: TWILIO_NUMBER });
    expect((selfCall as Record<string, string> | null)?.Twiml).toContain(`>${conference}</Conference>`);

    // Twilio delivers the self-call: the speaker gets the stream, the app and mobile legs are cancelled, the assistant seated
    const stream = await twilioWebhook("/v1/twilio/voice", {
      To: TWILIO_NUMBER,
      From: TWILIO_NUMBER,
      CallSid: "CA-inbound",
    });
    expect(await stream.text()).toContain("<Connect><Stream");
    // The host's answer runs after the reply to Twilio, so the rest follows a moment later
    await vi.waitFor(() => expect(completed.sort()).toEqual(["CA-p1", "CA-p2"]));
    await vi.waitFor(() => expect(pinned).toEqual(["CA-self"]));
    expect(await line.next()).toEqual({ type: "call.incoming.cancel", conference });
    await vi.waitFor(() => expect(participants.some((p) => p.Label === "assistant")).toBe(true));
    const assistant = participants.find((p) => p.Label === "assistant");
    expect(assistant?.To).toContain(`sip:proj_abc12345@sip.api.openai.com`);
    expect(assistant?.StartConferenceOnEnter).toBe("false");
    const seat = await env.DB.prepare("SELECT brief FROM calls WHERE conference = ? AND role = 'assistant'")
      .bind(conference)
      .first<{ brief: string }>();
    expect(seat?.brief).toContain("Mum (+447700900123) has called maria's number");
    expect(seat?.brief).toContain("answered on their speaker");

    // A second answer is too late
    const again = await call(`${APP}/v1/device/calls/${conference}/answer`, {
      method: "POST",
      headers: device,
      body: JSON.stringify({ mode: "speaker" }),
    });
    expect(again.status).toBe(409);
    // The 40 s job finds the call answered and leaves it alone
    expect(await runDue({ env }, "maria", Date.now() + RING_MS + 1_000)).toBe(1);
    expect(await env.DB.prepare("SELECT status FROM calls WHERE sid = 'CA-in'").first()).toEqual({ status: "ringing" });
    upstream.done();
  });

  it("lets the assistant take the call alone with instructions, write down the message and hang up", async () => {
    await connectTwilio(maria);
    await connectOpenaiForCalls(maria);
    const line = await openLine();
    const participants: Record<string, string>[] = [];
    const completed: string[] = [];
    const upstream = mockUpstream({
      [`POST ${TWILIO}/Conferences/*`]: (_req, body) => {
        participants.push(formOf(body));
        return reply(201, { call_sid: `CA-p${participants.length}`, status: "ringing" });
      },
      [`POST ${TWILIO}/Calls/*`]: (req) => {
        completed.push(req.url.split("/").pop()?.replace(".json", "") ?? "");
        return reply(200, {});
      },
    });
    const twiml = await (await ring()).text();
    const conference = /<Conference[^>]*>(in-[a-z0-9]+)<\/Conference>/.exec(twiml)?.[1] ?? "";
    await line.next();
    const answered = await call(`${APP}/v1/device/calls/${conference}/answer`, {
      method: "POST",
      headers: device,
      body: JSON.stringify({ mode: "assistant", instruction: "say I am unavailable and take a message" }),
    });
    expect(await answered.json()).toEqual({ conference, host: "assistant", caller: "Mum" });
    const assistant = participants.find((p) => p.Label === "assistant");
    expect(assistant?.StartConferenceOnEnter).toBe("true");
    expect(assistant?.EndConferenceOnExit).toBe("true");
    expect(completed.sort()).toEqual(["CA-p1", "CA-p2"]);
    expect(await line.next()).toEqual({ type: "call.incoming.cancel", conference });
    const seat = await env.DB.prepare("SELECT brief FROM calls WHERE conference = ? AND role = 'assistant'")
      .bind(conference)
      .first<{ brief: string }>();
    expect(seat?.brief).toContain("They asked you: say I am unavailable and take a message");
    expect(seat?.brief).toContain("take_message");
    await env.DB.prepare("UPDATE calls SET status = 'in-progress' WHERE conference = ? AND role = 'assistant'")
      .bind(conference)
      .run();

    // On the call, the assistant takes the message: the home hears it and it is kept
    const taken = await tool(maria, "take_message", { text: "Mum says dinner is at seven, bring the cake" });
    expect(taken).toEqual({ ok: true, from: "Mum" });
    expect(await line.next()).toMatchObject({
      type: "notify",
      kind: "note",
      say: "Message from Mum: Mum says dinner is at seven, bring the cake",
    });
    const listed = (await (await call(`${APP}/api/notifications`, {}, maria)).json()) as {
      unread: number;
      notifications: { kind: string; title: string; body: string; contact: string | null }[];
    };
    expect(listed.unread).toBe(1);
    expect(listed.notifications).toMatchObject([
      { kind: "note", title: "Message from Mum", body: "Mum says dinner is at seven, bring the cake", contact: "Mum" },
    ]);
    // Hanging up ends the assistant's own seat, since it hosts this conference
    expect(await tool(maria, "end_call", {})).toMatchObject({ ok: true, conference });
    expect(completed.at(-1)).toBe("CA-p3");
    upstream.done();
  });

  it("still tells a waiting caller to try later when a ringing leg failed and ended the first conference instance", async () => {
    await connectTwilio(maria);
    let redirected: string | null = null;
    const upstream = mockUpstream({
      [`POST ${TWILIO}/Conferences/*`]: () => reply(201, { call_sid: "CA-app", status: "ringing" }),
      [`GET ${TWILIO}/Calls/CA-in.json`]: () => reply(200, { status: "in-progress", duration: null }),
      [`POST ${TWILIO}/Calls/*`]: (req, body) => {
        if (req.url.endsWith("CA-in.json")) {
          redirected = formOf(body).Twiml ?? null;
        }
        return reply(200, {});
      },
    });
    const twiml = await (await ring()).text();
    const conference = /<Conference[^>]*>(in-[a-z0-9]+)<\/Conference>/.exec(twiml)?.[1] ?? "";
    // The app is not open: its leg drops at once and Twilio ends that conference instance before the caller joins
    await twilioWebhook("/v1/twilio/conference", {
      FriendlyName: conference,
      StatusCallbackEvent: "conference-end",
    });
    expect(await env.DB.prepare("SELECT status FROM calls WHERE sid = 'CA-in'").first()).toEqual({
      status: "completed",
    });
    expect(await runDue({ env }, "maria", Date.now() + RING_MS + 1_000)).toBe(1);
    expect(redirected).toContain("try again later");
    upstream.done();
  });

  it("keeps and announces texts by policy, lists them under Messages, and marks notifications read", async () => {
    await connectTwilio(maria, { incoming_messages: "contacts" });
    const line = await openLine();
    const stranger = await twilioWebhook("/v1/twilio/messages", {
      To: TWILIO_NUMBER,
      From: STRANGER,
      Body: "Buy now",
      MessageSid: "SM-spam",
    });
    expect(stranger.status).toBe(200);
    const mum = await twilioWebhook("/v1/twilio/messages", {
      To: TWILIO_NUMBER,
      From: MUM,
      Body: "Dinner at 7?",
      MessageSid: "SM-mum",
    });
    expect(mum.status).toBe(200);
    expect(await line.next()).toMatchObject({
      type: "notify",
      kind: "message",
      say: "Text message from Mum: Dinner at 7?",
    });
    const messages = (await (await call(`${APP}/api/messages`, {}, maria)).json()) as {
      body: string;
      contact: string;
    }[];
    expect(messages).toMatchObject([{ body: "Dinner at 7?", contact: "Mum" }]);

    expect((await setTwilio(maria, { incoming_messages: "off" })).status).toBe(200);
    await twilioWebhook("/v1/twilio/messages", {
      To: TWILIO_NUMBER,
      From: MUM,
      Body: "Still there?",
      MessageSid: "SM-2",
    });
    expect(((await (await call(`${APP}/api/messages`, {}, maria)).json()) as unknown[]).length).toBe(1);

    const unread = (await tool(maria, "list_notifications", {})) as { id: string; title: string; read: boolean }[];
    expect(unread).toMatchObject([{ title: "Text from Mum", read: false }]);
    expect(await tool(maria, "mark_notifications_read", { ids: [unread[0]?.id] })).toEqual({ ok: true, marked: 1 });
    expect(await tool(maria, "list_notifications", {})).toEqual([]);
    expect((await tool(maria, "list_notifications", { unread_only: false })) as unknown[]).toHaveLength(1);
    const read = await json(`${APP}/api/notifications/read`, "POST", {}, maria);
    expect(await read.json()).toEqual({ marked: 0 });
  });

  async function connectOpenaiForCalls(cookie: string): Promise<void> {
    const res = await json(
      `${APP}/api/connections/openai`,
      "PUT",
      {
        api_key: "sk-test-0123456789abcdefghijklmnop",
        webhook_secret: OPENAI_SECRET,
        settings: { project_id: "proj_abc12345" },
      },
      cookie,
    );
    expect(await res.json()).toMatchObject({ calls: true });
  }
});
