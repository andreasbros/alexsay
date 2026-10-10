import type { Context } from "hono";
import { lightwaveToken, lightwaveUrls } from "./connections";
import { conversations, memories } from "./db";
import { type Light, lights, writeFeatures } from "./providers/lightwave";
import type { FunctionTool } from "./providers/openai";
import { memoryCategory } from "./schemas";
import type { AppEnv, MemoryCategory } from "./types";
import { MEMORY_CATEGORIES } from "./types";

/**
 * Every function the assistant can call, defined once: the browser and the speaker send calls here,
 * and the same registry can later sit behind an MCP endpoint for other AI providers.
 */
export interface Tool {
  definition: FunctionTool;
  /** Lightwave tools only make sense once the user connected Lightwave. */
  needs?: "lightwave";
  run: (c: Context<AppEnv>, args: Record<string, unknown>, conversationId: string | null) => Promise<unknown>;
}

const string = (args: Record<string, unknown>, key: string): string =>
  typeof args[key] === "string" ? (args[key] as string).trim() : "";
const num = (args: Record<string, unknown>, key: string): number | null =>
  typeof args[key] === "number" ? (args[key] as number) : null;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const TOOLS: Tool[] = [
  {
    definition: {
      type: "function",
      name: "end_conversation",
      description:
        "Ends the conversation after the user said goodbye, thanks or that is all. Say a short goodbye first; the " +
        "session closes once you finish speaking.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    run: async () => ({ ok: true, note: "say goodbye; the session closes when you finish speaking" }),
  },
  {
    definition: {
      type: "function",
      name: "remember",
      description:
        "Stores something worth keeping across conversations: a preference, a person, how the home is set up, a " +
        "routine, a reminder, an important fact. One short sentence per memory.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", enum: [...MEMORY_CATEGORIES] },
          content: { type: "string", description: "The memory, one short sentence" },
        },
        required: ["category", "content"],
        additionalProperties: false,
      },
    },
    run: async (c, args, conversationId) => {
      const category = memoryCategory.safeParse(string(args, "category"));
      const content = string(args, "content").slice(0, 500);
      if (!category.success || !content) {
        return { error: "category and content are required" };
      }
      const id = crypto.randomUUID();
      await memories.create(c.env.DB, {
        id,
        username: c.get("user").username,
        category: category.data,
        content,
        source: conversationId,
      });
      return { ok: true, id };
    },
  },
  {
    definition: {
      type: "function",
      name: "forget",
      description: "Deletes a memory by its id from list_memories, when the user asks you to forget something.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const result = await memories.remove(c.env.DB, c.get("user").username, string(args, "id"));
      return result.meta.changes ? { ok: true } : { error: "no such memory" };
    },
  },
  {
    definition: {
      type: "function",
      name: "list_memories",
      description: "Lists what you remember about the user, optionally one category, with ids.",
      parameters: {
        type: "object",
        properties: { category: { type: "string", enum: [...MEMORY_CATEGORIES] } },
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const category = memoryCategory.safeParse(string(args, "category"));
      const rows = await memories.list(c.env.DB, c.get("user").username, category.success ? category.data : undefined);
      return rows.map((m) => ({ id: m.id, category: m.category, content: m.content, updated: day(m.updated_at) }));
    },
  },
  {
    definition: {
      type: "function",
      name: "recall_conversations",
      description:
        "Lists past conversations newest first with their date and summary. Use query to find ones about a topic.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words to look for in summaries and transcripts" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const limit = Math.min(50, Math.max(1, num(args, "limit") ?? 10));
      const rows = await conversations.list(
        c.env.DB,
        c.get("user").username,
        limit,
        string(args, "query") || undefined,
      );
      return rows.map((r) => ({
        id: r.id,
        date: day(r.started_at),
        source: r.source,
        turns: r.turn_count,
        summary: r.summary ?? "(no summary yet)",
      }));
    },
  },
  {
    definition: {
      type: "function",
      name: "read_conversation",
      description: "Reads the transcript of one past conversation by id from recall_conversations.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const row = await conversations.get(c.env.DB, c.get("user").username, string(args, "id"));
      if (!row) {
        return { error: "no such conversation" };
      }
      const turns = await conversations.turns(c.env.DB, row.id, 200);
      return { date: day(row.started_at), summary: row.summary, turns: turns.map((t) => `${t.role}: ${t.text}`) };
    },
  },
  {
    needs: "lightwave",
    definition: {
      type: "function",
      name: "list_lights",
      description: "Lists the user's lights with their current on/off state and dim level.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    run: async (c) =>
      (await userLights(c)).map((l) => ({
        id: l.id,
        name: l.name,
        on: l.on,
        dim_level: l.dim_level,
        dimmable: !!l.dim,
      })),
  },
  {
    needs: "lightwave",
    definition: {
      type: "function",
      name: "set_light",
      description:
        "Switches a light on or off, or sets its brightness. Prefer the id from list_lights; the name the user said also works.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The light id from list_lights" },
          name: { type: "string", description: "The light's name as the user said it, when the id is unknown" },
          on: { type: "boolean", description: "True to switch on, false to switch off" },
          dim_level: { type: "integer", minimum: 0, maximum: 100, description: "Brightness in percent, if dimmable" },
        },
        required: [],
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const all = await userLights(c);
      const light = findLight(all, args);
      if (!light) {
        return { error: "no such light", available: all.map((l) => ({ id: l.id, name: l.name })) };
      }
      await writeLights(c, [light], args);
      return { ok: true, light: light.name };
    },
  },
  {
    needs: "lightwave",
    definition: {
      type: "function",
      name: "set_lights",
      description:
        'Switches or dims every light whose name or room matches the given words in one go, e.g. match "kitchen" for all ' +
        'kitchen lights. Use match "all" for every light in the home only after the user confirmed.',
      parameters: {
        type: "object",
        properties: {
          match: { type: "string", description: 'Room or name words to match, or "all"' },
          on: { type: "boolean", description: "True to switch on, false to switch off" },
          dim_level: { type: "integer", minimum: 0, maximum: 100, description: "Brightness in percent, if dimmable" },
        },
        required: ["match"],
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const all = await userLights(c);
      const matched = matchLights(all, string(args, "match"));
      if (matched.length === 0) {
        return { error: "no lights match", available: all.map((l) => l.name) };
      }
      await writeLights(c, matched, args);
      return { ok: true, lights: matched.map((l) => l.name) };
    },
  },
];

