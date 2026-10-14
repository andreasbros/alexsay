import { Hono } from "hono";
import type { CallAgentStart } from "../call_agent";
import { openaiConnection } from "../connections";
import { calls, connections, homes } from "../db";
import { logFor } from "../log";
import { serverOrigin } from "../origin";
import { acceptCall, ProviderError, rejectCall, verifyWebhook } from "../providers/openai";
import { skills } from "../skills";
import {
  AGENT_HEADER,
  agentBrief,
  assistantAgentName,
  CONFERENCE_HEADER,
  isLiveLeg,
  notOnCalls,
  parseAgent,
} from "../telephony";
import { agentToolDefinitions, toolDefinitions } from "../tools";
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
  const header = (name: string) =>
    event.data?.sip_headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
  const conference = header(CONFERENCE_HEADER);
  const agentLegId = header(AGENT_HEADER);
  const agentLeg = agentLegId ? await calls.get(c.env.DB, agentLegId) : null;
  const agent = agentLeg?.conference === conference ? parseAgent(agentLeg.brief) : null;
  const candidate = agent ? agentLeg : conference ? await calls.assistantLeg(c.env.DB, conference) : null;
  const leg = candidate && isLiveLeg(candidate, Date.now()) ? candidate : null;
  const openai = leg ? await openaiConnection(c, leg.home_id) : null;
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
    const hasLights = (await connections.get(c.env.DB, leg.home_id, "lightwave")) !== null;
    const [logAccess, callTest, where, skillsOn] = await Promise.all([
      homes.logAccess(c.env.DB, leg.home_id),
      homes.callTest(c.env.DB, leg.home_id),
      homes.locale(c.env.DB, leg.home_id),
      skills.enabled(c.env.DB, leg.home_id),
    ]);
    await acceptCall(c.env.OPENAI_BASE_URL, openai.apiKey, callId, {
      model: openai.settings.call_model,
      instructions: agent ? agentBrief(agent, leg.home_id, where) : (leg.brief ?? ""),
      voice: agent ? agent.voice : openai.settings.voice,
      tools: agent
        ? agentToolDefinitions()
        : toolDefinitions(hasLights, true, logAccess, callTest, skillsOn).filter((t) => !notOnCalls(t.name)),
      // The person called (or the agent playing one) keeps the floor; the assistant gives way, as a caller's helper would
      turnTaking: agent ? "holds" : "yields",
    });
    const start: CallAgentStart = {
      callId,
      conference,
      transcript: !agent,
      legId: agent ? leg.id : undefined,
      apiKey: openai.apiKey,
      baseUrl: c.env.OPENAI_BASE_URL,
      home: leg.home_id,
      origin: serverOrigin(c),
    };
    await logFor(
      c,
      leg.home_id,
      "info",
      `openai: SIP call ${callId} accepted for ${conference}${agent ? ` (test agent: ${agent.role})` : ""}`,
    );
    // The assistant's object is named after the conference, so call events (who answered) can reach it
    const worker = c.env.CALL_AGENT.get(c.env.CALL_AGENT.idFromName(agent ? callId : assistantAgentName(conference)));
    c.executionCtx.waitUntil(
      worker.fetch("https://call-agent/start", { method: "POST", body: JSON.stringify(start) }).catch(() => undefined),
    );
  } catch (err) {
    const detail = err instanceof ProviderError ? err.detail : err instanceof Error ? err.message : "accept failed";
    console.warn(JSON.stringify({ provider: "openai", webhook: "call.incoming", user: leg.home_id, error: detail }));
    await logFor(c, leg.home_id, "error", `openai: SIP call for ${conference} refused: ${detail}`);
    await rejectCall(c.env.OPENAI_BASE_URL, openai.apiKey, callId).catch(() => undefined);
    return c.json({ ok: false });
  }
  return c.json({ ok: true });
});
