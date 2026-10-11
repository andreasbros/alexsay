import { DEFAULT_LOCALE, type Locale } from "./locale";
import { purgeLog } from "./log";
import { searchName } from "./phone";
import type {
  CallReportRow,
  CallRow,
  CallSpeaker,
  CallTurnRow,
  Channel,
  ConnectionRow,
  ContactRow,
  ConversationRow,
  ConversationSource,
  DeviceRow,
  Direction,
  MemoryCategory,
  MemoryRow,
  MessageRow,
  Provider,
  Role,
  TurnRole,
  TurnRow,
  User,
  UserRow,
} from "./types";

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

  /** Whether the user let the assistant read their server log. */
  locale: async (db: D1Database, username: string): Promise<Locale> =>
    (await db.prepare("SELECT locale, timezone FROM users WHERE username = ?").bind(username).first<Locale>()) ??
    DEFAULT_LOCALE,

  setLocale: (db: D1Database, username: string, changes: Partial<Locale>) =>
    db
      .prepare("UPDATE users SET locale = COALESCE(?, locale), timezone = COALESCE(?, timezone) WHERE username = ?")
      .bind(changes.locale ?? null, changes.timezone ?? null, username)
      .run(),

  callTest: async (db: D1Database, username: string) =>
    (
      await db
        .prepare("SELECT ai_call_test FROM users WHERE username = ?")
        .bind(username)
        .first<{ ai_call_test: number }>()
    )?.ai_call_test === 1,

  setCallTest: (db: D1Database, username: string, allowed: boolean) =>
    db
      .prepare("UPDATE users SET ai_call_test = ? WHERE username = ?")
      .bind(allowed ? 1 : 0, username)
      .run(),

  logAccess: async (db: D1Database, username: string) =>
    (
      await db
        .prepare("SELECT ai_log_access FROM users WHERE username = ?")
        .bind(username)
        .first<{ ai_log_access: number }>()
    )?.ai_log_access === 1,

  setLogAccess: (db: D1Database, username: string, allowed: boolean) =>
    db
      .prepare("UPDATE users SET ai_log_access = ? WHERE username = ?")
      .bind(allowed ? 1 : 0, username)
      .run(),

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

  /** Whose Twilio number (or WhatsApp sender) an incoming call or message was addressed to. */
  twilioByNumber: (db: D1Database, number: string) =>
    db
      .prepare(
        `SELECT * FROM connections WHERE provider = 'twilio' AND (
           json_extract(settings, '$.from_number') = ?1 OR
           json_extract(settings, '$.whatsapp_from') IN (?1, 'whatsapp:' || ?1))`,
      )
      .bind(number)
      .first<ConnectionRow>(),
};

/** Nightly: drops expired sessions and old login failures. */
export async function purgeExpired(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM login_failures WHERE at <= ?").bind(now - DAY_MS),
    purgeLog(db, now),
  ]);
}

export interface NewTurn {
  at: number;
  role: TurnRole;
  text: string;
}

