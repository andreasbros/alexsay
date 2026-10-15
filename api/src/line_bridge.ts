import { DurableObject } from "cloudflare:workers";
import { type DropIn, type DropInEnd, dueToEnd, hasSpeech } from "./drop_in";
import { logFor } from "./log";
import { endCall, TelephonyError } from "./telephony";

/** During a call the speaker sends audio 50 times a second and pings every 5 s (muted too); nothing for this long is a dead line. */
export const DEVICE_SILENCE_MS = 12_000;
const CHECK_EVERY_MS = 2_000;

/** What the line keeps on Twilio's stream socket. */
interface StreamAttachment {
  conference?: string;
  who?: string;
  home?: string;
  streamSid?: string;
}

/**
 * A speaker's phone line. One object per speaker holds the speaker's own WebSocket, kept open
 * while it runs, and at most one other: Twilio's media stream for a phone call, or the app's socket
 * for a drop-in. Audio frames pass straight through in both directions (8 kHz mu-law, base64, as
 * Twilio sends them); the speaker and the app convert.
 *
 * Speaker messages: {type: "audio", payload}, {type: "hangup"}, {type: "mute", muted}, {type: "ping"},
 * {type: "drop_in.answer", id, accept}.
 * To the speaker: {type: "call.start", conference, who, kind}, {type: "audio", payload}, {type: "call.end"},
 * {type: "pong"}, {type: "drop_in.offer", id, from}, {type: "drop_in.cancel", id}, and whatever the server
 * pushes through /push (the device channel: alarms.changed, alarm.stop, alarm.snooze).
 * The app's drop-in socket (/guest): it sends audio, hangup, mute and ping like the speaker; it hears
 * {type: "ringing"}, {type: "accepted"}, {type: "audio", payload}, {type: "ended", reason}.
 * If the speaker's socket drops during a call, the call is hung up: nobody is left to carry it.
 * Pings are answered without waking the object, so an idle speaker costs nothing.
 */
