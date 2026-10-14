import { Hono } from "hono";
import { smtpConfig } from "../mail";
import * as schemas from "../schemas";
import { serverSettings } from "../server_settings";
import type { AppEnv } from "../types";
import { jsonBody } from "../validate";

/** Server admins: switches that apply to every account on this server. */
export const serverRoutes = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await view(c.env)))
  .patch("/", async (c) => {
    const { email_login } = await jsonBody(c, schemas.updateServerSettings);
    if (email_login && !smtpConfig(c.env)) {
      return c.json({ error: "smtp_not_configured" }, 409);
    }
    await serverSettings.setEmailLogin(c.env.DB, email_login);
    return c.json(await view(c.env));
  });

async function view(env: Env) {
  const smtp = smtpConfig(env);
  return { ...(await serverSettings.get(env.DB)), smtp: smtp ? { host: smtp.host, from: smtp.from } : null };
}
