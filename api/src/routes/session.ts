import { Hono } from "hono";
import { addressOf, login, logout, registrationAllowed, requireHomeAdmin, requireUser, startSession } from "../auth";
import { hashPassword } from "../crypto";
import { homes, users } from "../db";
import { allowSend, CODE_MINUTES, checkCode, checkToken, issueCode } from "../email_codes";
import { accountForEmail } from "../invites";
import { sendMail } from "../mail";
import { confirmEmail, loginEmail } from "../mail_templates";
import { serverOrigin } from "../origin";
import * as schemas from "../schemas";
import { emailEnabled } from "../server_settings";
import { captchaFor, passedCaptcha } from "../turnstile";
import type { AppEnv } from "../types";
import { jsonBody } from "../validate";

export const sessionRoutes = new Hono<AppEnv>()
  /** What the sign-in page offers. */
  .get("/config", async (c) =>
    c.json({
      email_login: await emailEnabled(c),
      registration: c.env.REGISTRATION !== "closed",
      captcha: captchaFor(c),
    }),
  )
  /**
   * Sends a code and a link. The answer is the same whether or not the address has an account; with
   * registration closed, an unknown address gets nothing (an invitation makes its account instead).
   */
  .post("/email/start", async (c) => {
    const { email, captcha } = await jsonBody(c, schemas.emailStart);
    if (!(await emailEnabled(c))) {
      return c.json({ error: "email_login_off" }, 404);
    }
    if (!(await passedCaptcha(c, captcha))) {
      return c.json({ error: "captcha_failed" }, 403);
    }
    const known = (await users.byEmail(c.env.DB, email)) !== null;
    if (!known && c.env.REGISTRATION === "closed") {
      return c.json({ sent: true });
    }
    const now = Date.now();
    const allowed = await allowSend(c.env.DB, email, addressOf(c), now);
    if (allowed !== "ok") {
      return c.json({ error: "too_many" }, 429);
    }
    const { code, token } = await issueCode(c.env, email, "login", null, now);
    const link = `${serverOrigin(c)}/sign-in/email#token=${token}`;
    await sendMail(c.env, { to: email, ...loginEmail({ code, link, minutes: CODE_MINUTES }) });
    return c.json({ sent: true });
  })
  .post("/email/verify", async (c) => {
    const { email, code } = await jsonBody(c, schemas.emailVerify);
    if (!(await emailEnabled(c))) {
      return c.json({ error: "email_login_off" }, 404);
    }
    const result = await checkCode(c.env, { email }, "login", code, Date.now());
    if (!result.ok) {
      return c.json({ error: result.reason }, result.reason === "too_many_attempts" ? 429 : 401);
    }
    const user = await accountForEmail(c.env.DB, email);
    await startSession(c, user.username);
    return c.json(user);
  })
  .post("/email/link", async (c) => {
    const { token } = await jsonBody(c, schemas.emailLink);
    if (!(await emailEnabled(c))) {
      return c.json({ error: "email_login_off" }, 404);
    }
    const row = await checkToken(c.env, token, "login", Date.now());
    if (!row) {
      return c.json({ error: "expired" }, 401);
    }
    const user = await accountForEmail(c.env.DB, row.email);
    await startSession(c, user.username);
    return c.json(user);
  })
  /** Adding an address to an account: it is stored only once the code sent to it comes back. */
  .post("/email/add", requireUser, async (c) => {
    const { email } = await jsonBody(c, schemas.emailStart);
    const me = c.get("user");
    if (!(await emailEnabled(c))) {
      return c.json({ error: "email_login_off" }, 404);
    }
    const owner = await users.byEmail(c.env.DB, email);
    if (owner && owner.username !== me.username) {
      return c.json({ error: "email_in_use" }, 409);
    }
    const now = Date.now();
    if ((await allowSend(c.env.DB, email, addressOf(c), now)) !== "ok") {
      return c.json({ error: "too_many" }, 429);
    }
    const { code } = await issueCode(c.env, email, "verify", me.username, now);
    await sendMail(c.env, { to: email, ...confirmEmail({ code, username: me.username, minutes: CODE_MINUTES }) });
    return c.json({ sent: true });
  })
  .post("/email/confirm", requireUser, async (c) => {
    const { code } = await jsonBody(c, schemas.emailConfirm);
    const me = c.get("user");
    const result = await checkCode(c.env, { username: me.username }, "verify", code, Date.now());
    if (!result.ok) {
      return c.json({ error: result.reason }, result.reason === "too_many_attempts" ? 429 : 401);
    }
    const owner = await users.byEmail(c.env.DB, result.row.email);
    if (owner && owner.username !== me.username) {
      return c.json({ error: "email_in_use" }, 409);
    }
    await users.setEmail(c.env.DB, me.username, result.row.email);
    return c.json({ email: result.row.email });
  })
  .delete("/email", requireUser, async (c) => {
    await users.setEmail(c.env.DB, c.get("user").username, null);
    return c.body(null, 204);
  })
  .post("/register", async (c) => {
    const { username, password, captcha } = await jsonBody(c, schemas.register);
    if (c.env.REGISTRATION === "closed") {
      return c.json({ error: "registration_closed" }, 403);
    }
    if (!(await passedCaptcha(c, captcha))) {
      return c.json({ error: "captcha_failed" }, 403);
    }
    if (!(await registrationAllowed(c))) {
      return c.json({ error: "too_many" }, 429);
    }
    if (await users.get(c.env.DB, username)) {
      return c.json({ error: "exists" }, 409);
    }
    await users.create(c.env.DB, { username, role: "user", password_hash: await hashPassword(password) });
    await startSession(c, username);
    return c.json(await users.session(c.env.DB, username), 201);
  })
  .post("/login", async (c) => {
    const { username, password, captcha } = await jsonBody(c, schemas.login);
    if (!(await passedCaptcha(c, captcha))) {
      return c.json({ error: "captcha_failed" }, 403);
    }
    const result = await login(c, username.trim().toLowerCase(), password);
    if (!result.ok) {
      return c.json({ error: result.reason }, result.reason === "locked" ? 429 : 401);
    }
    return c.json(result.user);
  })
  .post("/logout", async (c) => {
    await logout(c);
    return c.body(null, 204);
  })
  .get("/me", requireUser, async (c) => {
    const user = c.get("user");
    return c.json({ ...user, ...(await accountSettings(c.env.DB, user.home)) });
  })
  /** Account-level preferences the server must enforce, unlike the browser-only ones in Settings. */
  .patch("/settings", requireUser, requireHomeAdmin, async (c) => {
    const { ai_log_access, ai_call_test, locale, timezone } = await jsonBody(c, schemas.userSettings);
    const home = c.get("user").home;
    if (ai_log_access !== undefined) {
      await homes.setLogAccess(c.env.DB, home, ai_log_access);
    }
    if (ai_call_test !== undefined) {
      await homes.setCallTest(c.env.DB, home, ai_call_test);
    }
    if (locale !== undefined || timezone !== undefined) {
      await homes.setLocale(c.env.DB, home, { locale, timezone });
    }
    return c.json(await accountSettings(c.env.DB, home));
  });

async function accountSettings(db: D1Database, home: string) {
  const [ai_log_access, ai_call_test, where] = await Promise.all([
    homes.logAccess(db, home),
    homes.callTest(db, home),
    homes.locale(db, home),
  ]);
  return { ai_log_access, ai_call_test, ...where };
}
