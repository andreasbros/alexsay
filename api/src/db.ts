import type { ConnectionRow, DeviceRow, Provider, Role, User, UserRow } from "./types";

const DAY_MS = 86_400_000;
/** Caps how many unclaimed devices can call home, so random traffic cannot grow the table. */
const MAX_UNCLAIMED_DEVICES = 200;

export const users = {
  get: (db: D1Database, username: string) =>
    db.prepare("SELECT * FROM users WHERE username = ?").bind(username).first<UserRow>(),

  list: async (db: D1Database) =>
    (
      await db
        .prepare(
          `SELECT u.username, u.role, u.created_at, COUNT(d.id) AS devices
           FROM users u LEFT JOIN devices d ON d.owner = u.username
           GROUP BY u.username ORDER BY u.username`,
        )
        .all<User & { created_at: number; devices: number }>()
    ).results,

  create: (db: D1Database, user: { username: string; password_hash: string; role: Role }) =>
    db
      .prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)")
      .bind(user.username, user.password_hash, user.role, Date.now())
      .run(),

  setRole: (db: D1Database, username: string, role: Role) =>
    db.prepare("UPDATE users SET role = ? WHERE username = ?").bind(role, username).run(),

  setPassword: (db: D1Database, username: string, passwordHash: string) =>
    db.prepare("UPDATE users SET password_hash = ? WHERE username = ?").bind(passwordHash, username).run(),

  remove: (db: D1Database, username: string) => db.prepare("DELETE FROM users WHERE username = ?").bind(username).run(),

  countAdmins: async (db: D1Database) =>
    (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").first<{ n: number }>())?.n ?? 0,
};

export const sessions = {
  create: (db: D1Database, tokenSha256: string, username: string, expiresAt: number) =>
    db
      .prepare("INSERT INTO sessions (token_sha256, username, expires_at) VALUES (?, ?, ?)")
      .bind(tokenSha256, username, expiresAt)
      .run(),

  user: (db: D1Database, tokenSha256: string, now: number) =>
    db
      .prepare(
        `SELECT u.username, u.role FROM sessions s JOIN users u ON u.username = s.username
         WHERE s.token_sha256 = ? AND s.expires_at > ?`,
      )
      .bind(tokenSha256, now)
      .first<User>(),

  remove: (db: D1Database, tokenSha256: string) =>
    db.prepare("DELETE FROM sessions WHERE token_sha256 = ?").bind(tokenSha256).run(),
};

export const loginFailures = {
  recent: async (db: D1Database, username: string, since: number) =>
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM login_failures WHERE username = ? AND at > ?")
        .bind(username, since)
        .first<{ n: number }>()
    )?.n ?? 0,

  record: (db: D1Database, username: string, at: number) =>
    db.prepare("INSERT INTO login_failures (username, at) VALUES (?, ?)").bind(username, at).run(),

  clear: (db: D1Database, username: string) =>
    db.prepare("DELETE FROM login_failures WHERE username = ?").bind(username).run(),
};

export const devices = {
  get: (db: D1Database, id: string) => db.prepare("SELECT * FROM devices WHERE id = ?").bind(id).first<DeviceRow>(),

  /** Every device for admins (owner null), otherwise the owner's. */
  list: async (db: D1Database, owner: string | null) => {
    const query = owner
      ? db.prepare("SELECT * FROM devices WHERE owner = ? ORDER BY created_at").bind(owner)
      : db.prepare("SELECT * FROM devices ORDER BY owner IS NULL, created_at");
    return (await query.all<DeviceRow>()).results;
  },

  /** Adds the device to the owner, creating the row if the speaker has never called home. */
  claim: (db: D1Database, id: string, name: string, owner: string, now: number) =>
    db
      .prepare(
        `INSERT INTO devices (id, name, owner, created_at, claimed_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET owner = excluded.owner, claimed_at = excluded.claimed_at,
           name = CASE WHEN excluded.name = '' THEN devices.name ELSE excluded.name END
         WHERE devices.owner IS NULL`,
      )
      .bind(id, name, owner, now, now)
      .run(),

  update: (db: D1Database, id: string, changes: { name?: string; owner?: string | null }) =>
    db
      .prepare(
        `UPDATE devices SET
           name = COALESCE(?, name),
           owner = CASE WHEN ? THEN ? ELSE owner END,
           claimed_at = CASE WHEN ? THEN ? ELSE claimed_at END
         WHERE id = ?`,
      )
      .bind(
        changes.name ?? null,
        changes.owner !== undefined ? 1 : 0,
        changes.owner ?? null,
        changes.owner !== undefined ? 1 : 0,
        changes.owner ? Date.now() : null,
        id,
      )
      .run(),

  release: (db: D1Database, id: string, owner: string) =>
    db.prepare("UPDATE devices SET owner = NULL, claimed_at = NULL WHERE id = ? AND owner = ?").bind(id, owner).run(),

  remove: (db: D1Database, id: string) => db.prepare("DELETE FROM devices WHERE id = ?").bind(id).run(),

  /** A speaker calling home: known rows get a last-seen stamp, unknown ones a capped unclaimed row. */
  touch: (db: D1Database, id: string, now: number, firmware: string | null, meta: string) =>
    db.batch([
      db
        .prepare(
          `INSERT INTO devices (id, created_at, last_seen_at, firmware, last_meta)
           SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM devices WHERE owner IS NULL) < ?
           ON CONFLICT (id) DO NOTHING`,
        )
        .bind(id, now, now, firmware, meta, MAX_UNCLAIMED_DEVICES),
      db
        .prepare("UPDATE devices SET last_seen_at = ?, firmware = COALESCE(?, firmware), last_meta = ? WHERE id = ?")
        .bind(now, firmware, meta, id),
    ]),
};

export const connections = {
  get: (db: D1Database, username: string, provider: Provider) =>
    db
      .prepare("SELECT * FROM connections WHERE username = ? AND provider = ?")
      .bind(username, provider)
      .first<ConnectionRow>(),

  list: async (db: D1Database, username: string) =>
    (
      await db
        .prepare(
          "SELECT provider, settings, created_at, updated_at FROM connections WHERE username = ? ORDER BY provider",
        )
        .bind(username)
        .all<Pick<ConnectionRow, "provider" | "settings" | "created_at" | "updated_at">>()
    ).results,

  put: (db: D1Database, username: string, provider: Provider, secret: string, settings: string) =>
    db
      .prepare(
        `INSERT INTO connections (username, provider, secret, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (username, provider) DO UPDATE SET secret = excluded.secret, settings = excluded.settings,
           updated_at = excluded.updated_at`,
      )
      .bind(username, provider, secret, settings, Date.now(), Date.now())
      .run(),

  /** Rotating credentials (Lightwave's refresh token) are re-sealed after every use. */
  setSecret: (db: D1Database, username: string, provider: Provider, secret: string) =>
    db
      .prepare("UPDATE connections SET secret = ? WHERE username = ? AND provider = ?")
      .bind(secret, username, provider)
      .run(),

  remove: (db: D1Database, username: string, provider: Provider) =>
    db.prepare("DELETE FROM connections WHERE username = ? AND provider = ?").bind(username, provider).run(),
};

/** Nightly: drops expired sessions and old login failures. */
export async function purgeExpired(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM login_failures WHERE at <= ?").bind(now - DAY_MS),
  ]);
}