export class LineBridge extends DurableObject<Env> {
  /** When the speaker last sent anything: a socket that dies without closing still goes quiet. */
  deviceSeenAt = Date.now();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/status") {
      return Response.json(this.status());
    }
    if (url.pathname === "/push" && request.method === "POST") {
      const device = this.ctx.getWebSockets("device")[0];
      send(device, (await request.json()) as Record<string, unknown>);
      return Response.json({ delivered: device !== undefined });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a websocket", { status: 426 });
    }
    if (url.pathname === "/device") {
      for (const old of this.ctx.getWebSockets("device")) {
        old.close(1000, "replaced by a newer connection");
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ["device"]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/twilio") {
      if (this.ctx.getWebSockets("device").length === 0) {
        return new Response("the speaker is not online", { status: 409 });
      }
      for (const old of this.ctx.getWebSockets("twilio")) {
        old.close(1000, "another call");
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ["twilio"]);
      pair[1].serializeAttachment({
        conference: url.searchParams.get("conference") ?? "",
        who: url.searchParams.get("who") ?? "",
        home: url.searchParams.get("home") ?? "",
      } satisfies StreamAttachment);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/guest") {
      return this.openGuest(url.searchParams.get("id") ?? crypto.randomUUID(), url.searchParams.get("from") ?? "");
    }
    return new Response("not found", { status: 404 });
  }

  /**
   * The app drops in. The socket is always accepted, so the app hears why when it cannot go ahead:
   * the speaker offline, or busy with a call or another drop-in. Otherwise the speaker gets the offer.
   */
  private openGuest(id: string, from: string): Response {
    const pair = new WebSocketPair();
    const device = this.ctx.getWebSockets("device")[0];
    const busy = this.ctx.getWebSockets("twilio").length > 0 || this.guest() !== null;
    if (!device || busy) {
      pair[1].accept();
      send(pair[1], { type: "ended", reason: device ? "busy" : "offline" } satisfies Ended);
      pair[1].close(1000, "cannot drop in");
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    this.ctx.acceptWebSocket(pair[1], ["guest"]);
    const now = Date.now();
    pair[1].serializeAttachment({ id, from, state: "ringing", since: now, lastSpeechAt: now } satisfies DropIn);
    send(device, { type: "drop_in.offer", id, from });
    send(pair[1], { type: "ringing" });
    this.ctx.waitUntil(this.ctx.storage.setAlarm(now + CHECK_EVERY_MS));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  status(): {
    device: boolean;
    call: { conference: string; streamSid: string } | null;
    drop_in: { id: string; from: string; state: DropIn["state"] } | null;
  } {
    const twilio = this.ctx.getWebSockets("twilio")[0];
    const attachment = twilio?.deserializeAttachment() as StreamAttachment | null;
    const guest = this.guest();
    return {
      device: this.ctx.getWebSockets("device").length > 0,
      call: attachment?.streamSid ? { conference: attachment.conference ?? "", streamSid: attachment.streamSid } : null,
      drop_in: guest ? { id: guest.dropIn.id, from: guest.dropIn.from, state: guest.dropIn.state } : null,
    };
  }

  /** The app's live drop-in socket, if any: one the bridge ended stays listed a moment longer. */
  private guest(): { ws: WebSocket; dropIn: DropIn } | null {
    for (const ws of this.ctx.getWebSockets("guest")) {
      const dropIn = ws.deserializeAttachment() as DropIn | null;
      if (dropIn && dropIn.state !== "ended" && ws.readyState === WebSocket.READY_STATE_OPEN) {
        return { ws, dropIn };
      }
    }
    return null;
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    if (typeof raw !== "string") {
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const tags = this.ctx.getTags(ws);
    if (tags.includes("twilio")) {
      this.fromTwilio(ws, message);
    } else if (tags.includes("guest")) {
      this.fromGuest(ws, message);
    } else {
      this.deviceSeenAt = Date.now();
      this.fromDevice(ws, message);
    }
  }

  private fromTwilio(ws: WebSocket, message: Record<string, unknown>): void {
    const device = this.ctx.getWebSockets("device")[0];
    switch (message.event) {
      case "start": {
        const start = message.start as { streamSid?: string; customParameters?: Record<string, string> } | undefined;
        const attachment = (ws.deserializeAttachment() as StreamAttachment | null) ?? {};
        const conference = start?.customParameters?.conference ?? attachment.conference ?? "";
        const who = start?.customParameters?.who ?? attachment.who ?? "";
        ws.serializeAttachment({ ...attachment, conference, who, streamSid: start?.streamSid ?? "" });
        send(device, { type: "call.start", conference, who, kind: "phone" });
        this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + CHECK_EVERY_MS));
        break;
      }
      case "media": {
        const media = message.media as { payload?: string; track?: string } | undefined;
        if (media?.payload && media.track !== "outbound") {
          send(device, { type: "audio", payload: media.payload });
        }
        break;
      }
      case "stop":
        send(device, { type: "call.end" });
        ws.close(1000, "stream stopped");
        break;
      default:
        break;
    }
  }

  private fromGuest(ws: WebSocket, message: Record<string, unknown>): void {
    const dropIn = ws.deserializeAttachment() as DropIn | null;
    if (!dropIn) {
      return;
    }
    switch (message.type) {
      case "audio":
        if (dropIn.state === "open" && typeof message.payload === "string") {
          send(this.ctx.getWebSockets("device")[0], { type: "audio", payload: message.payload });
          this.heardSpeech(ws, dropIn, message.payload);
        }
        break;
      case "hangup":
        this.endDropIn("left");
        break;
      case "ping":
        send(ws, { type: "pong" });
        break;
      default:
        break;
    }
  }

  private fromDevice(ws: WebSocket, message: Record<string, unknown>): void {
    const twilio = this.ctx.getWebSockets("twilio")[0];
    const streamSid = (twilio?.deserializeAttachment() as StreamAttachment | null)?.streamSid;
    const guest = this.guest();
    switch (message.type) {
      case "audio":
        if (twilio && streamSid && typeof message.payload === "string") {
          send(twilio, { event: "media", streamSid, media: { payload: message.payload } });
        } else if (guest?.dropIn.state === "open" && typeof message.payload === "string") {
          send(guest.ws, { type: "audio", payload: message.payload });
          this.heardSpeech(guest.ws, guest.dropIn, message.payload);
        }
        break;
      case "hangup":
        if (twilio) {
          twilio.close(1000, "the speaker hung up");
          send(ws, { type: "call.end" });
        } else if (guest) {
          this.endDropIn("hung_up");
        }
        break;
      case "drop_in.answer":
        if (guest && guest.dropIn.state === "ringing" && message.id === guest.dropIn.id) {
          if (message.accept === true) {
            const now = Date.now();
            guest.ws.serializeAttachment({ ...guest.dropIn, state: "open", lastSpeechAt: now } satisfies DropIn);
            send(guest.ws, { type: "accepted" });
            send(ws, { type: "call.start", conference: guest.dropIn.id, who: guest.dropIn.from, kind: "drop_in" });
          } else {
            this.endDropIn("rejected");
          }
        }
        break;
      case "ping":
        send(ws, { type: "pong" });
        break;
      default:
        break;
    }
  }

  /** Speech on either side keeps the drop-in alive; the time is only written when it moves. */
  private heardSpeech(guest: WebSocket, dropIn: DropIn, payload: string): void {
    if (hasSpeech(payload)) {
      guest.serializeAttachment({ ...dropIn, lastSpeechAt: Date.now() } satisfies DropIn);
    }
  }

  /** Tells both sides and drops the app's socket; the speaker keeps its line. */
  private endDropIn(reason: DropInEnd, guest = this.guest()): void {
    if (!guest) {
      return;
    }
    const device = this.ctx.getWebSockets("device")[0];
    if (guest.dropIn.state === "open") {
      send(device, { type: "call.end" });
    } else if (reason !== "rejected") {
      send(device, { type: "drop_in.cancel", id: guest.dropIn.id });
    }
    send(guest.ws, { type: "ended", reason } satisfies Ended);
    // Closing runs the close handler too; it must not take this for the app leaving
    guest.ws.serializeAttachment({ ...guest.dropIn, state: "ended" } satisfies DropIn);
    guest.ws.close(1000, reason);
  }

  webSocketClose(ws: WebSocket): void {
    const tags = this.ctx.getTags(ws);
    if (tags.includes("twilio")) {
      send(this.ctx.getWebSockets("device")[0], { type: "call.end" });
      return;
    }
    if (tags.includes("guest")) {
      // The app closed its tab or lost its network (a socket closed by its client is no longer listed)
      const dropIn = ws.deserializeAttachment() as DropIn | null;
      this.endDropIn("left", dropIn && dropIn.state !== "ended" ? { ws, dropIn } : null);
      return;
    }
    // The closing socket is still listed while its close handler runs
    if (!this.ctx.getWebSockets("device").some((other) => other !== ws)) {
      this.lineDropped();
    }
  }

  /**
   * While a call or drop-in is on: a speaker gone quiet for too long has dropped its line, closed or
   * not; a drop-in nobody answered, or nobody has spoken on for a while, ends.
   */
  async alarm(): Promise<void> {
    const guest = this.guest();
    if (this.ctx.getWebSockets("twilio").length === 0 && !guest) {
      return;
    }
    const now = Date.now();
    if (guest) {
      const why = dueToEnd(guest.dropIn, now);
      if (why) {
        this.endDropIn(why);
        return;
      }
    }
    const onCall = this.ctx.getWebSockets("twilio").length > 0 || guest?.dropIn.state === "open";
    if (onCall && now - this.lastHeardFromDevice() > DEVICE_SILENCE_MS) {
      this.lineDropped();
      for (const device of this.ctx.getWebSockets("device")) {
        device.close(1001, "no word from the speaker");
      }
      return;
    }
    await this.ctx.storage.setAlarm(now + CHECK_EVERY_MS);
  }

  /** The last message from the speaker, auto-answered pings included. */
  private lastHeardFromDevice(): number {
    const pinged = this.ctx
      .getWebSockets("device")
      .map((ws) => this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0);
    return Math.max(this.deviceSeenAt, ...pinged);
  }

  /** Nobody is left on the user's side: the stream closes and the call is hung up. */
  private lineDropped(): void {
    this.endDropIn("offline");
    for (const twilio of this.ctx.getWebSockets("twilio")) {
      // Both the alarm and the close handler can get here; the first one hangs up
      if (twilio.readyState !== WebSocket.READY_STATE_OPEN) {
        continue;
      }
      const attachment = (twilio.deserializeAttachment() as StreamAttachment | null) ?? {};
      twilio.close(1000, "the speaker went offline");
      if (attachment.home) {
        this.ctx.waitUntil(this.hangUp(attachment.home, attachment.conference ?? ""));
      }
    }
  }

  /** The stream closing alone can leave the conference up; ending the host leg takes it down. */
  private async hangUp(home: string, conference: string): Promise<void> {
    const scope = { env: this.env };
    await logFor(scope, home, "warn", `call ${conference}: the speaker's line dropped, hanging up`);
    try {
      await endCall(scope, home, "user");
    } catch (err) {
      if (!(err instanceof TelephonyError)) {
        await logFor(scope, home, "error", `call ${conference}: hanging up failed: ${String(err)}`);
      }
    }
  }

  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws);
  }
}

interface Ended {
  type: "ended";
  reason: DropInEnd;
}

/** Exactly what the speaker sends (serde, no spaces), so Cloudflare can answer it itself. */
const PING = '{"type":"ping"}';
const PONG = '{"type":"pong"}';

function send(ws: WebSocket | undefined, message: Record<string, unknown>): void {
  try {
    ws?.send(JSON.stringify(message));
  } catch {
    // A socket that is closing drops the frame; the close handler tidies up
  }
}
