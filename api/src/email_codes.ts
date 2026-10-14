import { constantTimeEqual, randomToken, toHex } from "./crypto";
import { loginFailures } from "./db";

export const CODE_MINUTES = 10;
const CODE_TTL_MS = CODE_MINUTES * 60_000;
/** Wrong codes allowed per code; a new code for the same address keeps the count. */
export const MAX_ATTEMPTS = 5;
export const SENDS_PER_ADDRESS_PER_HOUR = 5;
export const SENDS_PER_IP_PER_HOUR = 30;
const HOUR_MS = 60 * 60_000;
const CODE_SPACE = 1_000_000;

export type CodePurpose = "login" | "verify";

export interface EmailCodeRow {
  email: string;
  purpose: CodePurpose;
  username: string | null;
  code_mac: string;
  token_mac: string;
  attempts: number;
  created_at: number;
  expires_at: number;
}

const encoder = new TextEncoder();

/**
 * Codes and link tokens are kept only as HMACs under a key only the Worker holds: a leaked table
 * cannot be searched for the million possible codes offline, as plain hashes could.
 */
export async function mac(env: Env, label: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`alexsay ${label}\0${env.SECRETS_KEY}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

/** Six digits, uniform: draws above the last whole million are thrown back. */
export function newCode(): string {
  const limit = Math.floor(2 ** 32 / CODE_SPACE) * CODE_SPACE;
  for (;;) {
    const [draw = limit] = crypto.getRandomValues(new Uint32Array(1));
    if (draw < limit) {
      return String(draw % CODE_SPACE).padStart(6, "0");
    }
  }
}

export type SendCheck = "ok" | "address" | "ip";

/** Counts a send against the address and the IP address; refuses past either hourly limit. */
export async function allowSend(db: D1Database, email: string, ip: string, now: number): Promise<SendCheck> {
  const since = now - HOUR_MS;
  const [byAddress, byIp] = await Promise.all([
    loginFailures.recent(db, `mail:${email}`, since),
    loginFailures.recent(db, `mail-ip:${ip}`, since),
  ]);
  if (byAddress >= SENDS_PER_ADDRESS_PER_HOUR) {
    return "address";
  }
  if (byIp >= SENDS_PER_IP_PER_HOUR) {
    return "ip";
  }
  await Promise.all([loginFailures.record(db, `mail:${email}`, now), loginFailures.record(db, `mail-ip:${ip}`, now)]);
  return "ok";
}

/** A fresh code and link token for an address, replacing any earlier one but not its wrong guesses. */
export async function issueCode(
  env: Env,
  email: string,
  purpose: CodePurpose,
  username: string | null,
  now: number,
): Promise<{ code: string; token: string }> {
  const code = newCode();
  const token = randomToken();
  const [codeMac, tokenMac] = await Promise.all([mac(env, "code", `${email}\0${code}`), mac(env, "token", token)]);
  await env.DB.prepare(
    `INSERT INTO email_codes (email, purpose, username, code_mac, token_mac, attempts, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT (email, purpose) DO UPDATE SET username = excluded.username, code_mac = excluded.code_mac,
       token_mac = excluded.token_mac, created_at = excluded.created_at, expires_at = excluded.expires_at,
       attempts = CASE WHEN email_codes.expires_at > excluded.created_at THEN email_codes.attempts ELSE 0 END`,
  )
    .bind(email, purpose, username, codeMac, tokenMac, now, now + CODE_TTL_MS)
    .run();
  return { code, token };
}

export type CodeCheck =
  | { ok: true; row: EmailCodeRow }
  | { ok: false; reason: "expired" | "wrong" | "too_many_attempts" };

/** Checks a typed code; a right one is used up, a wrong one counts, the fifth wrong one burns the code. */
export async function checkCode(
  env: Env,
  where: { email: string } | { username: string },
  purpose: CodePurpose,
  code: string,
  now: number,
): Promise<CodeCheck> {
  const row = await ("email" in where
    ? env.DB.prepare("SELECT * FROM email_codes WHERE email = ? AND purpose = ?").bind(where.email, purpose)
    : env.DB.prepare("SELECT * FROM email_codes WHERE username = ? AND purpose = ?").bind(where.username, purpose)
  ).first<EmailCodeRow>();
  if (!row || row.expires_at <= now) {
    return { ok: false, reason: "expired" };
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    await remove(env.DB, row);
    return { ok: false, reason: "too_many_attempts" };
  }
  if (!constantTimeEqual(await mac(env, "code", `${row.email}\0${code}`), row.code_mac)) {
    await env.DB.prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE email = ? AND purpose = ?")
      .bind(row.email, row.purpose)
      .run();
    return { ok: false, reason: row.attempts + 1 >= MAX_ATTEMPTS ? "too_many_attempts" : "wrong" };
  }
  await remove(env.DB, row);
  return { ok: true, row };
}

/** The link in a sign-in email: found by its HMAC, used once. */
export async function checkToken(env: Env, token: string, purpose: CodePurpose, now: number) {
  const row = await env.DB.prepare("SELECT * FROM email_codes WHERE token_mac = ? AND purpose = ?")
    .bind(await mac(env, "token", token), purpose)
    .first<EmailCodeRow>();
  if (!row || row.expires_at <= now) {
    return null;
  }
  await remove(env.DB, row);
  return row;
}

function remove(db: D1Database, row: EmailCodeRow) {
  return db.prepare("DELETE FROM email_codes WHERE email = ? AND purpose = ?").bind(row.email, row.purpose).run();
}
