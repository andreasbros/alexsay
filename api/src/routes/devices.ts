import { Hono } from "hono";
import { devices, users } from "../db";
import * as schemas from "../schemas";
import type { AppEnv, DeviceRow } from "../types";
import { jsonBody, parse } from "../validate";

const ONLINE_WINDOW_MS = 3 * 60_000;

function view(row: DeviceRow, now: number) {
  return {
    id: row.id,
    name: row.name,
    owner: row.home_id,
    created_at: row.created_at,
    claimed_at: row.claimed_at,
    last_seen_at: row.last_seen_at,
    firmware: row.firmware,
    online: row.last_seen_at !== null && now - row.last_seen_at < ONLINE_WINDOW_MS,
  };
}

/** A home sees its own speakers; server admins see every speaker and can move one to a person's home. */
export const deviceRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const me = c.get("user");
    const rows = await devices.list(c.env.DB, me.role === "admin" ? null : me.home);
    const now = Date.now();
    return c.json(rows.map((row) => view(row, now)));
  })
  .post("/", async (c) => {
    const { id, name } = await jsonBody(c, schemas.claimDevice);
    const me = c.get("user");
    const existing = await devices.get(c.env.DB, id);
    if (existing?.home_id && existing.home_id !== me.home) {
      return c.json({ error: "claimed" }, 409);
    }
    if (existing?.home_id === me.home) {
      return c.json({ error: "exists" }, 409);
    }
    await devices.claim(c.env.DB, id, name, me.home, Date.now());
    const row = await devices.get(c.env.DB, id);
    return row ? c.json(view(row, Date.now()), 201) : c.json({ error: "internal" }, 500);
  })
  .patch("/:id", async (c) => {
    const id = parse(schemas.deviceId, c.req.param("id"));
    const changes = await jsonBody(c, schemas.updateDevice);
    const me = c.get("user");
    const row = await devices.get(c.env.DB, id);
    if (!row || (me.role !== "admin" && row.home_id !== me.home)) {
      return c.json({ error: "not_found" }, 404);
    }
    if (changes.owner !== undefined && me.role !== "admin") {
      return c.json({ error: "forbidden" }, 403);
    }
    let home: string | null | undefined;
    if (changes.owner !== undefined) {
      home = changes.owner === null ? null : ((await users.session(c.env.DB, changes.owner))?.home ?? undefined);
      if (home === undefined) {
        return c.json({ error: "no_such_user" }, 404);
      }
    }
    await devices.update(c.env.DB, id, { name: changes.name, home_id: home });
    return c.body(null, 204);
  })
  /**
   * Drop in on a speaker: the app's side of the two-way channel, a WebSocket to the speaker's line
   * bridge. The bridge offers it to the speaker, which announces who it is and asks before opening.
   */
  .get("/:id/drop-in", async (c) => {
    const id = parse(schemas.deviceId, c.req.param("id"));
    const me = c.get("user");
    const row = await devices.get(c.env.DB, id);
    if (!row || row.home_id !== me.home) {
      return c.json({ error: "not_found" }, 404);
    }
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.json({ error: "expected a websocket" }, 426);
    }
    const bridge = c.env.LINE_BRIDGE.get(c.env.LINE_BRIDGE.idFromName(id));
    const guest = new URL("https://line/guest");
    guest.searchParams.set("id", crypto.randomUUID());
    guest.searchParams.set("from", me.username);
    return bridge.fetch(guest, { headers: { upgrade: "websocket" } });
  })
  .delete("/:id", async (c) => {
    const id = parse(schemas.deviceId, c.req.param("id"));
    const me = c.get("user");
    const row = await devices.get(c.env.DB, id);
    if (!row || (me.role !== "admin" && row.home_id !== me.home)) {
      return c.json({ error: "not_found" }, 404);
    }
    if (me.role === "admin") {
      await devices.remove(c.env.DB, id);
    } else {
      await devices.release(c.env.DB, id, me.home);
    }
    return c.body(null, 204);
  });
