import type { Context } from "hono";
import type { AppEnv } from "./types";

/**
 * Where this server can be reached from the internet. Twilio and OpenAI call back to it, so a
 * server on a laptop or a private network has no working callbacks unless PUBLIC_URL names a
 * tunnel that leads to it. The request's own origin is right for the deployed Worker.
 */
export function serverOrigin(c: Context<AppEnv>): string {
  const configured = c.env.PUBLIC_URL?.trim().replace(/\/+$/, "");
  return configured || new URL(c.req.url).origin;
}

/** True when callbacks from the outside can reach this origin. */
export function isPublicOrigin(origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "::1" ||
    host === "[::1]"
  ) {
    return false;
  }
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return !(
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254)
    );
  }
  return host.includes(".");
}

/** What a user on a local server is told about the parts that need a public address. */
export const LOCAL_SERVER_NOTE =
  "this server has no public address, so Twilio and OpenAI cannot call it back: incoming calls, the assistant " +
  "joining calls and speaker phone lines need a public URL (set PUBLIC_URL to a tunnel such as cloudflared)";
