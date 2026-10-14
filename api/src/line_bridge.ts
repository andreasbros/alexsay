import { DurableObject } from "cloudflare:workers";
import { logFor } from "./log";
import { endCall, TelephonyError } from "./telephony";

/** During a call the speaker sends audio 50 times a second and pings every 5 s (muted too); nothing for this long is a dead line. */
export const DEVICE_SILENCE_MS = 12_000;
const CHECK_EVERY_MS = 2_000;

/** What the line keeps on Twilio's stream socket. */
interface StreamAttachment {
  conference?: string;
  who?: string;
  username?: string;
  streamSid?: string;
}

/**
 * A speaker's phone line. One object per speaker holds two WebSockets: the speaker's own, kept open
 * while it runs, and Twilio's media stream for the call in progress. Audio frames pass straight
 * through in both directions (8 kHz mu-law, base64, as Twilio sends them); the speaker converts.
 *
 * Speaker messages: {type: "audio", payload}, {type: "hangup"}, {type: "mute", muted}, {type: "ping"}.
 * To the speaker: {type: "call.start", conference, who}, {type: "audio", payload}, {type: "call.end"}, {type: "pong"},
 * and whatever the server pushes through /push (the device channel: alarms.changed, alarm.stop, alarm.snooze).
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
        username: url.searchParams.get("username") ?? "",
      } satisfies StreamAttachment);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("not found", { status: 404 });
  }

  status(): { device: boolean; call: { conference: string; streamSid: string } | null } {
    const twilio = this.ctx.getWebSockets("twilio")[0];
    const attachment = twilio?.deserializeAttachment() as StreamAttachment | null;
    return {
      device: this.ctx.getWebSockets("device").length > 0,
      call: attachment?.streamSid ? { conference: attachment.conference ?? "", streamSid: attachment.streamSid } : null,
    };
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
    if (this.ctx.getTags(ws).includes("twilio")) {
      this.fromTwilio(ws, message);
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
        send(device, { type: "call.start", conference, who });
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

  private fromDevice(ws: WebSocket, message: Record<string, unknown>): void {
    const twilio = this.ctx.getWebSockets("twilio")[0];
    const streamSid = (twilio?.deserializeAttachment() as StreamAttachment | null)?.streamSid;
    switch (message.type) {
      case "audio":
        if (twilio && streamSid && typeof message.payload === "string") {
          send(twilio, { event: "media", streamSid, media: { payload: message.payload } });
        }
        break;
      case "hangup":
        if (twilio) {
          twilio.close(1000, "the speaker hung up");
          send(ws, { type: "call.end" });
        }
        break;
      case "ping":
        send(ws, { type: "pong" });
        break;
      default:
        break;
    }
  }

  webSocketClose(ws: WebSocket): void {
    if (this.ctx.getTags(ws).includes("twilio")) {
      send(this.ctx.getWebSockets("device")[0], { type: "call.end" });
      return;
    }
    // The closing socket is still listed while its close handler runs
    if (!this.ctx.getWebSockets("device").some((other) => other !== ws)) {
      this.lineDropped();
    }
  }

  /** While a call is on: a speaker gone quiet for too long has dropped its line, closed or not. */
  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets("twilio").length === 0) {
      return;
    }
    if (Date.now() - this.lastHeardFromDevice() > DEVICE_SILENCE_MS) {
      this.lineDropped();
      for (const device of this.ctx.getWebSockets("device")) {
        device.close(1001, "no word from the speaker");
      }
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + CHECK_EVERY_MS);
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
    for (const twilio of this.ctx.getWebSockets("twilio")) {
      // Both the alarm and the close handler can get here; the first one hangs up
      if (twilio.readyState !== WebSocket.READY_STATE_OPEN) {
        continue;
      }
      const attachment = (twilio.deserializeAttachment() as StreamAttachment | null) ?? {};
      twilio.close(1000, "the speaker went offline");
      if (attachment.username) {
        this.ctx.waitUntil(this.hangUp(attachment.username, attachment.conference ?? ""));
      }
    }
  }

  /** The stream closing alone can leave the conference up; ending the host leg takes it down. */
  private async hangUp(username: string, conference: string): Promise<void> {
    const scope = { env: this.env };
    await logFor(scope, username, "warn", `call ${conference}: the speaker's line dropped, hanging up`);
    try {
      await endCall(scope, username, "user");
    } catch (err) {
      if (!(err instanceof TelephonyError)) {
        await logFor(scope, username, "error", `call ${conference}: hanging up failed: ${String(err)}`);
      }
    }
  }

  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws);
  }
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