export const conversations = {
  create: (
    db: D1Database,
    row: { id: string; username: string; source: ConversationSource; device_id: string | null },
  ) =>
    db
      .prepare("INSERT INTO conversations (id, username, source, device_id, started_at) VALUES (?, ?, ?, ?, ?)")
      .bind(row.id, row.username, row.source, row.device_id, Date.now())
      .run(),

  get: (db: D1Database, username: string, id: string) =>
    db.prepare("SELECT * FROM conversations WHERE id = ? AND username = ?").bind(id, username).first<ConversationRow>(),

  /** Newest first; `query` matches the summary and the turns' text (capped: D1 rejects long LIKE patterns). */
  list: async (db: D1Database, username: string, limit: number, rawQuery?: string) => {
    const query = rawQuery?.trim().slice(0, 100);
    const statement = query
      ? db
          .prepare(
            `SELECT DISTINCT c.* FROM conversations c LEFT JOIN conversation_turns t ON t.conversation_id = c.id
             WHERE c.username = ? AND (c.summary LIKE ? OR t.text LIKE ?)
             ORDER BY c.started_at DESC LIMIT ?`,
          )
          .bind(username, `%${query}%`, `%${query}%`, limit)
      : db
          .prepare("SELECT * FROM conversations WHERE username = ? ORDER BY started_at DESC LIMIT ?")
          .bind(username, limit);
    return (await statement.all<ConversationRow>()).results;
  },

  addTurns: (db: D1Database, id: string, turns: NewTurn[]) =>
    db.batch([
      ...turns.map((t) =>
        db
          .prepare("INSERT INTO conversation_turns (conversation_id, at, role, text) VALUES (?, ?, ?, ?)")
          .bind(id, t.at, t.role, t.text),
      ),
      db.prepare("UPDATE conversations SET turn_count = turn_count + ? WHERE id = ?").bind(turns.length, id),
    ]),

  turns: async (db: D1Database, id: string, limit = 500) =>
    (
      await db
        .prepare("SELECT * FROM conversation_turns WHERE conversation_id = ? ORDER BY at, id LIMIT ?")
        .bind(id, limit)
        .all<TurnRow>()
    ).results,

  end: (db: D1Database, id: string, endedAt: number) =>
    db.prepare("UPDATE conversations SET ended_at = COALESCE(ended_at, ?) WHERE id = ?").bind(endedAt, id).run(),

  setSummary: (db: D1Database, id: string, summary: string) =>
    db.prepare("UPDATE conversations SET summary = ? WHERE id = ?").bind(summary, id).run(),

  remove: (db: D1Database, username: string, id: string) =>
    db.prepare("DELETE FROM conversations WHERE id = ? AND username = ?").bind(id, username).run(),
};

