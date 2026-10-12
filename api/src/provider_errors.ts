import type { Context } from "hono";
import { logFor } from "./log";
import { ProviderError } from "./providers/openai";
import type { AppEnv, Provider } from "./types";

/**
 * A provider (OpenAI, Lightwave) refused or failed: logged for `just logs`, never with any token,
 * and returned to the browser as a structured 502. Anything else is rethrown as an internal error.
 */
/** OpenAI's 401 bodies quote part of the key; nothing like it reaches a log or the browser. */
export const redactKeys = (text: string): string => text.replace(/sk-[A-Za-z0-9_*-]{4,}/g, "sk-***");

export function providerFailure(c: Context<AppEnv>, provider: Provider, err: unknown): Response {
  if (err instanceof ProviderError) {
    const detail = redactKeys(err.detail);
    console.warn(
      JSON.stringify({
        provider,
        status: err.status,
        detail,
        user: c.get("user")?.username,
        path: c.req.path,
      }),
    );
    const username = c.get("user")?.username;
    if (username) {
      void logFor(c, username, "error", `${provider} ${c.req.method} ${c.req.path}: ${err.status} ${detail}`);
    }
    return c.json({ ok: false, error: "provider", status: err.status, detail }, 502);
  }
  throw err;
}
