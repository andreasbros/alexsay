import { devices, users } from "./db";
import { notifyDevice } from "./device_channel";
import { cancel, type JobRow, schedule, setJobEnabled } from "./jobs";
import { logFor } from "./log";
import { describeRepeat, nextOccurrence, occurrences, parseRule, type Rule } from "./schedule";
import type { DeviceRow, Scope } from "./types";

export const ALARM_KINDS = ["alarm", "timer", "reminder"] as const;
export type AlarmKind = (typeof ALARM_KINDS)[number];
export const ALARM_EVENTS = ["rang", "stopped", "snoozed", "missed"] as const;
export type AlarmEvent = (typeof ALARM_EVENTS)[number];

export interface AlarmRow {
  id: string;
  username: string;
  device_id: string | null;
  kind: AlarmKind;
  label: string;
  message: string;
  rule: string;
  enabled: number;
  next_at: number | null;
  snoozed_until: number | null;
  job_id: string;
  created_via: string;
  created_at: number;
  updated_at: number;
}

export interface AlarmEventRow {
  id: number;
  alarm_id: string;
  username: string;
  device_id: string | null;
  occurrence: number;
  event: AlarmEvent;
  at: number;
  detail: string;
}

/** The server checks this long after each occurrence that the speaker said what happened. */
export const VERIFY_AFTER_MS = 45_000;
/** How many upcoming occurrences a speaker keeps, so repeats ring while it is offline. */
export const FIRES_AHEAD = 3;
export const DEFAULT_SNOOZE_MINUTES = 9;

export interface NewAlarm {
  kind: AlarmKind;
  rule: Rule;
  label: string;
  message: string;
  deviceId: string | null;
  via: string;
}

