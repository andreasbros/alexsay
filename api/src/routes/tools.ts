import { Hono } from "hono";
import { ProviderError } from "../providers/openai";
import * as schemas from "../schemas";
import { toolByName } from "../tools";
import type { AppEnv } from "../types";
import { jsonBody } from "../validate";

/**
 * Runs one of the assistant's functions for the signed-in user and returns what the model should
 * hear. Failures come back as a result too, so the model can tell the user instead of hanging.
 */
export const toolRoutes = new Hono<AppEnv>().post("/call", async (c) => {
  const { name, arguments: args, conversation_id } = await jsonBody(c, schemas.toolCall);
  const tool = toolByName(name);
  if (!tool) {
    return c.json({ output: { error: `unknown tool ${name}` } });
  }
  try {
    return c.json({ output: await tool.run(c, args, conversation_id ?? null) });
  } catch (err) {
    const detail = err instanceof ProviderError ? err.detail : err instanceof Error ? err.message : "tool failed";
    console.warn(JSON.stringify({ tool: name, user: c.get("user").username, error: detail }));
    return c.json({ output: { error: detail } });
  }
});
