import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { base64ToBytes, bytesToBase64 } from "../src/mulaw";
import {
  APP,
  addUser,
  connectTwilio,
  formOf,
  json,
  mockUpstream,
  reply,
  resetDb,
  signIn,
  TWILIO,
  TWILIO_NUMBER,
  twilioWebhook,
} from "../test/helpers";

const KEY = (env as unknown as { E2E_OPENAI_API_KEY: string }).E2E_OPENAI_API_KEY;
const MUM = "+447700900123";
const QUIET_FRAME = bytesToBase64(new Uint8Array(160).fill(0xff));

/** The Twilio side of the seat's stream: what GPT-Live says comes back here as mu-law. */
class Stream {
  readonly media: string[] = [];
  readonly other: Record<string, unknown>[] = [];
  constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { event?: string; media?: { payload?: string } };
      if (message.event === "media" && message.media?.payload) {
        this.media.push(message.media.payload);
      } else {
        this.other.push(message as Record<string, unknown>);
      }
    });
  }
  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }
}

/**
 * The GPT-Live seat against the real model: Twilio is mocked, OpenAI is not. A call placed from the
 * app seats the assistant; its self-call is answered with the stream; the stream carries silence in
 * and the assistant's voice out once it is told the person did not answer, which it reports aloud.
 */
describe("the GPT-Live seat on a real session", () => {
  let maria: string;

  beforeEach(async () => {
    await resetDb();
    await addUser("maria", "maria-pass", "user");
    maria = await signIn("maria", "maria-pass");
    await json(`${APP}/api/contacts`, "POST", { name: "Mum", phone: MUM, label: "mobile" }, maria);
    await connectTwilio(maria);
    const res = await json(
      `${APP}/api/connections/openai`,
      "PUT",
      { api_key: KEY, settings: { call_engine: "live" } },
      maria,
    );
    expect(res.status).toBe(200);
  });

  it("speaks to the line through the bridge and keeps what it said", async () => {
    let legs = 0;
    let selfCall: Record<string, string> | null = null;
    const upstream = mockUpstream(
      {
        [`POST ${TWILIO}/Conferences/*`]: () => {
          legs += 1;
          return reply(201, { call_sid: legs === 1 ? "CA-host" : "CA-mum", status: "ringing" });
        },
        [`POST ${TWILIO}/Calls.json`]: (_req, body) => {
          selfCall = formOf(body);
          return reply(201, { sid: "CA-self", status: "queued" });
        },
      },
      { passThrough: (url) => url.startsWith("https://api.openai.com/") },
    );
    const placed = (await (
      await json(
        `${APP}/api/tools/call`,
        "POST",
        { name: "place_call", arguments: { name: "Mum" }, client: { voice: "browser" } },
        maria,
      )
    ).json()) as { output: { conference: string; assistant: boolean } };
    expect(placed.output.assistant).toBe(true);
    const conference = placed.output.conference;
    await twilioWebhook("/v1/twilio/status", { CallSid: "CA-host", CallStatus: "in-progress" });
    expect(selfCall).not.toBeNull();
    const bridge = await env.DB.prepare("SELECT token FROM bridges").first<{ token: string }>();
    await twilioWebhook("/v1/twilio/voice", { To: TWILIO_NUMBER, From: TWILIO_NUMBER, CallSid: "CA-i" });
    const res = await SELF.fetch(`${APP}/v1/twilio/stream/${bridge?.token}`, { headers: { upgrade: "websocket" } });
    if (!res.webSocket) {
      throw new Error("no stream socket");
    }
    const twilio = new Stream(res.webSocket);
    twilio.send({ event: "start", start: { streamSid: "MZ-real" } });

    // The line is quiet; the session needs a moment to open before it is told anything
    const quiet = setInterval(
      () => twilio.send({ event: "media", media: { track: "inbound", payload: QUIET_FRAME } }),
      20,
    );
    try {
      await vi.waitFor(
        async () => {
          const log = await env.DB.prepare(
            "SELECT message FROM server_log WHERE message LIKE '%GPT-Live assistant seat on the line%'",
          ).first();
          expect(log).not.toBeNull();
        },
        { timeout: 20_000, interval: 250 },
      );
      // Mum's line is busy: the seat is told, with a reply, so it speaks
      await twilioWebhook("/v1/twilio/status", { CallSid: "CA-mum", CallStatus: "busy" });
      await vi.waitFor(() => expect(twilio.media.length).toBeGreaterThan(20), { timeout: 60_000, interval: 500 });
      expect(base64ToBytes(twilio.media[0] ?? "").length).toBeGreaterThan(0);
      await vi.waitFor(
        async () => {
          const said = await env.DB.prepare(
            "SELECT text FROM call_turns WHERE conference = ? AND speaker = 'assistant'",
          )
            .bind(conference)
            .all<{ text: string }>();
          expect(said.results.length).toBeGreaterThan(0);
        },
        { timeout: 60_000, interval: 500 },
      );
    } finally {
      clearInterval(quiet);
      twilio.send({ event: "stop" });
    }
    const said = await env.DB.prepare("SELECT text FROM call_turns WHERE conference = ? AND speaker = 'assistant'")
      .bind(conference)
      .all<{ text: string }>();
    // What it said is kept for the report, whatever words it chose
    expect(said.results.length).toBeGreaterThan(0);
    expect(said.results.every((r) => r.text.trim().length > 0)).toBe(true);
    await vi.waitFor(async () => {
      const seat = await env.DB.prepare("SELECT status FROM calls WHERE conference = ? AND role = 'assistant'")
        .bind(conference)
        .first<{ status: string }>();
      expect(seat?.status).toBe("completed");
    });
    upstream.done();
  }, 150_000);
});
