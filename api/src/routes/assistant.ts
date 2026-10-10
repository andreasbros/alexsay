import { Hono } from "hono";
import { lightwaveToken, lightwaveUrls, openaiConnection } from "../connections";
import { connections } from "../db";
import { lights, writeFeature } from "../providers/lightwave";
import { createLiveSession, type LiveTool, ProviderError } from "../providers/openai";
import * as schemas from "../schemas";
import type { AppEnv } from "../types";
import { jsonBody } from "../validate";

/** Tools the backend model may call; the browser runs them against /api/lightwave. */
export const LIGHT_TOOLS: LiveTool[] = [
  {
    type: "function",
    name: "list_lights",
    description: "Lists the user's lights with their current on/off state and dim level.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "set_light",
    description: "Switches a light on or off, or sets its brightness. Use the light id from list_lights.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The light id from list_lights" },
        on: { type: "boolean", description: "True to switch on, false to switch off" },
        dim_level: { type: "integer", minimum: 0, maximum: 100, description: "Brightness in percent, if dimmable" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

/** The browser hands over its WebRTC offer; GPT-Live answers through the owner's own API key. */
export const assistantRoutes = new Hono<AppEnv>().post("/sessions", async (c) => {
  const { sdp } = await jsonBody(c, schemas.assistantSession);
  const me = c.get("user");
  const connection = await openaiConnection(c, me.username);
  if (!connection) {
    return c.json({ error: "no_openai_connection" }, 412);
  }
  const hasLights = (await connections.get(c.env.DB, me.username, "lightwave")) !== null;
  try {
    const session = await createLiveSession(c.env.OPENAI_BASE_URL, connection.apiKey, {
      settings: connection.settings,
      tools: hasLights ? LIGHT_TOOLS : [],
      sdp,
    });
    return c.json({ session_id: session.sessionId, sdp: session.sdp, tools: hasLights ? ["lights"] : [] });
  } catch (err) {
    if (err instanceof ProviderError) {
      return c.json({ error: "provider", status: err.status, detail: err.detail }, 502);
    }
    throw err;
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
      if (err instanceof ProviderError) {
        return c.json({ error: "provider", status: err.status, detail: err.detail }, 502);
      }
      throw err;
    }
  })
  .post("/features/:id", async (c) => {
    const featureId = c.req.param("id");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(featureId)) {
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
      if (err instanceof ProviderError) {
        return c.json({ error: "provider", status: err.status, detail: err.detail }, 502);
      }
      throw err;
    }
  });
