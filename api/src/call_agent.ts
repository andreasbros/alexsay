import { DurableObject } from "cloudflare:workers";
import { toolByName } from "./tools";
import type { ToolContext } from "./types";

export interface CallAgentStart {
  callId: string;
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
export class CallAgent extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/start") {
      return new Response("not found", { status: 404 });
    }
    const start = (await request.json()) as CallAgentStart;
    try {
      await this.openSocket(start);
      return Response.json({ ok: true });
    } catch (err) {
      console.warn(JSON.stringify({ call_agent: start.callId, error: err instanceof Error ? err.message : "failed" }));
      return Response.json({ ok: false }, { status: 502 });
    }
  }

  private async openSocket(start: CallAgentStart): Promise<void> {
    const url = `${start.baseUrl}/realtime?call_id=${encodeURIComponent(start.callId)}`;
    const res = await fetch(url, {
      headers: { upgrade: "websocket", authorization: `Bearer ${start.apiKey}` },
    });
    const socket = res.webSocket;
    if (!socket) {
      throw new Error(`realtime socket refused (${res.status})`);
    }
    socket.accept();
    const context: ToolContext = {
      env: this.env,
      user: { username: start.username, role: "user" },
      origin: start.origin,
      voice: "browser",
    };
    socket.addEventListener("message", (message) => {
      void this.onMessage(socket, context, message.data);
    });
  }

  private async onMessage(socket: WebSocket, context: ToolContext, data: unknown): Promise<void> {
    let event: unknown;
    try {
      event = JSON.parse(typeof data === "string" ? data : "");
    } catch {
      return;
    }
    const call = realtimeFunctionCall(event);
    if (!call) {
      return;
    }
    const output = await runCallTool(context, call);
    socket.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: call.call_id, output },
      }),
    );
    socket.send(JSON.stringify({ type: "response.create" }));
  }
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
