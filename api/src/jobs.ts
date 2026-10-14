import { nextOccurrence, parseRule, type Rule } from "./schedule";
import type { Scope } from "./types";

/** A scheduled job: the scheduler runs its topic's handler delay_ms after each occurrence of its rule. */
export interface JobRow {
  id: string;
  home_id: string;
  topic: string;
  payload: string;
  rule: string;
  delay_ms: number;
  next_at: number | null;
  enabled: number;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
}

export interface NewJob {
  id?: string;
  home: string;
  topic: string;
  payload: Record<string, unknown>;
  rule: Rule;
  delayMs?: number;
}

/** When a job's handler next runs: its next occurrence after `after`, plus its delay. */
export function runAt(rule: Rule, delayMs: number, after: number): number | null {
  const next = nextOccurrence(rule, after);
  return next === null ? null : next + delayMs;
}

/** Stores or replaces a job and wakes the user's scheduler; returns the job's id. */
export async function schedule(scope: Scope, job: NewJob, now = Date.now()): Promise<string> {
  const id = job.id ?? crypto.randomUUID();
  const delay = job.delayMs ?? 0;
  const next = runAt(job.rule, delay, now);
  await scope.env.DB.prepare(
    `INSERT INTO jobs (id, home_id, topic, payload, rule, delay_ms, next_at, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET topic = excluded.topic, payload = excluded.payload, rule = excluded.rule,
       delay_ms = excluded.delay_ms, next_at = excluded.next_at, enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
  )
    .bind(
      id,
      job.home,
      job.topic,
      JSON.stringify(job.payload),
      JSON.stringify(job.rule),
      delay,
      next,
      next === null ? 0 : 1,
      now,
      now,
    )
    .run();
  await wakeScheduler(scope, job.home);
  return id;
}

/** Pauses or resumes a job; resuming recomputes its next run from now. */
export async function setJobEnabled(
  scope: Scope,
  home: string,
  id: string,
  enabled: boolean,
  now = Date.now(),
): Promise<void> {
  const row = await jobs.get(scope.env.DB, home, id);
  const rule = row ? parseRule(row.rule) : null;
  if (!row || !rule) {
    return;
  }
  const next = enabled ? runAt(rule, row.delay_ms, now) : null;
  await scope.env.DB.prepare("UPDATE jobs SET enabled = ?, next_at = ?, updated_at = ? WHERE id = ? AND home_id = ?")
    .bind(enabled && next !== null ? 1 : 0, next, now, id, home)
    .run();
  await wakeScheduler(scope, home);
}

export async function cancel(scope: Scope, home: string, id: string): Promise<void> {
  await scope.env.DB.prepare("DELETE FROM jobs WHERE id = ? AND home_id = ?").bind(id, home).run();
  await wakeScheduler(scope, home);
}

/** The user's scheduler sets its alarm to their earliest job (or clears it). */
export async function wakeScheduler(scope: Scope, home: string): Promise<void> {
  const scheduler = scope.env.SCHEDULER.get(scope.env.SCHEDULER.idFromName(home));
  await scheduler.sync(home);
}

export const jobs = {
  get: (db: D1Database, home: string, id: string) =>
    db.prepare("SELECT * FROM jobs WHERE id = ? AND home_id = ?").bind(id, home).first<JobRow>(),

  earliest: async (db: D1Database, home: string) =>
    (
      await db
        .prepare("SELECT MIN(next_at) AS at FROM jobs WHERE home_id = ? AND enabled = 1 AND next_at IS NOT NULL")
        .bind(home)
        .first<{ at: number | null }>()
    )?.at ?? null,

  due: async (db: D1Database, home: string, until: number) =>
    (
      await db
        .prepare("SELECT * FROM jobs WHERE home_id = ? AND enabled = 1 AND next_at <= ? ORDER BY next_at LIMIT 50")
        .bind(home, until)
        .all<JobRow>()
    ).results,

  /** After a run: the next one, or off for good when the rule has none left. */
  advance: (db: D1Database, id: string, next: number | null, now: number) =>
    db
      .prepare("UPDATE jobs SET next_at = ?, enabled = ?, last_run_at = ?, updated_at = ? WHERE id = ?")
      .bind(next, next === null ? 0 : 1, now, now, id)
      .run(),
};
