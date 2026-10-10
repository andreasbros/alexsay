import { z } from "zod";
import { MEMORY_CATEGORIES } from "./types";

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
  /** Only answer when the user says the name, so a TV or other people in the room are ignored. */
  respond_when_addressed: z.boolean().default(false),
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

export const assistantSession = z.object({
  sdp: z.string().min(16).max(65_536),
  resume_from: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
});

const featureId = z.string().regex(/^[A-Za-z0-9_.+-]{1,160}$/);
export const featureValue = z.object({ value: z.number().int().min(0).max(100) });
export const featureWrites = z.object({
  features: z
    .array(z.object({ featureId, value: z.number().int().min(0).max(100) }))
    .min(1)
    .max(50),
});

export const memoryId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const id = memoryId;
export const memoryCategory = z.enum(MEMORY_CATEGORIES);
const turnRole = z.enum(["user", "assistant", "tool"]);

export const startConversation = z.object({
  source: z.enum(["app", "device"]).default("app"),
  device_id: deviceId.optional(),
});
export const addTurns = z.object({
  turns: z
    .array(z.object({ at: z.number().int().min(0), role: turnRole, text: z.string().min(1).max(4000) }))
    .min(1)
    .max(200),
});
export const conversationList = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(100).optional(),
});
export const createMemory = z.object({ category: memoryCategory, content: z.string().trim().min(1).max(500) });
export const updateMemory = z
  .object({ category: memoryCategory, content: z.string().trim().min(1).max(500) })
  .partial();
export const toolCall = z.object({
  name: z.string().regex(/^[a-z_]{1,40}$/),
  arguments: z.record(z.string(), z.unknown()).default({}),
  conversation_id: id.optional(),
});
