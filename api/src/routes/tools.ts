import { Hono } from "hono";
import { logFor } from "../log";
import { ProviderError } from "../providers/openai";
import * as schemas from "../schemas";
import { toolContext } from "../tool_context";
import { toolByName } from "../tools";
import type { AppEnv } from "../types";
import { jsonBody } from "../validate";

/**
 * Runs one of the assistant's functions for the signed-in user and returns what the model should
 * hear. Failures come back as a result too, so the model can tell the user instead of hanging.
 */
export const toolRoutes = new Hono<AppEnv>().post("/call", async (c) => {
  const { name, arguments: args, conversation_id, client } = await jsonBody(c, schemas.toolCall);
  const ctx = toolContext(c, client?.voice ?? "mobile");
  const tool = toolByName(name);
  if (!tool) {
    return c.json({ output: { error: `unknown tool ${name}` } });
  }
  try {
    const output = await tool.run(ctx, args, conversation_id ?? null);
    if (name !== "read_log") {
      const summary = JSON.stringify(output);
      const failed = summary.includes('"error"');
      void logFor(c, ctx.user.username, failed ? "warn" : "info", `tool ${name} ${summarise(args)} -> ${summary}`);
    }
    return c.json({ output });
  } catch (err) {
    const detail = err instanceof ProviderError ? err.detail : err instanceof Error ? err.message : "tool failed";
    console.warn(JSON.stringify({ tool: name, user: c.get("user").username, error: detail }));
    void logFor(c, ctx.user.username, "error", `tool ${name} ${summarise(args)} failed: ${detail}`);
    return c.json({ output: { error: detail } });
  }
});

const summarise = (args: Record<string, unknown>) => JSON.stringify(args).slice(0, 120);
