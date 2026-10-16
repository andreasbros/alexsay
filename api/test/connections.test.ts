import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { accessToken } from "../src/providers/spotify";
import { seal } from "../src/secrets";
import {
  APP,
  addUser,
  call,
  connectLightwave,
  connectOpenai,
  connectSpotify,
  formOf,
  json,
  mockUpstream,
  OPENAI_KEY,
  reply,
  resetDb,
  SPOTIFY,
  SPOTIFY_ACCOUNTS,
  SPOTIFY_CLIENT_ID,
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

  it("exchanges pasted Lightwave tokens on save and refuses a dead refresh token", async () => {
    const dead = mockUpstream({
      "POST https://auth.lightwaverf.com/token": () =>
        reply(400, { error: "invalid_token", error_description: "Unknown refresh token" }),
    });
    const refused = await json(
      `${APP}/api/connections/lightwave`,
      "PUT",
      { basic_token: "basic-token-0123456789", refresh_token: "used-before-0123456789" },
      maria,
    );
    dead.done();
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "lightwave_rejected", detail: "Unknown refresh token" });
    expect(await (await call(`${APP}/api/connections`, {}, maria)).json()).toEqual([]);

    expect((await connectLightwave(maria)).status).toBe(200);
    // The stored secret already holds the rotated token and a cached access token
    const upstream = mockUpstream({
      "GET https://publicapi.lightwaverf.com/v1/structures": (req) => {
        expect(req.headers.get("authorization")).toBe("bearer access-0");
        return reply(200, { structures: ["s1", "s2"] });
      },
    });
    const res = await call(`${APP}/api/connections/lightwave/test`, { method: "POST" }, maria);
    upstream.done();
    expect(await res.json()).toEqual({ ok: true, structures: 2 });
  });

  it("recovers when a parallel request already rotated the Lightwave refresh token", async () => {
    await connectLightwave(maria);
    await env.DB.prepare("UPDATE connections SET secret = ? WHERE provider = 'lightwave'")
      .bind(await seal("11".repeat(32), { basic_token: "basic-token-0123456789", refresh_token: "stale" }))
      .run();
    let refreshes = 0;
    const upstream = mockUpstream({
      "POST https://auth.lightwaverf.com/token": async (_req, body) => {
        refreshes += 1;
        if (JSON.parse(body).refresh_token === "stale") {
          // Simulate the other request winning the race between our read and our refresh
          await env.DB.prepare("UPDATE connections SET secret = ? WHERE provider = 'lightwave'")
            .bind(await seal("11".repeat(32), { basic_token: "basic-token-0123456789", refresh_token: "fresh" }))
            .run();
          return reply(400, { error: "invalid_token", error_description: "Unknown refresh token" });
        }
        return reply(200, { access_token: "access-2", refresh_token: "refresh-3", expires_in: 3600 });
      },
      "GET https://publicapi.lightwaverf.com/v1/structures": () => reply(200, { structures: ["s1"] }),
    });
    const res = await call(`${APP}/api/connections/lightwave/test`, { method: "POST" }, maria);
    upstream.done();
    expect(refreshes).toBe(2);
    expect(await res.json()).toEqual({ ok: true, structures: 1 });
  });

  it("saves a Spotify app, signs the account in through OAuth and lists it without secrets", async () => {
    const saved = await json(
      `${APP}/api/connections/spotify`,
      "PUT",
      { client_id: SPOTIFY_CLIENT_ID, client_secret: "fedcba9876543210fedcba9876543210" },
      maria,
    );
    expect(await saved.json()).toMatchObject({
      provider: "spotify",
      settings: { authorized: false },
      redirect_uri: `${APP}/api/connections/spotify/callback`,
    });
    // Left unfollowed: a followed redirect would come back into this Worker as a page request
    const sent = await call(`${APP}/api/connections/spotify/authorize`, { redirect: "manual" }, maria);
    expect(sent.status).toBe(302);
    const location = new URL(sent.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(`${SPOTIFY_ACCOUNTS}/authorize`);
    expect(location.searchParams.get("client_id")).toBe(SPOTIFY_CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(`${APP}/api/connections/spotify/callback`);
    expect(location.searchParams.get("scope")).toContain("user-modify-playback-state");
    const state = location.searchParams.get("state") ?? "";
    // A state this home did not make is refused before any code is exchanged
    const forged = await call(
      `${APP}/api/connections/spotify/callback?code=code-1&state=${state}x`,
      { redirect: "manual" },
      maria,
    );
    expect(forged.status).toBe(400);
    const upstream = mockUpstream({
      [`POST ${SPOTIFY_ACCOUNTS}/api/token`]: (_req, body) => {
        expect(formOf(body)).toMatchObject({
          grant_type: "authorization_code",
          code: "code-1",
          redirect_uri: `${APP}/api/connections/spotify/callback`,
        });
        return reply(200, { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
      },
      [`GET ${SPOTIFY}/me`]: () =>
        reply(200, { id: "maria", display_name: "Maria", product: "premium", country: "GB" }),
    });
    const back = await call(
      `${APP}/api/connections/spotify/callback?code=code-1&state=${state}`,
      { redirect: "manual" },
      maria,
    );
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe(`${APP}/#spotify`);
    upstream.done();
    const listed = (await (await call(`${APP}/api/connections`, {}, maria)).json()) as {
      provider: string;
      settings: unknown;
    }[];
    expect(listed).toEqual([
      {
        provider: "spotify",
        settings: { authorized: true, account: "Maria", premium: true, market: "GB" },
        created_at: expect.any(Number),
        updated_at: expect.any(Number),
      },
    ]);
    const row = await env.DB.prepare("SELECT secret FROM connections WHERE provider = 'spotify'").first<{
      secret: string;
    }>();
    expect(row?.secret).not.toContain("refresh-1");
    expect(row?.secret).not.toContain(SPOTIFY_CLIENT_ID);
  });

  it("tests the Spotify account: who signed in and how many devices are open", async () => {
    await connectSpotify(maria);
    const upstream = mockUpstream({
      [`GET ${SPOTIFY}/me`]: () =>
        reply(200, { id: "maria", display_name: "Maria", product: "premium", country: "GB" }),
      [`GET ${SPOTIFY}/me/player/devices`]: () =>
        reply(200, { devices: [{ id: "d1", name: "Kitchen", type: "Speaker", is_active: false, volume_percent: 50 }] }),
    });
    const res = await call(`${APP}/api/connections/spotify/test`, { method: "POST" }, maria);
    expect(await res.json()).toEqual({ ok: true, account: "Maria", premium: true, devices: 1 });
    upstream.done();
  });

  it("refreshes an expired Spotify access token and keeps the refresh token unless a new one comes", async () => {
    const urls = { accounts: SPOTIFY_ACCOUNTS, base: SPOTIFY };
    const secret = {
      client_id: "id",
      client_secret: "secret",
      refresh_token: "refresh-1",
      access_token: "old",
      access_expires_at: 1_000,
    };
    const upstream = mockUpstream({
      [`POST ${SPOTIFY_ACCOUNTS}/api/token`]: (_req, body) => {
        expect(formOf(body)).toEqual({ grant_type: "refresh_token", refresh_token: "refresh-1" });
        return reply(200, { access_token: "access-2", expires_in: 3600 });
      },
    });
    const fresh = await accessToken(urls, secret, 2_000_000);
    expect(fresh).toMatchObject({
      token: "access-2",
      refreshed: true,
      secret: { refresh_token: "refresh-1", access_token: "access-2" },
    });
    upstream.done();
    // Still valid: nothing is fetched
    expect(await accessToken(urls, fresh.secret, 2_000_000 + 60_000)).toMatchObject({
      token: "access-2",
      refreshed: false,
    });
  });

  it("removes a connection", async () => {
    await connectOpenai(maria);
    expect((await call(`${APP}/api/connections/openai`, { method: "DELETE" }, maria)).status).toBe(204);
    expect((await call(`${APP}/api/connections/openai`, { method: "DELETE" }, maria)).status).toBe(404);
    expect((await call(`${APP}/api/connections/nope`, { method: "DELETE" }, maria)).status).toBe(404);
  });
});
