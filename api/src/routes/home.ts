import { Hono } from "hono";
import { requireHomeAdmin, startSession } from "../auth";
import { homes, users } from "../db";
import { acceptInvite, createInvite, INVITE_DAYS, inviteByToken, invites, inviteView } from "../invites";
import { sendMail } from "../mail";
import { inviteEmail } from "../mail_templates";
import { serverOrigin } from "../origin";
import * as schemas from "../schemas";
import { emailEnabled } from "../server_settings";
import type { AppEnv } from "../types";
import { jsonBody, parse } from "../validate";

/** The signed-in person's home: everyone sees it and its members; admins also manage it. */
export const homeRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const me = c.get("user");
    const [home, members, email] = await Promise.all([
      homes.get(c.env.DB, me.home),
      homes.members(c.env.DB, me.home),
      emailEnabled(c),
    ]);
    if (!home) {
      return c.json({ error: "not_found" }, 404);
    }
    const now = Date.now();
    const pending = me.homeRole === "admin" ? await invites.list(c.env.DB, me.home) : [];
    return c.json({
      id: home.id,
      name: home.name,
      role: me.homeRole,
      creator: home.id === me.username,
      members,
      invites: pending.map((row) => inviteView(row, now)),
      can_invite: me.homeRole === "admin" && email,
    });
  })
  .patch("/", requireHomeAdmin, async (c) => {
    const { name } = await jsonBody(c, schemas.renameHome);
    await homes.rename(c.env.DB, c.get("user").home, name);
    return c.json({ name });
  })
  .patch("/members/:username", requireHomeAdmin, async (c) => {
    const username = parse(schemas.username, c.req.param("username"));
    const { role } = await jsonBody(c, schemas.changeMember);
    const home = c.get("user").home;
    const member = (await homes.members(c.env.DB, home)).find((m) => m.username === username);
    if (!member) {
      return c.json({ error: "not_found" }, 404);
    }
    if (member.creator) {
      return c.json({ error: "creator" }, 409);
    }
    await users.setHome(c.env.DB, username, home, role);
    return c.body(null, 204);
  })
  /** Removing someone sends them back to their own home. */
  .delete("/members/:username", requireHomeAdmin, async (c) => {
    const username = parse(schemas.username, c.req.param("username"));
    const home = c.get("user").home;
    const member = (await homes.members(c.env.DB, home)).find((m) => m.username === username);
    if (!member) {
      return c.json({ error: "not_found" }, 404);
    }
    if (member.creator) {
      return c.json({ error: "creator" }, 409);
    }
    await users.setHome(c.env.DB, username, null, "admin");
    return c.body(null, 204);
  })
  .post("/leave", async (c) => {
    const me = c.get("user");
    if (me.home === me.username) {
      return c.json({ error: "creator" }, 409);
    }
    await users.setHome(c.env.DB, me.username, null, "admin");
    return c.body(null, 204);
  })
  .post("/invites", requireHomeAdmin, async (c) => {
    const { email, role } = await jsonBody(c, schemas.invite);
    const me = c.get("user");
    if (!(await emailEnabled(c))) {
      return c.json({ error: "email_login_off" }, 409);
    }
    const existing = await users.byEmail(c.env.DB, email);
    if (existing?.home === me.home) {
      return c.json({ error: "already_member" }, 409);
    }
    const { row, token } = await createInvite(
      c.env,
      { home: me.home, email, role, invitedBy: me.username },
      Date.now(),
    );
    await sendInvite(c.env, row.home_id, me.username, email, `${serverOrigin(c)}/invite#token=${token}`);
    return c.json(inviteView(row, Date.now()), 201);
  })
  /** A fresh link and three more days, for an invitation that expired or got lost. */
  .post("/invites/:id/resend", requireHomeAdmin, async (c) => {
    const id = parse(schemas.inviteId, c.req.param("id"));
    const me = c.get("user");
    const old = await invites.get(c.env.DB, me.home, id);
    if (old?.status !== "pending") {
      return c.json({ error: "not_found" }, 404);
    }
    if (!(await emailEnabled(c))) {
      return c.json({ error: "email_login_off" }, 409);
    }
    const { row, token } = await createInvite(
      c.env,
      { home: me.home, email: old.email, role: old.role, invitedBy: me.username },
      Date.now(),
    );
    await sendInvite(c.env, row.home_id, me.username, old.email, `${serverOrigin(c)}/invite#token=${token}`);
    return c.json(inviteView(row, Date.now()));
  })
  .delete("/invites/:id", requireHomeAdmin, async (c) => {
    const id = parse(schemas.inviteId, c.req.param("id"));
    const result = await invites.remove(c.env.DB, c.get("user").home, id);
    return result.meta.changes ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  });

async function sendInvite(env: Env, home: string, inviter: string, email: string, link: string): Promise<void> {
  const name = (await homes.get(env.DB, home))?.name ?? "Home";
  await sendMail(env, { to: email, ...inviteEmail({ home: name, inviter, link, days: INVITE_DAYS }) });
}

/** Opened from the invitation email, signed in or not: the token in the link is the credential. */
export const inviteRoutes = new Hono<AppEnv>()
  .post("/lookup", async (c) => {
    const { token } = await jsonBody(c, schemas.emailLink);
    const invite = await inviteByToken(c.env, token, Date.now());
    if (!invite) {
      return c.json({ error: "expired" }, 404);
    }
    const home = await homes.get(c.env.DB, invite.home_id);
    return c.json({
      home: home?.name ?? "Home",
      invited_by: invite.invited_by,
      email: invite.email,
      role: invite.role,
    });
  })
  .post("/accept", async (c) => {
    const { token } = await jsonBody(c, schemas.emailLink);
    const now = Date.now();
    const invite = await inviteByToken(c.env, token, now);
    if (!invite) {
      return c.json({ error: "expired" }, 404);
    }
    const result = await acceptInvite(c.env, invite, now);
    if (!result.ok) {
      return c.json({ error: result.reason }, 409);
    }
    await startSession(c, result.user.username);
    return c.json(result.user);
  });
