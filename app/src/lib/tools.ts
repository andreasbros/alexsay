import type { api as Api } from "../api";

type ToolApi = Pick<typeof Api, "callTool">;

/** A function call the backend model asked for, as GPT-Live delivers it inside a response.event envelope. */
export interface FunctionCall {
  call_id: string;
  name: string;
  arguments: string;
}

/** Pulls the function call out of a `response.event` envelope, or null for any other event. */
export function functionCallOf(event: unknown): FunctionCall | null {
  if (!isRecord(event) || event.type !== "response.event" || !isRecord(event.event)) {
    return null;
  }
  const nested = event.event;
  const item = nested.item;
  if (nested.type !== "response.output_item.done" || !isRecord(item) || item.type !== "function_call") {
    return null;
  }
  if (typeof item.call_id !== "string" || typeof item.name !== "string") {
    return null;
  }
  return {
    call_id: item.call_id,
    name: item.name,
    arguments: typeof item.arguments === "string" ? item.arguments : "{}",
  };
}

/**
 * Every tool runs on the server, which owns the user's connections and memory; the browser only
 * relays the call and hands the result back to the model as JSON text.
 */
export async function runTool(call: FunctionCall, api: ToolApi, conversationId: string | null): Promise<string> {
  try {
    const { output } = await api.callTool(call.name, parseArguments(call.arguments), conversationId);
    return JSON.stringify(output);
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : "tool failed" });
  }
}

function parseArguments(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
