import type { OpenAiSettings } from "./api";

export type VoiceType = "male" | "female";

/** OpenAI does not label its voices; this is how they are commonly heard. The first of each list is the default. */
export const VOICES: Record<VoiceType, string[]> = {
  male: ["cedar", "ash", "ballad", "echo", "verse"],
  female: ["marin", "coral", "sage", "shimmer", "alloy"],
};

export const voiceTypeOf = (voice: string): VoiceType => (VOICES.female.includes(voice) ? "female" : "male");

export const DEFAULT_OPENAI: OpenAiSettings = {
  model: "gpt-live-1",
  backend_model: "gpt-6-luna",
  voice: "cedar",
  instructions: "",
  web_search: true,
  respond_when_addressed: false,
};