/** Stores an alarm with its verify job and tells its speaker. */
export async function createAlarm(scope: Scope, username: string, alarm: NewAlarm, now = Date.now()) {
  const id = crypto.randomUUID();
  const jobId = await schedule(
    scope,
    { username, topic: "alarm.verify", payload: { alarm_id: id }, rule: alarm.rule, delayMs: VERIFY_AFTER_MS },
    now,
  );
  const row: AlarmRow = {
    id,
    username,
    device_id: alarm.deviceId,
    kind: alarm.kind,
    label: alarm.label,
    message: alarm.message,
    rule: JSON.stringify(alarm.rule),
    enabled: 1,
    next_at: nextOccurrence(alarm.rule, now),
    snoozed_until: null,
    job_id: jobId,
    created_via: alarm.via,
    created_at: now,
    updated_at: now,
  };
  await scope.env.DB.prepare(
    `INSERT INTO alarms (id, username, device_id, kind, label, message, rule, enabled, next_at, snoozed_until,
       job_id, created_via, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id,
      row.username,
      row.device_id,
      row.kind,
      row.label,
      row.message,
      row.rule,
      row.enabled,
      row.next_at,
      row.snoozed_until,
      row.job_id,
      row.created_via,
      row.created_at,
      row.updated_at,
    )
    .run();
  await tellSpeaker(scope, row.device_id);
  return row;
}

export interface AlarmChanges {
  enabled?: boolean;
  deviceId?: string | null;
  label?: string;
  message?: string;
  rule?: Rule;
}

export async function updateAlarm(
  scope: Scope,
  username: string,
  id: string,
  changes: AlarmChanges,
  now = Date.now(),
): Promise<AlarmRow | null> {
  const row = await alarms.get(scope.env.DB, username, id);
  if (!row) {
    return null;
  }
  const rule = changes.rule ?? parseRule(row.rule);
  if (!rule) {
    return null;
  }
  const enabled = changes.enabled ?? row.enabled === 1;
  const next = enabled ? nextOccurrence(rule, now) : null;
  const updated: AlarmRow = {
    ...row,
    device_id: changes.deviceId !== undefined ? changes.deviceId : row.device_id,
    label: changes.label ?? row.label,
    message: changes.message ?? row.message,
    rule: JSON.stringify(rule),
    enabled: enabled && (next !== null || !changes.rule) ? 1 : 0,
    next_at: next,
    snoozed_until: changes.rule || changes.enabled === false ? null : row.snoozed_until,
    updated_at: now,
  };
  await scope.env.DB.prepare(
    `UPDATE alarms SET device_id = ?, label = ?, message = ?, rule = ?, enabled = ?, next_at = ?, snoozed_until = ?,
       updated_at = ? WHERE id = ? AND username = ?`,
  )
    .bind(
      updated.device_id,
      updated.label,
      updated.message,
      updated.rule,
      updated.enabled,
      updated.next_at,
      updated.snoozed_until,
      now,
      id,
      username,
    )
    .run();
  if (changes.rule) {
    await schedule(
      scope,
      {
        id: row.job_id,
        username,
        topic: "alarm.verify",
        payload: { alarm_id: id },
        rule,
        delayMs: VERIFY_AFTER_MS,
      },
      now,
    );
  }
  if (changes.enabled !== undefined || changes.rule) {
    await setJobEnabled(scope, username, row.job_id, updated.enabled === 1, now);
  }
  await tellSpeaker(scope, row.device_id);
  if (updated.device_id !== row.device_id) {
    await tellSpeaker(scope, updated.device_id);
  }
  return updated;
}

export async function deleteAlarm(scope: Scope, username: string, id: string): Promise<boolean> {
  const row = await alarms.get(scope.env.DB, username, id);
  if (!row) {
    return false;
  }
  await scope.env.DB.prepare("DELETE FROM alarms WHERE id = ? AND username = ?").bind(id, username).run();
  await cancel(scope, username, row.job_id);
  await tellSpeaker(scope, row.device_id);
  return true;
}

/** A speaker refetches its alarms when told; an offline one does so when it reconnects. */
async function tellSpeaker(scope: Scope, deviceId: string | null): Promise<void> {
  if (deviceId) {
    await notifyDevice(scope, deviceId, { type: "alarms.changed" });
  }
}

/** What a speaker rings: the next few occurrences of each of its alarms, and what to say. */
export async function alarmsForDevice(scope: Scope, device: DeviceRow, now = Date.now()) {
  if (!device.owner) {
    return [];
  }
  const rows = (
    await scope.env.DB.prepare("SELECT * FROM alarms WHERE device_id = ? AND username = ? AND enabled = 1")
      .bind(device.id, device.owner)
      .all<AlarmRow>()
  ).results;
  return rows.flatMap((row) => {
    const rule = parseRule(row.rule);
    if (!rule) {
      return [];
    }
    const snoozed = row.snoozed_until && row.snoozed_until > now ? [row.snoozed_until] : [];
    const fires = [...snoozed, ...occurrences(rule, now, FIRES_AHEAD)];
    if (fires.length === 0) {
      return [];
    }
    return [{ id: row.id, kind: row.kind, label: row.label, say: spokenText(row), fires }];
  });
}

/** What the speaker says between rings. */
export function spokenText(row: Pick<AlarmRow, "kind" | "label" | "message">): string {
  if (row.kind === "reminder") {
    return row.message ? `Reminder: ${row.message}` : row.label ? `Reminder: ${row.label}` : "Reminder";
  }
  if (row.kind === "timer") {
    return row.label ? `${row.label}.` : "Your timer is done.";
  }
  return row.label ? `${row.label}.` : "";
}

export interface ReportedEvent {
  alarm_id: string;
  occurrence: number;
  event: AlarmEvent;
  at: number;
  until?: number;
}

/** What the speaker says happened; repeats of the same event are ignored. */
export async function recordEvents(scope: Scope, device: DeviceRow, events: ReportedEvent[]): Promise<number> {
  if (!device.owner) {
    return 0;
  }
  let recorded = 0;
  for (const event of events) {
    const row = await alarms.get(scope.env.DB, device.owner, event.alarm_id);
    if (!row) {
      continue;
    }
    const result = await scope.env.DB.prepare(
      `INSERT OR IGNORE INTO alarm_events (alarm_id, username, device_id, occurrence, event, at, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(row.id, row.username, device.id, event.occurrence, event.event, event.at, "")
      .run();
    recorded += result.meta.changes;
    if (event.event === "snoozed" && event.until) {
      await scope.env.DB.prepare("UPDATE alarms SET snoozed_until = ?, updated_at = ? WHERE id = ?")
        .bind(event.until, event.at, row.id)
        .run();
    } else if (event.event === "stopped" || event.event === "missed") {
      await finishOccurrence(scope, row, event.at);
    }
  }
  return recorded;
}

/** An occurrence is over: a snooze is spent, a one-off is done, a repeat moves on. */
async function finishOccurrence(scope: Scope, row: AlarmRow, now: number): Promise<void> {
  const rule = parseRule(row.rule);
  const next = rule ? nextOccurrence(rule, now) : null;
  await scope.env.DB.prepare(
    "UPDATE alarms SET snoozed_until = NULL, next_at = ?, enabled = ?, updated_at = ? WHERE id = ?",
  )
    .bind(next, next === null ? 0 : row.enabled, now, row.id)
    .run();
}

/**
 * The scheduler's `alarm.verify`, 45 s after each occurrence: if the speaker reported nothing for it,
 * the speaker was off or offline and the alarm counts as missed. Idempotent through the unique index.
 */
export async function verifyAlarm(scope: Scope, job: JobRow, occurrence: number): Promise<void> {
  const { alarm_id } = JSON.parse(job.payload) as { alarm_id: string };
  const row = await alarms.get(scope.env.DB, job.username, alarm_id);
  if (!row) {
    return;
  }
  const heard = await scope.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM alarm_events WHERE alarm_id = ? AND occurrence = ?",
  )
    .bind(row.id, occurrence)
    .first<{ n: number }>();
  if ((heard?.n ?? 0) === 0) {
    await scope.env.DB.prepare(
      `INSERT OR IGNORE INTO alarm_events (alarm_id, username, device_id, occurrence, event, at, detail)
       VALUES (?, ?, ?, ?, 'missed', ?, ?)`,
    )
      .bind(row.id, row.username, row.device_id, occurrence, Date.now(), "no word from the speaker")
      .run();
    await logFor(scope, row.username, "warn", `alarm ${row.label || row.kind}: the speaker never reported ringing`);
  }
  const snoozedAhead = row.snoozed_until !== null && row.snoozed_until > occurrence;
  if (!snoozedAhead) {
    await finishOccurrence(scope, row, occurrence);
  }
}

