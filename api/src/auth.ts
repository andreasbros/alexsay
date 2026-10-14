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
  const user = await users.session(db, row.username);
  if (!user) {
    return { ok: false, reason: "invalid" };
  }
  await startSession(c, user.username);
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

/** Always on Cloudflare; a self-hosted server on plain HTTP in a home network needs the cookie without it. */
export function overHttps(c: Context<AppEnv>): boolean {
  return new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";
}

export async function startSession(c: Context<AppEnv>, username: string): Promise<void> {
  const token = randomToken();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await sessions.create(c.env.DB, await sha256Hex(token), username, expiresAt);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: overHttps(c),
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
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: overHttps(c) });
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

/** Changing the home itself (speakers, connections, settings, members) is for its admins. */
export const requireHomeAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("user").homeRole !== "admin") {
    return c.json({ error: "home_admin_only" }, 403);
  }
  await next();
});

/**
 * Members see the home's speakers and connections; only its admins (and server admins) change them.
 * Connection tests change nothing, so everyone may run them.
 */
export const changesNeedHomeAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  const changes = c.req.method !== "GET" && c.req.method !== "HEAD" && !c.req.path.endsWith("/test");
  if (changes && user.homeRole !== "admin" && user.role !== "admin") {
    return c.json({ error: "home_admin_only" }, 403);
  }
  await next();
});
