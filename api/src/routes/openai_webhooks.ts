import { Hono } from "hono";
import type { CallAgentStart } from "../call_agent";
import { openaiConnection } from "../connections";
import { calls, connections, users } from "../db";
import { logFor } from "../log";
import { acceptCall, ProviderError, rejectCall, verifyWebhook } from "../providers/openai";
import { CONFERENCE_HEADER, notOnCalls } from "../telephony";
import { toolDefinitions } from "../tools";
import type { AppEnv } from "../types";

interface IncomingCall {
  type?: string;
  data?: { call_id?: string; sip_headers?: { name: string; value: string }[] };
}

/**
 * OpenAI tells us a SIP call reached the user's project: Twilio dialled it into a conference we
 * opened, with the conference name in a header. We find whose call it is, check the signature with
 * that user's webhook secret, and accept it with the briefing stored for the assistant's leg.
 */
export const openaiWebhookRoutes = new Hono<AppEnv>().post("/webhook", async (c) => {
  const body = await c.req.text();
  let event: IncomingCall;
  try {
    event = JSON.parse(body) as IncomingCall;
  } catch {
    return c.json({ error: "bad_request" }, 400);
  }
  if (event.type !== "realtime.call.incoming") {
    return c.json({ ok: true });
  }
  const callId = event.data?.call_id ?? "";
  const conference =
    event.data?.sip_headers?.find((h) => h.name.toLowerCase() === CONFERENCE_HEADER.toLowerCase())?.value ?? "";
  const leg = conference ? await calls.assistantLeg(c.env.DB, conference) : null;
  const openai = leg ? await openaiConnection(c, leg.username) : null;
  if (!leg || !openai?.webhookSecret || !callId) {
    return c.json({ error: "not_found" }, 404);
  }
  const headers = {
    id: c.req.header("webhook-id"),
    timestamp: c.req.header("webhook-timestamp"),
    signature: c.req.header("webhook-signature"),
  };
  if (!(await verifyWebhook(openai.webhookSecret, headers, body))) {
    return c.text("forbidden", 403);
  }
  try {
    const hasLights = (await connections.get(c.env.DB, leg.username, "lightwave")) !== null;
    const logAccess = await users.logAccess(c.env.DB, leg.username);
    await acceptCall(c.env.OPENAI_BASE_URL, openai.apiKey, callId, {
      model: openai.settings.call_model,
      instructions: leg.brief ?? "",
      voice: openai.settings.voice,
      tools: toolDefinitions(hasLights, true, logAccess).filter((t) => !notOnCalls(t.name)),
    });
    const start: CallAgentStart = {
      callId,
      apiKey: openai.apiKey,
      baseUrl: c.env.OPENAI_BASE_URL.replace(/^http/, "ws"),
      username: leg.username,
      origin: new URL(c.req.url).origin,
    };
    void logFor(c, leg.username, "info", `openai: SIP call ${callId} accepted for ${conference}`);
    const agent = c.env.CALL_AGENT.get(c.env.CALL_AGENT.idFromName(callId));
    c.executionCtx.waitUntil(
      agent.fetch("https://call-agent/start", { method: "POST", body: JSON.stringify(start) }).catch(() => undefined),
    );
  } catch (err) {
    const detail = err instanceof ProviderError ? err.detail : err instanceof Error ? err.message : "accept failed";
    console.warn(JSON.stringify({ provider: "openai", webhook: "call.incoming", user: leg.username, error: detail }));
    void logFor(c, leg.username, "error", `openai: SIP call for ${conference} refused: ${detail}`);
    await rejectCall(c.env.OPENAI_BASE_URL, openai.apiKey, callId).catch(() => undefined);
    return c.json({ ok: false });
  }
  return c.json({ ok: true });
});
