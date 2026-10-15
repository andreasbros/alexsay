import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyDevice } from "../src/device_channel";
import { DEVICE_SILENCE_MS, type LineBridge } from "../src/line_bridge";
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
const device = { "x-device-id": DEVICE_ID };

/** Opens the speaker's line socket as the binary does. */
async function openLine(id = DEVICE_ID): Promise<WebSocket> {
  const res = await SELF.fetch(`${APP}/v1/device/line`, { headers: { upgrade: "websocket", "x-device-id": id } });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) {
    throw new Error("no websocket");
  }
  ws.accept();
  return ws;
}

/** Twilio's media stream socket for a bridge token. */
async function openStream(token: string): Promise<Response> {
  return SELF.fetch(`${APP}/v1/twilio/stream/${token}`, { headers: { upgrade: "websocket" } });
}

function nextMessage(ws: WebSocket, timeoutMs = 2_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no message")), timeoutMs);
    ws.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
      },
      { once: true },
    );
  });
}

const deviceTool = (name: string, args: Record<string, unknown>) =>
  call(`${APP}/v1/device/tools/call`, {
    method: "POST",
    headers: { ...device, "content-type": "application/json" },
    body: JSON.stringify({ name, arguments: args }),
  }).then((r) => r.json() as Promise<{ output: Record<string, unknown> }>);

