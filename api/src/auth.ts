import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { randomToken, sha256Hex, verifyPassword } from "./crypto";
import { loginFailures, sessions, users } from "./db";
import type { AppEnv, User } from "./types";

export const SESSION_COOKIE = "ay_session";
const SESSION_TTL_MS = 30 * 86_400_000;
const LOCKOUT_WINDOW_MS = 15 * 60_000;
/**
 * Five failures lock a name for one address; an address locks after many failures across names, and
 * a name alone only after far more, so a stranger cannot lock you out of your own account.
 */
const MAX_FAILURES_PER_PAIR = 5;
const MAX_FAILURES_PER_ADDRESS = 30;
const MAX_FAILURES_PER_NAME = 50;
const REGISTRATIONS_PER_ADDRESS = 40;
const REGISTRATION_WINDOW_MS = 60 * 60_000;
/** Verified for unknown users too, so the response time does not reveal whether a name exists. */
const DECOY_HASH = "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export type LoginResult = { ok: true; user: User } | { ok: false; reason: "invalid" | "locked" };

export const addressOf = (c: Context<AppEnv>): string => c.req.header("cf-connecting-ip") ?? "unknown";

export async function login(c: Context<AppEnv>, username: string, password: string): Promise<LoginResult> {
  const db = c.env.DB;
  const now = Date.now();
  const address = `ip:${addressOf(c)}`;
  const pair = `${username}@${addressOf(c)}`;
  const since = now - LOCKOUT_WINDOW_MS;
  const [byPair, byAddress, byName] = await Promise.all([
    loginFailures.recent(db, pair, since),
    loginFailures.recent(db, address, since),
    loginFailures.recent(db, username, since),
  ]);
  if (byPair >= MAX_FAILURES_PER_PAIR || byAddress >= MAX_FAILURES_PER_ADDRESS || byName >= MAX_FAILURES_PER_NAME) {
    return { ok: false, reason: "locked" };
  }
  const row = await users.get(db, username);
  const matches = await verifyPassword(password, row?.password_hash ?? DECOY_HASH);
  if (!row || !matches) {
    await Promise.all([pair, address, username].map((key) => loginFailures.record(db, key, now)));
    return { ok: false, reason: "invalid" };
  }
  await Promise.all([loginFailures.clear(db, username), loginFailures.clear(db, pair)]);
  const user = { username: row.username, role: row.role };
  await startSession(c, user);
  return { ok: true, user };
}

/** True when this address may register another account this hour; the attempt is counted. */
export async function registrationAllowed(c: Context<AppEnv>): Promise<boolean> {
  const key = `register:${addressOf(c)}`;
  const now = Date.now();
  if ((await loginFailures.recent(c.env.DB, key, now - REGISTRATION_WINDOW_MS)) >= REGISTRATIONS_PER_ADDRESS) {
    return false;
  }
  await loginFailures.record(c.env.DB, key, now);
  return true;
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
