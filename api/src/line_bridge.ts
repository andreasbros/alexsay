import { DurableObject } from "cloudflare:workers";

/**
 * A speaker's phone line. One object per speaker holds two WebSockets: the speaker's own, kept open
 * while it runs, and Twilio's media stream for the call in progress. Audio frames pass straight
 * through in both directions (8 kHz mu-law, base64, as Twilio sends them); the speaker converts.
 *
 * Speaker messages: {type: "audio", payload}, {type: "hangup"}, {type: "mute", muted}, {type: "ping"}.
 * To the speaker: {type: "call.start", conference, who}, {type: "audio", payload}, {type: "call.end"}, {type: "pong"}.
 */
export class LineBridge extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/status") {
      return Response.json(this.status());
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
      });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("not found", { status: 404 });
  }

  status(): { device: boolean; call: { conference: string; streamSid: string } | null } {
    const twilio = this.ctx.getWebSockets("twilio")[0];
    const attachment = twilio?.deserializeAttachment() as { conference?: string; streamSid?: string } | null;
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
      this.fromDevice(ws, message);
    }
  }

  private fromTwilio(ws: WebSocket, message: Record<string, unknown>): void {
    const device = this.ctx.getWebSockets("device")[0];
    switch (message.event) {
      case "start": {
        const start = message.start as { streamSid?: string; customParameters?: Record<string, string> } | undefined;
        const attachment = (ws.deserializeAttachment() as { conference?: string; who?: string } | null) ?? {};
        const conference = start?.customParameters?.conference ?? attachment.conference ?? "";
        const who = start?.customParameters?.who ?? attachment.who ?? "";
        ws.serializeAttachment({ ...attachment, conference, who, streamSid: start?.streamSid ?? "" });
        send(device, { type: "call.start", conference, who });
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
    const streamSid = (twilio?.deserializeAttachment() as { streamSid?: string } | null)?.streamSid;
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
    } else if (this.ctx.getWebSockets("device").length === 0) {
      // The speaker went away: nobody is left to carry the call
      for (const twilio of this.ctx.getWebSockets("twilio")) {
        twilio.close(1000, "the speaker went offline");
      }
    }
  }

  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws);
  }
}

function send(ws: WebSocket | undefined, message: Record<string, unknown>): void {
  try {
    ws?.send(JSON.stringify(message));
  } catch {
    // A socket that is closing drops the frame; the close handler tidies up
  }
}
