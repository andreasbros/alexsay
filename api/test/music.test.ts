import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  APP,
  addUser,
  call,
  connectSpotify,
  DEVICE_ID,
  heartbeat,
  json,
  mockUpstream,
  noContent,
  reply,
  resetDb,
  SPOTIFY,
  signIn,
} from "./helpers";

const DEVICES = {
  devices: [
    { id: "d-kitchen", name: "Kitchen", type: "Speaker", is_active: false, volume_percent: 40 },
    { id: "d-phone", name: "Maria's iPhone", type: "Smartphone", is_active: true, volume_percent: 70 },
  ],
};
const PLAYLISTS = {
  items: [
    {
      id: "p1",
      name: "Dinner Jazz",
      uri: "spotify:playlist:p1",
      tracks: { total: 40 },
      owner: { display_name: "Maria" },
    },
    { id: "p2", name: "Running", uri: "spotify:playlist:p2", tracks: { total: 12 }, owner: { display_name: "Maria" } },
  ],
  next: null,
};
const device = { "x-device-id": DEVICE_ID };

const fromApp = (cookie: string, name: string, args: Record<string, unknown> = {}) =>
  json(`${APP}/api/tools/call`, "POST", { name, arguments: args }, cookie).then(
    async (r) => ((await r.json()) as { output: unknown }).output,
  );
const fromSpeaker = (name: string, args: Record<string, unknown> = {}) =>
  call(`${APP}/v1/device/tools/call`, {
    method: "POST",
    headers: device,
    body: JSON.stringify({ name, arguments: args }),
  }).then(async (r) => ((await r.json()) as { output: unknown }).output);

