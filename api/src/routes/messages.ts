import { Hono } from "hono";
import { z } from "zod";
import { contacts, messages, notifications } from "../db";
import type { AppEnv } from "../types";
import { jsonBody } from "../validate";

const LIST_MAX = 200;
const limitOf = (raw: string | undefined, fallback: number) =>
  Math.min(LIST_MAX, Math.max(1, Number.parseInt(raw ?? "", 10) || fallback));

/** Names for the contact ids a list carries, fetched once each. */
async function namesFor(db: D1Database, home: string, rows: { contact_id: string | null }[]) {
  const names = new Map<string, string>();
  for (const row of rows) {
    if (row.contact_id && !names.has(row.contact_id)) {
      const contact = await contacts.get(db, home, row.contact_id);
      if (contact) {
        names.set(row.contact_id, contact.name);
      }
    }
  }
  return names;
}

/** Every text and WhatsApp message either way, newest first, with the contact's name where there is one. */
export const messageRoutes = new Hono<AppEnv>().get("/", async (c) => {
  const home = c.get("user").home;
  const rows = await messages.list(c.env.DB, home, null, limitOf(c.req.query("limit"), 100));
  const names = await namesFor(c.env.DB, home, rows);
  return c.json(
    rows.map((m) => ({
      id: m.id,
      at: m.at,
      channel: m.channel,
      direction: m.direction,
      phone: m.phone,
      contact_id: m.contact_id,
      contact: m.contact_id ? (names.get(m.contact_id) ?? null) : null,
      body: m.body,
      status: m.status,
    })),
  );
});

const markRead = z.object({ ids: z.array(z.string().max(64)).max(200).optional() });

/** Texts received, calls missed and messages taken, with read marks the speakers and the page share. */
export const notificationRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const home = c.get("user").home;
    const unreadOnly = c.req.query("unread") === "1";
    const rows = await notifications.list(c.env.DB, home, limitOf(c.req.query("limit"), 100), unreadOnly);
    const names = await namesFor(c.env.DB, home, rows);
    return c.json({
      unread: await notifications.unread(c.env.DB, home),
      notifications: rows.map((n) => ({
        id: n.id,
        at: n.at,
        kind: n.kind,
        phone: n.phone,
        contact_id: n.contact_id,
        contact: n.contact_id ? (names.get(n.contact_id) ?? null) : null,
        title: n.title,
        body: n.body,
        ref: n.ref,
        read_at: n.read_at,
      })),
    });
  })
  .post("/read", async (c) => {
    const { ids } = await jsonBody(c, markRead);
    const marked = await notifications.markRead(c.env.DB, c.get("user").home, ids ?? null, Date.now());
    return c.json({ marked });
  });
