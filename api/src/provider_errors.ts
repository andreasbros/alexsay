import type { Context } from "hono";
import { ProviderError } from "./providers/openai";
import type { AppEnv } from "./types";

/**
 * A provider (OpenAI, Lightwave) refused or failed: logged for `just logs`, never with any token,
 * and returned to the browser as a structured 502. Anything else is rethrown as an internal error.
 */
export function providerFailure(c: Context<AppEnv>, provider: "openai" | "lightwave", err: unknown): Response {
  if (err instanceof ProviderError) {
    console.warn(
      JSON.stringify({
        provider,
        status: err.status,
        detail: err.detail,
        user: c.get("user")?.username,
        path: c.req.path,
      }),
    );
    return c.json({ ok: false, error: "provider", status: err.status, detail: err.detail }, 502);
  }
  throw err;
}
