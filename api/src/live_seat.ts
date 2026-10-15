import { DurableObject } from "cloudflare:workers";
import { type CallNotice, realtimeFunctionCall, runCallTool } from "./call_agent";
import { openaiConnection } from "./connections";
import { calls, connections, homes } from "./db";
import { logFor } from "./log";
import { base64ToBytes, base64ToPcm16, liveToTwilio, muLawToPcm16k, pcm16ToBase64 } from "./mulaw";
import { liveCallSession, liveSocketUrl } from "./providers/openai";
import { skills } from "./skills";
import { agentBrief, notOnCalls, parseAgent } from "./telephony";
import { agentToolDefinitions, toolDefinitions } from "./tools";
import { actingFor, type CallRow, type CallSpeaker, type ToolContext } from "./types";

/** How the stream route names the seat and what it tells the object when Twilio's stream arrives. */
export const liveSeatName = (legId: string) => `live:${legId}`;

export interface SeatStart {
  legId: string;
  conference: string;
  home: string;
  origin: string;
}

/** Twilio's frames are 20 ms; GPT-Live is fed in 100 ms pieces, as the speaker does. */
const FRAMES_PER_APPEND = 5;

/**
 * A seat on a phone call held by a GPT-Live session: the assistant's (full duplex, the model the
 * speaker uses, with the call briefing and the registry's tools), or a scripted test agent's. The
 * seat is a call from the user's number to itself: the outbound side sits in the conference, the
 * inbound side streams the conference's audio here (8 kHz mu-law), and this object bridges it to
 * GPT-Live (16 kHz PCM) both ways, runs the function calls, and keeps the transcript for the report.
 */
