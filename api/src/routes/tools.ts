import { Hono } from "hono";
import { runToolFor } from "../assistant_api";
import * as schemas from "../schemas";
import { toolContext } from "../tool_context";
import type { AppEnv } from "../types";
import { jsonBody } from "../validate";

/**
 * Runs one of the assistant's functions for the signed-in user and returns what the model should
 * hear. Failures come back as a result too, so the model can tell the user instead of hanging.
 */
export const toolRoutes = new Hono<AppEnv>().post("/call", async (c) => {
  const { name, arguments: args, conversation_id, client } = await jsonBody(c, schemas.toolCall);
  return c.json({
    output: await runToolFor(toolContext(c, client?.voice ?? "mobile"), name, args, conversation_id ?? null),
  });
});
