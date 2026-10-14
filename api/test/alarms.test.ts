import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ruleFrom } from "../src/alarm_tools";
import { runDue } from "../src/scheduler";
import { toolDefinitions } from "../src/tools";
import { APP, addUser, call, DEVICE_ID, json, resetDb, signIn } from "./helpers";

const SECOND_DEVICE = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const device = { "x-device-id": DEVICE_ID };

const tool = async (cookie: string, name: string, args: Record<string, unknown>) =>
  (
    (await (await json(`${APP}/api/tools/call`, "POST", { name, arguments: args }, cookie)).json()) as {
      output: Record<string, unknown>;
    }
  ).output;

const deviceTool = async (name: string, args: Record<string, unknown>) =>
  (
    (await (
      await call(`${APP}/v1/device/tools/call`, {
        method: "POST",
        headers: device,
        body: JSON.stringify({ name, arguments: args }),
      })
    ).json()) as { output: Record<string, unknown> }
  ).output;

const speakerAlarms = async () =>
  (await (await call(`${APP}/v1/device/alarms`, { headers: device })).json()) as {
    alarms: { id: string; kind: string; label: string; say: string; fires: number[] }[];
  };

const report = (events: Record<string, unknown>[]) =>
  call(`${APP}/v1/device/alarms/events`, { method: "POST", headers: device, body: JSON.stringify({ events }) });

