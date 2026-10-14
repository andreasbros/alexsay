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
    const on = await skills.enabled(c.env.DB, c.get("user").username);
    return c.json(SKILLS.map((s) => ({ ...s, enabled: on.has(s.id) })));
  })
  .patch("/:id", async (c) => {
    const id = parse(schemas.skillId, c.req.param("id"));
    if (!isSkill(id)) {
      return c.json({ error: "not_found" }, 404);
    }
    const { enabled } = await jsonBody(c, schemas.setSkill);
    await skills.set(c.env.DB, c.get("user").username, id, enabled);
    return c.json({ id, enabled });
  });

/** Skills, Alarms: what is coming, what happened lately, and changing either. */
export const alarmRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const username = c.get("user").username;
    const [show, upcoming, recent, owned] = await Promise.all([
      presenter(c, username),
      alarms.list(c.env.DB, username),
      alarms.recent(c.env.DB, username),
      devices.list(c.env.DB, username),
    ]);
    return c.json({
      alarms: upcoming.map(show.alarm),
      recent: recent.map(show.event),
      speakers: owned.map((d) => ({ id: d.id, name: d.name })),
      timezone: show.where.timezone,
    });
  })
  .patch("/:id", async (c) => {
    const username = c.get("user").username;
    const id = parse(schemas.alarmId, c.req.param("id"));
    const { enabled, device_id } = await jsonBody(c, schemas.updateAlarm);
    if (device_id && (await devices.get(c.env.DB, device_id))?.owner !== username) {
      return c.json({ error: "not_your_speaker" }, 400);
    }
    const row = await updateAlarm(c, username, id, { enabled, deviceId: device_id });
    return row ? c.json((await presenter(c, username)).alarm(row)) : c.json({ error: "not_found" }, 404);
  })
  .delete("/:id", async (c) => {
    const id = parse(schemas.alarmId, c.req.param("id"));
    return (await deleteAlarm(c, c.get("user").username, id)) ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  })
  .post("/:id/stop", async (c) => {
    const id = parse(schemas.alarmId, c.req.param("id"));
    return c.json(await signalRinging(c, c.get("user").username, id, null));
  });
