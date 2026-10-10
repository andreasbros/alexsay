import type { api as Api } from "../api";

type ToolApi = Pick<typeof Api, "lights" | "setFeature">;

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

/** Runs one of the light tools the API advertised; the result goes back to the model as JSON text. */
export async function runTool(call: FunctionCall, api: ToolApi): Promise<string> {
  const args = parseArguments(call.arguments);
  try {
    switch (call.name) {
      case "list_lights":
        return JSON.stringify(await api.lights());
      case "set_light": {
        const light = (await api.lights()).find((l) => l.id === args.id);
        if (!light) {
          return JSON.stringify({ error: `no light with id ${String(args.id)}` });
        }
        if (typeof args.dim_level === "number" && light.dim) {
          await api.setFeature(light.dim, Math.round(args.dim_level));
        }
        if (typeof args.on === "boolean") {
          await api.setFeature(light.switch, args.on ? 1 : 0);
        }
        return JSON.stringify({ ok: true, light: light.name });
      }
      default:
        return JSON.stringify({ error: `unknown tool ${call.name}` });
    }
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
