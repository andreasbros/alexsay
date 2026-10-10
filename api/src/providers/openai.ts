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
  "You are Alexsay, a friendly home assistant speaker. Keep spoken replies short and natural. " +
  "Use the available tools for anything about the home; never pretend a device changed.";

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
      responses: { model: settings.backend_model, instructions, tools, tool_choice: "auto" },
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
