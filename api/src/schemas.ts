import { z } from "zod";

export const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_.-]{2,32}$/, "2 to 32 of a-z, 0-9, _ . -");
const password = z.string().min(8).max(256);
export const role = z.enum(["admin", "user"]);
export const provider = z.enum(["openai", "lightwave"]);

export const deviceId = z.string().trim().toLowerCase().uuid();
const deviceName = z.string().trim().max(64);

export const register = z.object({ username, password });
export const login = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) });

export const claimDevice = z.object({ id: deviceId, name: deviceName.default("") });
export const updateDevice = z.object({ name: deviceName, owner: username.nullable() }).partial();

export const updateUser = z.object({ role });

export const heartbeat = z.object({
  firmware: z.string().max(64).optional(),
  uptime_s: z.number().int().min(0).optional(),
  ip: z.string().max(64).optional(),
});

const voice = z.enum(["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"]);
export const openaiSettings = z.object({
  model: z.string().trim().min(1).max(64).default("gpt-live-1"),
  backend_model: z.string().trim().min(1).max(64).default("gpt-6-luna"),
  voice: voice.default("cedar"),
  instructions: z.string().max(4000).default(""),
  web_search: z.boolean().default(true),
});
export type OpenAiSettings = z.infer<typeof openaiSettings>;

/** An empty or missing key keeps the stored one, so settings can change on their own. */
export const openaiConnection = z.object({
  api_key: z
    .string()
    .trim()
    .regex(/^sk-[A-Za-z0-9_-]{20,}$/, "an OpenAI API key starts with sk-")
    .or(z.literal(""))
    .optional(),
  settings: openaiSettings.prefault({}),
});

export const lightwaveConnection = z.object({
  basic_token: z.string().trim().min(16).max(512),
  refresh_token: z.string().trim().min(16).max(512),
});

export const assistantSession = z.object({ sdp: z.string().min(16).max(65_536) });

const featureId = z.string().regex(/^[A-Za-z0-9_.+-]{1,160}$/);
export const featureValue = z.object({ value: z.number().int().min(0).max(100) });
export const featureWrites = z.object({
  features: z
    .array(z.object({ featureId, value: z.number().int().min(0).max(100) }))
    .min(1)
    .max(50),
});
