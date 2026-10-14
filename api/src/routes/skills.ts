import { Hono } from "hono";
import { alarms, deleteAlarm, presenter, signalRinging, updateAlarm } from "../alarms";
import { devices } from "../db";
import * as schemas from "../schemas";
import { isSkill, SKILLS, skills } from "../skills";
import type { AppEnv } from "../types";
import { jsonBody, parse } from "../validate";

/** The Skills page: which skills are on. */
export const skillRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const on = await skills.enabled(c.env.DB, c.get("user").home);
    return c.json(SKILLS.map((s) => ({ ...s, enabled: on.has(s.id) })));
  })
  .patch("/:id", async (c) => {
    const id = parse(schemas.skillId, c.req.param("id"));
    if (!isSkill(id)) {
      return c.json({ error: "not_found" }, 404);
    }
    const { enabled } = await jsonBody(c, schemas.setSkill);
    await skills.set(c.env.DB, c.get("user").home, id, enabled);
    return c.json({ id, enabled });
  });

/** Skills, Alarms: what is coming, what happened lately, and changing either. */
export const alarmRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const home = c.get("user").home;
    const [show, upcoming, recent, owned] = await Promise.all([
      presenter(c, home),
      alarms.list(c.env.DB, home),
      alarms.recent(c.env.DB, home),
      devices.list(c.env.DB, home),
    ]);
    return c.json({
      alarms: upcoming.map(show.alarm),
      recent: recent.map(show.event),
      speakers: owned.map((d) => ({ id: d.id, name: d.name })),
      timezone: show.where.timezone,
    });
  })
  .patch("/:id", async (c) => {
    const home = c.get("user").home;
    const id = parse(schemas.alarmId, c.req.param("id"));
    const { enabled, device_id } = await jsonBody(c, schemas.updateAlarm);
    if (device_id && (await devices.get(c.env.DB, device_id))?.home_id !== home) {
      return c.json({ error: "not_your_speaker" }, 400);
    }
    const row = await updateAlarm(c, home, id, { enabled, deviceId: device_id });
    return row ? c.json((await presenter(c, home)).alarm(row)) : c.json({ error: "not_found" }, 404);
  })
  .delete("/:id", async (c) => {
    const id = parse(schemas.alarmId, c.req.param("id"));
    return (await deleteAlarm(c, c.get("user").home, id)) ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  })
  .post("/:id/stop", async (c) => {
    const id = parse(schemas.alarmId, c.req.param("id"));
    return c.json(await signalRinging(c, c.get("user").home, id, null));
  });
