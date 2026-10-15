import { DEFAULT_LOCALE, type Locale } from "./locale";
import { purgeLog } from "./log";
import { searchName } from "./phone";
import type {
  BridgeRow,
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
  HomeRole,
  HomeRow,
  MemoryCategory,
  MemoryRow,
  MessageRow,
  NotificationRow,
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

const SESSION_USER = `SELECT u.username, u.role, u.email, COALESCE(u.home_id, u.username) AS home,
  CASE WHEN u.home_id IS NULL OR u.home_id = u.username THEN 'admin' ELSE u.home_role END AS homeRole
  FROM users u`;

export const users = {
  get: (db: D1Database, username: string) =>
    db.prepare("SELECT * FROM users WHERE username = ?").bind(username).first<UserRow>(),

  /** The signed-in shape of an account: its home and role there. */
  session: (db: D1Database, username: string) =>
    db.prepare(`${SESSION_USER} WHERE u.username = ?`).bind(username).first<User>(),

  byEmail: (db: D1Database, email: string) => db.prepare(`${SESSION_USER} WHERE u.email = ?`).bind(email).first<User>(),

  list: async (db: D1Database) =>
    (
      await db
        .prepare(
          `SELECT u.username, u.role, u.email, u.created_at, COALESCE(u.home_id, u.username) AS home,
             (SELECT COUNT(*) FROM devices d WHERE d.home_id = COALESCE(u.home_id, u.username)) AS devices
           FROM users u ORDER BY u.username`,
        )
        .all<Pick<User, "username" | "role" | "email" | "home"> & { created_at: number; devices: number }>()
    ).results,

  /** A new account and its own home, called "Home". */
  create: (db: D1Database, user: { username: string; password_hash: string; role: Role; email?: string | null }) => {
    const now = Date.now();
    return db.batch([
      db
        .prepare("INSERT INTO users (username, password_hash, role, email, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(user.username, user.password_hash, user.role, user.email ?? null, now),
      db.prepare("INSERT INTO homes (id, created_at) VALUES (?, ?)").bind(user.username, now),
    ]);
  },

  setRole: (db: D1Database, username: string, role: Role) =>
    db.prepare("UPDATE users SET role = ? WHERE username = ?").bind(role, username).run(),

  setPassword: (db: D1Database, username: string, passwordHash: string) =>
    db.prepare("UPDATE users SET password_hash = ? WHERE username = ?").bind(passwordHash, username).run(),

  setEmail: (db: D1Database, username: string, email: string | null) =>
    db.prepare("UPDATE users SET email = ? WHERE username = ?").bind(email, username).run(),

  /** Moves a person into a home; their own home (NULL) makes them its admin again. */
  setHome: (db: D1Database, username: string, home: string | null, role: HomeRole) =>
    db
      .prepare("UPDATE users SET home_id = ?, home_role = ? WHERE username = ?")
      .bind(home === username ? null : home, role, username)
      .run(),

  remove: (db: D1Database, username: string) => db.prepare("DELETE FROM users WHERE username = ?").bind(username).run(),

  countAdmins: async (db: D1Database) =>
    (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").first<{ n: number }>())?.n ?? 0,

  /** Whether a username is free, for accounts made from an email address. */
  exists: async (db: D1Database, username: string) =>
    (await db.prepare("SELECT 1 AS x FROM users WHERE username = ?").bind(username).first()) !== null,
};

export interface HomeMember {
  username: string;
  email: string | null;
  role: HomeRole;
  creator: boolean;
}

export const homes = {
  get: (db: D1Database, id: string) => db.prepare("SELECT * FROM homes WHERE id = ?").bind(id).first<HomeRow>(),

  rename: (db: D1Database, id: string, name: string) =>
    db.prepare("UPDATE homes SET name = ? WHERE id = ?").bind(name, id).run(),

  /** The creator first, then everyone who joined. */
  members: async (db: D1Database, id: string) =>
    (
      await db
        .prepare(
          `SELECT username, email, CASE WHEN username = ?1 THEN 'admin' ELSE home_role END AS role,
             username = ?1 AS creator
           FROM users WHERE COALESCE(home_id, username) = ?1 ORDER BY username != ?1, username`,
        )
        .bind(id)
        .all<Omit<HomeMember, "creator"> & { creator: number }>()
    ).results.map((m) => ({ ...m, creator: m.creator === 1 })),

  locale: async (db: D1Database, id: string): Promise<Locale> =>
    (await db.prepare("SELECT locale, timezone FROM homes WHERE id = ?").bind(id).first<Locale>()) ?? DEFAULT_LOCALE,

  setLocale: (db: D1Database, id: string, changes: Partial<Locale>) =>
    db
      .prepare("UPDATE homes SET locale = COALESCE(?, locale), timezone = COALESCE(?, timezone) WHERE id = ?")
      .bind(changes.locale ?? null, changes.timezone ?? null, id)
      .run(),

  /** Whether the home lets the assistant place scripted test calls. */
  callTest: async (db: D1Database, id: string) =>
    (await db.prepare("SELECT ai_call_test FROM homes WHERE id = ?").bind(id).first<{ ai_call_test: number }>())
      ?.ai_call_test === 1,

  setCallTest: (db: D1Database, id: string, allowed: boolean) =>
    db
      .prepare("UPDATE homes SET ai_call_test = ? WHERE id = ?")
      .bind(allowed ? 1 : 0, id)
      .run(),

  /** Whether the home lets the assistant read its server log. */
  logAccess: async (db: D1Database, id: string) =>
    (await db.prepare("SELECT ai_log_access FROM homes WHERE id = ?").bind(id).first<{ ai_log_access: number }>())
      ?.ai_log_access === 1,

  setLogAccess: (db: D1Database, id: string, allowed: boolean) =>
    db
      .prepare("UPDATE homes SET ai_log_access = ? WHERE id = ?")
      .bind(allowed ? 1 : 0, id)
      .run(),
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
        `${SESSION_USER} JOIN sessions s ON u.username = s.username WHERE s.token_sha256 = ? AND s.expires_at > ?`,
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

  /** Every device for admins (home null), otherwise the home's. */
  list: async (db: D1Database, home: string | null) => {
    const query = home
      ? db.prepare("SELECT * FROM devices WHERE home_id = ? ORDER BY created_at").bind(home)
      : db.prepare("SELECT * FROM devices ORDER BY home_id IS NULL, created_at");
    return (await query.all<DeviceRow>()).results;
  },

  /** Adds the device to the home, creating the row if the speaker has never called home. */
  claim: (db: D1Database, id: string, name: string, home: string, now: number) =>
    db
      .prepare(
        `INSERT INTO devices (id, name, home_id, created_at, claimed_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET home_id = excluded.home_id, claimed_at = excluded.claimed_at,
           name = CASE WHEN excluded.name = '' THEN devices.name ELSE excluded.name END
         WHERE devices.home_id IS NULL`,
      )
      .bind(id, name, home, now, now)
      .run(),

  update: (db: D1Database, id: string, changes: { name?: string; home_id?: string | null }) =>
    db
      .prepare(
        `UPDATE devices SET
           name = COALESCE(?, name),
           home_id = CASE WHEN ? THEN ? ELSE home_id END,
           claimed_at = CASE WHEN ? THEN ? ELSE claimed_at END
         WHERE id = ?`,
      )
      .bind(
        changes.name ?? null,
        changes.home_id !== undefined ? 1 : 0,
        changes.home_id ?? null,
        changes.home_id !== undefined ? 1 : 0,
        changes.home_id ? Date.now() : null,
        id,
      )
      .run(),

  release: (db: D1Database, id: string, home: string) =>
    db
      .prepare("UPDATE devices SET home_id = NULL, claimed_at = NULL WHERE id = ? AND home_id = ?")
      .bind(id, home)
      .run(),

  remove: (db: D1Database, id: string) => db.prepare("DELETE FROM devices WHERE id = ?").bind(id).run(),

  /** A speaker calling home: known rows get a last-seen stamp, unknown ones a capped unclaimed row. */
  touch: (db: D1Database, id: string, now: number, firmware: string | null, meta: string) =>
    db.batch([
      db
        .prepare(
          `INSERT INTO devices (id, created_at, last_seen_at, firmware, last_meta)
           SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM devices WHERE home_id IS NULL) < ?
           ON CONFLICT (id) DO NOTHING`,
        )
        .bind(id, now, now, firmware, meta, MAX_UNCLAIMED_DEVICES),
      db
        .prepare("UPDATE devices SET last_seen_at = ?, firmware = COALESCE(?, firmware), last_meta = ? WHERE id = ?")
        .bind(now, firmware, meta, id),
    ]),
};

export const connections = {
  get: (db: D1Database, home: string, provider: Provider) =>
    db
      .prepare("SELECT * FROM connections WHERE home_id = ? AND provider = ?")
      .bind(home, provider)
      .first<ConnectionRow>(),

  list: async (db: D1Database, home: string) =>
    (
      await db
        .prepare(
          "SELECT provider, settings, created_at, updated_at FROM connections WHERE home_id = ? ORDER BY provider",
        )
        .bind(home)
        .all<Pick<ConnectionRow, "provider" | "settings" | "created_at" | "updated_at">>()
    ).results,

  put: (db: D1Database, home: string, provider: Provider, secret: string, settings: string) =>
    db
      .prepare(
        `INSERT INTO connections (home_id, provider, secret, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (home_id, provider) DO UPDATE SET secret = excluded.secret, settings = excluded.settings,
           updated_at = excluded.updated_at`,
      )
      .bind(home, provider, secret, settings, Date.now(), Date.now())
      .run(),

  /** Rotating credentials (Lightwave's refresh token) are re-sealed after every use. */
  setSecret: (db: D1Database, home: string, provider: Provider, secret: string) =>
    db
      .prepare("UPDATE connections SET secret = ? WHERE home_id = ? AND provider = ?")
      .bind(secret, home, provider)
      .run(),

  remove: (db: D1Database, home: string, provider: Provider) =>
    db.prepare("DELETE FROM connections WHERE home_id = ? AND provider = ?").bind(home, provider).run(),

  /** Whose Twilio number (or WhatsApp sender) an incoming call or message was addressed to. */
  /** Every user whose Twilio number or WhatsApp sender this is: the sandbox sender is shared by all. */
  twilioByNumber: async (db: D1Database, number: string) =>
    (
      await db
        .prepare(
          `SELECT * FROM connections WHERE provider = 'twilio' AND (
             json_extract(settings, '$.from_number') = ?1 OR
             json_extract(settings, '$.whatsapp_from') IN (?1, 'whatsapp:' || ?1))
           ORDER BY home_id`,
        )
        .bind(number)
        .all<ConnectionRow>()
    ).results,
};

/** Nightly: drops expired sessions and sign-in codes, and old login failures. */
export async function purgeExpired(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM login_failures WHERE at <= ?").bind(now - DAY_MS),
    db.prepare("DELETE FROM bridges WHERE created_at <= ?").bind(now - DAY_MS),
    db.prepare("DELETE FROM email_codes WHERE expires_at <= ?").bind(now),
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
    row: { id: string; home_id: string; source: ConversationSource; device_id: string | null },
  ) =>
    db
      .prepare("INSERT INTO conversations (id, home_id, source, device_id, started_at) VALUES (?, ?, ?, ?, ?)")
      .bind(row.id, row.home_id, row.source, row.device_id, Date.now())
      .run(),

  get: (db: D1Database, home: string, id: string) =>
    db.prepare("SELECT * FROM conversations WHERE id = ? AND home_id = ?").bind(id, home).first<ConversationRow>(),

  /** Newest first; `query` matches the summary and the turns' text (capped: D1 rejects long LIKE patterns). */
  list: async (db: D1Database, home: string, limit: number, rawQuery?: string) => {
    const query = rawQuery?.trim().slice(0, 100);
    const statement = query
      ? db
          .prepare(
            `SELECT DISTINCT c.* FROM conversations c LEFT JOIN conversation_turns t ON t.conversation_id = c.id
             WHERE c.home_id = ? AND (c.summary LIKE ? OR t.text LIKE ?)
             ORDER BY c.started_at DESC LIMIT ?`,
          )
          .bind(home, `%${query}%`, `%${query}%`, limit)
      : db.prepare("SELECT * FROM conversations WHERE home_id = ? ORDER BY started_at DESC LIMIT ?").bind(home, limit);
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

  remove: (db: D1Database, home: string, id: string) =>
    db.prepare("DELETE FROM conversations WHERE id = ? AND home_id = ?").bind(id, home).run(),
};

export const memories = {
  list: async (db: D1Database, home: string, category?: MemoryCategory) =>
    (
      await db
        .prepare(
          `SELECT * FROM memories WHERE home_id = ? AND (? IS NULL OR category = ?)
           ORDER BY CASE category WHEN 'important' THEN 0 ELSE 1 END, updated_at DESC`,
        )
        .bind(home, category ?? null, category ?? null)
        .all<MemoryRow>()
    ).results,

  get: (db: D1Database, home: string, id: string) =>
    db.prepare("SELECT * FROM memories WHERE id = ? AND home_id = ?").bind(id, home).first<MemoryRow>(),

  create: (
    db: D1Database,
    row: { id: string; home_id: string; category: MemoryCategory; content: string; source: string | null },
  ) =>
    db
      .prepare(
        `INSERT INTO memories (id, home_id, category, content, source_conversation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(row.id, row.home_id, row.category, row.content, row.source, Date.now(), Date.now())
      .run(),

  count: async (db: D1Database, home: string) =>
    (await db.prepare("SELECT COUNT(*) AS n FROM memories WHERE home_id = ?").bind(home).first<{ n: number }>())?.n ??
    0,

  update: (db: D1Database, home: string, id: string, changes: { category?: MemoryCategory; content?: string }) =>
    db
      .prepare(
        `UPDATE memories SET category = COALESCE(?, category), content = COALESCE(?, content), updated_at = ?
         WHERE id = ? AND home_id = ?`,
      )
      .bind(changes.category ?? null, changes.content ?? null, Date.now(), id, home)
      .run(),

  remove: (db: D1Database, home: string, id: string) =>
    db.prepare("DELETE FROM memories WHERE id = ? AND home_id = ?").bind(id, home).run(),
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
    home: string,
    options: { query?: string; favourites?: boolean; page: number; pageSize: number },
  ): Promise<ContactPage> => {
    const name = options.query ? `%${searchName(options.query)}%` : null;
    const digits = options.query?.replace(/\D/g, "") ?? "";
    const phone = digits.length >= 3 ? `%${digits}%` : null;
    const where = `home_id = ?1 AND (?2 IS NULL OR search_name LIKE ?2 OR (?3 IS NOT NULL AND phone LIKE ?3))
      AND (?4 = 0 OR favourite = 1)`;
    const args = [home, name, phone, options.favourites ? 1 : 0];
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

  get: (db: D1Database, home: string, id: string) =>
    db.prepare("SELECT * FROM contacts WHERE id = ? AND home_id = ?").bind(id, home).first<ContactRow>(),

  byPhone: (db: D1Database, home: string, phone: string) =>
    db.prepare("SELECT * FROM contacts WHERE home_id = ? AND phone = ?").bind(home, phone).first<ContactRow>(),

  phones: async (db: D1Database, home: string) =>
    new Set(
      (
        await db.prepare("SELECT phone FROM contacts WHERE home_id = ?").bind(home).all<{ phone: string }>()
      ).results.map((r) => r.phone),
    ),

  /** Inserts new numbers and renames known ones; a blank imported label never wipes a kept one. */
  upsert: (db: D1Database, home: string, rows: NewContact[], now: number) =>
    db.batch(
      rows.map((row) =>
        db
          .prepare(
            `INSERT INTO contacts (id, home_id, name, search_name, phone, label, note, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (home_id, phone) DO UPDATE SET name = excluded.name, search_name = excluded.search_name,
               label = CASE WHEN excluded.label = '' THEN contacts.label ELSE excluded.label END,
               note = CASE WHEN excluded.note = '' THEN contacts.note ELSE excluded.note END,
               updated_at = excluded.updated_at`,
          )
          .bind(
            crypto.randomUUID(),
            home,
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
    home: string,
    id: string,
    changes: { name?: string; phone?: string; label?: string; note?: string; favourite?: boolean },
  ) =>
    db
      .prepare(
        `UPDATE contacts SET name = COALESCE(?, name), search_name = COALESCE(?, search_name),
           phone = COALESCE(?, phone), label = COALESCE(?, label), note = COALESCE(?, note),
           favourite = COALESCE(?, favourite), updated_at = ?
         WHERE id = ? AND home_id = ?`,
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
        home,
      )
      .run(),

  remove: (db: D1Database, home: string, id: string) =>
    db.prepare("DELETE FROM contacts WHERE id = ? AND home_id = ?").bind(id, home).run(),

  stamp: (db: D1Database, home: string, phone: string, field: ContactStamp, at: number) =>
    db.prepare(`UPDATE contacts SET ${field} = ? WHERE home_id = ? AND phone = ?`).bind(at, home, phone).run(),
};

export const messages = {
  create: (
    db: D1Database,
    row: {
      home_id: string;
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
        `INSERT INTO messages (id, home_id, contact_id, channel, direction, phone, body, sid, status, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        row.home_id,
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
  list: async (db: D1Database, home: string, contactId: string | null, limit: number) =>
    (
      await db
        .prepare(`SELECT * FROM messages WHERE home_id = ? AND (? IS NULL OR contact_id = ?) ORDER BY at DESC LIMIT ?`)
        .bind(home, contactId, contactId, limit)
        .all<MessageRow>()
    ).results,
};

const TERMINAL_CALL_STATUSES = "('completed', 'busy', 'failed', 'no-answer', 'canceled')";

export const calls = {
  create: (
    db: D1Database,
    row: {
      home_id: string;
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
        `INSERT INTO calls (id, home_id, contact_id, direction, kind, phone, conference, role, brief, sid, status, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id ?? crypto.randomUUID(),
        row.home_id,
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

  list: async (db: D1Database, home: string, contactId: string | null, limit: number) =>
    (
      await db
        .prepare(`SELECT * FROM calls WHERE home_id = ? AND (? IS NULL OR contact_id = ?) ORDER BY at DESC LIMIT ?`)
        .bind(home, contactId, contactId, limit)
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
  latestConference: async (db: D1Database, home: string) =>
    (
      await db
        .prepare("SELECT conference FROM calls WHERE home_id = ? AND kind = 'conference' ORDER BY at DESC LIMIT 1")
        .bind(home)
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
        .prepare("INSERT OR IGNORE INTO call_reports (conference, home_id, ended_at, ended_by) VALUES (?, ?, ?, ?)")
        .bind(row.conference, row.home_id, row.ended_at, row.ended_by)
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
  /** The assistant's seat, with its briefing already in place for OpenAI's webhook, which may come first. */
  claimAssistant: async (
    db: D1Database,
    row: { id: string; home_id: string; conference: string; brief: string; at: number },
  ) => {
    try {
      await db
        .prepare(
          `INSERT INTO calls (id, home_id, contact_id, direction, kind, phone, conference, role, brief, sid, status, at)
           VALUES (?, ?, NULL, 'out', 'conference', 'assistant', ?, 'assistant', ?, NULL, 'dialling', ?)`,
        )
        .bind(row.id, row.home_id, row.conference, row.brief, row.at)
        .run();
      return true;
    } catch {
      return false;
    }
  },

  /** Moves a leg to a new status; never out of a final one (late callbacks arrive). True when it changed. */
  setStatus: async (db: D1Database, sid: string, status: string) =>
    (
      await db
        .prepare(
          `UPDATE calls SET status = ? WHERE sid = ? AND status != ? AND status NOT IN ${TERMINAL_CALL_STATUSES}`,
        )
        .bind(status, sid, status)
        .run()
    ).meta.changes > 0,

  /** Marks a host's guests as dialled, once: of the triggers racing to dial them, only the first gets true. */
  claimDialling: async (db: D1Database, id: string) =>
    (
      await db
        .prepare(
          `UPDATE calls SET brief = json_set(brief, '$.dialled', json('true'))
             WHERE id = ? AND coalesce(json_extract(brief, '$.dialled'), 0) = 0`,
        )
        .bind(id)
        .run()
    ).meta.changes > 0,

  removeLeg: (db: D1Database, id: string) => db.prepare("DELETE FROM calls WHERE id = ?").bind(id).run(),

  /** The leg OpenAI's SIP endpoint is dialled on, found from the header Twilio carries into the INVITE. */
  assistantLeg: (db: D1Database, conference: string) =>
    db
      .prepare("SELECT * FROM calls WHERE conference = ? AND role = 'assistant' ORDER BY at DESC LIMIT 1")
      .bind(conference)
      .first<CallRow>(),

  hostLeg: (db: D1Database, home: string, conference: string) =>
    db
      .prepare("SELECT * FROM calls WHERE home_id = ? AND conference = ? AND role = 'host' ORDER BY at DESC LIMIT 1")
      .bind(home, conference)
      .first<CallRow>(),

  endConference: (db: D1Database, conference: string) =>
    db
      .prepare(`UPDATE calls SET status = 'completed' WHERE conference = ? AND status NOT IN ${TERMINAL_CALL_STATUSES}`)
      .bind(conference)
      .run(),

  /** The conference the user is in right now, if any leg started recently and has not ended. */
  openConference: async (db: D1Database, home: string, since: number) =>
    (
      await db
        .prepare(
          `SELECT conference FROM calls WHERE home_id = ? AND kind = 'conference' AND at > ?
             AND status NOT IN ${TERMINAL_CALL_STATUSES} ORDER BY at DESC LIMIT 1`,
        )
        .bind(home, since)
        .first<{ conference: string }>()
    )?.conference ?? null,
};

/** Pending speaker bridges: one row per call opened on a speaker, consumed when Twilio calls back. */
export const bridges = {
  create: (
    db: D1Database,
    row: { token: string; home_id: string; device_id: string; conference: string; at: number },
  ) =>
    db
      .prepare("INSERT INTO bridges (token, home_id, device_id, conference, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(row.token, row.home_id, row.device_id, row.conference, row.at)
      .run(),

  get: (db: D1Database, token: string) =>
    db.prepare("SELECT * FROM bridges WHERE token = ?").bind(token).first<BridgeRow>(),

  /** The newest bridge of a user that Twilio has not called back for yet. */
  pending: (db: D1Database, home: string, since: number) =>
    db
      .prepare(
        "SELECT * FROM bridges WHERE home_id = ? AND used_at IS NULL AND created_at > ? ORDER BY created_at DESC LIMIT 1",
      )
      .bind(home, since)
      .first<BridgeRow>(),

  use: (db: D1Database, token: string, at: number) =>
    db.prepare("UPDATE bridges SET used_at = ? WHERE token = ?").bind(at, token).run(),

  remove: (db: D1Database, token: string) => db.prepare("DELETE FROM bridges WHERE token = ?").bind(token).run(),

  purge: (db: D1Database, before: number) => db.prepare("DELETE FROM bridges WHERE created_at < ?").bind(before).run(),
};

export type { CallRow } from "./types";

/** What the home was told about, shown under Messages and read out on the speakers. */
export const notifications = {
  create: (
    db: D1Database,
    row: {
      id: string;
      home_id: string;
      kind: NotificationRow["kind"];
      contact_id: string | null;
      phone: string;
      title: string;
      body: string;
      ref: string | null;
      at: number;
    },
  ) =>
    db
      .prepare(
        `INSERT INTO notifications (id, home_id, kind, contact_id, phone, title, body, ref, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(row.id, row.home_id, row.kind, row.contact_id, row.phone, row.title, row.body, row.ref, row.at)
      .run(),

  list: async (db: D1Database, home: string, limit: number, unreadOnly: boolean) =>
    (
      await db
        .prepare(
          `SELECT * FROM notifications WHERE home_id = ? AND (? = 0 OR read_at IS NULL) ORDER BY at DESC LIMIT ?`,
        )
        .bind(home, unreadOnly ? 1 : 0, limit)
        .all<NotificationRow>()
    ).results,

  unread: async (db: D1Database, home: string) =>
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM notifications WHERE home_id = ? AND read_at IS NULL")
        .bind(home)
        .first<{ n: number }>()
    )?.n ?? 0,

  /** Marks the given ones (or every unread one) read; how many changed. */
  markRead: async (db: D1Database, home: string, ids: string[] | null, at: number) => {
    if (ids === null) {
      return (
        await db
          .prepare("UPDATE notifications SET read_at = ? WHERE home_id = ? AND read_at IS NULL")
          .bind(at, home)
          .run()
      ).meta.changes;
    }
    let changed = 0;
    for (const id of ids) {
      changed += (
        await db
          .prepare("UPDATE notifications SET read_at = ? WHERE home_id = ? AND id = ? AND read_at IS NULL")
          .bind(at, home, id)
          .run()
      ).meta.changes;
    }
    return changed;
  },
};
