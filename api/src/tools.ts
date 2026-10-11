import type { Context } from "hono";
import { countryCode, lightwaveToken, lightwaveUrls } from "./connections";
import { contacts, conversations, memories, messages } from "./db";
import { normalisePhone } from "./phone";
import { type Light, lights, writeFeatures } from "./providers/lightwave";
import type { FunctionTool } from "./providers/openai";
import { type Recipient, type RecipientRef, resolveRecipient } from "./recipients";
import { applyContactChanges, publicContact } from "./routes/contacts";
import { memoryCategory } from "./schemas";
import { addToConference, endCall, placeCall, sendText, startConference, TelephonyError } from "./telephony";
import type { AppEnv, ContactRow, MemoryCategory, VoiceClient } from "./types";
import { MEMORY_CATEGORIES } from "./types";

/**
 * Every function the assistant can call, defined once: the browser and the speaker send calls here,
 * and the same registry can later sit behind an MCP endpoint for other AI providers.
 */
export interface Tool {
  definition: FunctionTool;
  /** Provider tools only make sense once the user connected that provider. */
  needs?: "lightwave" | "twilio";
  run: (c: Context<AppEnv>, args: Record<string, unknown>, conversationId: string | null) => Promise<unknown>;
}

const string = (args: Record<string, unknown>, key: string): string =>
  typeof args[key] === "string" ? (args[key] as string).trim() : "";
const num = (args: Record<string, unknown>, key: string): number | null =>
  typeof args[key] === "number" ? (args[key] as number) : null;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayOrNull = (ms: number | null) => (ms === null ? null : day(ms));

const CONTACT_PAGE = 25;
const CONTACT_EDIT_ERRORS: Record<"not_found" | "bad_phone" | "phone_taken", string> = {
  not_found: "no such contact",
  bad_phone: "that is not a phone number",
  phone_taken: "another contact has that number",
};

/** How the model sees a contact: ids to act on, dates instead of timestamps. */
const contactForModel = (row: ContactRow) => {
  const { last_called_at, last_messaged_at, updated_at, ...rest } = publicContact(row);
  return { ...rest, last_called: dayOrNull(last_called_at), last_messaged: dayOrNull(last_messaged_at) };
};

/** The recipient fields every phone tool shares: a contact id, a name as heard, or a number. */
const RECIPIENT_PROPERTIES = {
  contact_id: { type: "string", description: "The id from find_contact or list_contacts" },
  name: { type: "string", description: "The person's name as the user said it, when the id is unknown" },
  number: { type: "string", description: "A phone number the user dictated, when they are not a contact" },
};

const refOf = (args: Record<string, unknown>): RecipientRef => ({
  contact_id: string(args, "contact_id") || undefined,
  name: string(args, "name") || undefined,
  number: string(args, "number") || undefined,
});

async function recipientOf(c: Context<AppEnv>, args: Record<string, unknown>): Promise<Recipient | { error: string }> {
  const username = c.get("user").username;
  const resolved = await resolveRecipient(c.env.DB, username, await countryCode(c, username), refOf(args));
  return resolved.ok ? resolved : { error: resolved.error, ...(resolved.options ? { options: resolved.options } : {}) };
}

/**
 * Where the user takes a call. The page they are talking from, when it has its phone line up; their
 * mobile only when they asked for it. A page without a line gets an error rather than a surprise call.
 */
function callHost(c: Context<AppEnv>, args: Record<string, unknown>): { host: VoiceClient } | { error: string } {
  if (string(args, "via") === "mobile") {
    return { host: "mobile" };
  }
  if (c.get("voice") === "browser") {
    return { host: "browser" };
  }
  return {
    error:
      "the Assistant page's phone line is not ready, so the call cannot open there. Tell the user: keep the " +
      "Assistant page open and check the phone line notice, or say 'on my mobile' to take the call on their phone.",
  };
}

