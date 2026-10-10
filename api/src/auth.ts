import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { randomToken, sha256Hex, verifyPassword } from "./crypto";
import { loginFailures, sessions, users } from "./db";
import type { AppEnv, User } from "./types";

export const SESSION_COOKIE = "ay_session";
const SESSION_TTL_MS = 30 * 86_400_000;
const LOCKOUT_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;
/** Verified for unknown users too, so the response time does not reveal whether a name exists. */
const DECOY_HASH = "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export type LoginResult = { ok: true; user: User } | { ok: false; reason: "invalid" | "locked" };

export async function login(c: Context<AppEnv>, username: string, password: string): Promise<LoginResult> {
  const db = c.env.DB;
  const now = Date.now();
  if ((await loginFailures.recent(db, username, now - LOCKOUT_WINDOW_MS)) >= MAX_FAILURES) {
    return { ok: false, reason: "locked" };
  }
  const row = await users.get(db, username);
  const matches = await verifyPassword(password, row?.password_hash ?? DECOY_HASH);
  if (!row || !matches) {
    await loginFailures.record(db, username, now);
    return { ok: false, reason: "invalid" };
  }
  await loginFailures.clear(db, username);
  const user = { username: row.username, role: row.role };
  await startSession(c, user);
  return { ok: true, user };
}

export async function startSession(c: Context<AppEnv>, user: User): Promise<void> {
  const token = randomToken();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await sessions.create(c.env.DB, await sha256Hex(token), user.username, expiresAt);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export async function logout(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await sessions.remove(c.env.DB, await sha256Hex(token));
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
}

export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const user = token ? await sessions.user(c.env.DB, await sha256Hex(token), Date.now()) : null;
  if (!user) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  c.set("user", user);
  await next();
});

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("user").role !== "admin") {
    return c.json({ error: "forbidden" }, 403);
  }
  await next();
});
