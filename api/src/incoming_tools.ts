import { calls, contacts, notifications } from "./db";
import { takeMessage } from "./incoming";
import type { Tool } from "./tools";

const HISTORY_MAX = 50;

const whenOf = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/**
 * What came in and what the assistant did about it: the call history, the notifications (texts,
 * missed calls, messages taken) and marking them read, and taking a message on a call it answered.
 * Replying and calling back are send_text and place_call, as for anything else.
 */
export const INCOMING_TOOLS: Tool[] = [
  {
    needs: "twilio",
    definition: {
      type: "function",
      name: "recent_calls",
      description:
        "The latest phone calls either way: who, when, whether it was answered or missed, and on an incoming " +
        "call who took it. Use it for 'who called?', 'did I miss a call?', 'call back whoever rang'.",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer", description: "How many, up to 50 (default 10)" } },
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const limit = Math.min(HISTORY_MAX, Math.max(1, typeof args.limit === "number" ? args.limit : 10));
      const home = c.user.home;
      // The people side of each call: the assistant's and the user's own legs say nothing new
      const rows = (await calls.list(c.env.DB, home, null, limit * 3))
        .filter((r) => r.role === "" || r.role === "guest")
        .slice(0, limit);
      const names = new Map<string, string>();
      for (const row of rows) {
        if (row.contact_id && !names.has(row.contact_id)) {
          names.set(row.contact_id, (await contacts.get(c.env.DB, home, row.contact_id))?.name ?? row.phone);
        }
      }
      return rows.map((r) => ({
        at: whenOf(r.at),
        direction: r.direction === "in" ? "incoming" : "outgoing",
        with: (r.contact_id && names.get(r.contact_id)) || r.phone,
        number: r.phone,
        kind: r.kind === "announcement" ? "spoken message" : "call",
        status: r.status,
        answered_by: r.answered_by,
      }));
    },
  },
  {
    definition: {
      type: "function",
      name: "list_notifications",
      description:
        "What the home was told about and may not have dealt with: incoming texts, missed calls and messages " +
        "the assistant took on calls, newest first. Use it for 'any messages?', 'what did I miss?'.",
      parameters: {
        type: "object",
        properties: {
          unread_only: { type: "boolean", description: "Only the ones not yet marked read (default true)" },
          limit: { type: "integer", description: "How many, up to 50 (default 10)" },
        },
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const limit = Math.min(HISTORY_MAX, Math.max(1, typeof args.limit === "number" ? args.limit : 10));
      const unreadOnly = args.unread_only !== false;
      const rows = await notifications.list(c.env.DB, c.user.home, limit, unreadOnly);
      return rows.map((n) => ({
        id: n.id,
        at: whenOf(n.at),
        kind: n.kind,
        title: n.title,
        text: n.body,
        number: n.phone,
        read: n.read_at !== null,
      }));
    },
  },
  {
    definition: {
      type: "function",
      name: "mark_notifications_read",
      description:
        "Marks notifications as dealt with, once the user has heard them or acted on them. Pass ids from " +
        "list_notifications, or nothing to mark all of them.",
      parameters: {
        type: "object",
        properties: { ids: { type: "array", items: { type: "string" }, description: "Which ones; all when omitted" } },
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === "string") : null;
      const marked = await notifications.markRead(c.env.DB, c.user.home, ids, Date.now());
      return { ok: true, marked };
    },
  },
  {
    needs: "twilio",
    definition: {
      type: "function",
      name: "take_message",
      description:
        "On a call you answered for the user: writes down the caller's message so the user hears it and sees " +
        "it under Messages. Pass the caller's words, or a faithful summary with their name and what they want.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "The message, as the caller would want it passed on" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      const text = typeof args.text === "string" ? args.text.trim().slice(0, 1000) : "";
      if (!text) {
        return { error: "text is required" };
      }
      return takeMessage(c, text);
    },
  },
];