/** Telephony preconditions are told to the model as plain errors it can relay, not thrown. */
async function telephony<T>(action: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await action();
  } catch (err) {
    if (err instanceof TelephonyError) {
      return { error: err.message };
    }
    throw err;
  }
}

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
        "Switches one light on or off. On returns the light to its last brightness, exactly like its wall switch. " +
        "Prefer the id from list_lights; the name the user said also works.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The light id from list_lights" },
          name: { type: "string", description: "The light's name as the user said it, when the id is unknown" },
          on: { type: "boolean", description: "True to switch on, false to switch off" },
        },
        required: ["on"],
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const all = await userLights(c);
      const light = findLight(all, args);
      if (!light) {
        return { error: "no such light", available: all.map((l) => ({ id: l.id, name: l.name })) };
      }
      await writeLights(c, [light], { on: args.on });
      return { ok: true, light: light.name };
    },
  },
  {
    needs: "lightwave",
    definition: {
      type: "function",
      name: "set_lights",
      description:
        'Switches every light whose name or room matches the given words on or off in one go, e.g. match "kitchen" ' +
        'for all kitchen lights. Use match "all" for every light in the home only after the user confirmed.',
      parameters: {
        type: "object",
        properties: {
          match: { type: "string", description: 'Room or name words to match, or "all"' },
          on: { type: "boolean", description: "True to switch on, false to switch off" },
        },
        required: ["match", "on"],
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const all = await userLights(c);
      const matched = matchLights(all, string(args, "match"));
      if (matched.length === 0) {
        return { error: "no lights match", available: all.map((l) => l.name) };
      }
      await writeLights(c, matched, { on: args.on });
      return { ok: true, lights: matched.map((l) => l.name) };
    },
  },
  {
    needs: "lightwave",
    definition: {
      type: "function",
      name: "dim_light",
      description:
        "Sets one light's brightness, only when the user asks to dim, brighten, or make it darker or lighter. " +
        "The light comes on at that level and keeps it until the next dim.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The light id from list_lights" },
          name: { type: "string", description: "The light's name as the user said it, when the id is unknown" },
          level: { type: "integer", minimum: 1, maximum: 100, description: "Brightness in percent" },
        },
        required: ["level"],
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const all = await userLights(c);
      const light = findLight(all, args);
      if (!light) {
        return { error: "no such light", available: all.map((l) => ({ id: l.id, name: l.name })) };
      }
      if (!light.dim) {
        return { error: `${light.name} is not dimmable` };
      }
      await writeLights(c, [light], { dim_level: args.level });
      return { ok: true, light: light.name, level: args.level };
    },
  },
  {
    needs: "lightwave",
    definition: {
      type: "function",
      name: "dim_lights",
      description:
        "Sets the brightness of every matching dimmable light, only when the user asks to dim, brighten, or make a " +
        'room darker or lighter. Match works like set_lights ("kitchen", or "all" after confirmation).',
      parameters: {
        type: "object",
        properties: {
          match: { type: "string", description: 'Room or name words to match, or "all"' },
          level: { type: "integer", minimum: 1, maximum: 100, description: "Brightness in percent" },
        },
        required: ["match", "level"],
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const all = await userLights(c);
      const matched = matchLights(all, string(args, "match")).filter((l) => l.dim);
      if (matched.length === 0) {
        return { error: "no dimmable lights match", available: all.filter((l) => l.dim).map((l) => l.name) };
      }
      await writeLights(c, matched, { dim_level: args.level });
      return { ok: true, lights: matched.map((l) => l.name), level: args.level };
    },
  },
  {
    definition: {
      type: "function",
      name: "find_contact",
      description:
        "Looks people up in the user's phone book by name or by digits of a number. Returns matches with ids, " +
        "labels (mobile, home), favourite flag and when they were last called or messaged.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "A name, part of a name, or digits" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const query = string(args, "query");
      if (!query) {
        return { error: "query is required" };
      }
      const { rows } = await contacts.list(c.env.DB, c.get("user").username, { query, page: 1, pageSize: 10 });
      return rows.map(contactForModel);
    },
  },
  {
    definition: {
      type: "function",
      name: "list_contacts",
      description: `Pages through the phone book, favourites first then alphabetical, ${CONTACT_PAGE} per page.`,
      parameters: {
        type: "object",
        properties: {
          page: { type: "integer", minimum: 1 },
          favourites_only: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const page = Math.max(1, num(args, "page") ?? 1);
      const result = await contacts.list(c.env.DB, c.get("user").username, {
        favourites: args.favourites_only === true,
        page,
        pageSize: CONTACT_PAGE,
      });
      return {
        contacts: result.rows.map(contactForModel),
        page,
        pages: Math.max(1, Math.ceil(result.total / CONTACT_PAGE)),
        total: result.total,
      };
    },
  },
  {
    definition: {
      type: "function",
      name: "favourite_contact",
      description: "Marks a contact as a favourite, or removes the mark, when the user asks.",
      parameters: {
        type: "object",
        properties: { ...RECIPIENT_PROPERTIES, favourite: { type: "boolean" } },
        required: ["favourite"],
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const recipient = await recipientOf(c, args);
      if ("error" in recipient) {
        return recipient;
      }
      if (!recipient.contact) {
        return { error: "that number is not in the phone book" };
      }
      const favourite = args.favourite === true;
      await contacts.update(c.env.DB, c.get("user").username, recipient.contact.id, { favourite });
      return { ok: true, contact: recipient.contact.name, favourite };
    },
  },
  {
    definition: {
      type: "function",
      name: "update_contact",
      description:
        "Edits a contact: rename, change the number or label, or set the note. The note is free text about the " +
        "person (who they are, when to call, what they like); setting it replaces the previous note, so fold old " +
        "content in when the user adds to it.",
      parameters: {
        type: "object",
        properties: {
          ...RECIPIENT_PROPERTIES,
          new_name: { type: "string" },
          new_number: { type: "string" },
          label: { type: "string", description: "mobile, home, work, or anything short" },
          note: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const recipient = await recipientOf(c, args);
      if ("error" in recipient) {
        return recipient;
      }
      if (!recipient.contact) {
        return { error: "that number is not in the phone book; add it first with add_contact" };
      }
      const changes = {
        ...(string(args, "new_name") ? { name: string(args, "new_name").slice(0, 120) } : {}),
        ...(string(args, "new_number") ? { phone: string(args, "new_number") } : {}),
        ...(typeof args.label === "string" ? { label: string(args, "label").slice(0, 40) } : {}),
        ...(typeof args.note === "string" ? { note: string(args, "note").slice(0, 1000) } : {}),
      };
      if (Object.keys(changes).length === 0) {
        return { error: "nothing to change" };
      }
      const result = await applyContactChanges(c, c.get("user").username, recipient.contact.id, changes);
      if (result !== "ok") {
        return { error: CONTACT_EDIT_ERRORS[result] };
      }
      const updated = await contacts.get(c.env.DB, c.get("user").username, recipient.contact.id);
      return { ok: true, contact: updated ? contactForModel(updated) : null };
    },
  },
  {
    definition: {
      type: "function",
      name: "add_contact",
      description: "Adds a person to the phone book with a number the user dictates, and optionally a label and note.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          number: { type: "string" },
          label: { type: "string" },
          note: { type: "string" },
        },
        required: ["name", "number"],
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const name = string(args, "name").slice(0, 120);
      const username = c.get("user").username;
      const phone = normalisePhone(string(args, "number"), await countryCode(c, username));
      if (!name || !phone) {
        return { error: "a name and a valid phone number are required" };
      }
      await contacts.upsert(
        c.env.DB,
        username,
        [{ name, phone, label: string(args, "label").slice(0, 40), note: string(args, "note").slice(0, 1000) }],
        Date.now(),
      );
      const row = await contacts.byPhone(c.env.DB, username, phone);
      return { ok: true, contact: row ? contactForModel(row) : null };
    },
  },
  {
    needs: "twilio",
    definition: {
      type: "function",
      name: "place_call",
      description:
        "Phones someone for the user. The call opens in the Assistant page the user is talking from, so they hear " +
        "and speak through it, and you are on the line as well when their OpenAI project allows it: give a task " +
        "when the user wants you to speak for them (ask something, book, explain), otherwise you listen and only " +
        "speak when addressed. Only when the user explicitly asks for it on their mobile, set via to mobile. " +
        "A message phones the person and reads it out without the user. Confirm who, and the task or message, " +
        "before calling.",
      parameters: {
        type: "object",
        properties: {
          ...RECIPIENT_PROPERTIES,
          task: { type: "string", description: "What you should get done on the call, in the user's words" },
          message: { type: "string", description: "Spoken to the person instead of connecting anyone" },
          via: {
            type: "string",
            enum: ["app", "mobile"],
            description: "Where the user takes the call; app unless asked",
          },
        },
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const recipient = await recipientOf(c, args);
      if ("error" in recipient) {
        return recipient;
      }
      const message = string(args, "message").slice(0, 500) || undefined;
      const task = string(args, "task").slice(0, 1000) || undefined;
      // A spoken message needs nobody on the user's side, so the page's line is only required for a real call
      const host = message ? { host: "mobile" as const } : callHost(c, args);
      if ("error" in host) {
        return host;
      }
      return telephony(async () => {
        const result = await placeCall(c, c.get("user").username, recipient, { message, task, host: host.host });
        const note = message
          ? "the message is being delivered"
          : "conference" in result
            ? [
                result.host === "browser" ? "the call is opening in the app" : "the user's mobile is ringing",
                result.assistant
                  ? `and you are on the line: ${task ? "carry out the task once they answer" : "speak only when addressed"}`
                  : "but you are not on the line (OpenAI phone calls are not set up); the user talks directly",
              ].join(" ")
            : "placed";
        return { ok: true, ...result, note };
      });
    },
  },
  {
    needs: "twilio",
    definition: {
      type: "function",
      name: "start_conference",
      description:
        "Starts a group call: the user's phone rings and joins as host, then every listed person is dialled in. " +
        "Confirm the list with the user first.",
      parameters: {
        type: "object",
        properties: {
          participants: {
            type: "array",
            minItems: 1,
            maxItems: 9,
            items: { type: "object", properties: RECIPIENT_PROPERTIES, additionalProperties: false },
          },
          via: {
            type: "string",
            enum: ["app", "mobile"],
            description: "Where the user takes the call; app unless asked",
          },
        },
        required: ["participants"],
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const refs = Array.isArray(args.participants) ? (args.participants as Record<string, unknown>[]) : [];
      if (refs.length === 0) {
        return { error: "participants are required" };
      }
      const recipients: Recipient[] = [];
      for (const ref of refs) {
        const recipient = await recipientOf(c, ref);
        if ("error" in recipient) {
          return recipient;
        }
        recipients.push(recipient);
      }
      const host = callHost(c, args);
      if ("error" in host) {
        return host;
      }
      return telephony(async () => ({
        ok: true,
        ...(await startConference(c, c.get("user").username, recipients, host.host)),
      }));
    },
  },
  {
    needs: "twilio",
    definition: {
      type: "function",
      name: "add_to_call",
      description: "Dials one more person into the group call the user is in right now.",
      parameters: { type: "object", properties: RECIPIENT_PROPERTIES, additionalProperties: false },
    },
    run: async (c, args) => {
      const recipient = await recipientOf(c, args);
      if ("error" in recipient) {
        return recipient;
      }
      return telephony(async () => ({ ok: true, ...(await addToConference(c, c.get("user").username, recipient)) }));
    },
  },
  {
    needs: "twilio",
    definition: {
      type: "function",
      name: "end_call",
      description: "Hangs up the phone call or group call in progress when the user asks.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    run: async (c) => telephony(async () => ({ ok: true, ...(await endCall(c, c.get("user").username)) })),
  },
  {
    needs: "twilio",
    definition: {
      type: "function",
      name: "send_text",
      description:
        "Sends an SMS text message from the user's number. Read the recipient and the exact text back and wait " +
        "for a yes before sending.",
      parameters: {
        type: "object",
        properties: { ...RECIPIENT_PROPERTIES, body: { type: "string", description: "The message text" } },
        required: ["body"],
        additionalProperties: false,
      },
    },
    run: (c, args) => sendTool(c, args, "sms"),
  },
  {
    needs: "twilio",
    definition: {
      type: "function",
      name: "send_whatsapp",
      description:
        "Sends a WhatsApp message from the user's WhatsApp sender. Plain text only reaches people who wrote to " +
        "this number in the last 24 hours; otherwise WhatsApp refuses it. Confirm recipient and text first.",
      parameters: {
        type: "object",
        properties: { ...RECIPIENT_PROPERTIES, body: { type: "string", description: "The message text" } },
        required: ["body"],
        additionalProperties: false,
      },
    },
    run: (c, args) => sendTool(c, args, "whatsapp"),
  },
  {
    needs: "twilio",
    definition: {
      type: "function",
      name: "recent_messages",
      description:
        "The latest text and WhatsApp messages, newest first: everything, or those with one person. Use it to " +
        "read the user their messages or recall what someone wrote.",
      parameters: {
        type: "object",
        properties: { ...RECIPIENT_PROPERTIES, limit: { type: "integer", minimum: 1, maximum: 50 } },
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const limit = Math.min(50, Math.max(1, num(args, "limit") ?? 10));
      const ref = refOf(args);
      let contactId: string | null = null;
      if (ref.contact_id || ref.name || ref.number) {
        const recipient = await recipientOf(c, args);
        if ("error" in recipient) {
          return recipient;
        }
        if (!recipient.contact) {
          return { error: "that number is not in the phone book" };
        }
        contactId = recipient.contact.id;
      }
      const rows = await messages.list(c.env.DB, c.get("user").username, contactId, limit);
      const names = new Map<string, string>();
      for (const row of rows) {
        if (row.contact_id && !names.has(row.contact_id)) {
          const contact = await contacts.get(c.env.DB, c.get("user").username, row.contact_id);
          names.set(row.contact_id, contact?.name ?? row.phone);
        }
      }
      return rows.map((m) => ({
        at: new Date(m.at).toISOString().slice(0, 16).replace("T", " "),
        direction: m.direction === "out" ? "sent" : "received",
        channel: m.channel,
        with: (m.contact_id && names.get(m.contact_id)) || m.phone,
        text: m.body,
        status: m.status,
      }));
    },
  },
];

async function sendTool(c: Context<AppEnv>, args: Record<string, unknown>, channel: "sms" | "whatsapp") {
  const body = string(args, "body").slice(0, 1600);
  if (!body) {
    return { error: "body is required" };
  }
  const recipient = await recipientOf(c, args);
  if ("error" in recipient) {
    return recipient;
  }
  return telephony(async () => ({
    ok: true,
    ...(await sendText(c, c.get("user").username, recipient, body, channel)),
  }));
}

export const toolByName = (name: string) => TOOLS.find((t) => t.definition.name === name);

export function toolDefinitions(hasLightwave: boolean, hasTwilio = false): FunctionTool[] {
  const available = { lightwave: hasLightwave, twilio: hasTwilio };
  return TOOLS.filter((t) => !t.needs || available[t.needs]).map((t) => t.definition);
}

async function userLights(c: Context<AppEnv>): Promise<Light[]> {
  const token = await lightwaveToken(c, c.get("user").username);
  if (!token) {
    throw new Error("Lightwave is not connected");
  }
  return lights(lightwaveUrls(c), token);
}

/** Lightwave keeps the dim level across off and on, so "off" never touches it and a dim never goes to 0. */
const MIN_DIM = 1;

export function lightWrites(targets: Light[], args: Record<string, unknown>): { featureId: string; value: number }[] {
  const on = typeof args.on === "boolean" ? args.on : null;
  const requested = num(args, "dim_level");
  const dim = requested === null || on === false ? null : Math.max(MIN_DIM, Math.min(100, Math.round(requested)));
  return targets.flatMap((light) => [
    ...(dim !== null && light.dim ? [{ featureId: light.dim, value: dim }] : []),
    ...(on !== null ? [{ featureId: light.switch, value: on ? 1 : 0 }] : []),
  ]);
}

async function writeLights(c: Context<AppEnv>, targets: Light[], args: Record<string, unknown>): Promise<void> {
  const writes = lightWrites(targets, args);
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
