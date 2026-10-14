import { createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { users } from "../src/db";
import api from "../src/index";
import { type Mail, transport } from "../src/mail";
import type { Scheduler } from "../src/scheduler";
import { APP, addUser, call, json, mockUpstream, reply, resetDb, signIn } from "./helpers";

let sent: Mail[] = [];
const originalSend = transport.send;

function lastMail(to: string): Mail {
  const mail = sent.filter((m) => m.to === to).at(-1);
  if (!mail) {
    throw new Error(`no email to ${to}`);
  }
  return mail;
}
const codeIn = (mail: Mail) => /\b(\d{6})\b/.exec(mail.text)?.[1] ?? "";
const tokenIn = (mail: Mail) => /#token=([A-Za-z0-9_-]{43})/.exec(mail.text)?.[1] ?? "";
const cookieOf = (res: Response) => res.headers.get("set-cookie")?.split(";")[0] ?? "";

async function enableEmail(): Promise<void> {
  const admin = await signIn("andreas", "correct horse");
  expect((await json(`${APP}/api/server`, "PATCH", { email_login: true }, admin)).status).toBe(200);
}

describe("homes", () => {
  beforeEach(async () => {
    await resetDb();
    sent = [];
    transport.send = async (_config, mail) => {
      sent.push(mail);
    };
    await addUser("andreas", "correct horse", "admin");
    await addUser("maria", "maria-pass", "user");
  });
  afterEach(() => {
    transport.send = originalSend;
  });

  it("gives every new account its own home called Home, which its admin can rename", async () => {
    const res = await json(`${APP}/api/session/register`, "POST", { username: "tom", password: "battery staple" });
    const tom = cookieOf(res);
    expect(await res.json()).toMatchObject({ username: "tom", home: "tom", homeRole: "admin" });
    const home = await (await call(`${APP}/api/home`, {}, tom)).json();
    expect(home).toMatchObject({
      name: "Home",
      role: "admin",
      creator: true,
      members: [{ username: "tom", role: "admin", creator: true }],
      invites: [],
      can_invite: false,
    });
    expect((await json(`${APP}/api/home`, "PATCH", { name: "Flat 4" }, tom)).status).toBe(200);
    expect(await (await call(`${APP}/api/home`, {}, tom)).json()).toMatchObject({ name: "Flat 4" });
  });

  it("keeps email sign-in off until a server admin switches it on, and only with a way to send mail", async () => {
    expect(await (await call(`${APP}/api/session/config`)).json()).toEqual({
      email_login: false,
      registration: true,
      captcha: null,
    });
    expect((await json(`${APP}/api/session/email/start`, "POST", { email: "maria@example.com" })).status).toBe(404);
    const maria = await signIn("maria", "maria-pass");
    expect((await json(`${APP}/api/server`, "PATCH", { email_login: true }, maria)).status).toBe(403);
    const admin = await signIn("andreas", "correct horse");
    const noMail = await api.fetch(
      new Request(`${APP}/api/server`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: admin },
        body: JSON.stringify({ email_login: true }),
      }),
      { ...env, EMAIL: undefined, SMTP_HOST: undefined },
      createExecutionContext(),
    );
    expect(noMail.status).toBe(409);
    await enableEmail();
    expect(await (await call(`${APP}/api/session/config`)).json()).toEqual({
      email_login: true,
      registration: true,
      captcha: null,
    });
  });

  it("asks Turnstile for the password sign-in and registration too, unless the suite's bypass header is sent", async () => {
    const guarded = {
      ...env,
      TURNSTILE_SITE_KEY: "0x4AAAsite",
      TURNSTILE_SECRET: "turnstile-secret",
      TURNSTILE_BYPASS: "suite-secret-0123456789",
    };
    const post = (path: string, body: object, headers: Record<string, string> = {}) =>
      api.fetch(
        new Request(`${APP}/api/session/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
        guarded,
        createExecutionContext(),
      );
    const bypass = { "x-turnstile-bypass": "suite-secret-0123456789" };
    const wrong = { "x-turnstile-bypass": "suite-secret-0123456780" };

    expect((await post("login", { username: "maria", password: "maria-pass" })).status).toBe(403);
    expect((await post("login", { username: "maria", password: "maria-pass" }, wrong)).status).toBe(403);
    expect((await post("register", { username: "sam", password: "sam-pass-123" })).status).toBe(403);
    expect(await users.get(env.DB, "sam")).toBeNull();

    const upstream = mockUpstream({
      "POST https://challenges.cloudflare.com/turnstile/v0/siteverify": () => reply(200, { success: true }),
    });
    expect((await post("login", { username: "maria", password: "maria-pass", captcha: "human" })).status).toBe(200);
    upstream.done();

    expect((await post("login", { username: "maria", password: "maria-pass" }, bypass)).status).toBe(200);
    expect((await post("register", { username: "sam", password: "sam-pass-123" }, bypass)).status).toBe(201);
    const config = await api.fetch(
      new Request(`${APP}/api/session/config`, { headers: bypass }),
      guarded,
      createExecutionContext(),
    );
    expect(await config.json()).toMatchObject({ captcha: null });
    const plain = await api.fetch(new Request(`${APP}/api/session/config`), guarded, createExecutionContext());
    expect(await plain.json()).toMatchObject({ captcha: "0x4AAAsite" });
  });

  it("asks Turnstile before sending a sign-in email when a site key and secret are set", async () => {
    await enableEmail();
    const guarded = { ...env, TURNSTILE_SITE_KEY: "0x4AAAsite", TURNSTILE_SECRET: "turnstile-secret" };
    const send = (body: object) =>
      api.fetch(
        new Request(`${APP}/api/session/email/start`, {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
          body: JSON.stringify(body),
        }),
        guarded,
        createExecutionContext(),
      );
    const config = await api.fetch(new Request(`${APP}/api/session/config`), guarded, createExecutionContext());
    expect(await config.json()).toMatchObject({ captcha: "0x4AAAsite" });

    expect((await send({ email: "sam@example.com" })).status).toBe(403);
    const verdicts: unknown[] = [];
    const upstream = mockUpstream({
      "POST https://challenges.cloudflare.com/turnstile/v0/siteverify": (_req, body) => {
        verdicts.push(JSON.parse(body));
        return reply(200, { success: verdicts.length > 1 });
      },
    });
    expect((await send({ email: "sam@example.com", captcha: "bot" })).status).toBe(403);
    expect(sent).toHaveLength(0);
    expect((await send({ email: "sam@example.com", captcha: "human" })).status).toBe(200);
    upstream.done();
    expect(verdicts.at(-1)).toEqual({ secret: "turnstile-secret", response: "human", remoteip: "203.0.113.9" });
    expect(lastMail("sam@example.com").subject).toMatch(/^alexsay\.com: sign-in code \d{6}$/);
  });

  it("signs in with an emailed code, making the account and its home for a new address", async () => {
    await enableEmail();
    expect((await json(`${APP}/api/session/email/start`, "POST", { email: "Sam.Jones@Example.com" })).status).toBe(200);
    const mail = lastMail("sam.jones@example.com");
    const code = codeIn(mail);
    const wrong = code === "000000" ? "111111" : "000000";
    const bad = await json(`${APP}/api/session/email/verify`, "POST", { email: "sam.jones@example.com", code: wrong });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "wrong" });
    const res = await json(`${APP}/api/session/email/verify`, "POST", { email: "sam.jones@example.com", code });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      username: "sam.jones",
      email: "sam.jones@example.com",
      home: "sam.jones",
    });
    const me = await (await call(`${APP}/api/session/me`, {}, cookieOf(res))).json();
    expect(me).toMatchObject({ username: "sam.jones", homeRole: "admin" });
    // Used once
    expect(
      (await json(`${APP}/api/session/email/verify`, "POST", { email: "sam.jones@example.com", code })).status,
    ).toBe(401);
  });

  it("stores codes only as HMACs, burns a code after five wrong guesses, and limits sends", async () => {
    await enableEmail();
    await json(`${APP}/api/session/email/start`, "POST", { email: "maria@example.com" });
    const code = codeIn(lastMail("maria@example.com"));
    const row = await env.DB.prepare("SELECT * FROM email_codes WHERE email = 'maria@example.com'").first<{
      code_mac: string;
      token_mac: string;
    }>();
    expect(JSON.stringify(row)).not.toContain(code);
    expect(row?.code_mac).toMatch(/^[0-9a-f]{64}$/);
    const wrong = code === "000000" ? "111111" : "000000";
    const answers: number[] = [];
    for (let i = 0; i < 5; i++) {
      answers.push(
        (await json(`${APP}/api/session/email/verify`, "POST", { email: "maria@example.com", code: wrong })).status,
      );
    }
    expect(answers).toEqual([401, 401, 401, 401, 429]);
    // A new code does not bring the guesses back
    await json(`${APP}/api/session/email/start`, "POST", { email: "maria@example.com" });
    const fresh = codeIn(lastMail("maria@example.com"));
    expect(
      (await json(`${APP}/api/session/email/verify`, "POST", { email: "maria@example.com", code: fresh })).status,
    ).toBe(429);
    // Five sends an hour per address
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await json(`${APP}/api/session/email/start`, "POST", { email: "maria@example.com" })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("signs in once with the emailed link", async () => {
    await enableEmail();
    await json(`${APP}/api/session/email/start`, "POST", { email: "sam@example.com" });
    const token = tokenIn(lastMail("sam@example.com"));
    const first = await json(`${APP}/api/session/email/link`, "POST", { token });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ username: "sam", email: "sam@example.com" });
    expect((await json(`${APP}/api/session/email/link`, "POST", { token })).status).toBe(401);
  });

  it("adds an email to an account once the code sent to it comes back, and keeps addresses unique", async () => {
    await enableEmail();
    const maria = await signIn("maria", "maria-pass");
    expect((await json(`${APP}/api/session/email/add`, "POST", { email: "maria@example.com" }, maria)).status).toBe(
      200,
    );
    const code = codeIn(lastMail("maria@example.com"));
    expect(await (await json(`${APP}/api/session/email/confirm`, "POST", { code }, maria)).json()).toEqual({
      email: "maria@example.com",
    });
    const admin = await signIn("andreas", "correct horse");
    expect((await json(`${APP}/api/session/email/add`, "POST", { email: "maria@example.com" }, admin)).status).toBe(
      409,
    );
    // Maria can now sign in by email to her existing account
    await json(`${APP}/api/session/email/start`, "POST", { email: "maria@example.com" });
    const res = await json(`${APP}/api/session/email/verify`, "POST", {
      email: "maria@example.com",
      code: codeIn(lastMail("maria@example.com")),
    });
    expect(await res.json()).toMatchObject({ username: "maria", home: "maria" });
  });

  it("invites by email: the link makes the account, signs it in and puts it in the home", async () => {
    await enableEmail();
    const maria = await signIn("maria", "maria-pass");
    await json(`${APP}/api/memories`, "POST", { category: "home", content: "The boiler is in the loft" }, maria);
    const invited = await json(`${APP}/api/home/invites`, "POST", { email: "dad@example.com" }, maria);
    expect(invited.status).toBe(201);
    expect(await invited.json()).toMatchObject({ email: "dad@example.com", role: "user", status: "pending" });
    const mail = lastMail("dad@example.com");
    expect(mail.subject).toBe("alexsay.com: maria invited you to Home");
    const token = tokenIn(mail);
    expect(await (await json(`${APP}/api/invites/lookup`, "POST", { token })).json()).toEqual({
      home: "Home",
      invited_by: "maria",
      email: "dad@example.com",
      role: "user",
    });
    const accepted = await json(`${APP}/api/invites/accept`, "POST", { token });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ username: "dad", home: "maria", homeRole: "user" });
    const dad = cookieOf(accepted);
    // Everything in the home is shared
    const memories = (await (await call(`${APP}/api/memories`, {}, dad)).json()) as { content: string }[];
    expect(memories.map((m) => m.content)).toEqual(["The boiler is in the loft"]);
    // A plain member uses the home but does not change it
    expect((await json(`${APP}/api/session/settings`, "PATCH", { timezone: "Europe/Paris" }, dad)).status).toBe(403);
    expect((await json(`${APP}/api/home`, "PATCH", { name: "Mine" }, dad)).status).toBe(403);
    expect((await json(`${APP}/api/connections/lightwave`, "DELETE", {}, dad)).status).toBe(403);
    expect((await json(`${APP}/api/home/invites`, "POST", { email: "x@example.com" }, dad)).status).toBe(403);
    // The link works once; the owner sees it accepted
    expect((await json(`${APP}/api/invites/accept`, "POST", { token })).status).toBe(404);
    const home = (await (await call(`${APP}/api/home`, {}, maria)).json()) as {
      members: { username: string; role: string }[];
      invites: { status: string; accepted_by: string }[];
    };
    expect(home.members).toEqual([
      expect.objectContaining({ username: "maria", role: "admin", creator: true }),
      expect.objectContaining({ username: "dad", role: "user", creator: false }),
    ]);
    expect(home.invites).toEqual([expect.objectContaining({ status: "accepted", accepted_by: "dad" })]);
  });

  it("lets an admin promote and remove members, never the creator, and a member leave", async () => {
    await enableEmail();
    const maria = await signIn("maria", "maria-pass");
    await json(`${APP}/api/memories`, "POST", { category: "home", content: "Bins go out on Tuesday" }, maria);
    await json(`${APP}/api/home/invites`, "POST", { email: "dad@example.com" }, maria);
    const dad = cookieOf(
      await json(`${APP}/api/invites/accept`, "POST", { token: tokenIn(lastMail("dad@example.com")) }),
    );
    expect((await json(`${APP}/api/home/members/dad`, "PATCH", { role: "admin" }, maria)).status).toBe(204);
    expect(await (await call(`${APP}/api/session/me`, {}, dad)).json()).toMatchObject({ homeRole: "admin" });
    expect((await json(`${APP}/api/home/members/maria`, "PATCH", { role: "user" }, dad)).status).toBe(409);
    expect((await json(`${APP}/api/home/members/maria`, "DELETE", {}, dad)).status).toBe(409);
    expect((await json(`${APP}/api/home/leave`, "POST", {}, maria)).status).toBe(409);
    expect((await json(`${APP}/api/home/members/dad`, "DELETE", {}, maria)).status).toBe(204);
    // Back in his own (empty) home
    expect(await (await call(`${APP}/api/session/me`, {}, dad)).json()).toMatchObject({
      home: "dad",
      homeRole: "admin",
    });
    expect(await (await call(`${APP}/api/memories`, {}, dad)).json()).toEqual([]);
  });

  it("expires an invitation after 3 days, replaces it on resend, and lets the admin delete it", async () => {
    await enableEmail();
    const maria = await signIn("maria", "maria-pass");
    const created = (await (
      await json(`${APP}/api/home/invites`, "POST", { email: "dad@example.com" }, maria)
    ).json()) as {
      id: string;
      expires_at: number;
      created_at: number;
    };
    expect(created.expires_at - created.created_at).toBe(3 * 86_400_000);
    const stale = tokenIn(lastMail("dad@example.com"));
    await env.DB.prepare("UPDATE invites SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, created.id)
      .run();
    expect((await json(`${APP}/api/invites/accept`, "POST", { token: stale })).status).toBe(404);
    const listed = (await (await call(`${APP}/api/home`, {}, maria)).json()) as { invites: { status: string }[] };
    expect(listed.invites).toEqual([expect.objectContaining({ status: "expired" })]);
    const resent = (await (await json(`${APP}/api/home/invites/${created.id}/resend`, "POST", {}, maria)).json()) as {
      id: string;
    };
    expect(sent.filter((m) => m.to === "dad@example.com")).toHaveLength(2);
    expect((await json(`${APP}/api/home/invites/${resent.id}`, "DELETE", {}, maria)).status).toBe(204);
    expect(
      (await json(`${APP}/api/invites/accept`, "POST", { token: tokenIn(lastMail("dad@example.com")) })).status,
    ).toBe(404);
  });

  it("will not take a creator out of a home that has other people in it", async () => {
    await enableEmail();
    const maria = await signIn("maria", "maria-pass");
    const admin = await signIn("andreas", "correct horse");
    await json(`${APP}/api/home/invites`, "POST", { email: "dad@example.com" }, maria);
    await json(`${APP}/api/invites/accept`, "POST", { token: tokenIn(lastMail("dad@example.com")) });
    await json(`${APP}/api/session/email/add`, "POST", { email: "maria@example.com" }, maria);
    await json(`${APP}/api/session/email/confirm`, "POST", { code: codeIn(lastMail("maria@example.com")) }, maria);
    await json(`${APP}/api/home/invites`, "POST", { email: "maria@example.com" }, admin);
    const res = await json(`${APP}/api/invites/accept`, "POST", { token: tokenIn(lastMail("maria@example.com")) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "home_has_members" });
  });

  it("keeps running a scheduler that stored its home under the old key", async () => {
    const id = env.SCHEDULER.idFromName("maria");
    await runInDurableObject(env.SCHEDULER.get(id), async (instance, state: DurableObjectState) => {
      await state.storage.put("username", "maria");
      await (instance as Scheduler).alarm();
      expect(await state.storage.get("home")).toBe("maria");
    });
  });
});
