import { hashPassword, randomToken } from "./crypto";
import { homes, users } from "./db";
import { mac } from "./email_codes";
import type { HomeRole, User } from "./types";

export const INVITE_DAYS = 3;
const INVITE_TTL_MS = INVITE_DAYS * 86_400_000;

export interface InviteRow {
  id: string;
  home_id: string;
  email: string;
  role: HomeRole;
  token_mac: string;
  invited_by: string;
  status: "pending" | "accepted" | "revoked";
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
  accepted_by: string | null;
}

export type InviteStatus = InviteRow["status"] | "expired";

export function inviteStatus(row: InviteRow, now: number): InviteStatus {
  return row.status === "pending" && row.expires_at <= now ? "expired" : row.status;
}

export function inviteView(row: InviteRow, now: number) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    invited_by: row.invited_by,
    status: inviteStatus(row, now),
    created_at: row.created_at,
    expires_at: row.expires_at,
    accepted_at: row.accepted_at,
    accepted_by: row.accepted_by,
  };
}

export const invites = {
  list: async (db: D1Database, home: string) =>
    (
      await db
        .prepare("SELECT * FROM invites WHERE home_id = ? ORDER BY created_at DESC LIMIT 50")
        .bind(home)
        .all<InviteRow>()
    ).results,

  get: (db: D1Database, home: string, id: string) =>
    db.prepare("SELECT * FROM invites WHERE id = ? AND home_id = ?").bind(id, home).first<InviteRow>(),

  remove: (db: D1Database, home: string, id: string) =>
    db.prepare("DELETE FROM invites WHERE id = ? AND home_id = ?").bind(id, home).run(),
};

/** A new invitation (or a fresh link for the same address): any earlier pending one is replaced. */
export async function createInvite(
  env: Env,
  invite: { home: string; email: string; role: HomeRole; invitedBy: string },
  now: number,
): Promise<{ row: InviteRow; token: string }> {
  const token = randomToken();
  const row: InviteRow = {
    id: crypto.randomUUID(),
    home_id: invite.home,
    email: invite.email,
    role: invite.role,
    token_mac: await mac(env, "invite", token),
    invited_by: invite.invitedBy,
    status: "pending",
    created_at: now,
    expires_at: now + INVITE_TTL_MS,
    accepted_at: null,
    accepted_by: null,
  };
  await env.DB.batch([
    env.DB.prepare("DELETE FROM invites WHERE home_id = ? AND email = ? AND status = 'pending'").bind(
      invite.home,
      invite.email,
    ),
    env.DB.prepare(
      `INSERT INTO invites (id, home_id, email, role, token_mac, invited_by, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).bind(row.id, row.home_id, row.email, row.role, row.token_mac, row.invited_by, row.created_at, row.expires_at),
  ]);
  return { row, token };
}

/** The pending, unexpired invitation a link carries. */
export async function inviteByToken(env: Env, token: string, now: number): Promise<InviteRow | null> {
  const row = await env.DB.prepare("SELECT * FROM invites WHERE token_mac = ?")
    .bind(await mac(env, "invite", token))
    .first<InviteRow>();
  return row && inviteStatus(row, now) === "pending" ? row : null;
}

/** A name for an account made from an email address: its local part, made unique. */
export async function usernameFor(db: D1Database, email: string): Promise<string> {
  const base =
    (email.split("@")[0] ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, "")
      .slice(0, 24) || "user";
  const stem = base.length >= 2 ? base : `${base}-user`;
  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? stem : `${stem}-${n + 1}`;
    if (!(await users.exists(db, candidate))) {
      return candidate;
    }
  }
  return `${stem}-${crypto.randomUUID().slice(0, 8)}`;
}

/** The account an email address signs in to, made on the spot (with no usable password) when there is none. */
export async function accountForEmail(db: D1Database, email: string): Promise<User> {
  const existing = await users.byEmail(db, email);
  if (existing) {
    return existing;
  }
  const username = await usernameFor(db, email);
  await users.create(db, { username, role: "user", email, password_hash: await hashPassword(randomToken()) });
  const created = await users.session(db, username);
  if (!created) {
    throw new Error(`account ${username} vanished`);
  }
  return created;
}

export type JoinResult = { ok: true; user: User } | { ok: false; reason: "home_has_members" };

/**
 * Moves a person into an invitation's home. Their own home stays as it was, waiting for them, but a
 * home with other people in it cannot be left behind by its creator.
 */
export async function acceptInvite(env: Env, invite: InviteRow, now: number): Promise<JoinResult> {
  const account = await accountForEmail(env.DB, invite.email);
  if (account.home !== invite.home_id) {
    const own = await homes.members(env.DB, account.username);
    if (account.home === account.username && own.length > 1) {
      return { ok: false, reason: "home_has_members" };
    }
    await users.setHome(env.DB, account.username, invite.home_id, invite.role);
  }
  await env.DB.prepare(
    "UPDATE invites SET status = 'accepted', accepted_at = ?, accepted_by = ? WHERE id = ? AND status = 'pending'",
  )
    .bind(now, account.username, invite.id)
    .run();
  const joined = await users.session(env.DB, account.username);
  return joined ? { ok: true, user: joined } : { ok: false, reason: "home_has_members" };
}
