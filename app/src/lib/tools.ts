import type { api as Api, Light } from "../api";

type ToolApi = Pick<typeof Api, "lights" | "setFeature" | "setFeatures">;

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
        return JSON.stringify(
          (await api.lights()).map((l) => ({
            id: l.id,
            name: l.name,
            on: l.on,
            dim_level: l.dim_level,
            dimmable: !!l.dim,
          })),
        );
      case "set_light": {
        const lights = await api.lights();
        const light = findLight(lights, args);
        if (!light) {
          return JSON.stringify({
            error: "no such light",
            available: lights.map((l) => ({ id: l.id, name: l.name })),
          });
        }
        if (typeof args.dim_level === "number" && light.dim) {
          await api.setFeature(light.dim, Math.round(args.dim_level));
        }
        if (typeof args.on === "boolean") {
          await api.setFeature(light.switch, args.on ? 1 : 0);
        }
        return JSON.stringify({ ok: true, light: light.name });
      }
      case "set_lights": {
        const lights = await api.lights();
        const matched = matchLights(lights, typeof args.match === "string" ? args.match : "");
        if (matched.length === 0) {
          return JSON.stringify({ error: "no lights match", available: lights.map((l) => l.name) });
        }
        const writes = matched.flatMap((light) => [
          ...(typeof args.dim_level === "number" && light.dim
            ? [{ featureId: light.dim, value: Math.round(args.dim_level) }]
            : []),
          ...(typeof args.on === "boolean" ? [{ featureId: light.switch, value: args.on ? 1 : 0 }] : []),
        ]);
        if (writes.length > 0) {
          await api.setFeatures(writes);
        }
        return JSON.stringify({ ok: true, lights: matched.map((l) => l.name) });
      }
      default:
        return JSON.stringify({ error: `unknown tool ${call.name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : "tool failed" });
  }
}

/** The model may pass the id from list_lights, or just the name it heard; names match loosely. */
function findLight(lights: Light[], args: Record<string, unknown>): Light | undefined {
  const id = typeof args.id === "string" ? args.id : "";
  const wanted = normalise(typeof args.name === "string" ? args.name : id);
  return (
    lights.find((l) => l.id === id) ??
    lights.find((l) => normalise(l.name) === wanted) ??
    lights.find((l) => normalise(l.name).includes(wanted) || wanted.includes(normalise(l.name))) ??
    lights.find((l) => normalise(`${l.device} ${l.name}`).includes(wanted))
  );
}

const normalise = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

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

/** Every light whose name or device contains all the words, or every light for "all". */
function matchLights(lights: Light[], match: string): Light[] {
  const words = normalise(match).split(" ").filter(Boolean);
  if (words.length === 0 || (words.length === 1 && words[0] === "all")) {
    return lights;
  }
  return lights.filter((l) => {
    const haystack = normalise(`${l.device} ${l.name}`);
    return words.every((word) => haystack.includes(word));
  });
}
