import { Hono } from "hono";
import { lightwaveToken, lightwaveUrls, openaiConnection } from "../connections";
import { connections } from "../db";
import { contextInstructions, loadContext } from "../memory";
import { providerFailure } from "../provider_errors";
import { lights, writeFeature, writeFeatures } from "../providers/lightwave";
import { createLiveSession, ProviderError } from "../providers/openai";
import * as schemas from "../schemas";
import { toolDefinitions } from "../tools";
import type { AppEnv } from "../types";
import { jsonBody } from "../validate";

/** The browser hands over its WebRTC offer; GPT-Live answers through the owner's own API key. */
export const assistantRoutes = new Hono<AppEnv>().post("/sessions", async (c) => {
  const { sdp, resume_from } = await jsonBody(c, schemas.assistantSession);
  const me = c.get("user");
  const connection = await openaiConnection(c, me.username);
  if (!connection) {
    return c.json({ error: "no_openai_connection" }, 412);
  }
  const hasLights = (await connections.get(c.env.DB, me.username, "lightwave")) !== null;
  try {
    const context = contextInstructions(await loadContext(c.env.DB, me.username));
    const input = { settings: connection.settings, tools: toolDefinitions(hasLights), context, sdp };
    const session = await createLiveSession(c.env.OPENAI_BASE_URL, connection.apiKey, {
      ...input,
      resumeFrom: resume_from,
    }).catch(async (err: unknown) => {
      // An expired or unknown source session falls back to a fresh conversation
      if (resume_from && err instanceof ProviderError && err.status < 500) {
        return { ...(await createLiveSession(c.env.OPENAI_BASE_URL, connection.apiKey, input)), fresh: true };
      }
      throw err;
    });
    return c.json({
      session_id: session.sessionId,
      sdp: session.sdp,
      tools: hasLights ? ["lights"] : [],
      resumed: !!resume_from && !("fresh" in session),
    });
  } catch (err) {
    return providerFailure(c, "openai", err);
  }
});

/** Lights through the user's Lightwave connection, for the Connections page and the assistant's tools. */
export const lightwaveRoutes = new Hono<AppEnv>()
  .get("/lights", async (c) => {
    try {
      const token = await lightwaveToken(c, c.get("user").username);
      if (!token) {
        return c.json({ error: "no_lightwave_connection" }, 412);
      }
      return c.json(await lights(lightwaveUrls(c), token));
    } catch (err) {
      return providerFailure(c, "lightwave", err);
    }
  })
  .post("/features", async (c) => {
    const { features } = await jsonBody(c, schemas.featureWrites);
    try {
      const token = await lightwaveToken(c, c.get("user").username);
      if (!token) {
        return c.json({ error: "no_lightwave_connection" }, 412);
      }
      await writeFeatures(lightwaveUrls(c), token, features);
      return c.body(null, 204);
    } catch (err) {
      return providerFailure(c, "lightwave", err);
    }
  })
  .post("/features/:id", async (c) => {
    const featureId = c.req.param("id");
    if (!/^[A-Za-z0-9_.+-]{1,160}$/.test(featureId)) {
      return c.json({ error: "not_found" }, 404);
    }
    const { value } = await jsonBody(c, schemas.featureValue);
    try {
      const token = await lightwaveToken(c, c.get("user").username);
      if (!token) {
        return c.json({ error: "no_lightwave_connection" }, 412);
      }
      await writeFeature(lightwaveUrls(c), token, featureId, value);
      return c.body(null, 204);
    } catch (err) {
      return providerFailure(c, "lightwave", err);
    }
  });
