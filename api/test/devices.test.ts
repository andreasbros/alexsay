import { beforeEach, describe, expect, it } from "vitest";
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
