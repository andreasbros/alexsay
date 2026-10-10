import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  APP,
  addUser,
  call,
  connectLightwave,
  connectOpenai,
  json,
  mockUpstream,
  OPENAI_KEY,
  reply,
  resetDb,
  signIn,
} from "./helpers";

describe("connections", () => {
  let maria: string;

  beforeEach(async () => {
    await resetDb();
    await addUser("maria", "maria-pass", "user");
    maria = await signIn("maria", "maria-pass");
  });

  it("stores the OpenAI key sealed and lists the connection without it", async () => {
    const res = await connectOpenai(maria, { voice: "cedar", backend_model: "gpt-5.5" });
    expect(res.status).toBe(200);
    const list = await (await call(`${APP}/api/connections`, {}, maria)).json();
    expect(list).toEqual([
      expect.objectContaining({ provider: "openai", settings: expect.objectContaining({ voice: "cedar" }) }),
    ]);
    expect(JSON.stringify(list)).not.toContain(OPENAI_KEY);
    const row = await env.DB.prepare("SELECT secret FROM connections").first<{ secret: string }>();
    expect(row?.secret).toMatch(/^v1:/);
    expect(row?.secret).not.toContain(OPENAI_KEY);
  });

  it("changes settings without re-entering the key, but needs a key the first time", async () => {
    const first = await json(`${APP}/api/connections/openai`, "PUT", { settings: { voice: "cedar" } }, maria);
    expect(first.status).toBe(400);
    await connectOpenai(maria, { voice: "cedar" });
    const before = await env.DB.prepare("SELECT secret FROM connections").first<{ secret: string }>();
    const res = await json(`${APP}/api/connections/openai`, "PUT", { api_key: "", settings: { voice: "sage" } }, maria);
    expect(res.status).toBe(200);
    const after = await env.DB.prepare("SELECT secret, settings FROM connections").first<{
      secret: string;
      settings: string;
    }>();
    expect(after?.secret).toBe(before?.secret);
    expect(JSON.parse(after?.settings ?? "{}")).toMatchObject({ voice: "sage" });
  });

  it("rejects keys that do not look like OpenAI keys", async () => {
    const res = await json(`${APP}/api/connections/openai`, "PUT", { api_key: "hello" }, maria);
    expect(res.status).toBe(400);
  });

  it("tests the OpenAI key against the models endpoint", async () => {
    await connectOpenai(maria);
    const upstream = mockUpstream({
      "GET https://api.openai.com/v1/models": (req) => {
        expect(req.headers.get("authorization")).toBe(`Bearer ${OPENAI_KEY}`);
        return reply(200, { data: [{ id: "gpt-live-1" }, { id: "gpt-4.1" }] });
      },
    });
    const res = await call(`${APP}/api/connections/openai/test`, { method: "POST" }, maria);
    upstream.done();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, models: 2, live_model: true, backend_model: false });
  });

  it("reports a rejected key", async () => {
    await connectOpenai(maria);
    const upstream = mockUpstream({
      "GET https://api.openai.com/v1/models": () => reply(401, { error: { message: "Incorrect API key provided" } }),
    });
    const res = await call(`${APP}/api/connections/openai/test`, { method: "POST" }, maria);
    upstream.done();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, status: 401, detail: "Incorrect API key provided" });
  });

  it("tests Lightwave by refreshing the token and keeps the rotated refresh token", async () => {
    await connectLightwave(maria);
    const first = mockUpstream({
      "POST https://auth.lightwaverf.com/token": (req, body) => {
        expect(req.headers.get("authorization")).toBe("basic basic-token-0123456789");
        expect(JSON.parse(body)).toEqual({ grant_type: "refresh_token", refresh_token: "refresh-token-0123456789" });
        return reply(200, { access_token: "access-1", refresh_token: "refresh-2", expires_in: 3600 });
      },
      "GET https://publicapi.lightwaverf.com/v1/structures": (req) => {
        expect(req.headers.get("authorization")).toBe("bearer access-1");
        return reply(200, { structures: ["s1", "s2"] });
      },
    });
    const res = await call(`${APP}/api/connections/lightwave/test`, { method: "POST" }, maria);
    first.done();
    expect(await res.json()).toEqual({ ok: true, structures: 2 });

    const second = mockUpstream({
      "GET https://publicapi.lightwaverf.com/v1/structures": () => reply(200, { structures: ["s1"] }),
    });
    const again = await call(`${APP}/api/connections/lightwave/test`, { method: "POST" }, maria);
    second.done();
    expect(await again.json()).toEqual({ ok: true, structures: 1 });
  });

  it("removes a connection", async () => {
    await connectOpenai(maria);
    expect((await call(`${APP}/api/connections/openai`, { method: "DELETE" }, maria)).status).toBe(204);
    expect((await call(`${APP}/api/connections/openai`, { method: "DELETE" }, maria)).status).toBe(404);
    expect((await call(`${APP}/api/connections/nope`, { method: "DELETE" }, maria)).status).toBe(404);
  });
});
