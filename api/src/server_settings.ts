import { mailRoute } from "./mail";
import type { Scope } from "./types";

export interface ServerSettings {
  email_login: boolean;
}

export const serverSettings = {
  get: async (db: D1Database): Promise<ServerSettings> => {
    const rows = (await db.prepare("SELECT key, value FROM server_settings").all<{ key: string; value: string }>())
      .results;
    const value = (key: string) => rows.find((row) => row.key === key)?.value;
    return { email_login: value("email_login") === "on" };
  },

  setEmailLogin: (db: D1Database, on: boolean) =>
    db
      .prepare(
        `INSERT INTO server_settings (key, value) VALUES ('email_login', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind(on ? "on" : "off")
      .run(),
};

/** Email sign-in and invitations need both: an admin switched it on and the server can send mail. */
export async function emailEnabled(scope: Scope): Promise<boolean> {
  return mailRoute(scope.env) !== null && (await serverSettings.get(scope.env.DB)).email_login;
}
