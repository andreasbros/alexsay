import { Hono } from "hono";
import { mailDescription, mailRoute } from "../mail";
import * as schemas from "../schemas";
import { serverSettings } from "../server_settings";
import type { AppEnv } from "../types";
import { jsonBody } from "../validate";

/** Server admins: switches that apply to every account on this server. */
export const serverRoutes = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await view(c.env)))
  .patch("/", async (c) => {
    const { email_login } = await jsonBody(c, schemas.updateServerSettings);
    if (email_login && !mailRoute(c.env)) {
      return c.json({ error: "mail_not_configured" }, 409);
    }
    await serverSettings.setEmailLogin(c.env.DB, email_login);
    return c.json(await view(c.env));
  });

async function view(env: Env) {
  const route = mailRoute(env);
  return { ...(await serverSettings.get(env.DB)), mail: route ? mailDescription(route) : null };
}
