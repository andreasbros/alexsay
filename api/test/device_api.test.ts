import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { APP, addUser, call, connectOpenai, DEVICE_ID, heartbeat, json, OPENAI_KEY, resetDb, signIn } from "./helpers";

describe("device heartbeat", () => {
  let maria: string;

  beforeEach(async () => {
    await resetDb();
    await addUser("maria", "maria-pass", "user");
    maria = await signIn("maria", "maria-pass");
  });

  it("answers the health check without credentials", async () => {
    const res = await call(`${APP}/v1/device/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("needs a UUID device id", async () => {
    expect((await heartbeat(null)).status).toBe(400);
    expect((await heartbeat("not-a-uuid")).status).toBe(400);
  });

  it("registers an unknown speaker as unclaimed and tells it to keep polling", async () => {
    const res = await heartbeat(DEVICE_ID, { firmware: "0.1.0", uptime_s: 12 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ claimed: false, poll_s: 30 });
    const row = await env.DB.prepare("SELECT * FROM devices WHERE id = ?").bind(DEVICE_ID).first();
    expect(row).toMatchObject({ owner: null, firmware: "0.1.0" });
  });

  it("hands a claimed speaker its owner's assistant credentials", async () => {
    await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID, name: "Kitchen" }, maria);
    const before = await (await heartbeat(DEVICE_ID)).json();
    expect(before).toMatchObject({ claimed: true, name: "Kitchen", assistant: null });
    await connectOpenai(maria, { voice: "cedar" });
    const after = await (await heartbeat(DEVICE_ID)).json();
    expect(after).toMatchObject({
      claimed: true,
      assistant: { provider: "openai", api_key: OPENAI_KEY, model: "gpt-live-1", voice: "cedar" },
    });
  });
});