export const memories = {
  list: async (db: D1Database, username: string, category?: MemoryCategory) =>
    (
      await db
        .prepare(
          `SELECT * FROM memories WHERE username = ? AND (? IS NULL OR category = ?)
           ORDER BY CASE category WHEN 'important' THEN 0 ELSE 1 END, updated_at DESC`,
        )
        .bind(username, category ?? null, category ?? null)
        .all<MemoryRow>()
    ).results,

  get: (db: D1Database, username: string, id: string) =>
    db.prepare("SELECT * FROM memories WHERE id = ? AND username = ?").bind(id, username).first<MemoryRow>(),

  create: (
    db: D1Database,
    row: { id: string; username: string; category: MemoryCategory; content: string; source: string | null },
  ) =>
    db
      .prepare(
        `INSERT INTO memories (id, username, category, content, source_conversation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(row.id, row.username, row.category, row.content, row.source, Date.now(), Date.now())
      .run(),

  update: (db: D1Database, username: string, id: string, changes: { category?: MemoryCategory; content?: string }) =>
    db
      .prepare(
        `UPDATE memories SET category = COALESCE(?, category), content = COALESCE(?, content), updated_at = ?
         WHERE id = ? AND username = ?`,
      )
      .bind(changes.category ?? null, changes.content ?? null, Date.now(), id, username)
      .run(),

  remove: (db: D1Database, username: string, id: string) =>
    db.prepare("DELETE FROM memories WHERE id = ? AND username = ?").bind(id, username).run(),
};

export interface ContactPage {
  rows: ContactRow[];
  total: number;
}

export interface NewContact {
  name: string;
  phone: string;
  label: string;
  note?: string;
}

/** Fields the assistant stamps when it reaches someone; a fixed set, so the column name is safe to splice. */
export type ContactStamp = "last_called_at" | "last_messaged_at";

export const contacts = {
  /** Favourites first, then by name; `query` matches a name fragment or the digits of a number. */
  list: async (
    db: D1Database,
    username: string,
    options: { query?: string; favourites?: boolean; page: number; pageSize: number },
  ): Promise<ContactPage> => {
    const name = options.query ? `%${searchName(options.query)}%` : null;
    const digits = options.query?.replace(/\D/g, "") ?? "";
    const phone = digits.length >= 3 ? `%${digits}%` : null;
    const where = `username = ?1 AND (?2 IS NULL OR search_name LIKE ?2 OR (?3 IS NOT NULL AND phone LIKE ?3))
      AND (?4 = 0 OR favourite = 1)`;
    const args = [username, name, phone, options.favourites ? 1 : 0];
    const [rows, count] = await Promise.all([
      db
        .prepare(`SELECT * FROM contacts WHERE ${where} ORDER BY favourite DESC, search_name, label LIMIT ?5 OFFSET ?6`)
        .bind(...args, options.pageSize, (options.page - 1) * options.pageSize)
        .all<ContactRow>(),
      db
        .prepare(`SELECT COUNT(*) AS n FROM contacts WHERE ${where}`)
        .bind(...args)
        .first<{ n: number }>(),
    ]);
    return { rows: rows.results, total: count?.n ?? 0 };
  },

  get: (db: D1Database, username: string, id: string) =>
    db.prepare("SELECT * FROM contacts WHERE id = ? AND username = ?").bind(id, username).first<ContactRow>(),

  byPhone: (db: D1Database, username: string, phone: string) =>
    db.prepare("SELECT * FROM contacts WHERE username = ? AND phone = ?").bind(username, phone).first<ContactRow>(),

  phones: async (db: D1Database, username: string) =>
    new Set(
      (
        await db.prepare("SELECT phone FROM contacts WHERE username = ?").bind(username).all<{ phone: string }>()
      ).results.map((r) => r.phone),
    ),

  /** Inserts new numbers and renames known ones; a blank imported label never wipes a kept one. */
  upsert: (db: D1Database, username: string, rows: NewContact[], now: number) =>
    db.batch(
      rows.map((row) =>
        db
          .prepare(
            `INSERT INTO contacts (id, username, name, search_name, phone, label, note, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (username, phone) DO UPDATE SET name = excluded.name, search_name = excluded.search_name,
               label = CASE WHEN excluded.label = '' THEN contacts.label ELSE excluded.label END,
               note = CASE WHEN excluded.note = '' THEN contacts.note ELSE excluded.note END,
               updated_at = excluded.updated_at`,
          )
          .bind(
            crypto.randomUUID(),
            username,
            row.name,
            searchName(row.name),
            row.phone,
            row.label,
            row.note ?? "",
            now,
            now,
          ),
      ),
    ),

  update: (
    db: D1Database,
    username: string,
    id: string,
    changes: { name?: string; phone?: string; label?: string; note?: string; favourite?: boolean },
  ) =>
    db
      .prepare(
        `UPDATE contacts SET name = COALESCE(?, name), search_name = COALESCE(?, search_name),
           phone = COALESCE(?, phone), label = COALESCE(?, label), note = COALESCE(?, note),
           favourite = COALESCE(?, favourite), updated_at = ?
         WHERE id = ? AND username = ?`,
      )
      .bind(
        changes.name ?? null,
        changes.name ? searchName(changes.name) : null,
        changes.phone ?? null,
        changes.label ?? null,
        changes.note ?? null,
        changes.favourite === undefined ? null : changes.favourite ? 1 : 0,
        Date.now(),
        id,
        username,
      )
      .run(),

  remove: (db: D1Database, username: string, id: string) =>
    db.prepare("DELETE FROM contacts WHERE id = ? AND username = ?").bind(id, username).run(),

  stamp: (db: D1Database, username: string, phone: string, field: ContactStamp, at: number) =>
    db.prepare(`UPDATE contacts SET ${field} = ? WHERE username = ? AND phone = ?`).bind(at, username, phone).run(),
};

export const messages = {
  create: (
    db: D1Database,
    row: {
      username: string;
      contact_id: string | null;
      channel: Channel;
      direction: Direction;
      phone: string;
      body: string;
      sid: string | null;
      status: string;
      at: number;
    },
  ) =>
    db
      .prepare(
        `INSERT INTO messages (id, username, contact_id, channel, direction, phone, body, sid, status, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        row.username,
        row.contact_id,
        row.channel,
        row.direction,
        row.phone,
        row.body,
        row.sid,
        row.status,
        row.at,
      )
      .run(),

  /** Newest first, for one contact or across the phone book. */
  list: async (db: D1Database, username: string, contactId: string | null, limit: number) =>
    (
      await db
        .prepare(`SELECT * FROM messages WHERE username = ? AND (? IS NULL OR contact_id = ?) ORDER BY at DESC LIMIT ?`)
        .bind(username, contactId, contactId, limit)
        .all<MessageRow>()
    ).results,
};

const TERMINAL_CALL_STATUSES = "('completed', 'busy', 'failed', 'no-answer', 'canceled')";

export const calls = {
  create: (
    db: D1Database,
    row: {
      username: string;
      contact_id: string | null;
      direction: Direction;
      kind: CallRow["kind"];
      phone: string;
      conference: string | null;
      role?: CallRow["role"];
      brief?: string | null;
      sid: string | null;
      status: string;
      at: number;
      id?: string;
    },
  ) =>
    db
      .prepare(
        `INSERT INTO calls (id, username, contact_id, direction, kind, phone, conference, role, brief, sid, status, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id ?? crypto.randomUUID(),
        row.username,
        row.contact_id,
        row.direction,
        row.kind,
        row.phone,
        row.conference,
        row.role ?? "",
        row.brief ?? null,
        row.sid,
        row.status,
        row.at,
      )
      .run(),

  list: async (db: D1Database, username: string, contactId: string | null, limit: number) =>
    (
      await db
        .prepare(`SELECT * FROM calls WHERE username = ? AND (? IS NULL OR contact_id = ?) ORDER BY at DESC LIMIT ?`)
        .bind(username, contactId, contactId, limit)
        .all<CallRow>()
    ).results,

  bySid: (db: D1Database, sid: string) => db.prepare("SELECT * FROM calls WHERE sid = ?").bind(sid).first<CallRow>(),

  get: (db: D1Database, id: string) => db.prepare("SELECT * FROM calls WHERE id = ?").bind(id).first<CallRow>(),

  setBrief: (db: D1Database, id: string, brief: string) =>
    db.prepare("UPDATE calls SET brief = ? WHERE id = ?").bind(brief, id).run(),

  setLeg: (db: D1Database, id: string, sid: string, status: string) =>
    db.prepare("UPDATE calls SET sid = ?, status = ? WHERE id = ?").bind(sid, status, id).run(),

  setAnsweredBy: (db: D1Database, sid: string, answeredBy: string) =>
    db.prepare("UPDATE calls SET answered_by = ? WHERE sid = ?").bind(answeredBy, sid).run(),

  /** The guest leg most recently dialled that is still up: the one a menu is playing on. */
  liveGuest: (db: D1Database, conference: string) =>
    db
      .prepare(
        `SELECT * FROM calls WHERE conference = ? AND role = 'guest' AND status NOT IN ${TERMINAL_CALL_STATUSES}
         ORDER BY at DESC LIMIT 1`,
      )
      .bind(conference)
      .first<CallRow>(),

  /** Every leg of a conference in dialling order: host, guests, assistant. */
  legs: async (db: D1Database, conference: string) =>
    (await db.prepare("SELECT * FROM calls WHERE conference = ? ORDER BY at").bind(conference).all<CallRow>()).results,

  setLeft: (db: D1Database, sid: string, at: number) =>
    db.prepare("UPDATE calls SET status = 'completed', left_at = ? WHERE sid = ?").bind(at, sid).run(),

  /** The assistant's leg is gone (its socket closed), whatever Twilio has said so far. */
  endAssistant: (db: D1Database, conference: string) =>
    db
      .prepare("UPDATE calls SET status = 'completed' WHERE conference = ? AND role = 'assistant'")
      .bind(conference)
      .run(),

  /** The user's most recent conference, in progress or not. */
  latestConference: async (db: D1Database, username: string) =>
    (
      await db
        .prepare("SELECT conference FROM calls WHERE username = ? AND kind = 'conference' ORDER BY at DESC LIMIT 1")
        .bind(username)
        .first<{ conference: string }>()
    )?.conference ?? null,

  addTurn: (db: D1Database, conference: string, at: number, speaker: CallSpeaker, text: string) =>
    db
      .prepare("INSERT INTO call_turns (conference, at, speaker, text) VALUES (?, ?, ?, ?)")
      .bind(conference, at, speaker, text)
      .run(),

  turns: async (db: D1Database, conference: string, limit: number) =>
    (
      await db
        .prepare("SELECT * FROM call_turns WHERE conference = ? ORDER BY id LIMIT ?")
        .bind(conference, limit)
        .all<CallTurnRow>()
    ).results,

  /** Notes how a call ended, once: the first signal (hang-up, agent, Twilio) wins. */
  recordEnd: async (db: D1Database, row: CallReportRow) =>
    (
      await db
        .prepare("INSERT OR IGNORE INTO call_reports (conference, username, ended_at, ended_by) VALUES (?, ?, ?, ?)")
        .bind(row.conference, row.username, row.ended_at, row.ended_by)
        .run()
    ).meta.changes > 0,

  report: (db: D1Database, conference: string) =>
    db.prepare("SELECT * FROM call_reports WHERE conference = ?").bind(conference).first<CallReportRow>(),

  /** Guests of a conference, in dialling order. */
  guests: async (db: D1Database, conference: string) =>
    (
      await db
        .prepare("SELECT * FROM calls WHERE conference = ? AND role = 'guest' ORDER BY at")
        .bind(conference)
        .all<CallRow>()
    ).results,

  /**
   * Reserves the one assistant seat of a conference before dialling it. Two webhooks racing for it
   * both try; the unique index lets exactly one through.
   */
  claimAssistant: async (db: D1Database, row: { id: string; username: string; conference: string; at: number }) => {
    try {
      await db
        .prepare(
          `INSERT INTO calls (id, username, contact_id, direction, kind, phone, conference, role, sid, status, at)
           VALUES (?, ?, NULL, 'out', 'conference', 'assistant', ?, 'assistant', NULL, 'dialling', ?)`,
        )
        .bind(row.id, row.username, row.conference, row.at)
        .run();
      return true;
    } catch {
      return false;
    }
  },

  setStatus: (db: D1Database, sid: string, status: string) =>
    db.prepare("UPDATE calls SET status = ? WHERE sid = ?").bind(status, sid).run(),

  /** The leg OpenAI's SIP endpoint is dialled on, found from the header Twilio carries into the INVITE. */
  assistantLeg: (db: D1Database, conference: string) =>
    db
      .prepare("SELECT * FROM calls WHERE conference = ? AND role = 'assistant' ORDER BY at DESC LIMIT 1")
      .bind(conference)
      .first<CallRow>(),

  hostLeg: (db: D1Database, username: string, conference: string) =>
    db
      .prepare("SELECT * FROM calls WHERE username = ? AND conference = ? AND role = 'host' ORDER BY at DESC LIMIT 1")
      .bind(username, conference)
      .first<CallRow>(),

  endConference: (db: D1Database, conference: string) =>
    db
      .prepare(`UPDATE calls SET status = 'completed' WHERE conference = ? AND status NOT IN ${TERMINAL_CALL_STATUSES}`)
      .bind(conference)
      .run(),

  /** The conference the user is in right now, if any leg started recently and has not ended. */
  openConference: async (db: D1Database, username: string, since: number) =>
    (
      await db
        .prepare(
          `SELECT conference FROM calls WHERE username = ? AND kind = 'conference' AND at > ?
             AND status NOT IN ${TERMINAL_CALL_STATUSES} ORDER BY at DESC LIMIT 1`,
        )
        .bind(username, since)
        .first<{ conference: string }>()
    )?.conference ?? null,
};

export type { CallRow } from "./types";
