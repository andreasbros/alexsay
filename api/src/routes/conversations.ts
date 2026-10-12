import { Hono } from "hono";
import { addTurns, endConversation, startConversation } from "../assistant_api";
import { conversations, memories } from "../db";
import * as schemas from "../schemas";
import type { AppEnv } from "../types";
import { jsonBody, parse } from "../validate";

const conversationId = (value: string) => parse(schemas.memoryId, value);

/** Conversation history: the app records turns as they happen and closes the record when the call ends. */
export const conversationRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const { limit, q } = parse(schemas.conversationList, c.req.query());
    return c.json(await conversations.list(c.env.DB, c.get("user").username, limit, q));
  })
  .post("/", async (c) => {
    const { source, device_id } = await jsonBody(c, schemas.startConversation);
    return c.json({ id: await startConversation(c.env, c.get("user").username, source, device_id ?? null) }, 201);
  })
  .get("/:id", async (c) => {
    const row = await conversations.get(c.env.DB, c.get("user").username, conversationId(c.req.param("id")));
    if (!row) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({ ...row, turns: await conversations.turns(c.env.DB, row.id) });
  })
  .post("/:id/turns", async (c) => {
    const { turns } = await jsonBody(c, schemas.addTurns);
    const ok = await addTurns(c.env, c.get("user").username, conversationId(c.req.param("id")), turns);
    return ok ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  })
  .post("/:id/end", async (c) => {
    const ok = await endConversation(c.env, c.executionCtx, c.get("user").username, conversationId(c.req.param("id")));
    return ok ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  })
  .delete("/:id", async (c) => {
    const result = await conversations.remove(c.env.DB, c.get("user").username, conversationId(c.req.param("id")));
    return result.meta.changes ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  });

export const MAX_MEMORIES = 1000;

export const memoryRoutes = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await memories.list(c.env.DB, c.get("user").username)))
  .post("/", async (c) => {
    const { category, content } = await jsonBody(c, schemas.createMemory);
    if ((await memories.count(c.env.DB, c.get("user").username)) >= MAX_MEMORIES) {
      return c.json({ error: "limit", limit: MAX_MEMORIES }, 413);
    }
    const id = crypto.randomUUID();
    await memories.create(c.env.DB, { id, username: c.get("user").username, category, content, source: null });
    return c.json({ id }, 201);
  })
  .patch("/:id", async (c) => {
    const changes = await jsonBody(c, schemas.updateMemory);
    const result = await memories.update(c.env.DB, c.get("user").username, conversationId(c.req.param("id")), changes);
    return result.meta.changes ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  })
  .delete("/:id", async (c) => {
    const result = await memories.remove(c.env.DB, c.get("user").username, conversationId(c.req.param("id")));
    return result.meta.changes ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  });
