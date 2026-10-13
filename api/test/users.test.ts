import { beforeEach, describe, expect, it } from "vitest";
import { APP, addUser, call, json, resetDb, signIn } from "./helpers";

describe("users", () => {
  let admin: string;

  beforeEach(async () => {
    await resetDb();
    await addUser("andreas", "admin-pass", "admin");
    await addUser("maria", "maria-pass", "user");
    admin = await signIn("andreas", "admin-pass");
  });

  it("is admin only", async () => {
    const maria = await signIn("maria", "maria-pass");
    expect((await call(`${APP}/api/users`, {}, maria)).status).toBe(403);
  });

  it("lists users with their roles and device counts", async () => {
    await json(`${APP}/api/devices`, "POST", { id: "7d1d6e2e-7c7b-4f6a-9d0a-1d2e3f4a5b6c" }, admin);
    const list = await (await call(`${APP}/api/users`, {}, admin)).json();
    expect(list).toEqual([
      expect.objectContaining({ username: "andreas", role: "admin", devices: 1 }),
      expect.objectContaining({ username: "maria", role: "user", devices: 0 }),
    ]);
  });

  it("assigns roles but protects the last admin and the signed-in user", async () => {
    expect((await call(`${APP}/api/users/andreas`, { method: "DELETE" }, admin)).status).toBe(409);
    expect((await json(`${APP}/api/users/andreas`, "PATCH", { role: "user" }, admin)).status).toBe(409);
    expect((await json(`${APP}/api/users/ghost`, "PATCH", { role: "user" }, admin)).status).toBe(404);
    expect((await json(`${APP}/api/users/maria`, "PATCH", { role: "admin" }, admin)).status).toBe(204);
    expect((await json(`${APP}/api/users/andreas`, "PATCH", { role: "user" }, admin)).status).toBe(204);
    expect((await call(`${APP}/api/users`, {}, admin)).status).toBe(403);
  });

  it("lets an admin create accounts without using up the address's registrations", async () => {
    const maria = await signIn("maria", "maria-pass");
    expect((await json(`${APP}/api/users`, "POST", { username: "tom", password: "tom-pass-123" }, maria)).status).toBe(
      403,
    );
    for (let i = 0; i < 45; i++) {
      const res = await json(`${APP}/api/users`, "POST", { username: `e2e-${i}`, password: "a-long-password" }, admin);
      expect(res.status).toBe(201);
    }
    expect(
      (await json(`${APP}/api/users`, "POST", { username: "e2e-0", password: "a-long-password" }, admin)).status,
    ).toBe(409);
    expect(await signIn("e2e-44", "a-long-password")).toBeTruthy();
    const registered = await call(`${APP}/api/session/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "walk-in", password: "a-long-password" }),
    });
    expect(registered.status).toBe(201);
  });
});
