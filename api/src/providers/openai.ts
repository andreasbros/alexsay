import type { OpenAiSettings } from "../schemas";

export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`provider ${status}: ${detail}`);
  }
}

export interface FunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** OpenAI runs hosted tools itself; web_search gives the backend current information. */
export type LiveTool = FunctionTool | { type: "web_search" };

const SPEAKER_INSTRUCTIONS =
  'Your name is Alexsay, pronounced "Aleksey" (ah-lek-SAY, like the Russian first name Alexei). ' +
  "When you say your name, say Aleksey; never spell it out or say Alexa. " +
  "You are a friendly home assistant speaker. Keep spoken replies short and natural. " +
  "Use the available tools for anything about the home; never pretend a device changed. " +
  "For lights, call list_lights once to learn the names and ids. One light: set_light. A room or group such as " +
  '"the kitchen lights": set_lights with the room words, which handles them all at once. Every light in the home: ' +
  'ask the user to confirm first, then set_lights with match "all". Report the tool\'s result truthfully.';

const WEB_SEARCH_INSTRUCTIONS =
  "You can search the web for current information such as news, weather, opening hours or facts you are unsure of; " +
  "say briefly that you are checking, then answer with the essentials and name the source when it matters.";

const PHONE_INSTRUCTIONS =
  "You can phone, text and WhatsApp people through the user's own Twilio number. Resolve names with find_contact; " +
  "when several people match, ask which. Before any call or message, say who it goes to (and the exact text of a " +
  "message) and wait for a yes. A call opens in the Assistant page the user is talking from, with you on the line; " +
  "give place_call a task when the user wants you to do the talking. Ring the user's mobile only when they ask " +
  "for it (via mobile). With a message it phones them and reads it out instead. " +
  "start_conference makes a group call, add_to_call brings in one more person, end_call hangs up. " +
  "recent_messages reads back texts the user received or sent. " +
  "A call exists only when place_call, start_conference or add_to_call has returned a result in this turn: " +
  "once the user says yes, make that tool call before saying anything else, and never say a call is being placed, " +
  "ringing, connected or answered without that result. If no such result exists, say plainly that no call was made. " +
  "For how a call is going (ringing, answered, who is on, ended), call call_status and report what it says.";

const ADDRESSED_INSTRUCTIONS =
  "You are in a room with background sound: a television, music, other people talking to each other. " +
  "Only respond when someone addresses you by name (Alexsay, Aleksey, Alexei) or clearly continues an exchange " +
  "they started with you in the last few seconds. Speech that is not aimed at you, overheard conversation and " +
  "broadcast voices get no reply at all: stay silent and keep listening.";

export interface SessionInput {
  settings: OpenAiSettings;
  tools: LiveTool[];
  /** What the assistant remembers and how to use the memory tools, from memory.ts. */
  context?: string;
  sdp: string;
  /** A session to continue from, so a dropped call picks up with its memory of the conversation. */
  resumeFrom?: string;
}

/** The session body GPT-Live expects: voice layer plus a Responses backend that owns the tools. */
export function sessionConfig(settings: OpenAiSettings, functions: LiveTool[], context = ""): Record<string, unknown> {
  const hasPhone = functions.some((t) => t.type === "function" && t.name === "place_call");
  const instructions = [
    SPEAKER_INSTRUCTIONS,
    settings.respond_when_addressed ? ADDRESSED_INSTRUCTIONS : "",
    settings.web_search ? WEB_SEARCH_INSTRUCTIONS : "",
    hasPhone ? PHONE_INSTRUCTIONS : "",
    settings.instructions,
    context,
  ]
    .filter(Boolean)
    .join("\n\n");
  const tools: LiveTool[] = settings.web_search ? [{ type: "web_search" }, ...functions] : functions;
  return {
    model: settings.model,
    instructions,
    audio: { output: { voice: settings.voice } },
    delegation: {
      type: "responses",
      responses: {
        model: settings.backend_model,
        instructions,
        tools,
        tool_choice: "auto",
        // Spoken replies: think briefly, answer briefly, so GPT-Live is not left waiting
        reasoning: { effort: "low" },
        text: { verbosity: "low" },
      },
    },
  };
}

/** Exchanges the browser's SDP offer for GPT-Live's answer; the API key never leaves the Worker. */
export async function createLiveSession(
  baseUrl: string,
  apiKey: string,
  input: SessionInput,
): Promise<{ sessionId: string; sdp: string }> {
  const path = input.resumeFrom ? `/live/sessions/${encodeURIComponent(input.resumeFrom)}/fork` : "/live/sessions";
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      session: sessionConfig(input.settings, input.tools, input.context),
      transport: { type: "webrtc", sdp: input.sdp },
    }),
  });
  if (!res.ok) {
    throw new ProviderError(res.status, await errorDetail(res));
  }
  const body = (await res.json()) as { session?: { id?: string }; transport?: { sdp?: string } };
  if (!body.transport?.sdp) {
    throw new ProviderError(502, "no SDP answer in the GPT-Live response");
  }
  return { sessionId: body.session?.id ?? "", sdp: body.transport.sdp };
}

/** Lists the models the key can see; proves the key works and shows whether the chosen ones exist. */
export async function listModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!res.ok) {
    throw new ProviderError(res.status, await errorDetail(res));
  }
  const body = (await res.json()) as { data?: { id: string }[] };
  return (body.data ?? []).map((m) => m.id);
}

async function errorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed.error?.message ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200) || res.statusText;
  }
}

const WEBHOOK_TOLERANCE_S = 300;

/**
 * OpenAI signs webhooks the Standard Webhooks way: base64 HMAC-SHA256 of "id.timestamp.body" with
 * the secret that follows whsec_, sent as "v1,<signature>" (several may be space separated).
 */
export async function verifyWebhook(
  secret: string,
  headers: { id: string | undefined; timestamp: string | undefined; signature: string | undefined },
  body: string,
  now = Date.now(),
): Promise<boolean> {
  if (!headers.id || !headers.timestamp || !headers.signature) {
    return false;
  }
  const sentAt = Number(headers.timestamp) * 1000;
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > WEBHOOK_TOLERANCE_S * 1000) {
    return false;
  }
  const raw = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${headers.id}.${headers.timestamp}.${body}`),
  );
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return headers.signature
    .split(" ")
    .map((part) => part.split(",")[1] ?? "")
    .some((candidate) => candidate.length === expected.length && candidate === expected);
}

export interface CallSession {
  model: string;
  instructions: string;
  voice: string;
  tools: FunctionTool[];
}

/** Answers a SIP call OpenAI announced through realtime.call.incoming with a configured realtime session. */
export async function acceptCall(baseUrl: string, apiKey: string, callId: string, session: CallSession): Promise<void> {
  const res = await fetch(`${baseUrl}/realtime/calls/${encodeURIComponent(callId)}/accept`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      type: "realtime",
      model: session.model,
      instructions: session.instructions,
      audio: { output: { voice: session.voice } },
      tools: session.tools,
      tool_choice: "auto",
    }),
  });
  if (!res.ok) {
    throw new ProviderError(res.status, await errorDetail(res));
  }
}

export async function rejectCall(baseUrl: string, apiKey: string, callId: string): Promise<void> {
  await fetch(`${baseUrl}/realtime/calls/${encodeURIComponent(callId)}/reject`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ status_code: 603 }),
  });
}
