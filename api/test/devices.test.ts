import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP, addUser, call, DEVICE_ID, heartbeat, json, resetDb, signIn } from "./helpers";

interface DeviceView {
  id: string;
  name: string;
  owner: string | null;
  online: boolean;
}

describe("devices", () => {
  let admin: string;
  let maria: string;

  beforeEach(async () => {
    await resetDb();
    await addUser("andreas", "admin-pass", "admin");
    await addUser("maria", "maria-pass", "user");
    admin = await signIn("andreas", "admin-pass");
    maria = await signIn("maria", "maria-pass");
  });

  it("needs a session", async () => {
    expect((await call(`${APP}/api/devices`)).status).toBe(401);
  });

  it("lets a user add a speaker by UUID before it ever called home", async () => {
    const res = await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID.toUpperCase(), name: "Kitchen" }, maria);
    expect(res.status).toBe(201);
    const list = (await (await call(`${APP}/api/devices`, {}, maria)).json()) as DeviceView[];
    expect(list).toEqual([expect.objectContaining({ id: DEVICE_ID, name: "Kitchen", owner: "maria", online: false })]);
  });

  it("rejects anything that is not a UUID", async () => {
    expect((await json(`${APP}/api/devices`, "POST", { id: "speaker-1" }, maria)).status).toBe(400);
  });

  it("claims a speaker that already called home, and only once", async () => {
    expect((await heartbeat(DEVICE_ID, { firmware: "0.1.0" })).status).toBe(200);
    expect((await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID }, maria)).status).toBe(201);
    expect((await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID }, maria)).status).toBe(409);
    await addUser("sam", "sam-pass", "user");
    const sam = await signIn("sam", "sam-pass");
    expect((await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID }, sam)).status).toBe(409);
    expect((await call(`${APP}/api/devices`, {}, sam)).json()).resolves.toEqual([]);
  });

  it("shows a speaker's sound state, pushes the app's changes to it and takes what it reports", async () => {
    await heartbeat(DEVICE_ID, { firmware: "0.1.9", volume: 80, mic_muted: false });
    await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID, name: "Kitchen" }, maria);
    const sound = async () =>
      ((await (await call(`${APP}/api/devices`, {}, maria)).json()) as { sound: unknown }[])[0]?.sound;
    expect(await sound()).toEqual({ volume: 80, mic_muted: false });
    // Not connected: nothing to push to
    const offline = await json(`${APP}/api/devices/${DEVICE_ID}/sound`, "POST", { volume: 40 }, maria);
    expect(offline.status).toBe(409);
    const res = await SELF.fetch(`${APP}/v1/device/line`, {
      headers: { upgrade: "websocket", "x-device-id": DEVICE_ID },
    });
    const ws = res.webSocket;
    if (!ws) {
      throw new Error("no line");
    }
    ws.accept();
    const received: Record<string, unknown>[] = [];
    ws.addEventListener("message", (event) => received.push(JSON.parse(String(event.data)) as Record<string, unknown>));
    // A member, not only an admin, may turn a speaker down or mute it
    await addUser("tom", "tom-pass", "user");
    const tom = await signIn("tom", "tom-pass");
    await json(`${APP}/api/home/members`, "POST", { username: "tom" }, maria).catch(() => undefined);
    const pushed = await json(`${APP}/api/devices/${DEVICE_ID}/sound`, "POST", { volume: 40 }, maria);
    expect(await pushed.json()).toEqual({ delivered: true, sound: { volume: 40, mic_muted: false } });
    await vi.waitFor(() => expect(received).toContainEqual({ type: "sound.set", volume: 40 }));
    // The speaker says what it ended up with (on connect and after every change)
    ws.send(JSON.stringify({ type: "sound", volume: 40, mic_muted: true }));
    await vi.waitFor(async () => expect(await sound()).toEqual({ volume: 40, mic_muted: true }));
    expect((await json(`${APP}/api/devices/${DEVICE_ID}/sound`, "POST", {}, maria)).status).toBe(400);
    expect((await json(`${APP}/api/devices/${DEVICE_ID}/sound`, "POST", { volume: 10 }, tom)).status).toBe(404);
    expect(env).toBeDefined();
  });

  it("shows admins every speaker and lets them reassign one", async () => {
    await heartbeat(DEVICE_ID);
    await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID, name: "Hall" }, maria);
    const all = (await (await call(`${APP}/api/devices`, {}, admin)).json()) as DeviceView[];
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ owner: "maria", online: true });
    expect((await json(`${APP}/api/devices/${DEVICE_ID}`, "PATCH", { owner: "andreas" }, maria)).status).toBe(403);
    expect((await json(`${APP}/api/devices/${DEVICE_ID}`, "PATCH", { owner: "andreas" }, admin)).status).toBe(204);
    expect((await call(`${APP}/api/devices`, {}, maria)).json()).resolves.toEqual([]);
  });

  it("renames and releases a speaker; an admin delete removes it", async () => {
    await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID }, maria);
    expect((await json(`${APP}/api/devices/${DEVICE_ID}`, "PATCH", { name: "Study" }, maria)).status).toBe(204);
    expect((await call(`${APP}/api/devices/${DEVICE_ID}`, { method: "DELETE" }, maria)).status).toBe(204);
    const all = (await (await call(`${APP}/api/devices`, {}, admin)).json()) as DeviceView[];
    expect(all).toEqual([expect.objectContaining({ name: "Study", owner: null })]);
    expect((await call(`${APP}/api/devices/${DEVICE_ID}`, { method: "DELETE" }, admin)).status).toBe(204);
    expect((await call(`${APP}/api/devices`, {}, admin)).json()).resolves.toEqual([]);
  });
});