describe("music through Spotify", () => {
  let maria: string;

  beforeEach(async () => {
    await resetDb();
    await addUser("maria", "maria-pass", "user");
    maria = await signIn("maria", "maria-pass");
    await heartbeat(DEVICE_ID, { firmware: "0.2.0" });
    await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID, name: "Kitchen" }, maria);
  });

  it("offers the music tools only once a Spotify account is signed in", async () => {
    const names = async () => {
      const session = (await (await call(`${APP}/v1/device/session`, { headers: device })).json()) as {
        session: { delegation: { responses: { tools: { name: string }[] } } };
      };
      return session.session.delegation.responses.tools.map((t) => t.name);
    };
    await json(`${APP}/api/connections/openai`, "PUT", { api_key: "sk-test-0123456789abcdefghijklmnop" }, maria);
    expect(await names()).not.toContain("play_music");
    await connectSpotify(maria);
    const tools = await names();
    expect(tools).toEqual(expect.arrayContaining(["play_music", "list_playlists", "pause_music", "now_playing"]));
  });

  it("plays one of the user's playlists on the speaker the user is talking from", async () => {
    await connectSpotify(maria);
    const played: string[] = [];
    const upstream = mockUpstream({
      [`GET ${SPOTIFY}/me/player/devices`]: () => reply(200, DEVICES),
      [`GET ${SPOTIFY}/me/playlists?limit=50&offset=0`]: () => reply(200, PLAYLISTS),
      [`PUT ${SPOTIFY}/me/player/play?device_id=d-kitchen`]: (_req, body) => {
        played.push(body);
        return noContent();
      },
    });
    const output = await fromSpeaker("play_music", { query: "dinner jazz" });
    expect(output).toEqual({ playing: "Dinner Jazz", kind: "playlist", by: "Maria", on: "Kitchen" });
    expect(JSON.parse(played[0] ?? "{}")).toEqual({ context_uri: "spotify:playlist:p1" });
    upstream.done();
  });

  it("searches for a song from the app and plays it where Spotify is active", async () => {
    await connectSpotify(maria);
    const upstream = mockUpstream({
      [`GET ${SPOTIFY}/me/player/devices`]: () => reply(200, DEVICES),
      [`GET ${SPOTIFY}/me/playlists?limit=50&offset=0`]: () => reply(200, PLAYLISTS),
      [`GET ${SPOTIFY}/search?*`]: (req) => {
        const url = new URL(req.url);
        expect(url.searchParams.get("q")).toBe("get lucky");
        expect(url.searchParams.get("type")).toBe("track,album,artist,playlist");
        return reply(200, {
          tracks: { items: [{ uri: "spotify:track:t1", name: "Get Lucky", artists: [{ name: "Daft Punk" }] }] },
          albums: { items: [] },
          artists: { items: [] },
          playlists: { items: [null] },
        });
      },
      [`PUT ${SPOTIFY}/me/player/play?device_id=d-phone`]: (_req, body) => {
        expect(JSON.parse(body)).toEqual({ uris: ["spotify:track:t1"] });
        return noContent();
      },
    });
    const output = await fromApp(maria, "play_music", { query: "get lucky" });
    expect(output).toEqual({ playing: "Get Lucky", kind: "track", by: "Daft Punk", on: "Maria's iPhone" });
    upstream.done();
  });

  it("plays an artist when the whole query is their name, on the speaker the user named", async () => {
    await connectSpotify(maria);
    const upstream = mockUpstream({
      [`GET ${SPOTIFY}/me/player/devices`]: () => reply(200, DEVICES),
      [`GET ${SPOTIFY}/me/playlists?limit=50&offset=0`]: () => reply(200, PLAYLISTS),
      [`GET ${SPOTIFY}/search?*`]: () =>
        reply(200, {
          tracks: { items: [{ uri: "spotify:track:t2", name: "One More Time", artists: [{ name: "Daft Punk" }] }] },
          artists: { items: [{ uri: "spotify:artist:a1", name: "Daft Punk" }] },
        }),
      [`PUT ${SPOTIFY}/me/player/play?device_id=d-kitchen`]: (_req, body) => {
        expect(JSON.parse(body)).toEqual({ context_uri: "spotify:artist:a1" });
        return noContent();
      },
    });
    const output = await fromApp(maria, "play_music", { query: "Daft Punk", speaker: "kitchen" });
    expect(output).toEqual({ playing: "Daft Punk", kind: "artist", by: "", on: "Kitchen" });
    upstream.done();
  });

  it("lists playlists, says what is playing, pauses, skips and sets the volume", async () => {
    await connectSpotify(maria);
    const state = {
      is_playing: true,
      device: { id: "d-phone", name: "Maria's iPhone" },
      progress_ms: 1000,
      item: {
        name: "Get Lucky",
        duration_ms: 200_000,
        artists: [{ name: "Daft Punk" }],
        album: { name: "Random Access Memories" },
      },
      context: { type: "album", uri: "spotify:album:x" },
    };
    const upstream = mockUpstream({
      [`GET ${SPOTIFY}/me/playlists?limit=50&offset=0`]: () => reply(200, PLAYLISTS),
      [`GET ${SPOTIFY}/me/player`]: () => reply(200, state),
      [`PUT ${SPOTIFY}/me/player/pause?device_id=d-phone`]: () => noContent(),
      [`POST ${SPOTIFY}/me/player/next`]: () => noContent(),
      [`PUT ${SPOTIFY}/me/player/volume?volume_percent=30`]: () => noContent(),
    });
    expect(await fromApp(maria, "list_playlists")).toEqual([
      { name: "Dinner Jazz", tracks: 40, owner: "Maria" },
      { name: "Running", tracks: 12, owner: "Maria" },
    ]);
    expect(await fromApp(maria, "now_playing")).toEqual({
      playing: true,
      track: "Get Lucky",
      by: "Daft Punk",
      album: "Random Access Memories",
      on: "Maria's iPhone",
    });
    expect(await fromApp(maria, "pause_music")).toEqual({ paused: true, on: "Maria's iPhone" });
    expect(await fromApp(maria, "skip_track")).toEqual({ skipped: "next", now: "Get Lucky by Daft Punk" });
    expect(await fromApp(maria, "set_music_volume", { percent: 30 })).toEqual({ volume: 30 });
    upstream.done();
  });

  it("explains a free account and a missing player in words", async () => {
    await connectSpotify(maria, "free");
    const upstream = mockUpstream({
      [`GET ${SPOTIFY}/me/player/devices`]: () => reply(200, DEVICES),
      [`GET ${SPOTIFY}/me/playlists?limit=50&offset=0`]: () => reply(200, PLAYLISTS),
      [`PUT ${SPOTIFY}/me/player/play?device_id=d-phone`]: () =>
        reply(403, {
          error: { status: 403, message: "Player command failed: Premium required", reason: "PREMIUM_REQUIRED" },
        }),
    });
    expect(await fromApp(maria, "play_music", { query: "running" })).toEqual({
      error: "Spotify Premium is needed to control playback; this account is not Premium",
    });
    upstream.done();
    const nobody = mockUpstream({
      [`GET ${SPOTIFY}/me/player/devices`]: () => reply(200, { devices: [] }),
    });
    expect(await fromApp(maria, "play_music", { query: "running" })).toEqual({
      error: "no Spotify device is open: open Spotify on a phone, computer or speaker first",
    });
    nobody.done();
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM server_log WHERE message LIKE 'tool play_music%'").first(),
    ).toEqual({ n: 2 });
  });

  it("is not connected until the account signed in", async () => {
    await json(
      `${APP}/api/connections/spotify`,
      "PUT",
      { client_id: "0123456789abcdef0123456789abcdef", client_secret: "fedcba9876543210fedcba9876543210" },
      maria,
    );
    expect(await fromApp(maria, "now_playing")).toEqual({
      error: "Spotify is not connected: the home's admin signs in under Connections",
    });
  });
});
