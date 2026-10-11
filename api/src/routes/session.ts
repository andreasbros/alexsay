import { Hono } from "hono";
import { login, logout, requireUser, startSession } from "../auth";
import { hashPassword } from "../crypto";
import { users } from "../db";
import * as schemas from "../schemas";
import type { AppEnv } from "../types";
import { jsonBody } from "../validate";

export const sessionRoutes = new Hono<AppEnv>()
  .post("/register", async (c) => {
    const { username, password } = await jsonBody(c, schemas.register);
    if (await users.get(c.env.DB, username)) {
      return c.json({ error: "exists" }, 409);
    }
    const user = { username, role: "user" as const };
    await users.create(c.env.DB, { ...user, password_hash: await hashPassword(password) });
    await startSession(c, user);
    return c.json(user, 201);
  })
  .post("/login", async (c) => {
    const { username, password } = await jsonBody(c, schemas.login);
    const result = await login(c, username.trim().toLowerCase(), password);
    if (!result.ok) {
      return c.json({ error: result.reason }, result.reason === "locked" ? 429 : 401);
    }
    return c.json(result.user);
  })
  .post("/logout", async (c) => {
    await logout(c);
    return c.body(null, 204);
  })
  .get("/me", requireUser, async (c) => {
    const user = c.get("user");
    return c.json({ ...user, ai_log_access: await users.logAccess(c.env.DB, user.username) });
  })
  /** Account-level preferences the server must enforce, unlike the browser-only ones in Settings. */
  .patch("/settings", requireUser, async (c) => {
    const { ai_log_access } = await jsonBody(c, schemas.userSettings);
    await users.setLogAccess(c.env.DB, c.get("user").username, ai_log_access);
    return c.json({ ai_log_access });
  });
