import { constantTimeEqual } from "../crypto";
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

const PERSONA_INSTRUCTIONS =
  'Your name is Alexsay, pronounced "Aleksey" (ah-lek-SAY, like the Russian first name Alexei). ' +
  "When you say your name, say Aleksey; never spell it out or say Alexa. " +
  "You are a friendly home assistant speaker. Keep spoken replies short and natural. " +
  "Use the available tools for anything about the home; never pretend a device changed. " +
  "For lights, call list_lights once to learn the names and ids. One light: set_light. A room or group such as " +
  '"the kitchen lights": set_lights with the room words, which handles them all at once. Every light in the home: ' +
  'ask the user to confirm first, then set_lights with match "all". Report the tool\'s result truthfully.';

/** How a speaker or page conversation ends; a phone call ends by the briefing's hang-up rule instead. */
const ENDING_INSTRUCTIONS =
  "The conversation ends only through the end_conversation tool: whenever the user wants to stop, in any words " +
  '("end the conversation", "that\'s all", "stop listening", "bye"), say a short goodbye and call it. ' +
  "Never just agree without calling it: the speaker keeps listening until you do.";

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
  "For how a call is going (ringing, answered, who is on, ended), call call_status and report what it says. " +
  "When a call ends, the app hands you its report as a note (who answered, how long, who hung up, the transcript): " +
  "tell the user in two or three sentences how it went and what was agreed; call_report has it again later.";

const MUSIC_INSTRUCTIONS =
  "You play music through the home's connected music service (Spotify) with the music tools: play_music for a " +
  "playlist, song, album or artist by name (or to resume), pause_music to pause or stop, skip_track for next or " +
  "previous, now_playing for what is on, set_music_volume, list_playlists for the user's playlists. " +
  '"Play X" means call play_music with X at once; never say you cannot play music or control Spotify. ' +
  "Music plays on the speaker the user is talking from unless they name another device.";

const ADDRESSED_INSTRUCTIONS =
  "You are in a room with background sound: a television, music, other people talking to each other. " +
  "Only respond when someone addresses you by name (Alexsay, Aleksey, Alexei) or clearly continues an exchange " +
  "they started with you in the last few seconds. Speech that is not aimed at you, overheard conversation and " +
  "broadcast voices get no reply at all: stay silent and keep listening.";

export interface SessionInput {
  /** The session body from sessionConfig(), shared with the speaker's own WebSocket client. */
  session: Record<string, unknown>;
  sdp: string;
  /** A session to continue from, so a dropped call picks up with its memory of the conversation. */
  resumeFrom?: string;
}

/**
 * The assistant's instructions, the same wherever it speaks from: persona and house rules, what its
 * tools allow, the user's own instructions, then the context (memories, locale; on a call, the briefing).
 * A call has no end_conversation tool and no room to listen to, so those two parts stay off the line.
 */
