import { beforeEach, describe, expect, it } from "vitest";
import { APP, addUser, call, json, resetDb, signIn } from "./helpers";

const login = (username: string, password: string) => json(`${APP}/api/session/login`, "POST", { username, password });
const register = (username: string, password: string) =>
  json(`${APP}/api/session/register`, "POST", { username, password });

describe("session", () => {
  beforeEach(async () => {
    await resetDb();
    await addUser("andreas", "correct horse", "admin");
  });

  it("registers a new account as a plain user and signs it in", async () => {
    const res = await register("Maria", "battery staple");
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ username: "maria", role: "user" });
    const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
    const me = await call(`${APP}/api/session/me`, {}, cookie);
    expect(await me.json()).toMatchObject({ username: "maria", role: "user" });
  });

  it("refuses a taken username, short passwords and odd names", async () => {
    expect((await register("andreas", "battery staple")).status).toBe(409);
    expect((await register("maria", "short")).status).toBe(400);
    expect((await register("ma ria", "battery staple")).status).toBe(400);
  });

  it("signs in with the right password and returns the user", async () => {
    const cookie = await signIn("andreas", "correct horse");
    const me = await call(`${APP}/api/session/me`, {}, cookie);
    expect(await me.json()).toMatchObject({ username: "andreas", role: "admin" });
  });

  it("sets a secure, http-only session cookie", async () => {
    const res = await login("Andreas", "correct horse");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it("rejects wrong passwords and unknown users alike", async () => {
    expect((await login("andreas", "wrong")).status).toBe(401);
    expect((await login("nobody", "wrong")).status).toBe(401);
  });

  it("locks the account after repeated failures", async () => {
    for (let i = 0; i < 5; i++) {
      await login("andreas", "wrong");
    }
    expect((await login("andreas", "correct horse")).status).toBe(429);
  });

  it("logs out by revoking the session", async () => {
    const cookie = await signIn("andreas", "correct horse");
    await call(`${APP}/api/session/logout`, { method: "POST" }, cookie);
    expect((await call(`${APP}/api/session/me`, {}, cookie)).status).toBe(401);
  });
});
