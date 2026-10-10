import { Hono } from "hono";
import { openaiConnection } from "../connections";
import { conversations, memories } from "../db";
import { digestConversation } from "../memory";
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
    const id = crypto.randomUUID();
    await conversations.create(c.env.DB, {
      id,
      username: c.get("user").username,
      source,
      device_id: device_id ?? null,
    });
    return c.json({ id }, 201);
  })
  .get("/:id", async (c) => {
    const row = await conversations.get(c.env.DB, c.get("user").username, conversationId(c.req.param("id")));
    if (!row) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({ ...row, turns: await conversations.turns(c.env.DB, row.id) });
  })
  .post("/:id/turns", async (c) => {
    const row = await conversations.get(c.env.DB, c.get("user").username, conversationId(c.req.param("id")));
    if (!row) {
      return c.json({ error: "not_found" }, 404);
    }
    const { turns } = await jsonBody(c, schemas.addTurns);
    await conversations.addTurns(c.env.DB, row.id, turns);
    return c.body(null, 204);
  })
  .post("/:id/end", async (c) => {
    const me = c.get("user");
    const row = await conversations.get(c.env.DB, me.username, conversationId(c.req.param("id")));
    if (!row) {
      return c.json({ error: "not_found" }, 404);
    }
    await conversations.end(c.env.DB, row.id, Date.now());
    const connection = await openaiConnection(c, me.username);
    if (connection && row.summary === null) {
      // The summary and memory update run after the response, with the user's own key
      c.executionCtx.waitUntil(
        digestConversation(
          c.env.DB,
          { baseUrl: c.env.OPENAI_BASE_URL, apiKey: connection.apiKey, model: connection.settings.backend_model },
          me.username,
          row.id,
        ).catch((err: unknown) => console.warn(JSON.stringify({ digest: row.id, error: String(err) }))),
      );
    }
    return c.body(null, 204);
  })
  .delete("/:id", async (c) => {
    const result = await conversations.remove(c.env.DB, c.get("user").username, conversationId(c.req.param("id")));
    return result.meta.changes ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  });

export const memoryRoutes = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await memories.list(c.env.DB, c.get("user").username)))
  .post("/", async (c) => {
    const { category, content } = await jsonBody(c, schemas.createMemory);
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
