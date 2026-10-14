import { conversations, homes, memories } from "./db";
import { type Locale, localeInstructions } from "./locale";
import { ProviderError } from "./providers/openai";
import type { ConversationRow, MemoryCategory, MemoryRow, TurnRow } from "./types";
import { MEMORY_CATEGORIES } from "./types";

const RECENT_CONVERSATIONS = 5;
const LAST_CHAT_TURNS = 8;
const MAX_MEMORY_CHARS = 6000;

export interface Context {
  memories: MemoryRow[];
  recent: ConversationRow[];
  lastTurns: TurnRow[];
  where: Locale;
}

export async function loadContext(db: D1Database, home: string): Promise<Context> {
  const [all, recent, where] = await Promise.all([
    memories.list(db, home),
    conversations.list(db, home, RECENT_CONVERSATIONS),
    homes.locale(db, home),
  ]);
  const last = recent.find((r) => r.ended_at !== null);
  const lastTurns = last ? (await conversations.turns(db, last.id, 400)).slice(-LAST_CHAT_TURNS) : [];
  return { memories: all, recent, lastTurns, where };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The memory block that opens every session's instructions, plus how to use the memory tools. */
export function contextInstructions(context: Context, today = new Date()): string {
  const parts: string[] = [localeInstructions(context.where, today)];
  if (context.memories.length > 0) {
    const grouped = MEMORY_CATEGORIES.map((category) => {
      const items = context.memories.filter((m) => m.category === category);
      return items.length ? `${category}:\n${items.map((m) => `- ${m.content}`).join("\n")}` : "";
    }).filter(Boolean);
    parts.push(`What you remember about this user:\n${grouped.join("\n")}`.slice(0, MAX_MEMORY_CHARS));
  }
  const summaries = context.recent.filter((r) => r.summary);
  if (summaries.length > 0) {
    parts.push(
      `Recent conversations, newest first:\n${summaries.map((r) => `- ${day(r.started_at)}: ${r.summary}`).join("\n")}`,
    );
  }
  if (context.lastTurns.length > 0) {
    parts.push(`How the last conversation ended:\n${context.lastTurns.map((t) => `${t.role}: ${t.text}`).join("\n")}`);
  }
  parts.push(
    "Memory tools: remember stores a new fact (categories: important, preferences, people, home, routines, notes, " +
      "facts; anything to be told at a time is an alarm, never a memory), list_memories shows them with ids, forget deletes one. History tools: recall_conversations lists past " +
      "conversations by date with summaries and can search a topic, read_conversation reads one transcript. Use them " +
      "when the user refers to earlier talks or asks you to remember or forget something; do not announce them otherwise. " +
      "Phone book tools: find_contact looks someone up by name or digits, list_contacts pages through everyone " +
      "(favourites first), favourite_contact stars or unstars a person, add_contact and update_contact add or edit one " +
      "(name, number, label, note). Use the note for what the user tells you about a person. If read_log is " +
      "available, use it when the user asks what happened or why something failed, and quote the lines that matter.",
  );
  return parts.join("\n\n");
}

interface Digest {
  summary: string;
  memories: { op: "add" | "update" | "remove"; id?: string; category?: MemoryCategory; content?: string }[];
}

const DIGEST_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    memories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["add", "update", "remove"] },
          id: { type: "string" },
          category: { type: "string", enum: [...MEMORY_CATEGORIES] },
          content: { type: "string" },
        },
        required: ["op", "id", "category", "content"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "memories"],
  additionalProperties: false,
};

/**
 * After a conversation ends: a cheap text model writes a two-sentence summary and reconciles the
 * memory records (new facts, corrections, things the user asked to forget) against what is stored.
 */
export async function digestConversation(
  db: D1Database,
  openai: { baseUrl: string; apiKey: string; model: string },
  home: string,
  conversationId: string,
): Promise<void> {
  const turns = await conversations.turns(db, conversationId, 400);
  if (turns.length === 0) {
    return;
  }
  const existing = await memories.list(db, home);
  const transcript = turns.map((t) => `${t.role}: ${t.text}`).join("\n");
  const known = existing.map((m) => `${m.id} [${m.category}] ${m.content}`).join("\n") || "(none)";
  const res = await fetch(`${openai.baseUrl}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${openai.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: openai.model,
      reasoning: { effort: "low" },
      instructions:
        "You maintain the long-term memory of a home assistant speaker. Summarise the conversation in at most two " +
        "sentences, in the past tense, naming what was asked and done. Then update the memory records: add durable " +
        "facts about the user, their preferences, people, home, routines and notes; update a record when the " +
        "conversation corrects it (give its id); remove a record the user asked to forget (give its id). Skip small " +
        "talk and anything already stored. For add, set id to an empty string.",
      input: `Stored memories:\n${known}\n\nConversation:\n${transcript}`,
      text: { format: { type: "json_schema", name: "digest", strict: true, schema: DIGEST_SCHEMA } },
    }),
  });
  if (!res.ok) {
    throw new ProviderError(res.status, (await res.text().catch(() => "")).slice(0, 200) || "digest failed");
  }
  const digest = parseDigest(await res.json());
  if (!digest) {
    return;
  }
  await conversations.setSummary(db, conversationId, digest.summary.slice(0, 600));
  for (const change of digest.memories) {
    const content = (change.content ?? "").trim().slice(0, 500);
    if (change.op === "add" && change.category && content) {
      await memories.create(db, {
        id: crypto.randomUUID(),
        home_id: home,
        category: change.category,
        content,
        source: conversationId,
      });
    } else if (change.op === "update" && change.id && content) {
      await memories.update(db, home, change.id, { category: change.category, content });
    } else if (change.op === "remove" && change.id) {
      await memories.remove(db, home, change.id);
    }
  }
}

/** The Responses API returns the JSON as the text of the first output message. */
function parseDigest(body: unknown): Digest | null {
  const output = (body as { output?: { type: string; content?: { type: string; text?: string }[] }[] }).output ?? [];
  const text = output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .find((part) => part.type === "output_text")?.text;
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as Digest;
  } catch {
    return null;
  }
}

const CURRENT_TURNS = 30;

/** What has been said so far in the conversation that is still open, for an assistant joining it elsewhere. */
export async function currentConversation(db: D1Database, home: string): Promise<string> {
  const recent = await conversations.list(db, home, 1);
  const open = recent[0];
  if (!open || open.ended_at !== null) {
    return "";
  }
  const turns = (await conversations.turns(db, open.id, 400)).slice(-CURRENT_TURNS);
  if (turns.length === 0) {
    return "";
  }
  return `The conversation so far in the app, which led to this call:\n${turns
    .map((t) => `${t.role}: ${t.text}`)
    .join("\n")}`;
}