export class LiveSeat extends DurableObject<Env> {
  private twilio: WebSocket | null = null;
  private streamSid = "";
  private live: WebSocket | null = null;
  private start: SeatStart | null = null;
  private leg: CallRow | null = null;
  private agent = false;
  private pending: Int16Array[] = [];
  private heard = { line: "", assistant: "" };
  private closed = false;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/notify" && request.method === "POST") {
      return this.notify((await request.json()) as CallNotice);
    }
    if (url.pathname !== "/twilio" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("not found", { status: 404 });
    }
    this.start = {
      legId: url.searchParams.get("leg") ?? "",
      conference: url.searchParams.get("conference") ?? "",
      home: url.searchParams.get("home") ?? "",
      origin: url.searchParams.get("origin") ?? "",
    };
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    this.twilio = server;
    server.addEventListener("message", (event) => {
      void this.fromTwilio(event.data);
    });
    server.addEventListener("close", () => void this.end("the stream closed"));
    server.addEventListener("error", () => void this.end("the stream failed"));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** What happened on the call that the seat cannot hear for itself: someone answered, or did not. */
  private notify(notice: CallNotice): Response {
    if (!this.live) {
      return new Response(null, { status: 409 });
    }
    this.toLive({
      type: "response.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: notice.text }] },
    });
    if (notice.reply) {
      this.toLive({ type: "response.create" });
    }
    return new Response(null, { status: 204 });
  }

  private async fromTwilio(data: unknown): Promise<void> {
    let message: { event?: string; start?: { streamSid?: string }; media?: { payload?: string; track?: string } };
    try {
      message = JSON.parse(typeof data === "string" ? data : "") as typeof message;
    } catch {
      return;
    }
    switch (message.event) {
      case "start":
        this.streamSid = message.start?.streamSid ?? "";
        await this.openLive();
        break;
      case "media":
        if (message.media?.payload && message.media.track !== "outbound") {
          this.pending.push(muLawToPcm16k(base64ToBytes(message.media.payload)));
          if (this.pending.length >= FRAMES_PER_APPEND) {
            this.flushAudio();
          }
        }
        break;
      case "stop":
        await this.end("the stream stopped");
        break;
      default:
        break;
    }
  }

  private flushAudio(): void {
    if (this.pending.length === 0 || !this.live) {
      this.pending = [];
      return;
    }
    const total = this.pending.reduce((n, piece) => n + piece.length, 0);
    const joined = new Int16Array(total);
    let at = 0;
    for (const piece of this.pending) {
      joined.set(piece, at);
      at += piece.length;
    }
    this.pending = [];
    this.toLive({ type: "session.input_audio.append", audio: pcm16ToBase64(joined) });
  }

  /** Opens the GPT-Live session for this seat, with the briefing and tools its leg calls for. */
  private async openLive(): Promise<void> {
    const start = this.start;
    if (!start) {
      return;
    }
    const scope = { env: this.env };
    try {
      const leg = await calls.get(this.env.DB, start.legId);
      const openai = leg ? await openaiConnection(scope, leg.home_id) : null;
      if (!leg || !openai) {
        throw new Error("no leg or no OpenAI connection for this seat");
      }
      this.leg = leg;
      const agent = leg.role === "guest" ? parseAgent(leg.brief) : null;
      this.agent = agent !== null;
      let session: Record<string, unknown>;
      if (agent) {
        const where = await homes.locale(this.env.DB, leg.home_id);
        session = liveCallSession(
          openai.settings,
          agentToolDefinitions(),
          agentBrief(agent, leg.home_id, where),
          agent.voice,
        );
      } else {
        const [hasLights, logAccess, callTest, skillsOn] = await Promise.all([
          connections.get(this.env.DB, leg.home_id, "lightwave").then((row) => row !== null),
          homes.logAccess(this.env.DB, leg.home_id),
          homes.callTest(this.env.DB, leg.home_id),
          skills.enabled(this.env.DB, leg.home_id),
        ]);
        const tools = toolDefinitions(hasLights, true, logAccess, callTest, skillsOn).filter(
          (t) => !notOnCalls(t.name),
        );
        session = liveCallSession(openai.settings, tools, leg.brief ?? "");
      }
      const res = await fetch(liveSocketUrl(this.env.OPENAI_BASE_URL), {
        headers: { upgrade: "websocket", authorization: `Bearer ${openai.apiKey}` },
      });
      const socket = res.webSocket;
      if (!socket) {
        throw new Error(`GPT-Live refused the socket (${res.status})`);
      }
      socket.accept();
      this.live = socket;
      socket.addEventListener("message", (event) => {
        void this.fromLive(event.data);
      });
      socket.addEventListener("close", () => void this.end("GPT-Live closed the session"));
      socket.addEventListener("error", () => void this.end("the GPT-Live socket failed"));
      this.toLive({ type: "session.start", session });
      await logFor(
        scope,
        leg.home_id,
        "info",
        `call ${start.conference}: GPT-Live ${agent ? "agent" : "assistant"} seat on the line`,
      );
    } catch (err) {
      await logFor(
        scope,
        start.home,
        "error",
        `call ${start.conference}: GPT-Live seat failed: ${err instanceof Error ? err.message : "failed"}`,
      );
      await this.end("could not open GPT-Live");
    }
  }

  private async fromLive(data: unknown): Promise<void> {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(typeof data === "string" ? data : "") as Record<string, unknown>;
    } catch {
      return;
    }
    switch (event.type) {
      case "session.output_audio.delta":
        if (typeof event.delta === "string" && this.twilio && this.streamSid) {
          this.toTwilio({ event: "media", streamSid: this.streamSid, media: { payload: liveToTwilio(event.delta) } });
        }
        break;
      case "session.input_transcript.delta":
        await this.flushHeard("assistant");
        this.heard.line += typeof event.delta === "string" ? event.delta : "";
        break;
      case "session.output_transcript.delta":
        await this.flushHeard("line");
        this.heard.assistant += typeof event.delta === "string" ? event.delta : "";
        break;
      case "response.event": {
        // The backend finishing a reply closes the assistant's sentence in the transcript
        const nested = (event.event as { type?: string } | undefined)?.type;
        if (nested === "response.completed" || nested === "response.done") {
          await this.flushHeard("assistant");
        }
        const call = realtimeFunctionCall(event.event);
        if (call && this.start && this.leg) {
          const context: ToolContext = {
            env: this.env,
            user: actingFor(this.leg.home_id),
            origin: this.start.origin,
            voice: "browser",
            onCall: true,
            legId: this.agent ? this.leg.id : undefined,
          };
          const output = await runCallTool(context, call);
          await logFor(
            { env: this.env },
            this.leg.home_id,
            output.includes('"error"') ? "warn" : "info",
            `on-call tool ${call.name} ${call.arguments.slice(0, 120)} -> ${output.slice(0, 200)}`,
          );
          this.toLive({
            type: "response.item.create",
            item: { type: "function_call_output", call_id: call.call_id, output },
          });
          this.toLive({ type: "response.create" });
        }
        break;
      }
      case "session.closed":
        await this.end(`GPT-Live closed: ${String(event.reason ?? "")}`);
        break;
      case "error": {
        const detail = event.error as { message?: string } | undefined;
        if (this.leg) {
          await logFor(
            { env: this.env },
            this.leg.home_id,
            "error",
            `call ${this.start?.conference}: GPT-Live: ${detail?.message ?? "error"}`,
          );
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * A finished stretch of one speaker's words goes into the report: when the other starts, when the
   * backend finishes a reply, and at the end. The write runs off the audio path.
   */
  private async flushHeard(speaker: CallSpeaker): Promise<void> {
    const text = this.heard[speaker].trim();
    this.heard[speaker] = "";
    if (text && this.start && !this.agent) {
      const write = calls.addTurn(this.env.DB, this.start.conference, Date.now(), speaker, text.slice(0, 2000));
      this.ctx.waitUntil(write.then(() => undefined));
      await write;
    }
  }

  private toLive(message: Record<string, unknown>): void {
    try {
      this.live?.send(JSON.stringify(message));
    } catch {
      // A socket that is closing drops the event; the close handler ends the seat
    }
  }

  private toTwilio(message: Record<string, unknown>): void {
    try {
      this.twilio?.send(JSON.stringify(message));
    } catch {
      // As above
    }
  }

  /** Either side going away ends the seat: the other socket closes and the leg is marked as left. */
  private async end(why: string): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.flushHeard("line");
    await this.flushHeard("assistant");
    this.toLive({ type: "session.close" });
    try {
      this.live?.close(1000, why);
    } catch {
      // Already closed
    }
    try {
      this.twilio?.close(1000, why);
    } catch {
      // Already closed
    }
    const leg = this.leg;
    if (leg && this.start) {
      if (this.agent) {
        if (leg.sid) {
          await calls.setLeft(this.env.DB, leg.sid, Date.now());
        }
      } else {
        await calls.endAssistant(this.env.DB, this.start.conference);
      }
      await logFor(
        { env: this.env },
        leg.home_id,
        "info",
        `call ${this.start.conference}: GPT-Live seat ended: ${why}`,
      );
    }
    this.live = null;
    this.twilio = null;
  }
}

/** The samples a Twilio frame carries, for the tests that check the bridge's arithmetic. */
export const framePcm = (payload: string): Int16Array =>
  base64ToPcm16(pcm16ToBase64(muLawToPcm16k(base64ToBytes(payload))));
