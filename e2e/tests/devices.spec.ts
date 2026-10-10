import { request } from "@playwright/test";
import { addDevice, apiSession, env, expect, heartbeat, login, test } from "./helpers";

test("a speaker that calls home can be claimed, then receives its owner's settings", async ({ page, deviceId }) => {
  const anonymous = await request.newContext();
  const first = await heartbeat(anonymous, deviceId);
  expect(first.status()).toBe(200);
  expect(await first.json()).toMatchObject({ claimed: false });

  await login(page, env.user());
  await addDevice(page, deviceId, "Pilot speaker");
  await expect(page.getByRole("row", { name: /Pilot speaker/ }).getByText("online")).toBeVisible();

  const second = await heartbeat(anonymous, deviceId, { uptime_s: 60 });
  expect(await second.json()).toMatchObject({ claimed: true, name: "Pilot speaker" });
  await anonymous.dispose();
});

test("a speaker can be added before it ever calls home and shows offline", async ({ page, deviceId }) => {
  await login(page, env.user());
  await addDevice(page, deviceId);
  await expect(page.getByRole("row", { name: new RegExp(deviceId) }).getByText("offline")).toBeVisible();
});

test("nobody else can claim an owned speaker", async ({ deviceId }) => {
  const user = await apiSession(env.user());
  expect((await user.post("/api/devices", { data: { id: deviceId } })).status()).toBe(201);
  const admin = await apiSession(env.admin());
  expect((await admin.post("/api/devices", { data: { id: deviceId } })).status()).toBe(409);
  await user.dispose();
  await admin.dispose();
});

test("the admin sees every speaker with its owner", async ({ page, deviceId }) => {
  const user = await apiSession(env.user());
  await user.post("/api/devices", { data: { id: deviceId, name: "Owned by user" } });
  await user.dispose();
  await login(page, env.admin());
  const row = page.getByRole("row", { name: /Owned by user/ });
  await expect(row.getByText(env.user().username)).toBeVisible();
});
