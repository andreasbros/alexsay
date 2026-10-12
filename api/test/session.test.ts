import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import api from "../src/index";
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

  it("refuses sign-ups when the server's registration is closed", async () => {
    const request = new Request(`${APP}/api/session/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "stranger", password: "battery staple" }),
    });
    const res = await api.fetch(request, { ...env, REGISTRATION: "closed" }, createExecutionContext());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "registration_closed" });
    expect((await login("andreas", "correct horse")).status).toBe(200);
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

  it("drops Secure only for plain HTTP, as on a self-hosted server in a home network", async () => {
    const body = JSON.stringify({ username: "andreas", password: "correct horse" });
    const plain = await call("http://192.168.1.20:8787/api/session/login", { method: "POST", body });
    expect(plain.headers.get("set-cookie")).not.toMatch(/Secure/);
    const proxied = await call("http://192.168.1.20:8787/api/session/login", {
      method: "POST",
      headers: { "x-forwarded-proto": "https" },
      body,
    });
    expect(proxied.headers.get("set-cookie")).toMatch(/Secure/);
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

  it("a stranger's failures lock their address, not your account", async () => {
    const from = (ip: string, username: string, password: string) =>
      call(`${APP}/api/session/login`, {
        method: "POST",
        headers: { "cf-connecting-ip": ip },
        body: JSON.stringify({ username, password }),
      });
    for (let i = 0; i < 5; i++) {
      await from("203.0.113.9", "andreas", "wrong");
    }
    expect((await from("203.0.113.9", "andreas", "correct horse")).status).toBe(429);
    expect((await from("198.51.100.1", "andreas", "correct horse")).status).toBe(200);
  });

  it("limits registrations per address", async () => {
    const from = (ip: string, username: string) =>
      call(`${APP}/api/session/register`, {
        method: "POST",
        headers: { "cf-connecting-ip": ip },
        body: JSON.stringify({ username, password: "long enough password" }),
      });
    for (let i = 0; i < 40; i++) {
      expect((await from("203.0.113.5", `fresh${i}`)).status).toBe(201);
    }
    expect((await from("203.0.113.5", "fresh40")).status).toBe(429);
    expect((await from("203.0.113.6", "fresh41")).status).toBe(201);
  }, 60_000);

  it("logs out by revoking the session", async () => {
    const cookie = await signIn("andreas", "correct horse");
    await call(`${APP}/api/session/logout`, { method: "POST" }, cookie);
    expect((await call(`${APP}/api/session/me`, {}, cookie)).status).toBe(401);
  });
});
