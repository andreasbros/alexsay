import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { base64ToBytes, bytesToBase64 } from "../src/mulaw";
import {
  APP,
  addUser,
  call,
  connectTwilio,
  DEVICE_ID,
  formOf,
  heartbeat,
  json,
  mockUpstream,
  reply,
  resetDb,
  signIn,
  TWILIO,
  TWILIO_NUMBER,
  twilioWebhook,
} from "./helpers";

const MUM = "+447700900123";
const LIVE_URL = "GET https://api.openai.com/v1/live/sessions";
const WEBHOOK_SECRET = `whsec_${btoa("openai-webhook-secret-0123456789")}`;

type Engine = "live" | "realtime";

/** A socket whose messages are kept from the moment it is accepted. */
class Inbox {
  private readonly queue: Record<string, unknown>[] = [];
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
        this.queue.push(message);
      }
    });
  }
  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }
  next(timeoutMs = 3_000): Promise<Record<string, unknown>> {
    const queued = this.queue.shift();
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

/**
 * A stand-in for GPT-Live: the seat's upgrade request is forwarded to a relay in an auxiliary worker
 * (test/fake_live.mjs), and the test talks to the other end of that relay.
 */
function fakeLive(): { route: () => Promise<Response>; session: () => Promise<Inbox> } {
  const id = crypto.randomUUID();
  return {
    route: () => env.FAKE_LIVE.fetch(`https://fake-live/live?id=${id}`, { headers: { upgrade: "websocket" } }),
    session: async () => {
      const res = await env.FAKE_LIVE.fetch(`https://fake-live/test?id=${id}`, { headers: { upgrade: "websocket" } });
      if (!res.webSocket) {
        throw new Error("no relay socket");
      }
      return new Inbox(res.webSocket);
    },
  };
}

async function openStream(token: string): Promise<Inbox> {
  const res = await SELF.fetch(`${APP}/v1/twilio/stream/${token}`, { headers: { upgrade: "websocket" } });
  expect(res.status).toBe(101);
  if (!res.webSocket) {
    throw new Error("no stream socket");
  }
  return new Inbox(res.webSocket);
}

const toolAs = (cookie: string, name: string, args: Record<string, unknown>, voice = "browser") =>
  json(`${APP}/api/tools/call`, "POST", { name, arguments: args, client: { voice } }, cookie).then(
    async (r) => ((await r.json()) as { output: Record<string, unknown> }).output,
  );

const QUIET_FRAME = bytesToBase64(new Uint8Array(160).fill(0xff));

describe.each<Engine>(["live", "realtime"])("the assistant on calls (%s engine)", (engine) => {
  let maria: string;

  beforeEach(async () => {
    await resetDb();
    await addUser("maria", "maria-pass", "user");
    maria = await signIn("maria", "maria-pass");
    await heartbeat(DEVICE_ID, { firmware: "0.2.0" });
    await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID, name: "Kitchen" }, maria);
    await json(`${APP}/api/contacts`, "POST", { name: "Mum", phone: MUM, label: "mobile" }, maria);
    await connectTwilio(maria);
    const res = await json(
      `${APP}/api/connections/openai`,
      "PUT",
      {
        api_key: "sk-test-0123456789abcdefghijklmnop",
        webhook_secret: WEBHOOK_SECRET,
        settings: { project_id: "proj_abc12345", call_engine: engine },
      },
      maria,
    );
    expect(await res.json()).toMatchObject({ calls: true });
  });

  /** Where the seat went: a self-call for GPT-Live, a SIP participant for the Realtime API. */
  function seatCapture() {
    const participants: Record<string, string>[] = [];
    const selfCalls: Record<string, string>[] = [];
    const upstream = mockUpstream({
      [`POST ${TWILIO}/Conferences/*`]: (_req, body) => {
        participants.push(formOf(body));
        return reply(201, { call_sid: `CA-p${participants.length}`, status: "ringing" });
      },
      ...(engine === "live"
        ? {
            [`POST ${TWILIO}/Calls.json`]: (_req: Request, body: string) => {
              selfCalls.push(formOf(body));
              return reply(201, { sid: `CA-self${selfCalls.length}`, status: "queued" });
            },
          }
        : {}),
    });
    return { participants, selfCalls, upstream };
  }

  it("seats the assistant once the host is on a call it placed, as a self-call or over SIP", async () => {
    const { participants, selfCalls, upstream } = seatCapture();
    const placed = (await toolAs(maria, "place_call", { name: "Mum", task: "ask about lunch" })) as {
      conference: string;
      assistant: boolean;
    };
    expect(placed.assistant).toBe(true);
    const conference = placed.conference;
    expect(participants.map((p) => p.To)).toEqual([`client:alexsay-app?conference=${conference}`]);

    await twilioWebhook("/v1/twilio/status", { CallSid: "CA-p1", CallStatus: "in-progress" });
    expect(participants.map((p) => p.To)).toContain(MUM);
    const seat = await env.DB.prepare(
      "SELECT phone, status, sid FROM calls WHERE conference = ? AND role = 'assistant'",
    )
      .bind(conference)
      .first<{ phone: string; status: string; sid: string | null }>();
    if (engine === "live") {
      expect(selfCalls).toHaveLength(1);
      expect(selfCalls[0]).toMatchObject({ To: TWILIO_NUMBER, From: TWILIO_NUMBER });
      expect(selfCalls[0]?.Twiml).toContain('startConferenceOnEnter="false" endConferenceOnExit="false"');
      expect(selfCalls[0]?.Twiml).toContain(`>${conference}</Conference>`);
      expect(seat).toEqual({ phone: "assistant:live", status: "queued", sid: "CA-self1" });
      const bridge = await env.DB.prepare("SELECT device_id FROM bridges").first<{ device_id: string }>();
      expect(bridge?.device_id).toMatch(/^live:/);
    } else {
      expect(selfCalls).toHaveLength(0);
      const sip = participants.find((p) => p.Label === "assistant");
      expect(sip?.To).toContain("sip:proj_abc12345@sip.api.openai.com");
      expect(seat).toMatchObject({ phone: "assistant", sid: "CA-p3" });
    }
    upstream.done();
  });

  it("dials a scripted test agent the same way, with its own part", async () => {
    await json(`${APP}/api/session/settings`, "PATCH", { ai_call_test: true }, maria);
    const { participants, selfCalls, upstream } = seatCapture();
    const placed = (await toolAs(maria, "call_test", {
      role: "a dentist's receptionist",
      scenario: "fully booked",
    })) as {
      conference: string;
      pending: string[];
    };
    expect(placed.pending).toEqual(["a test agent playing a dentist's receptionist"]);
    await twilioWebhook("/v1/twilio/status", { CallSid: "CA-p1", CallStatus: "in-progress" });
    const agentLeg = await env.DB.prepare("SELECT brief, sid FROM calls WHERE conference = ? AND role = 'guest'")
      .bind(placed.conference)
      .first<{ brief: string; sid: string }>();
    expect(JSON.parse(agentLeg?.brief ?? "{}")).toMatchObject({ role: "a dentist's receptionist" });
    if (engine === "live") {
      // The agent and the assistant are both self-calls into the conference
      expect(selfCalls).toHaveLength(2);
      expect(agentLeg?.sid).toMatch(/^CA-self/);
    } else {
      expect(participants.find((p) => (p.To ?? "").includes("X-Alexsay-Agent"))).toBeDefined();
    }
    upstream.done();
  });

  it("answers an incoming call with the assistant alone as the conference's host", async () => {
    const { participants, selfCalls, upstream } = seatCapture();
    const rang = await twilioWebhook("/v1/twilio/voice", { To: TWILIO_NUMBER, From: MUM, CallSid: "CA-in" });
    const conference = /<Conference[^>]*>(in-[a-z0-9]+)<\/Conference>/.exec(await rang.text())?.[1] ?? "";
    const answered = await call(`${APP}/v1/device/calls/${conference}/answer`, {
      method: "POST",
      headers: { "x-device-id": DEVICE_ID },
      body: JSON.stringify({ mode: "assistant", instruction: "take a message" }),
    });
    expect(answered.status).toBe(200);
    if (engine === "live") {
      const seat = selfCalls.find((c) => c.Twiml?.includes(`>${conference}</Conference>`));
      expect(seat?.Twiml).toContain('startConferenceOnEnter="true" endConferenceOnExit="true"');
    } else {
      const seat = participants.find((p) => p.Label === "assistant");
      expect(seat).toMatchObject({ StartConferenceOnEnter: "true", EndConferenceOnExit: "true" });
    }
    upstream.done();
  });
});

