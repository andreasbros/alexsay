import { type Context, Hono } from "hono";
import { exchangeLightwave, lightwaveToken, lightwaveUrls, openaiConnection } from "../connections";
import { connections } from "../db";
import { structureIds } from "../providers/lightwave";
import { listModels, ProviderError } from "../providers/openai";
import * as schemas from "../schemas";
import { seal } from "../secrets";
import type { AppEnv } from "../types";
import { jsonBody } from "../validate";

function providerFailure(c: Context<AppEnv>, err: unknown) {
  if (err instanceof ProviderError) {
    return c.json({ ok: false, error: "provider", status: err.status, detail: err.detail }, 502);
  }
  throw err;
}

/** Each provider is one card in the app: stored sealed, listed without secrets, testable on demand. */
export const connectionRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const rows = await connections.list(c.env.DB, c.get("user").username);
    return c.json(
      rows.map((row) => ({
        provider: row.provider,
        settings: JSON.parse(row.settings) as Record<string, unknown>,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
    );
  })
  .put("/openai", async (c) => {
    const { api_key, settings } = await jsonBody(c, schemas.openaiConnection);
    const username = c.get("user").username;
    const existing = await connections.get(c.env.DB, username, "openai");
    if (!api_key && !existing) {
      return c.json({ error: "key_required" }, 400);
    }
    const sealed = api_key ? await seal(c.env.SECRETS_KEY, { api_key }) : existing?.secret;
    if (!sealed) {
      return c.json({ error: "key_required" }, 400);
    }
    await connections.put(c.env.DB, username, "openai", sealed, JSON.stringify(settings));
    return c.json({ provider: "openai", settings });
  })
  .put("/lightwave", async (c) => {
    const pasted = await jsonBody(c, schemas.lightwaveConnection);
    let secret: Awaited<ReturnType<typeof exchangeLightwave>>;
    try {
      secret = await exchangeLightwave(c, pasted);
    } catch (err) {
      if (err instanceof ProviderError) {
        return c.json({ error: "lightwave_rejected", status: err.status, detail: err.detail }, 400);
      }
      throw err;
    }
    const sealed = await seal(c.env.SECRETS_KEY, secret);
    await connections.put(c.env.DB, c.get("user").username, "lightwave", sealed, "{}");
    return c.json({ provider: "lightwave", settings: {} });
  })
  .post("/openai/test", async (c) => {
    const connection = await openaiConnection(c, c.get("user").username);
    if (!connection) {
      return c.json({ error: "not_found" }, 404);
    }
    try {
      const models = await listModels(c.env.OPENAI_BASE_URL, connection.apiKey);
      const { model, backend_model } = connection.settings;
      return c.json({
        ok: true,
        models: models.length,
        live_model: models.includes(model),
        backend_model: models.includes(backend_model),
      });
    } catch (err) {
      return providerFailure(c, err);
    }
  })
  .post("/lightwave/test", async (c) => {
    try {
      const token = await lightwaveToken(c, c.get("user").username);
      if (!token) {
        return c.json({ error: "not_found" }, 404);
      }
      const structures = await structureIds(lightwaveUrls(c), token);
      return c.json({ ok: true, structures: structures.length });
    } catch (err) {
      return providerFailure(c, err);
    }
  })
  .delete("/:provider", async (c) => {
    const parsed = schemas.provider.safeParse(c.req.param("provider"));
    if (!parsed.success) {
      return c.json({ error: "not_found" }, 404);
    }
    const result = await connections.remove(c.env.DB, c.get("user").username, parsed.data);
    return result.meta.changes ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  });
