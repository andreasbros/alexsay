import { z } from "zod";
import { MEMORY_CATEGORIES } from "./types";

export const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_.-]{2,32}$/, "2 to 32 of a-z, 0-9, _ . -");
const password = z.string().min(8).max(256);
export const role = z.enum(["admin", "user"]);
export const provider = z.enum(["openai", "lightwave", "twilio"]);

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
  /** The OpenAI project whose SIP endpoint joins phone calls; empty keeps the assistant off the line. */
  project_id: z
    .string()
    .trim()
    .regex(/^proj_[A-Za-z0-9_-]{6,}$/)
    .or(z.literal(""))
    .default(""),
  /** The realtime model that answers the SIP leg of a phone call. */
  call_model: z.string().trim().min(1).max(64).default("gpt-realtime"),
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
  /** The signing secret of the project's webhook for realtime.call.incoming; empty keeps the stored one. */
  webhook_secret: z
    .string()
    .trim()
    .regex(/^whsec_[A-Za-z0-9+/=_-]{8,}$/, "a webhook secret starts with whsec_")
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

export const voiceClient = z.enum(["browser", "mobile"]);
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
  /** What the page running the tool can do: a browser with a phone line takes calls itself. */
  client: z.object({ voice: voiceClient }).optional(),
});

const e164 = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, "an international number such as +447700900123");
const numberRouting = z.object({
  sid: z.string(),
  phone_number: z.string(),
  voice_url: z.string(),
  voice_method: z.string(),
  voice_application_sid: z.string(),
  trunk_sid: z.string(),
  sms_url: z.string(),
  sms_method: z.string(),
  sms_application_sid: z.string(),
  status_callback: z.string(),
});
export type NumberRouting = z.infer<typeof numberRouting>;

export const twilioSettings = z.object({
  /** The Twilio number calls and texts go out from; its webhooks point at this app. */
  from_number: e164.or(z.literal("")).default(""),
  /** A WhatsApp-enabled sender, with or without the whatsapp: prefix; the sandbox number works for testing. */
  whatsapp_from: z
    .string()
    .trim()
    .regex(/^(whatsapp:)?\+[1-9]\d{7,14}$/)
    .or(z.literal(""))
    .default(""),
  /** The user's own mobile: calls ring it first, then connect the other person. */
  my_number: e164.or(z.literal("")).default(""),
  /** A Twilio SIP domain the speakers register with, so incoming calls can ring them. */
  sip_domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]+\.sip\.twilio\.com$/)
    .or(z.literal(""))
    .default(""),
  /** Dialling code assumed for numbers written without one, such as 07700 900123. */
  country_code: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{0,3}$/)
    .default("+44"),
  /** How the chosen number routed calls before this app took it; put back when the user moves on. */
  number_backup: numberRouting.nullable().default(null),
});
export type TwilioSettings = z.infer<typeof twilioSettings>;

/** Empty credentials keep the stored pair, so the number and settings can change on their own. */
export const twilioConnection = z.object({
  account_sid: z
    .string()
    .trim()
    .regex(/^AC[0-9a-fA-F]{32}$/, "an account SID starts with AC")
    .or(z.literal(""))
    .optional(),
  auth_token: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{32}$/, "an auth token is 32 hex characters")
    .or(z.literal(""))
    .optional(),
  settings: twilioSettings.prefault({}),
});

export const contactId = memoryId;
const contactName = z.string().trim().min(1).max(120);
const contactLabel = z.string().trim().max(40).default("");
const contactNote = z.string().trim().max(1000).default("");
const rawPhone = z.string().trim().min(3).max(40);
export const createContact = z.object({ name: contactName, phone: rawPhone, label: contactLabel, note: contactNote });
export const importContacts = z.object({
  contacts: z
    .array(z.object({ name: contactName, phone: rawPhone, label: contactLabel }))
    .min(1)
    .max(1000),
});
export const updateContact = z
  .object({ name: contactName, phone: rawPhone, label: contactLabel, note: contactNote, favourite: z.boolean() })
  .partial();
export const contactList = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  favourites: z.enum(["1", "0"]).default("0"),
});

/** Who a call or message goes to: a contact from the phone book or a number as written. */
const recipientFields = { contact_id: contactId.optional(), to: rawPhone.optional() };
export const recipient = z.object(recipientFields);
export const placeCall = z.object({
  ...recipientFields,
  message: z.string().trim().min(1).max(500).optional(),
  task: z.string().trim().min(1).max(1000).optional(),
});
export const sendMessage = z.object({
  ...recipientFields,
  body: z.string().trim().min(1).max(1600),
  channel: z.enum(["sms", "whatsapp"]).default("sms"),
});
export const startConference = z.object({ participants: z.array(recipient).min(1).max(9) });
export const conferenceName = z.string().regex(/^[a-z0-9-]{4,64}$/);

export const userSettings = z.object({ ai_log_access: z.boolean() });