describe("the GPT-Live seat's bridge", () => {
  let maria: string;

  beforeEach(async () => {
    await resetDb();
    await addUser("maria", "maria-pass", "user");
    maria = await signIn("maria", "maria-pass");
    await json(`${APP}/api/contacts`, "POST", { name: "Mum", phone: MUM, label: "mobile" }, maria);
    await connectTwilio(maria);
    await json(
      `${APP}/api/connections/openai`,
      "PUT",
      { api_key: "sk-test-0123456789abcdefghijklmnop", settings: { call_engine: "live" } },
      maria,
    );
  });

  it("streams the conference to a GPT-Live session with the briefing and tools, both ways, with tools and a transcript", async () => {
    const live = fakeLive();
    let legs = 0;
    let selfCalls = 0;
    const completed: string[] = [];
    const upstream = mockUpstream({
      [`POST ${TWILIO}/Conferences/*`]: () => {
        legs += 1;
        return reply(201, { call_sid: legs === 1 ? "CA-host" : "CA-mum", status: "ringing" });
      },
      [`POST ${TWILIO}/Calls.json`]: () => {
        selfCalls += 1;
        return reply(201, { sid: selfCalls === 1 ? "CA-self" : `CA-self${selfCalls}`, status: "queued" });
      },
      [`POST ${TWILIO}/Calls/*`]: (req) => {
        completed.push(req.url.split("/").pop()?.replace(".json", "") ?? "");
        return reply(200, {});
      },
      [LIVE_URL]: live.route,
    });
    const placed = (await toolAs(maria, "place_call", { name: "Mum" })) as { conference: string; assistant: boolean };
    // No project id, no webhook secret: GPT-Live needs neither
    expect(placed.assistant).toBe(true);
    const conference = placed.conference;
    await twilioWebhook("/v1/twilio/status", { CallSid: "CA-host", CallStatus: "in-progress" });
    const bridge = await env.DB.prepare("SELECT token FROM bridges").first<{ token: string }>();
    expect(bridge).not.toBeNull();

    // Twilio delivers the seat's self-call: the inbound side streams the conference to the seat
    const inbound = await twilioWebhook("/v1/twilio/voice", {
      To: TWILIO_NUMBER,
      From: TWILIO_NUMBER,
      CallSid: "CA-i",
    });
    const twiml = await inbound.text();
    expect(twiml).toContain("<Connect><Stream");
    expect(twiml).toContain(`<Parameter name="who" value="assistant"/>`);
    const twilio = await openStream(bridge?.token ?? "");
    twilio.send({ event: "start", start: { streamSid: "MZ-seat" } });

    // The seat opens GPT-Live with the call briefing, the call tools and 16 kHz PCM
    const session = await live.session();
    const started = await session.next();
    expect(started.type).toBe("session.start");
    const config = started.session as {
      instructions: string;
      audio: { format: { type: string; rate: number }; output: { voice: string } };
      delegation: { responses: { tools: { name: string }[] } };
    };
    expect(config.instructions).toContain("You have just joined a phone call");
    expect(config.instructions).toContain("Mum (+447700900123)");
    expect(config.audio.format).toEqual({ type: "audio/pcmu", rate: 8_000 });
    const tools = config.delegation.responses.tools.map((t) => t.name);
    expect(tools).toContain("end_call");
    expect(tools).not.toContain("end_conversation");

    // Five 20 ms frames from the line become one 100 ms append of the same G.711 bytes
    for (let i = 0; i < 5; i += 1) {
      twilio.send({ event: "media", media: { track: "inbound", payload: QUIET_FRAME } });
    }
    const append = await session.next();
    expect(append.type).toBe("session.input_audio.append");
    expect(base64ToBytes(String(append.audio)).length).toBe(800);
    expect(String(append.audio)).toBe(bytesToBase64(new Uint8Array(800).fill(0xff)));

    // The assistant's G.711 goes back down the line untouched
    const spoken = bytesToBase64(Uint8Array.from({ length: 800 }, (_, i) => (i % 2 ? 0x80 : 0x00)));
    session.send({ type: "session.output_audio.delta", delta: spoken });
    const heard = await twilio.next();
    expect(heard).toEqual({ event: "media", streamSid: "MZ-seat", media: { payload: spoken } });

    // What is said lands in the transcript, and the assistant's tools run as on any call
    session.send({ type: "session.input_transcript.delta", delta: "Hello " });
    session.send({ type: "session.input_transcript.delta", delta: "there" });
    session.send({ type: "session.output_transcript.delta", delta: "Hi Mum" });
    session.send({
      type: "response.event",
      event: {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "c1", name: "recent_calls", arguments: "{}" },
      },
    });
    const output = await session.next();
    expect(output).toMatchObject({
      type: "response.item.create",
      item: { type: "function_call_output", call_id: "c1" },
    });
    expect(JSON.parse(String((output.item as { output: string }).output))).toBeInstanceOf(Array);
    expect(await session.next()).toEqual({ type: "response.create" });

    // Mum answering is told to the seat, as it would be to a Realtime agent
    await twilioWebhook("/v1/twilio/status", { CallSid: "CA-mum", CallStatus: "in-progress" });
    const told = await session.next();
    expect(told).toMatchObject({ type: "response.item.create", item: { type: "message", role: "user" } });
    expect(JSON.stringify(told)).toContain("Mum (+447700900123) answered.");

    // A test call asked for from inside the call joins this conference rather than opening one elsewhere
    await json(`${APP}/api/session/settings`, "PATCH", { ai_call_test: true }, maria);
    session.send({
      type: "response.event",
      event: {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "c2",
          name: "call_test",
          arguments: JSON.stringify({ role: "Sandra", scenario: "a friendly chat" }),
        },
      },
    });
    const joined = await session.next();
    expect(JSON.parse(String((joined.item as { output: string }).output))).toMatchObject({ ok: true });
    expect(await session.next()).toEqual({ type: "response.create" });
    const agentLegs = await env.DB.prepare(
      "SELECT conference, brief FROM calls WHERE role = 'guest' AND phone = 'test agent'",
    ).all<{ conference: string; brief: string }>();
    expect(agentLegs.results).toHaveLength(1);
    expect(agentLegs.results[0]?.conference).toBe(conference);
    expect(JSON.parse(agentLegs.results[0]?.brief ?? "{}")).toMatchObject({ role: "Sandra" });

    // The caller says goodbye and the model only answers in words: once that reply is done, the seat hangs up
    session.send({ type: "session.input_transcript.delta", delta: "okay, bye now" });
    session.send({ type: "session.output_transcript.delta", delta: "Bye!" });
    session.send({ type: "response.event", event: { type: "response.completed" } });
    await vi.waitFor(() => expect(completed).toContain("CA-host"));
    await vi.waitFor(async () => {
      const logged = await env.DB.prepare(
        "SELECT message FROM server_log WHERE message LIKE '%hung up by the seat%'",
      ).first();
      expect(logged).not.toBeNull();
    });
    const turns = await env.DB.prepare("SELECT message FROM server_log WHERE message LIKE '%turn: reply began%'").all<{
      message: string;
    }>();
    expect(turns.results.length).toBeGreaterThan(0);
    expect(turns.results[0]?.message).toContain("tools: recent_calls");

    twilio.send({ event: "stop" });
    expect(await session.next()).toEqual({ type: "session.close" });
    await vi.waitFor(async () => {
      const turns = await env.DB.prepare("SELECT speaker, text FROM call_turns WHERE conference = ? ORDER BY id")
        .bind(conference)
        .all<{ speaker: string; text: string }>();
      expect(turns.results).toEqual([
        { speaker: "line", text: "Hello there" },
        { speaker: "assistant", text: "Hi Mum" },
        { speaker: "line", text: "okay, bye now" },
        { speaker: "assistant", text: "Bye!" },
      ]);
    });
    const seat = await env.DB.prepare("SELECT status FROM calls WHERE conference = ? AND role = 'assistant'")
      .bind(conference)
      .first<{ status: string }>();
    expect(seat?.status).toBe("completed");
    upstream.done();
  });
});
