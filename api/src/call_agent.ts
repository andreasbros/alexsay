import { DurableObject } from "cloudflare:workers";
import { calls } from "./db";
import { logFor } from "./log";
import { toolByName } from "./tools";
import type { CallSpeaker, ToolContext } from "./types";

export interface CallAgentStart {
  callId: string;
  conference: string;
  /** The assistant's leg keeps a transcript for the call report; a test agent's leg does not. */
  transcript: boolean;
  /** Set for a test agent: the calls row of its own leg. */
  legId?: string;
  apiKey: string;
  baseUrl: string;
  username: string;
  origin: string;
}

interface FunctionCall {
  call_id: string;
  name: string;
  arguments: string;
}

/** A function call as the Realtime API announces it, in either of the shapes it uses. */
export function realtimeFunctionCall(event: unknown): FunctionCall | null {
  if (!event || typeof event !== "object") {
    return null;
  }
  const e = event as Record<string, unknown>;
  if (e.type === "response.function_call_arguments.done") {
    return typeof e.call_id === "string" && typeof e.name === "string"
      ? { call_id: e.call_id, name: e.name, arguments: typeof e.arguments === "string" ? e.arguments : "{}" }
      : null;
  }
  if (e.type === "response.output_item.done") {
    const item = e.item as Record<string, unknown> | undefined;
    if (item?.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string") {
      return {
        call_id: item.call_id,
        name: item.name,
        arguments: typeof item.arguments === "string" ? item.arguments : "{}",
      };
    }
  }
  return null;
}

/** A finished transcript of something said on the call: by the assistant, or by anyone else on the line. */
export function transcriptLine(event: unknown): { speaker: CallSpeaker; text: string } | null {
  if (!event || typeof event !== "object") {
    return null;
  }
  const e = event as Record<string, unknown>;
  const text = typeof e.transcript === "string" ? e.transcript.trim() : "";
  if (!text) {
    return null;
  }
  if (e.type === "conversation.item.input_audio_transcription.completed") {
    return { speaker: "line", text };
  }
  if (e.type === "response.output_audio_transcript.done") {
    return { speaker: "assistant", text };
  }
  return null;
}

export function parseArguments(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Sits on the websocket of the assistant's SIP leg for the length of a call, running the function
 * calls it makes (hang up, add someone, contacts, memory, lights) and handing the results back, the
 * same way the browser does for the GPT-Live session. One object per call, named after the call id.
 */
export interface CallNotice {
  text: string;
  /** Speak up about it now (nobody answered), rather than just knowing it (they answered and will talk). */
  reply: boolean;
}

export class CallAgent extends DurableObject<Env> {
  private socket: WebSocket | null = null;

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/notify") {
      return this.notify((await request.json()) as CallNotice);
    }
    if (path !== "/start") {
      return new Response("not found", { status: 404 });
    }
    const start = (await request.json()) as CallAgentStart;
    try {
      await this.openSocket(start);
      return Response.json({ ok: true });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "failed";
      await logFor(
        { env: this.env },
        start.username,
        "error",
        `call agent: no realtime socket for ${start.callId}: ${detail}`,
      );
      return Response.json({ ok: false }, { status: 502 });
    }
  }

  private async openSocket(start: CallAgentStart): Promise<void> {
    const res = await fetch(realtimeSocketUrl(start.baseUrl, start.callId), {
      headers: { upgrade: "websocket", authorization: `Bearer ${start.apiKey}` },
    });
    const socket = res.webSocket;
    if (!socket) {
      throw new Error(`realtime socket refused (${res.status})`);
    }
    socket.accept();
    this.socket = socket;
    await logFor({ env: this.env }, start.username, "info", `call agent: on the realtime socket for ${start.callId}`);
    const context: ToolContext = {
      env: this.env,
      user: { username: start.username, role: "user" },
      origin: start.origin,
      voice: "browser",
      onCall: true,
      legId: start.legId,
    };
    socket.addEventListener("message", (message) => {
      void this.onMessage(socket, context, start, message.data);
    });
    socket.addEventListener("close", async () => {
      this.socket = null;
      if (start.transcript) {
        await calls.endAssistant(this.env.DB, start.conference);
      } else if (start.legId) {
        const leg = await calls.get(this.env.DB, start.legId);
        if (leg?.sid) {
          await calls.setLeft(this.env.DB, leg.sid, Date.now());
        }
      }
      await logFor({ env: this.env }, start.username, "info", `call agent: socket closed for ${start.callId}`);
    });
  }

  /** What happened on the call that the assistant cannot hear for itself: someone answered, or did not. */
  private notify(notice: CallNotice): Response {
    if (!this.socket) {
      return new Response(null, { status: 409 });
    }
    this.socket.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "system", content: [{ type: "input_text", text: notice.text }] },
      }),
    );
    if (notice.reply) {
      this.socket.send(JSON.stringify({ type: "response.create" }));
    }
    return new Response(null, { status: 204 });
  }

  private async onMessage(
    socket: WebSocket,
    context: ToolContext,
    start: CallAgentStart,
    data: unknown,
  ): Promise<void> {
    let event: unknown;
    try {
      event = JSON.parse(typeof data === "string" ? data : "");
    } catch {
      return;
    }
    const line = transcriptLine(event);
    if (line) {
      if (start.transcript) {
        await calls.addTurn(this.env.DB, start.conference, Date.now(), line.speaker, line.text.slice(0, 2000));
      }
      return;
    }
    const call = realtimeFunctionCall(event);
    if (!call) {
      return;
    }
    const output = await runCallTool(context, call);
    await logFor(
      { env: this.env },
      context.user.username,
      output.includes('"error"') ? "warn" : "info",
      `on-call tool ${call.name} ${call.arguments.slice(0, 120)} -> ${output.slice(0, 200)}`,
    );
    socket.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: call.call_id, output },
      }),
    );
    socket.send(JSON.stringify({ type: "response.create" }));
  }
}

/** Workers open outbound WebSockets with an https fetch plus the Upgrade header; a ws(s) scheme is refused. */
export function realtimeSocketUrl(baseUrl: string, callId: string): string {
  return `${baseUrl.replace(/^wss?:/, "https:")}/realtime?call_id=${encodeURIComponent(callId)}`;
}

/** Runs one of the registry's tools for the assistant on the call; failures become results it can relay. */
export async function runCallTool(context: ToolContext, call: FunctionCall): Promise<string> {
  const tool = toolByName(call.name);
  if (!tool) {
    return JSON.stringify({ error: `unknown tool ${call.name}` });
  }
  try {
    return JSON.stringify(await tool.run(context, parseArguments(call.arguments), null));
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : "tool failed" });
  }
}
