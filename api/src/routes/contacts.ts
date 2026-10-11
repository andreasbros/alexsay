import { Hono } from "hono";
import { countryCode } from "../connections";
import { calls, contacts, messages, type NewContact } from "../db";
import { normalisePhone } from "../phone";
import * as schemas from "../schemas";
import type { AppEnv, ContactRow, Scope } from "../types";
import { jsonBody, parse } from "../validate";

const PAGE_SIZE = 50;
const DETAIL_MESSAGES = 20;
const DETAIL_CALLS = 10;

export const publicContact = (row: ContactRow) => ({
  id: row.id,
  name: row.name,
  phone: row.phone,
  label: row.label,
  note: row.note,
  favourite: row.favourite === 1,
  last_called_at: row.last_called_at,
  last_messaged_at: row.last_messaged_at,
  updated_at: row.updated_at,
});

/** The phone book: paged and searchable for the app, the same rows the assistant's contact tools read. */
export const contactRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const { q, page, favourites } = parse(schemas.contactList, c.req.query());
    const result = await contacts.list(c.env.DB, c.get("user").username, {
      query: q,
      favourites: favourites === "1",
      page,
      pageSize: PAGE_SIZE,
    });
    return c.json({ contacts: result.rows.map(publicContact), total: result.total, page, page_size: PAGE_SIZE });
  })
  .post("/", async (c) => {
    const body = await jsonBody(c, schemas.createContact);
    const username = c.get("user").username;
    const phone = normalisePhone(body.phone, await countryCode(c, username));
    if (!phone) {
      return c.json({ error: "bad_phone" }, 400);
    }
    await contacts.upsert(
      c.env.DB,
      username,
      [{ name: body.name, phone, label: body.label, note: body.note }],
      Date.now(),
    );
    const row = await contacts.byPhone(c.env.DB, username, phone);
    return row ? c.json(publicContact(row), 201) : c.json({ error: "internal" }, 500);
  })
  .post("/import", async (c) => {
    const { contacts: pasted } = await jsonBody(c, schemas.importContacts);
    const username = c.get("user").username;
    const code = await countryCode(c, username);
    const byPhone = new Map<string, NewContact>();
    for (const entry of pasted) {
      const phone = normalisePhone(entry.phone, code);
      if (phone) {
        byPhone.set(phone, { name: entry.name, phone, label: entry.label });
      }
    }
    const known = await contacts.phones(c.env.DB, username);
    const rows = [...byPhone.values()];
    if (rows.length > 0) {
      await contacts.upsert(c.env.DB, username, rows, Date.now());
    }
    const updated = rows.filter((row) => known.has(row.phone)).length;
    return c.json({ imported: rows.length - updated, updated, skipped: pasted.length - rows.length });
  })
  .get("/:id", async (c) => {
    const username = c.get("user").username;
    const row = await contacts.get(c.env.DB, username, c.req.param("id"));
    if (!row) {
      return c.json({ error: "not_found" }, 404);
    }
    const [recentMessages, recentCalls] = await Promise.all([
      messages.list(c.env.DB, username, row.id, DETAIL_MESSAGES),
      calls.list(c.env.DB, username, row.id, DETAIL_CALLS),
    ]);
    return c.json({
      ...publicContact(row),
      messages: recentMessages.map((m) => ({
        id: m.id,
        channel: m.channel,
        direction: m.direction,
        body: m.body,
        status: m.status,
        at: m.at,
      })),
      calls: recentCalls.map((k) => ({ id: k.id, direction: k.direction, kind: k.kind, status: k.status, at: k.at })),
    });
  })
  .patch("/:id", async (c) => {
    const changes = await jsonBody(c, schemas.updateContact);
    const username = c.get("user").username;
    const result = await applyContactChanges(c, username, c.req.param("id"), changes);
    if (result !== "ok") {
      return c.json({ error: result }, result === "not_found" ? 404 : result === "bad_phone" ? 400 : 409);
    }
    return c.body(null, 204);
  })
  .delete("/:id", async (c) => {
    const result = await contacts.remove(c.env.DB, c.get("user").username, c.req.param("id"));
    return result.meta.changes ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  });

export type ContactChanges = { name?: string; phone?: string; label?: string; note?: string; favourite?: boolean };

/** Edits shared by the app and the assistant; a new number is normalised and must not belong to another contact. */
export async function applyContactChanges(
  c: Scope,
  username: string,
  id: string,
  changes: ContactChanges,
): Promise<"ok" | "not_found" | "bad_phone" | "phone_taken"> {
  let phone: string | undefined;
  if (changes.phone !== undefined) {
    const normalised = normalisePhone(changes.phone, await countryCode(c, username));
    if (!normalised) {
      return "bad_phone";
    }
    const other = await contacts.byPhone(c.env.DB, username, normalised);
    if (other && other.id !== id) {
      return "phone_taken";
    }
    phone = normalised;
  }
  const result = await contacts.update(c.env.DB, username, id, { ...changes, phone });
  return result.meta.changes ? "ok" : "not_found";
}
