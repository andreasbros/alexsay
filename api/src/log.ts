import type { Scope } from "./types";

export type LogLevel = "info" | "warn" | "error";

export interface LogLine {
  at: number;
  level: LogLevel;
  message: string;
}

const MAX_MESSAGE = 400;
export const MAX_LOG_LINES = 100;
export const DEFAULT_LOG_LINES = 5;
const KEEP_MS = 7 * 86_400_000;

/**
 * Notes what the server did for a user: tool calls, calls placed and answered, webhooks, failures.
 * Best effort: a failure is swallowed, so callers await it (a Worker cancels floating promises once
 * the response is sent, which lost lines from webhooks on 12 Oct 2026).
 */
export function logFor(scope: Scope, home: string, level: LogLevel, message: string): Promise<void> {
  return scope.env.DB.prepare("INSERT INTO server_log (home_id, at, level, message) VALUES (?, ?, ?, ?)")
    .bind(home, Date.now(), level, message.slice(0, MAX_MESSAGE))
    .run()
    .then(() => undefined)
    .catch(() => undefined);
}

/** The first or last lines of a user's log, newest last. */
export async function readLog(
  db: D1Database,
  home: string,
  position: "head" | "tail",
  lines: number,
): Promise<LogLine[]> {
  const count = Math.min(MAX_LOG_LINES, Math.max(1, Math.round(lines)));
  const rows = (
    await db
      .prepare(
        `SELECT at, level, message FROM server_log WHERE home_id = ? ORDER BY id ${position === "head" ? "ASC" : "DESC"} LIMIT ?`,
      )
      .bind(home, count)
      .all<LogLine>()
  ).results;
  return position === "head" ? rows : rows.reverse();
}

export const purgeLog = (db: D1Database, now: number) =>
  db.prepare("DELETE FROM server_log WHERE at <= ?").bind(now - KEEP_MS);

export const formatLogLine = (line: LogLine) =>
  `${new Date(line.at).toISOString().slice(11, 19)} ${line.level} ${line.message}`;
