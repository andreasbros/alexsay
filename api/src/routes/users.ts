import { Hono } from "hono";
import { users } from "../db";
import * as schemas from "../schemas";
import type { AppEnv } from "../types";
import { jsonBody, parse } from "../validate";

/** Admin only: who registered, what role they have, how many speakers they own. */
export const userRoutes = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await users.list(c.env.DB)))
  .patch("/:username", async (c) => {
    const username = parse(schemas.username, c.req.param("username"));
    const { role } = await jsonBody(c, schemas.updateUser);
    const target = await users.get(c.env.DB, username);
    if (!target) {
      return c.json({ error: "not_found" }, 404);
    }
    if (target.role === "admin" && role === "user" && (await users.countAdmins(c.env.DB)) <= 1) {
      return c.json({ error: "last_admin" }, 409);
    }
    await users.setRole(c.env.DB, username, role);
    return c.body(null, 204);
  })
  .delete("/:username", async (c) => {
    const username = parse(schemas.username, c.req.param("username"));
    if (username === c.get("user").username) {
      return c.json({ error: "cannot_delete_self" }, 409);
    }
    const result = await users.remove(c.env.DB, username);
    return result.meta.changes ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  });
