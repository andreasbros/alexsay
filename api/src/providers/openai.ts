import type { OpenAiSettings } from "../schemas";

export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`provider ${status}: ${detail}`);
  }
}

export interface LiveTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const SPEAKER_INSTRUCTIONS =
  'Your name is Alexsay, pronounced "Aleksey" (ah-lek-SAY, like the Russian first name Alexei). ' +
  "When you say your name, say Aleksey; never spell it out or say Alexa. " +
  "You are a friendly home assistant speaker. Keep spoken replies short and natural. " +
  "Use the available tools for anything about the home; never pretend a device changed. " +
  "For lights, call list_lights once to learn the names and ids. One light: set_light. A room or group such as " +
  '"the kitchen lights": set_lights with the room words, which handles them all at once. Every light in the home: ' +
  'ask the user to confirm first, then set_lights with match "all". Report the tool\'s result truthfully.';

export interface SessionInput {
  settings: OpenAiSettings;
  tools: LiveTool[];
  sdp: string;
}

/** The session body GPT-Live expects: voice layer plus a Responses backend that owns the tools. */
export function sessionConfig(settings: OpenAiSettings, tools: LiveTool[]): Record<string, unknown> {
  const instructions = [SPEAKER_INSTRUCTIONS, settings.instructions].filter(Boolean).join("\n\n");
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
  const res = await fetch(`${baseUrl}/live/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      session: sessionConfig(input.settings, input.tools),
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