describe("alarms skill", () => {
  let maria: string;

  beforeEach(async () => {
    await resetDb();
    await addUser("maria", "maria-pass", "user");
    maria = await signIn("maria", "maria-pass");
    await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID, name: "Kitchen" }, maria);
  });

  it("sets a one minute timer on the only speaker, counted from the server's clock", async () => {
    const before = Date.now();
    const out = await tool(maria, "set_alarm", { in_seconds: 60 });
    expect(out).toMatchObject({ ok: true, kind: "timer", label: "1 minute timer", speaker: "Kitchen", enabled: true });
    expect(out.next_at as number).toBeGreaterThanOrEqual(before + 60_000);
    expect(out.next_at as number).toBeLessThan(Date.now() + 61_000);

    const { alarms } = await speakerAlarms();
    expect(alarms).toEqual([
      { id: out.id, kind: "timer", label: "1 minute timer", say: "1 minute timer.", fires: [out.next_at] },
    ]);
    const job = await env.DB.prepare("SELECT topic, next_at FROM jobs").first<{ topic: string; next_at: number }>();
    expect(job).toEqual({ topic: "alarm.verify", next_at: (out.next_at as number) + 45_000 });
  });

  it("wakes the user's scheduler at the earliest job, and clears it when none are left", async () => {
    const later = await tool(maria, "set_alarm", { in_seconds: 600 });
    const sooner = await tool(maria, "set_alarm", { in_seconds: 60 });
    const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName("maria"));
    const alarmAt = () => runInDurableObject(stub, (_s, state: DurableObjectState) => state.storage.getAlarm());
    expect(await alarmAt()).toBe((sooner.next_at as number) + 45_000);
    await call(`${APP}/api/alarms/${sooner.id}`, { method: "DELETE" }, maria);
    expect(await alarmAt()).toBe((later.next_at as number) + 45_000);
    await call(`${APP}/api/alarms/${later.id}`, { method: "DELETE" }, maria);
    expect(await alarmAt()).toBeNull();
  });

  it("reads a local clock time in the user's zone and refuses one that has passed", () => {
    const now = Date.parse("2026-10-14T10:00:00Z");
    expect(ruleFrom({ at: "2026-10-15T13:00" }, "Europe/London", now)).toEqual({
      rule: { kind: "at", at: Date.parse("2026-10-15T12:00:00Z") },
    });
    expect(ruleFrom({ at: "2026-10-14T09:00" }, "Europe/London", now)).toMatchObject({ error: expect.any(String) });
    expect(ruleFrom({ time: "07:00", repeat: "weekdays" }, "Europe/London", now)).toEqual({
      rule: { kind: "repeat", time: "07:00", days: [1, 2, 3, 4, 5], tz: "Europe/London" },
    });
    expect(ruleFrom({ in_seconds: 60, at: "2026-10-15T13:00" }, "Europe/London", now)).toMatchObject({
      error: expect.any(String),
    });
  });

  it("asks which speaker when set from the web with several, and rings where it was asked from a speaker", async () => {
    await json(`${APP}/api/devices`, "POST", { id: SECOND_DEVICE, name: "Bedroom" }, maria);
    const unsure = await tool(maria, "set_alarm", { time: "07:00", repeat: "daily", label: "wake up" });
    expect(unsure).toMatchObject({ error: expect.stringContaining("which"), speakers: ["Kitchen", "Bedroom"] });
    const chosen = await tool(maria, "set_alarm", { time: "07:00", repeat: "daily", speaker: "bedroom" });
    expect(chosen).toMatchObject({ ok: true, speaker: "Bedroom", repeat: "daily at 07:00" });

    const fromKitchen = await deviceTool("set_alarm", { in_seconds: 300, label: "pasta" });
    expect(fromKitchen).toMatchObject({ ok: true, speaker: "Kitchen", label: "pasta" });
    const { alarms } = await speakerAlarms();
    expect(alarms.map((a) => a.label)).toEqual(["pasta"]);
  });

  it("keeps the next three of a repeating alarm on the speaker, so it rings while offline", async () => {
    await tool(maria, "set_alarm", { time: "07:00", repeat: "daily" });
    const [alarm] = (await speakerAlarms()).alarms;
    expect(alarm?.fires).toHaveLength(3);
    expect((alarm?.fires[1] ?? 0) - (alarm?.fires[0] ?? 0)).toBeGreaterThanOrEqual(23 * 3_600_000);
  });

  it("records what the speaker reports once, and a stopped one-off is done", async () => {
    const out = await tool(maria, "set_alarm", { in_seconds: 60, kind: "alarm", label: "tea" });
    const occurrence = out.next_at as number;
    const events = [
      { alarm_id: out.id, occurrence, event: "rang", at: occurrence },
      { alarm_id: out.id, occurrence, event: "stopped", at: occurrence + 5_000 },
    ];
    expect(await (await report(events)).json()).toEqual({ recorded: 2 });
    expect(await (await report(events)).json()).toEqual({ recorded: 0 });

    const page = (await (await call(`${APP}/api/alarms`, {}, maria)).json()) as {
      alarms: unknown[];
      recent: { event: string; label: string }[];
    };
    expect(page.alarms).toEqual([]);
    expect(page.recent).toEqual([expect.objectContaining({ event: "stopped", label: "tea" })]);
    expect((await speakerAlarms()).alarms).toEqual([]);
  });

  it("counts an alarm the speaker never reported as missed, 45 s after it was due", async () => {
    const out = await tool(maria, "set_alarm", { in_seconds: 60, label: "gym" });
    const due = (out.next_at as number) + 45_000;
    expect(await runDue({ env }, "maria", due - 1_000)).toBe(0);
    expect(await runDue({ env }, "maria", due)).toBe(1);
    const event = await env.DB.prepare("SELECT event, occurrence, detail FROM alarm_events").first();
    expect(event).toEqual({ event: "missed", occurrence: out.next_at, detail: "no word from the speaker" });
    // At least once: running it again changes nothing
    await env.DB.prepare("UPDATE jobs SET next_at = ?, enabled = 1").bind(due).run();
    await runDue({ env }, "maria", due);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM alarm_events").first<{ n: number }>())?.n).toBe(1);
  });

  it("does not count a reported alarm as missed, and moves a repeating one to its next day", async () => {
    const out = await tool(maria, "set_alarm", { time: "07:00", repeat: "daily" });
    const occurrence = out.next_at as number;
    await report([{ alarm_id: out.id, occurrence, event: "rang", at: occurrence }]);
    await runDue({ env }, "maria", occurrence + 45_000);
    const events = await env.DB.prepare("SELECT event FROM alarm_events").all();
    expect(events.results).toEqual([{ event: "rang" }]);
    const row = await env.DB.prepare("SELECT next_at FROM alarms").first<{ next_at: number }>();
    expect(row?.next_at).toBe(occurrence + 86_400_000);
  });

  it("switches alarms off, moves them between speakers and deletes them from the app", async () => {
    await json(`${APP}/api/devices`, "POST", { id: SECOND_DEVICE, name: "Bedroom" }, maria);
    const out = await tool(maria, "set_alarm", { time: "07:00", repeat: "weekdays", speaker: "Kitchen" });
    const id = out.id as string;
    const off = await (await json(`${APP}/api/alarms/${id}`, "PATCH", { enabled: false }, maria)).json();
    expect(off).toMatchObject({ enabled: false, next_at: null });
    expect((await speakerAlarms()).alarms).toEqual([]);
    const moved = await (
      await json(`${APP}/api/alarms/${id}`, "PATCH", { enabled: true, device_id: SECOND_DEVICE }, maria)
    ).json();
    expect(moved).toMatchObject({ enabled: true, speaker: "Bedroom" });
    expect((await call(`${APP}/api/alarms/${id}`, { method: "DELETE" }, maria)).status).toBe(204);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>())?.n).toBe(0);
  });

  it("refuses another user's speaker", async () => {
    await addUser("tom", "tom-pass-1", "user");
    const tom = await signIn("tom", "tom-pass-1");
    await json(`${APP}/api/devices`, "POST", { id: SECOND_DEVICE, name: "Tom's" }, tom);
    const out = await tool(maria, "set_alarm", { in_seconds: 60 });
    const res = await json(`${APP}/api/alarms/${out.id}`, "PATCH", { device_id: SECOND_DEVICE }, maria);
    expect(res.status).toBe(400);
  });

  it("takes the skill's tools away when the user switches it off", async () => {
    const skills = (await (await call(`${APP}/api/skills`, {}, maria)).json()) as { id: string; enabled: boolean }[];
    expect(skills).toEqual([expect.objectContaining({ id: "alarms", enabled: true })]);
    await json(`${APP}/api/skills/alarms`, "PATCH", { enabled: false }, maria);
    expect(await tool(maria, "set_alarm", { in_seconds: 60 })).toMatchObject({ error: expect.stringContaining("off") });
    const names = (on: ReadonlySet<"alarms">) => toolDefinitions(false, false, false, false, on).map((t) => t.name);
    expect(names(new Set())).not.toContain("set_alarm");
    expect(names(new Set(["alarms"]))).toEqual(expect.arrayContaining(["set_alarm", "snooze_alarm", "stop_alarm"]));
  });

  it("tells a speaker that is not connected nothing, without failing", async () => {
    const out = await tool(maria, "stop_alarm", {});
    expect(out).toEqual({ ok: true, speakers: ["Kitchen"], online: 0 });
  });
});