export const toolByName = (name: string) => TOOLS.find((t) => t.definition.name === name);

export function toolDefinitions(hasLightwave: boolean): FunctionTool[] {
  return TOOLS.filter((t) => !t.needs || (t.needs === "lightwave" && hasLightwave)).map((t) => t.definition);
}

async function userLights(c: Context<AppEnv>): Promise<Light[]> {
  const token = await lightwaveToken(c, c.get("user").username);
  if (!token) {
    throw new Error("Lightwave is not connected");
  }
  return lights(lightwaveUrls(c), token);
}

async function writeLights(c: Context<AppEnv>, targets: Light[], args: Record<string, unknown>): Promise<void> {
  const dim = num(args, "dim_level");
  const on = typeof args.on === "boolean" ? args.on : null;
  const writes = targets.flatMap((light) => [
    ...(dim !== null && light.dim ? [{ featureId: light.dim, value: Math.round(dim) }] : []),
    ...(on !== null ? [{ featureId: light.switch, value: on ? 1 : 0 }] : []),
  ]);
  if (writes.length === 0) {
    return;
  }
  const token = await lightwaveToken(c, c.get("user").username);
  if (!token) {
    throw new Error("Lightwave is not connected");
  }
  await writeFeatures(lightwaveUrls(c), token, writes);
}

/** The model may pass the id from list_lights, or just the name it heard; names match loosely. */
export function findLight(all: Light[], args: Record<string, unknown>): Light | undefined {
  const id = string(args, "id");
  const wanted = normalise(string(args, "name") || id);
  return (
    all.find((l) => l.id === id) ??
    all.find((l) => normalise(l.name) === wanted) ??
    all.find((l) => normalise(l.name).includes(wanted) || wanted.includes(normalise(l.name))) ??
    all.find((l) => normalise(`${l.device} ${l.name}`).includes(wanted))
  );
}

/** Every light whose name or device contains all the words, or every light for "all". */
export function matchLights(all: Light[], match: string): Light[] {
  const words = normalise(match).split(" ").filter(Boolean);
  if (words.length === 0 || (words.length === 1 && words[0] === "all")) {
    return all;
  }
  return all.filter((l) => {
    const haystack = normalise(`${l.device} ${l.name}`);
    return words.every((word) => haystack.includes(word));
  });
}

const normalise = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export const categoryOf = (value: string): MemoryCategory | null => {
  const parsed = memoryCategory.safeParse(value);
  return parsed.success ? parsed.data : null;
};