describe("speaker phone line", () => {
  let maria: string;

  beforeEach(async () => {
    await resetDb();
    await addUser("maria", "maria-pass", "user");
    maria = await signIn("maria", "maria-pass");
    await heartbeat(DEVICE_ID, { firmware: "0.2.0" });
    await json(`${APP}/api/contacts`, "POST", { name: "Mum", phone: MUM, label: "mobile" }, maria);
  });

  it("only a claimed speaker may open its line, and the line reports itself online", async () => {
    const refused = await SELF.fetch(`${APP}/v1/device/line`, { headers: { upgrade: "websocket", ...device } });
    expect(refused.status).toBe(403);
    await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID, name: "Kitchen" }, maria);
    expect((await call(`${APP}/v1/device/line`, { headers: device })).status).toBe(426);
    expect(await (await call(`${APP}/v1/device/line/status`, { headers: device })).json()).toEqual({ online: false });
    const ws = await openLine();
    expect(await (await call(`${APP}/v1/device/line/status`, { headers: device })).json()).toEqual({ online: true });
    ws.send(JSON.stringify({ type: "ping" }));
    expect(await nextMessage(ws)).toEqual({ type: "pong" });
    ws.close();
  });

  it("opens a call on the speaker: the number calls itself, streams to the speaker, dials Mum and seats the assistant", async () => {
    await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID, name: "Kitchen" }, maria);
    await connectTwilio(maria);
    await connectOpenaiForCalls(maria);
    const line = await openLine();
    const legs: Record<string, string>[] = [];
    let selfCall: Record<string, string> | null = null;
    const upstream = mockUpstream({
      [`POST ${TWILIO}/Calls.json`]: (_req, body) => {
        selfCall = formOf(body);
        return reply(201, { sid: "CA-host", status: "queued" });
      },
      [`POST ${TWILIO}/Conferences/*`]: (_req, body) => {
        legs.push(formOf(body));
        return reply(201, { call_sid: `CA${legs.length + 1}`, status: "queued" });
      },
    });
    const placed = await deviceTool("place_call", { name: "Mum", task: "ask about lunch" });
    expect(placed.output).toMatchObject({ ok: true, host: "speaker", assistant: true });
    expect(String(placed.output.note)).toContain("opening on the speaker");
    const host = selfCall as Record<string, string> | null;
    expect(host).toMatchObject({ To: TWILIO_NUMBER, From: TWILIO_NUMBER });
    expect(host?.Twiml).toContain(`endConferenceOnExit="true"`);
    expect(host?.Twiml).toContain(`>${placed.output.conference}</Conference>`);
    const bridge = await env.DB.prepare("SELECT * FROM bridges").first<{ token: string; used_at: number | null }>();
    expect(bridge?.used_at).toBeNull();

    // Twilio delivers the self-call to the number: it is answered with the stream and Mum gets dialled
    const answered = await twilioWebhook("/v1/twilio/voice", {
      To: TWILIO_NUMBER,
      From: TWILIO_NUMBER,
      CallSid: "CA-inbound",
    });
    expect(answered.status).toBe(200);
    const twiml = await answered.text();
    expect(twiml).toContain(`<Connect><Stream url="wss://app.alexsay.com/v1/twilio/stream/${bridge?.token}">`);
    expect(twiml).toContain(`<Parameter name="conference" value="${placed.output.conference}"/>`);
    // The stream is answered first; Mum and the assistant are dialled right after, in the background
    await vi.waitFor(() => expect(legs.map((l) => l.Label).sort()).toEqual(["Mum", "assistant"]));
    upstream.done();

    // The stream connects: the speaker hears the call start, audio passes both ways, and it can hang up
    const stream = await openStream(bridge?.token ?? "");
    expect(stream.status).toBe(101);
    const twilio = stream.webSocket;
    if (!twilio) {
      throw new Error("no stream socket");
    }
    twilio.accept();
    twilio.send(JSON.stringify({ event: "connected" }));
    twilio.send(
      JSON.stringify({
        event: "start",
        start: {
          streamSid: "MZ1",
          callSid: "CA-inbound",
          customParameters: { conference: placed.output.conference, who: "speaker" },
        },
      }),
    );
    expect(await nextMessage(line)).toEqual({
      type: "call.start",
      conference: placed.output.conference,
      who: "speaker",
      kind: "phone",
    });
    twilio.send(JSON.stringify({ event: "media", media: { track: "inbound", payload: "AAAA" } }));
    expect(await nextMessage(line)).toEqual({ type: "audio", payload: "AAAA" });
    line.send(JSON.stringify({ type: "audio", payload: "BBBB" }));
    expect(await nextMessage(twilio)).toEqual({ event: "media", streamSid: "MZ1", media: { payload: "BBBB" } });
    expect(await (await call(`${APP}/api/twilio/calls`, {}, maria)).json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "host", phone: "speaker" })]),
    );
    const closed = new Promise<void>((resolve) => twilio.addEventListener("close", () => resolve(), { once: true }));
    line.send(JSON.stringify({ type: "hangup" }));
    expect(await nextMessage(line)).toEqual({ type: "call.end" });
    await closed;
    line.close();
  });

  it("tells the speaker when the call ends from Twilio's side, and refuses a stream for an unknown bridge", async () => {
    await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID, name: "Kitchen" }, maria);
    await connectTwilio(maria);
    const line = await openLine();
    const upstream = mockUpstream({
      [`POST ${TWILIO}/Calls.json`]: () => reply(201, { sid: "CA-host", status: "queued" }),
    });
    const placed = await deviceTool("place_call", { name: "Mum" });
    expect(placed.output).toMatchObject({ ok: true, host: "speaker", assistant: false });
    upstream.done();
    const bridge = await env.DB.prepare("SELECT token FROM bridges").first<{ token: string }>();
    expect((await openStream("nope")).status).toBe(403);
    const stream = await openStream(bridge?.token ?? "");
    const twilio = stream.webSocket;
    if (!twilio) {
      throw new Error("no stream socket");
    }
    twilio.accept();
    twilio.send(JSON.stringify({ event: "start", start: { streamSid: "MZ2" } }));
    expect(await nextMessage(line)).toMatchObject({ type: "call.start" });
    twilio.send(JSON.stringify({ event: "stop" }));
    expect(await nextMessage(line)).toEqual({ type: "call.end" });
    line.close();
  });

  it("refuses a speaker call when the line is down, when Twilio refuses, and rings the mobile only when asked", async () => {
    await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID, name: "Kitchen" }, maria);
    await connectTwilio(maria);
    const down = await deviceTool("place_call", { name: "Mum" });
    expect(String(down.output.error)).toContain("no phone line where the user is talking from");

    const line = await openLine();
    const refused = mockUpstream({
      [`POST ${TWILIO}/Calls.json`]: () => reply(400, { message: "Invalid phone number" }),
    });
    const failed = await deviceTool("place_call", { name: "Mum" });
    expect(String(failed.output.error)).toContain("Invalid phone number");
    refused.done();
    const left = await env.DB.prepare("SELECT * FROM bridges").all();
    expect(left.results).toEqual([]);

    const mobile = mockUpstream({
      [`POST ${TWILIO}/Conferences/*`]: (_req, body) => {
        expect(formOf(body).To).toBe(MY_NUMBER);
        return reply(201, { call_sid: "CA-mobile", status: "queued" });
      },
    });
    const viaMobile = await deviceTool("place_call", { name: "Mum", via: "mobile" });
    expect(viaMobile.output).toMatchObject({ ok: true, host: "mobile" });
    mobile.done();

    // Nobody is waiting: a self-call out of the blue is turned away
    const stray = await twilioWebhook("/v1/twilio/voice", { To: TWILIO_NUMBER, From: TWILIO_NUMBER, CallSid: "CA-x" });
    expect(await stray.text()).toContain("No speaker is waiting");
    line.close();
  });

  it("hangs up the call when the speaker's line drops in the middle of it", async () => {
    await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID, name: "Kitchen" }, maria);
    await connectTwilio(maria);
    const line = await openLine();
    let completed: Record<string, string> | null = null;
    const upstream = mockUpstream({
      [`POST ${TWILIO}/Calls.json`]: () => reply(201, { sid: "CA-host", status: "queued" }),
      [`POST ${TWILIO}/Conferences/*`]: () => reply(201, { call_sid: "CA-mum", status: "queued" }),
      [`POST ${TWILIO}/Calls/CA-host.json`]: (_req, body) => {
        completed = formOf(body);
        return reply(200, {});
      },
    });
    const placed = await deviceTool("place_call", { name: "Mum" });
    await twilioWebhook("/v1/twilio/voice", { To: TWILIO_NUMBER, From: TWILIO_NUMBER, CallSid: "CA-inbound" });
    const bridge = await env.DB.prepare("SELECT token FROM bridges").first<{ token: string }>();
    const twilio = (await openStream(bridge?.token ?? "")).webSocket;
    if (!twilio) {
      throw new Error("no stream socket");
    }
    twilio.accept();
    twilio.send(JSON.stringify({ event: "start", start: { streamSid: "MZ3" } }));
    expect(await nextMessage(line)).toMatchObject({ type: "call.start" });
    const streamClosed = new Promise<void>((resolve) =>
      twilio.addEventListener("close", () => resolve(), { once: true }),
    );

    // The speaker stops (Ctrl-C, a crash, the network): nobody is left on the user's side of the call
    line.close();
    await streamClosed;
    await vi.waitFor(() => expect(completed).toEqual({ Status: "completed" }));
    const report = await call(`${APP}/v1/device/conferences/${placed.output.conference}/report`, { headers: device });
    expect(await report.json()).toMatchObject({ ended_by: "user" });
    const logged = await env.DB.prepare("SELECT message FROM server_log WHERE message LIKE '%line dropped%'").first();
    expect(logged).not.toBeNull();
    upstream.done();
  });

  it("answers the speaker's pings itself, so an idle line costs nothing", async () => {
    await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID, name: "Kitchen" }, maria);
    const line = await openLine();
    line.send(JSON.stringify({ type: "ping" }));
    expect(await nextMessage(line)).toEqual({ type: "pong" });
    const stub = env.LINE_BRIDGE.get(env.LINE_BRIDGE.idFromName(DEVICE_ID));
    const pinged = await runInDurableObject(stub, (_bridge: LineBridge, state: DurableObjectState) =>
      state.getWebSocketAutoResponseTimestamp(state.getWebSockets("device")[0] as WebSocket),
    );
    expect(pinged).toBeInstanceOf(Date);
  });

  it("pushes the server's messages to the speaker, and says when it is not connected", async () => {
    const quiet = "5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9";
    await json(`${APP}/api/devices`, "POST", { id: quiet, name: "Hall" }, maria);
    expect(await notifyDevice({ env }, quiet, { type: "alarms.changed" })).toBe(false);
    const line = await openLine(quiet);
    const pushed = nextMessage(line);
    expect(await notifyDevice({ env }, quiet, { type: "alarm.snooze", minutes: 9 })).toBe(true);
    expect(await pushed).toEqual({ type: "alarm.snooze", minutes: 9 });
  });

  it("hangs up the call when the speaker goes silent without closing its line", async () => {
    await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID, name: "Kitchen" }, maria);
    await connectTwilio(maria);
    const line = await openLine();
    let completed = 0;
    const upstream = mockUpstream({
      [`POST ${TWILIO}/Calls.json`]: () => reply(201, { sid: "CA-host", status: "queued" }),
      [`POST ${TWILIO}/Conferences/*`]: () => reply(201, { call_sid: "CA-mum", status: "queued" }),
      [`POST ${TWILIO}/Calls/CA-host.json`]: () => {
        completed += 1;
        return reply(200, {});
      },
    });
    await deviceTool("place_call", { name: "Mum" });
    await twilioWebhook("/v1/twilio/voice", { To: TWILIO_NUMBER, From: TWILIO_NUMBER, CallSid: "CA-inbound" });
    const bridge = await env.DB.prepare("SELECT token FROM bridges").first<{ token: string }>();
    const twilio = (await openStream(bridge?.token ?? "")).webSocket;
    if (!twilio) {
      throw new Error("no stream socket");
    }
    twilio.accept();
    twilio.send(JSON.stringify({ event: "start", start: { streamSid: "MZ4" } }));
    expect(await nextMessage(line)).toMatchObject({ type: "call.start" });
    const stub = env.LINE_BRIDGE.get(env.LINE_BRIDGE.idFromName(DEVICE_ID));

    // Still talking: the check passes and comes round again
    line.send(JSON.stringify({ type: "mute", muted: false }));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(completed).toBe(0);

    // Then nothing from the speaker for longer than it ever stays quiet
    await runInDurableObject(stub, (bridge: LineBridge) => {
      bridge.deviceSeenAt = Date.now() - DEVICE_SILENCE_MS - 1;
    });
    const streamClosed = new Promise<void>((resolve) =>
      twilio.addEventListener("close", () => resolve(), { once: true }),
    );
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await streamClosed;
    await vi.waitFor(() => expect(completed).toBe(1));
    upstream.done();
  });

  it("hangs up a speaker call through the host leg and reports who was on it", async () => {
    await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID, name: "Kitchen" }, maria);
    await connectTwilio(maria);
    const line = await openLine();
    const upstream = mockUpstream({
      [`POST ${TWILIO}/Calls.json`]: () => reply(201, { sid: "CA-host", status: "queued" }),
      [`POST ${TWILIO}/Conferences/*`]: () => reply(201, { call_sid: "CA-mum", status: "queued" }),
      [`GET ${TWILIO}/Calls/*`]: (req) =>
        reply(
          200,
          req.url.includes("CA-mum")
            ? { status: "no-answer", duration: null }
            : { status: "in-progress", duration: "20" },
        ),
      [`POST ${TWILIO}/Calls/CA-host.json`]: (_req, body) => {
        expect(formOf(body)).toEqual({ Status: "completed" });
        return reply(200, {});
      },
    });
    const placed = await deviceTool("place_call", { name: "Mum" });
    await twilioWebhook("/v1/twilio/voice", { To: TWILIO_NUMBER, From: TWILIO_NUMBER, CallSid: "CA-inbound" });
    const status = await deviceTool("call_status", {});
    expect(status.output).toMatchObject({ in_call: true });
    expect(status.output.legs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ who: "the user, on the speaker", status: "in-progress" }),
        expect.objectContaining({ who: `Mum (${MUM})`, status: "no-answer" }),
      ]),
    );
    expect(await deviceTool("end_call", {})).toMatchObject({
      output: { ok: true, conference: placed.output.conference },
    });
    const report = await call(`${APP}/v1/device/conferences/${placed.output.conference}/report`, { headers: device });
    expect(await report.json()).toMatchObject({ ended_by: "user" });
    upstream.done();
    line.close();
  });
});