/** Stops (or snoozes) what is ringing: one alarm's speaker, or every speaker of the user. */
export async function signalRinging(
  scope: Scope,
  username: string,
  id: string | null,
  snoozeMinutes: number | null,
): Promise<{ speakers: string[]; online: number }> {
  const owned = await devices.list(scope.env.DB, username);
  const row = id ? await alarms.get(scope.env.DB, username, id) : null;
  const targets = row?.device_id ? owned.filter((d) => d.id === row.device_id) : owned;
  let online = 0;
  for (const device of targets) {
    const message =
      snoozeMinutes === null
        ? ({ type: "alarm.stop", ...(row ? { id: row.id } : {}) } as const)
        : ({ type: "alarm.snooze", minutes: snoozeMinutes, ...(row ? { id: row.id } : {}) } as const);
    if (await notifyDevice(scope, device.id, message)) {
      online++;
    }
  }
  return { speakers: targets.map((d) => d.name), online };
}

/** How an alarm reads for the model and the app, in the user's own zone and language. */
export async function presenter(scope: Scope, username: string) {
  const [where, owned] = await Promise.all([
    users.locale(scope.env.DB, username),
    devices.list(scope.env.DB, username),
  ]);
  const names = new Map(owned.map((d) => [d.id, d.name]));
  const format = new Intl.DateTimeFormat(where.locale, {
    timeZone: where.timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const when = (ms: number | null) => (ms === null ? null : format.format(new Date(ms)));
  return {
    where,
    when,
    alarm: (row: AlarmRow) => {
      const rule = parseRule(row.rule);
      const next = row.snoozed_until && row.snoozed_until > Date.now() ? row.snoozed_until : row.next_at;
      return {
        id: row.id,
        kind: row.kind,
        label: row.label,
        message: row.message,
        enabled: row.enabled === 1,
        next_at: next,
        when: when(next),
        repeat: rule ? describeRepeat(rule) : null,
        snoozed: row.snoozed_until !== null && row.snoozed_until > Date.now(),
        device_id: row.device_id,
        speaker: row.device_id ? (names.get(row.device_id) ?? "a removed speaker") : null,
      };
    },
    event: (row: AlarmEventRow & { kind: string | null; label: string | null }) => ({
      alarm_id: row.alarm_id,
      kind: row.kind,
      label: row.label ?? "",
      event: row.event,
      at: row.at,
      when: when(row.at),
      speaker: row.device_id ? (names.get(row.device_id) ?? "a removed speaker") : null,
      detail: row.detail,
    }),
  };
}

export const alarms = {
  get: (db: D1Database, username: string, id: string) =>
    db.prepare("SELECT * FROM alarms WHERE id = ? AND username = ?").bind(id, username).first<AlarmRow>(),

  /** Everything still to come or switched off; spent one-offs are only history. */
  list: async (db: D1Database, username: string) =>
    (
      await db
        .prepare(
          `SELECT * FROM alarms WHERE username = ? AND (next_at IS NOT NULL OR snoozed_until IS NOT NULL OR rule LIKE '%"repeat"%')
           ORDER BY next_at IS NULL, next_at`,
        )
        .bind(username)
        .all<AlarmRow>()
    ).results,

  recent: async (db: D1Database, username: string, limit = 5) =>
    (
      await db
        .prepare(
          `SELECT e.*, a.kind, a.label FROM alarm_events e LEFT JOIN alarms a ON a.id = e.alarm_id
           WHERE e.username = ? AND e.event != 'rang' ORDER BY e.at DESC LIMIT ?`,
        )
        .bind(username, limit)
        .all<AlarmEventRow & { kind: string | null; label: string | null }>()
    ).results,
};

/** Which speaker an alarm rings on, when the user did not say. */
export async function defaultSpeaker(
  scope: Scope,
  username: string,
  from: string | undefined,
  named: string,
): Promise<{ device: DeviceRow } | { error: string; speakers?: string[] }> {
  const owned = await devices.list(scope.env.DB, username);
  if (owned.length === 0) {
    return { error: "the user has no speaker to ring on: add one under Devices first" };
  }
  if (named) {
    const wanted = named.toLowerCase();
    const match =
      owned.find((d) => d.name.toLowerCase() === wanted) ?? owned.find((d) => d.name.toLowerCase().includes(wanted));
    return match ? { device: match } : { error: `no speaker called ${named}`, speakers: owned.map((d) => d.name) };
  }
  const here = from ? owned.find((d) => d.id === from) : undefined;
  if (here) {
    return { device: here };
  }
  if (owned.length === 1 && owned[0]) {
    return { device: owned[0] };
  }
  return {
    error: "the user has several speakers: ask which one should ring, then call again with speaker",
    speakers: owned.map((d) => d.name),
  };
}