export function assistantInstructions(
  settings: OpenAiSettings,
  functions: LiveTool[],
  context: string,
  onCall = false,
): string {
  const hasPhone = functions.some((t) => t.type === "function" && t.name === "place_call");
  const hasMusic = functions.some((t) => t.type === "function" && t.name === "play_music");
  return [
    PERSONA_INSTRUCTIONS,
    onCall ? "" : ENDING_INSTRUCTIONS,
    !onCall && settings.respond_when_addressed ? ADDRESSED_INSTRUCTIONS : "",
    settings.web_search ? WEB_SEARCH_INSTRUCTIONS : "",
    hasPhone ? PHONE_INSTRUCTIONS : "",
    hasMusic ? MUSIC_INSTRUCTIONS : "",
    settings.instructions,
    context,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The tools the Responses backend gets: OpenAI's hosted web search when switched on, then our functions. */
export function assistantTools(settings: OpenAiSettings, functions: LiveTool[]): LiveTool[] {
  return settings.web_search ? [{ type: "web_search" }, ...functions] : functions;
}

/** The session body GPT-Live expects: voice layer plus a Responses backend that owns the tools. */
export function sessionConfig(settings: OpenAiSettings, functions: LiveTool[], context = ""): Record<string, unknown> {
  const instructions = assistantInstructions(settings, functions, context);
  return {
    model: settings.model,
    instructions,
    audio: { output: { voice: settings.voice } },
    delegation: {
      type: "responses",
      responses: {
        model: settings.backend_model,
        instructions,
        tools: assistantTools(settings, functions),
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
      session: input.session,
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
    .some((candidate) => constantTimeEqual(candidate, expected));
}

/**
 * Who gives way when two voices start at once. The side that yields is cut off by incoming speech
 * and waits for a long pause before taking a turn; the other keeps talking and takes shorter pauses,
 * so a collision resolves itself instead of both stopping and restarting together.
 */
export type TurnTaking = "yields" | "holds";

export interface CallSession {
  model: string;
  instructions: string;
  voice: string;
  tools: FunctionTool[];
  turnTaking: TurnTaking;
}

/** A pause this long ends the other side's turn; the side that yields waits a little longer, so the two never tie. */
const HOLDS_SILENCE_MS = 450;
const YIELDS_SILENCE_MS = 650;
/**
 * How sure the detector must be that it hears speech (0 to 1; OpenAI's default is 0.5). Phone lines carry
 * room noise, breaths and handling, which at the default cut the assistant off mid-sentence and left it
 * silent (15 Oct 2026); speech still interrupts it at this level.
 */
const SPEECH_THRESHOLD = 0.75;

/** Silence-based end of turn (fast; semantic detection added seconds), with the collision rule in interrupt_response. */
export function turnDetection(turnTaking: TurnTaking): Record<string, unknown> {
  return {
    type: "server_vad",
    threshold: SPEECH_THRESHOLD,
    silence_duration_ms: turnTaking === "yields" ? YIELDS_SILENCE_MS : HOLDS_SILENCE_MS,
    prefix_padding_ms: 300,
    create_response: true,
    interrupt_response: turnTaking === "yields",
  };
}

/** The call's audio is a phone line: a handset or a speakerphone close by, so near-field noise reduction fits. */
export const NOISE_REDUCTION = { type: "near_field" } as const;

/**
 * The audio GPT-Live exchanges with the server's call seat: G.711 mu-law at 8 kHz, exactly what Twilio's
 * media stream carries, so the seat forwards each side's bytes untouched. Resampling to PCM and back
 * folded everything above 4 kHz into the speech band as hiss (heard on 15 Oct 2026).
 */
export const LIVE_CALL_FORMAT = { type: "audio/pcmu", rate: 8_000 } as const;

/**
 * The assistant's GPT-Live session on a phone call: the same persona, tool guidance, user instructions
 * and hosted web search as on the speaker, with the call's briefing (who is on, the task, memories) as
 * its context and the line's audio format (16 Oct 2026: a seat with the briefing alone could not say
 * what the weather was, having no web search and no word about it).
 */
export function assistantCallSession(
  settings: OpenAiSettings,
  functions: LiveTool[],
  briefing: string,
): Record<string, unknown> {
  return liveCallSession(
    settings,
    assistantTools(settings, functions),
    assistantInstructions(settings, functions, briefing, true),
  );
}

/**
 * A GPT-Live session for a seat on a phone call with the given instructions alone: a scripted test
 * agent's part, or the assistant's through `assistantCallSession`.
 */
export function liveCallSession(
  settings: OpenAiSettings,
  functions: LiveTool[],
  briefing: string,
  voice: string = settings.voice,
): Record<string, unknown> {
  return {
    model: settings.model,
    instructions: briefing,
    audio: { output: { voice }, format: LIVE_CALL_FORMAT },
    delegation: {
      type: "responses",
      responses: {
        model: settings.backend_model,
        instructions: briefing,
        tools: functions,
        tool_choice: "auto",
        reasoning: { effort: "low" },
        text: { verbosity: "low" },
      },
    },
  };
}

/** GPT-Live's socket on the provider's base (`.../v1` becomes `.../v1/live/sessions`; Workers upgrade over https). */
export function liveSocketUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^wss?:/, "https:").replace(/\/+$/, "")}/live/sessions`;
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
      // The call's own words come back as transcripts, for the report handed to the page's assistant
      audio: {
        input: {
          transcription: { model: "gpt-4o-mini-transcribe" },
          turn_detection: turnDetection(session.turnTaking),
          noise_reduction: NOISE_REDUCTION,
        },
        output: { voice: session.voice },
      },
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
