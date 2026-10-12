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
      account: { locale: "en-GB", timezone: "Europe/London" },
    });
  });
});

describe("device assistant", () => {
  let maria: string;
  const device = { "x-device-id": DEVICE_ID };

  beforeEach(async () => {
    await resetDb();
    await addUser("maria", "maria-pass", "user");
    maria = await signIn("maria", "maria-pass");
    await heartbeat(DEVICE_ID, { firmware: "0.2.0" });
  });

  it("refuses an unclaimed or unknown speaker", async () => {
    expect((await call(`${APP}/v1/device/session`, { headers: device })).status).toBe(403);
    expect((await call(`${APP}/v1/device/session`, { headers: { "x-device-id": "nope" } })).status).toBe(400);
    expect((await call(`${APP}/v1/device/tools/call`, { method: "POST", headers: device })).status).toBe(403);
  });

  it("gives a claimed speaker the owner's session, runs its tools and keeps its conversations", async () => {
    await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID, name: "Kitchen" }, maria);
    expect((await call(`${APP}/v1/device/session`, { headers: device })).status).toBe(412);
    await connectOpenai(maria);
    const session = (await (await call(`${APP}/v1/device/session`, { headers: device })).json()) as {
      api_key: string;
      session: { model: string; instructions: string; delegation: { responses: { tools: { name: string }[] } } };
      device: { name: string };
    };
    expect(session.api_key).toBe(OPENAI_KEY);
    expect(session.device).toEqual({ id: DEVICE_ID, name: "Kitchen" });
    expect(session.session.model).toBe("gpt-live-1");
    expect(session.session.instructions).toContain("Today is");
    expect(session.session.delegation.responses.tools.map((t) => t.name)).toContain("remember");

    const started = await call(`${APP}/v1/device/conversations`, { method: "POST", headers: device });
    expect(started.status).toBe(201);
    const { id } = (await started.json()) as { id: string };
    const remembered = await call(`${APP}/v1/device/tools/call`, {
      method: "POST",
      headers: { ...device, "content-type": "application/json" },
      body: JSON.stringify({
        name: "remember",
        arguments: { category: "preferences", content: "Likes the kitchen warm" },
        conversation_id: id,
      }),
    });
    expect(await remembered.json()).toMatchObject({ output: { ok: true } });
    const turns = await call(`${APP}/v1/device/conversations/${id}/turns`, {
      method: "POST",
      headers: { ...device, "content-type": "application/json" },
      body: JSON.stringify({ turns: [{ at: 1, role: "user", text: "Alexsay, remember I like the kitchen warm" }] }),
    });
    expect(turns.status).toBe(204);
    expect((await call(`${APP}/v1/device/conversations/${id}/end`, { method: "POST", headers: device })).status).toBe(
      204,
    );
    const history = (await (await call(`${APP}/api/conversations/${id}`, {}, maria)).json()) as {
      source: string;
      device_id: string;
      turns: { text: string }[];
    };
    expect(history).toMatchObject({ source: "device", device_id: DEVICE_ID });
    expect(history.turns.map((t) => t.text)).toEqual(["Alexsay, remember I like the kitchen warm"]);
    const memories = (await (await call(`${APP}/api/memories`, {}, maria)).json()) as { content: string }[];
    expect(memories.map((m) => m.content)).toEqual(["Likes the kitchen warm"]);
  });
});
