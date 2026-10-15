import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { type DropIn, dueToEnd, frameLevel, hasSpeech, RING_MS, SILENCE_HANGUP_MS } from "../src/drop_in";
import type { LineBridge } from "../src/line_bridge";
import { APP, addUser, call, DEVICE_ID, heartbeat, json, resetDb, signIn } from "./helpers";

const device = { "x-device-id": DEVICE_ID };
const OTHER_DEVICE = "0a1b2c3d-4e5f-4a6b-8c7d-9e8f7a6b5c4d";

/** 20 ms of full-scale square wave, and the same of digital silence, as mu-law frames. */
const LOUD = btoa(String.fromCharCode(...Array.from({ length: 160 }, (_, i) => (i % 2 ? 0x80 : 0x00))));
const QUIET = btoa(String.fromCharCode(...Array.from({ length: 160 }, () => 0xff)));

/** A socket whose messages are kept from the moment it opens, so none is missed before a listener is on. */
class Socket {
  private readonly inbox: Record<string, unknown>[] = [];
  private waiting: ((message: Record<string, unknown>) => void) | null = null;
  readonly closed: Promise<void>;

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
    this.closed = new Promise((resolve) => ws.addEventListener("close", () => resolve()));
  }

  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }

  close(): void {
    this.ws.close();
  }

  next(timeoutMs = 2_000): Promise<Record<string, unknown>> {
    const queued = this.inbox.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    const nothing = new Error("no message");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(nothing), timeoutMs);
      this.waiting = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
    });
  }
}

async function open(url: string, headers: Record<string, string>): Promise<Socket> {
  const res = await SELF.fetch(url, { headers: { upgrade: "websocket", ...headers } });
  expect(res.status).toBe(101);
  if (!res.webSocket) {
    throw new Error("no websocket");
  }
  return new Socket(res.webSocket);
}

const openLine = (id = DEVICE_ID) => open(`${APP}/v1/device/line`, { "x-device-id": id });
const openGuest = (cookie: string, id = DEVICE_ID) => open(`${APP}/api/devices/${id}/drop-in`, { cookie });

const stubFor = (id = DEVICE_ID) => env.LINE_BRIDGE.get(env.LINE_BRIDGE.idFromName(id));

/** The bridge object outlives a test: every socket from the last one is closed before the next. */
async function resetBridge(): Promise<void> {
  await runInDurableObject(stubFor(), (_bridge: LineBridge, state: DurableObjectState) => {
    for (const ws of state.getWebSockets()) {
      ws.close(1000, "next test");
    }
  });
}

/** Rewrites the guest's attachment as if that much time had passed. */
async function age(fields: Partial<DropIn>): Promise<void> {
  await runInDurableObject(stubFor(), (_bridge: LineBridge, state: DurableObjectState) => {
    const guest = state.getWebSockets("guest")[0] as WebSocket;
    guest.serializeAttachment({ ...(guest.deserializeAttachment() as DropIn), ...fields });
  });
}

const tool = (cookie: string, args: Record<string, unknown>) =>
  json(`${APP}/api/tools/call`, "POST", { name: "drop_in", arguments: args }, cookie).then(
    (r) => r.json() as Promise<{ output: Record<string, unknown> }>,
  );