describe("a server without a public address", () => {
  const LOCAL = "http://localhost:8787";
  let maria: string;

  beforeEach(async () => {
    await resetDb();
    await addUser("maria", "maria-pass", "user");
    maria = await signIn("maria", "maria-pass");
    await json(`${APP}/api/contacts`, "POST", { name: "Mum", phone: MUM, label: "mobile" }, maria);
  });

  it("leaves the Twilio number's routing alone and says why", async () => {
    const upstream = mockUpstream({
      [`GET ${TWILIO}.json`]: () => reply(200, { friendly_name: "Alexsay", status: "active" }),
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
    const res = await json(
      `${LOCAL}/api/connections/twilio`,
      "PUT",
      {
        account_sid: "AC0123456789abcdef0123456789abcdef",
        auth_token: "fedcba9876543210fedcba9876543210",
        settings: { from_number: TWILIO_NUMBER },
      },
      maria,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ local: true, note: expect.stringContaining("no public address") });
    upstream.done();
    const repair = await call(`${LOCAL}/api/twilio/numbers/repair`, { method: "POST" }, maria);
    expect(repair.status).toBe(412);
  });

  it("still opens calls in the browser, without the assistant and with a reason", async () => {
    await connectTwilio(maria);
    await connectOpenaiForCalls(maria);
    const upstream = mockUpstream({
      [`POST ${TWILIO}/Conferences/*`]: () => reply(201, { call_sid: "CA1", status: "queued" }),
    });
    const placed = (await (
      await json(
        `${LOCAL}/api/tools/call`,
        "POST",
        { name: "place_call", arguments: { name: "Mum" }, client: { voice: "browser" } },
        maria,
      )
    ).json()) as { output: { ok: boolean; host: string; assistant: boolean; without_assistant: string; note: string } };
    expect(placed.output).toMatchObject({ ok: true, host: "browser", assistant: false });
    expect(placed.output.without_assistant).toContain("no public address");
    expect(placed.output.note).toContain("no public address");
    upstream.done();
    const speaker = (await (
      await json(
        `${LOCAL}/api/tools/call`,
        "POST",
        { name: "place_call", arguments: { name: "Mum" }, client: { voice: "speaker" } },
        maria,
      )
    ).json()) as { output: { error: string } };
    expect(speaker.output.error).toContain("public address");
  });
});

async function connectOpenaiForCalls(cookie: string): Promise<void> {
  const res = await json(
    `${APP}/api/connections/openai`,
    "PUT",
    {
      api_key: "sk-test-0123456789abcdefghijklmnop",
      webhook_secret: `whsec_${btoa("a-secret-of-some-length-1234")}`,
      settings: { project_id: "proj_abc12345", call_engine: "realtime" },
    },
    cookie,
  );
  expect(res.status).toBe(200);
}