describe("drop in on a speaker", () => {
  let maria: string;

  beforeEach(async () => {
    await resetDb();
    await resetBridge();
    await addUser("maria", "maria-pass", "user");
    maria = await signIn("maria", "maria-pass");
    await heartbeat(DEVICE_ID, { firmware: "0.2.0" });
    await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID, name: "Kitchen" }, maria);
  });

  it("offers the drop-in to the speaker, opens on accept, carries audio both ways and ends when the app hangs up", async () => {
    const line = await openLine();
    const guest = await openGuest(maria);
    expect(await guest.next()).toEqual({ type: "ringing" });
    const offer = await line.next();
    expect(offer).toMatchObject({ type: "drop_in.offer", from: "maria" });
    const status = await (await call(`${APP}/v1/device/line/status`, { headers: device })).json();
    expect(status).toEqual({ online: true });

    // Before the speaker answers, nothing is carried either way
    guest.send({ type: "audio", payload: LOUD });
    line.send({ type: "drop_in.answer", id: offer.id, accept: true });
    expect(await guest.next()).toEqual({ type: "accepted" });
    expect(await line.next()).toEqual({
      type: "call.start",
      conference: offer.id,
      who: "maria",
      kind: "drop_in",
    });

    guest.send({ type: "audio", payload: LOUD });
    expect(await line.next()).toEqual({ type: "audio", payload: LOUD });
    line.send({ type: "audio", payload: QUIET });
    expect(await guest.next()).toEqual({ type: "audio", payload: QUIET });
    guest.send({ type: "ping" });
    expect(await guest.next()).toEqual({ type: "pong" });

    const gone = guest.closed;
    guest.send({ type: "hangup" });
    expect(await guest.next()).toEqual({ type: "ended", reason: "left" });
    expect(await line.next()).toEqual({ type: "call.end" });
    await gone;
    line.close();
  });

  it("ends for the app when the speaker rejects, hangs up, or its line drops", async () => {
    let line = await openLine();
    let guest = await openGuest(maria);
    await guest.next();
    let offer = await line.next();
    line.send({ type: "drop_in.answer", id: offer.id, accept: false });
    expect(await guest.next()).toEqual({ type: "ended", reason: "rejected" });

    guest = await openGuest(maria);
    await guest.next();
    offer = await line.next();
    line.send({ type: "drop_in.answer", id: offer.id, accept: true });
    await guest.next();
    await line.next();
    line.send({ type: "hangup" });
    expect(await guest.next()).toEqual({ type: "ended", reason: "hung_up" });
    expect(await line.next()).toEqual({ type: "call.end" });

    guest = await openGuest(maria);
    await guest.next();
    offer = await line.next();
    line.send({ type: "drop_in.answer", id: offer.id, accept: true });
    await guest.next();
    await line.next();
    line.close();
    expect(await guest.next()).toEqual({ type: "ended", reason: "offline" });

    // A wrong id or a second answer changes nothing
    line = await openLine();
    guest = await openGuest(maria);
    await guest.next();
    offer = await line.next();
    line.send({ type: "drop_in.answer", id: "not-this-one", accept: true });
    line.send({ type: "drop_in.answer", id: offer.id, accept: true });
    expect(await guest.next()).toEqual({ type: "accepted" });
    line.send({ type: "drop_in.answer", id: offer.id, accept: false });
    guest.send({ type: "audio", payload: QUIET });
    expect(await line.next()).toMatchObject({ type: "call.start" });
    expect(await line.next()).toEqual({ type: "audio", payload: QUIET });
  });

  it("tells the app at once when the speaker is offline or already busy", async () => {
    const offline = await openGuest(maria);
    expect(await offline.next()).toEqual({ type: "ended", reason: "offline" });
    await offline.closed;

    const line = await openLine();
    const first = await openGuest(maria);
    await first.next();
    await line.next();
    const second = await openGuest(maria);
    expect(await second.next()).toEqual({ type: "ended", reason: "busy" });
    await second.closed;

    // The first drop-in is untouched by the refused second
    const offer = (await runInDurableObject(stubFor(), (bridge: LineBridge) => bridge.status())).drop_in;
    expect(offer).toMatchObject({ from: "maria", state: "ringing" });

    // The app closing its socket while the speaker is still asking cancels the offer
    first.close();
    expect(await line.next()).toEqual({ type: "drop_in.cancel", id: offer?.id });
  });

  it("gives up when nobody answers in time, and hangs up after 40 s without a word on either side", async () => {
    const line = await openLine();
    let guest = await openGuest(maria);
    await guest.next();
    let offer = await line.next();
    expect(await runDurableObjectAlarm(stubFor())).toBe(true);
    await age({ since: Date.now() - RING_MS - 1 });
    expect(await runDurableObjectAlarm(stubFor())).toBe(true);
    expect(await guest.next()).toEqual({ type: "ended", reason: "no_answer" });
    expect(await line.next()).toEqual({ type: "drop_in.cancel", id: offer.id });

    guest = await openGuest(maria);
    await guest.next();
    offer = await line.next();
    line.send({ type: "drop_in.answer", id: offer.id, accept: true });
    await guest.next();
    await line.next();
    // Quiet frames do not count as talking; one loud frame from the speaker resets the clock
    await age({ lastSpeechAt: Date.now() - SILENCE_HANGUP_MS + 500 });
    guest.send({ type: "audio", payload: QUIET });
    await line.next();
    line.send({ type: "audio", payload: LOUD });
    await guest.next();
    const after = (await runInDurableObject(stubFor(), (_bridge: LineBridge, state: DurableObjectState) =>
      (state.getWebSockets("guest")[0] as WebSocket).deserializeAttachment(),
    )) as DropIn;
    expect(Date.now() - after.lastSpeechAt).toBeLessThan(1_000);
    expect(await runDurableObjectAlarm(stubFor())).toBe(true);

    await age({ lastSpeechAt: Date.now() - SILENCE_HANGUP_MS - 1 });
    expect(await runDurableObjectAlarm(stubFor())).toBe(true);
    expect(await guest.next()).toEqual({ type: "ended", reason: "silence" });
    expect(await line.next()).toEqual({ type: "call.end" });
  });

  it("only a member of the speaker's home may drop in, and only with a websocket", async () => {
    await addUser("sam", "sam-pass", "user");
    const sam = await signIn("sam", "sam-pass");
    const other = await SELF.fetch(`${APP}/api/devices/${DEVICE_ID}/drop-in`, {
      headers: { upgrade: "websocket", cookie: sam },
    });
    expect(other.status).toBe(404);
    const plain = await call(`${APP}/api/devices/${DEVICE_ID}/drop-in`, {}, maria);
    expect(plain.status).toBe(426);
    const anonymous = await SELF.fetch(`${APP}/api/devices/${DEVICE_ID}/drop-in`, {
      headers: { upgrade: "websocket" },
    });
    expect(anonymous.status).toBe(401);
  });

  it("the drop_in tool names the speaker for the app, asks between several, and refuses from a speaker", async () => {
    expect((await tool(maria, {})).output).toMatchObject({ error: expect.stringContaining("offline") });
    const line = await openLine();
    expect((await tool(maria, {})).output).toMatchObject({
      ok: true,
      device_id: DEVICE_ID,
      speaker: "Kitchen",
      say: "Dropping in on Kitchen.",
    });
    expect((await tool(maria, { speaker: "kitchen" })).output).toMatchObject({ ok: true, device_id: DEVICE_ID });

    await json(`${APP}/api/devices`, "POST", { id: OTHER_DEVICE, name: "Bedroom" }, maria);
    expect((await tool(maria, {})).output).toMatchObject({ speakers: ["Kitchen", "Bedroom"] });
    expect((await tool(maria, { speaker: "the bedroom" })).output).toMatchObject({
      error: expect.stringContaining("Bedroom is offline"),
    });

    const fromSpeaker = await call(`${APP}/v1/device/tools/call`, {
      method: "POST",
      headers: { ...device, "content-type": "application/json" },
      body: JSON.stringify({ name: "drop_in", arguments: {} }),
    });
    expect(((await fromSpeaker.json()) as { output: Record<string, unknown> }).output).toMatchObject({
      error: expect.stringContaining("from the app"),
    });
    line.close();
  });

  it("hears speech in a frame and knows when a drop-in is due to end", () => {
    expect(frameLevel(LOUD)).toBeGreaterThan(0.9);
    expect(frameLevel(QUIET)).toBe(0);
    expect(frameLevel("")).toBe(0);
    expect(frameLevel("not base64!")).toBe(0);
    expect(hasSpeech(LOUD)).toBe(true);
    expect(hasSpeech(QUIET)).toBe(false);
    const now = 1_000_000_000;
    const ringing: DropIn = { id: "d1", from: "maria", state: "ringing", since: now, lastSpeechAt: now };
    expect(dueToEnd(ringing, now + RING_MS)).toBeNull();
    expect(dueToEnd(ringing, now + RING_MS + 1)).toBe("no_answer");
    const open: DropIn = { ...ringing, state: "open", since: now - 60_000 };
    expect(dueToEnd(open, now + SILENCE_HANGUP_MS)).toBeNull();
    expect(dueToEnd(open, now + SILENCE_HANGUP_MS + 1)).toBe("silence");
  });
});
