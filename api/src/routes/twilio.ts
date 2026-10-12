import type { Context } from "hono";
import { Hono } from "hono";
import { countryCode, twilioConnection, twilioSigningKey } from "../connections";
import { calls, contacts } from "../db";
import { isPublicOrigin, LOCAL_SERVER_NOTE, serverOrigin } from "../origin";
import { providerFailure } from "../provider_errors";
import { CLIENT_IDENTITY, configureNumber, listNumbers, voiceToken } from "../providers/twilio";
import { type Recipient, resolveRecipient } from "../recipients";
import * as schemas from "../schemas";
import {
  addToConference,
  callReport,
  endCall,
  hostAnswered,
  placeCall,
  sendText,
  startConference,
  TelephonyError,
  webhooks,
} from "../telephony";
import { toolContext } from "../tool_context";
import type { AppEnv } from "../types";
import { jsonBody, parse } from "../validate";

const VOICE_TOKEN_TTL_S = 3600;
const RECENT_CALLS = 8;

/** Telephony actions the app triggers directly: the same code paths the assistant's tools run. */
export const twilioRoutes = new Hono<AppEnv>()
  .get("/numbers", async (c) => {
    const connection = await twilioConnection(c, c.get("user").username);
    if (!connection) {
      return c.json({ error: "no_twilio_connection" }, 412);
    }
    try {
      return c.json(await listNumbers(connection.client));
    } catch (err) {
      return providerFailure(c, "twilio", err);
    }
  })
  /** Points the chosen number at this app again, for a number that was re-routed in the Twilio console. */
  .post("/numbers/repair", async (c) => {
    const connection = await twilioConnection(c, c.get("user").username);
    if (!connection) {
      return c.json({ error: "no_twilio_connection" }, 412);
    }
    if (!connection.settings.from_number) {
      return c.json({ error: "no_from_number" }, 412);
    }
    if (!isPublicOrigin(serverOrigin(c))) {
      return c.json({ error: "local_server", detail: LOCAL_SERVER_NOTE }, 412);
    }
    try {
      const number = (await listNumbers(connection.client)).find(
        (n) => n.phone_number === connection.settings.from_number,
      );
      if (!number) {
        return c.json({ error: "number_not_found" }, 404);
      }
      return c.json(await configureNumber(connection.client, number.sid, webhooks(serverOrigin(c))));
    } catch (err) {
      return providerFailure(c, "twilio", err);
    }
  })
  /** A short-lived token the Assistant page registers with, so calls can ring in the browser. */
  .get("/voice-token", async (c) => {
    const username = c.get("user").username;
    const connection = await twilioConnection(c, username);
    if (!connection) {
      return c.json({ error: "no_twilio_connection" }, 412);
    }
    try {
      const key = await twilioSigningKey(c, username, connection);
      const token = await voiceToken(key, CLIENT_IDENTITY, VOICE_TOKEN_TTL_S);
      return c.json({ token, identity: CLIENT_IDENTITY, ttl: VOICE_TOKEN_TTL_S });
    } catch (err) {
      return providerFailure(c, "twilio", err);
    }
  })
  /** The latest calls either way, with where an incoming one rang, so a silent phone can be explained. */
  .get("/calls", async (c) => {
    const username = c.get("user").username;
    const rows = await calls.list(c.env.DB, username, null, RECENT_CALLS);
    const names = new Map<string, string>();
    for (const row of rows) {
      if (row.contact_id && !names.has(row.contact_id)) {
        names.set(row.contact_id, (await contacts.get(c.env.DB, username, row.contact_id))?.name ?? row.phone);
      }
    }
    return c.json(
      rows.map((row) => ({
        id: row.id,
        at: row.at,
        direction: row.direction,
        kind: row.kind,
        role: row.role,
        phone: row.phone,
        contact: row.contact_id ? (names.get(row.contact_id) ?? null) : null,
        status: row.status,
        detail: row.direction === "in" ? row.brief : null,
      })),
    );
  })
  .post("/calls", async (c) => {
    const { message, task, ...ref } = await jsonBody(c, schemas.placeCall);
    const username = c.get("user").username;
    return telephony(c, async () => {
      const recipient = await recipientOrThrow(c, username, ref);
      return c.json(await placeCall(toolContext(c), username, recipient, { message, task, host: "mobile" }), 201);
    });
  })
  .post("/calls/end", async (c) => {
    const username = c.get("user").username;
    return telephony(c, async () => c.json(await endCall(toolContext(c), username)));
  })
  .post("/messages", async (c) => {
    const { body, channel, ...ref } = await jsonBody(c, schemas.sendMessage);
    const username = c.get("user").username;
    return telephony(c, async () => {
      const recipient = await recipientOrThrow(c, username, ref);
      return c.json(await sendText(toolContext(c), username, recipient, body, channel), 201);
    });
  })
  .post("/conferences", async (c) => {
    const { participants } = await jsonBody(c, schemas.startConference);
    const username = c.get("user").username;
    return telephony(c, async () => {
      const recipients: Recipient[] = [];
      for (const ref of participants) {
        recipients.push(await recipientOrThrow(c, username, ref));
      }
      return c.json(await startConference(toolContext(c), username, recipients, "mobile"), 201);
    });
  })
  /**
   * The page answered its leg: dial the people waiting for it. Twilio's own answered callback does
   * the same, so whichever arrives first dials and the other finds nothing left to do.
   */
  .post("/conferences/:name/answered", async (c) => {
    const name = parse(schemas.conferenceName, c.req.param("name"));
    const username = c.get("user").username;
    const host = await calls.hostLeg(c.env.DB, username, name);
    if (!host) {
      return c.json({ error: "not_found" }, 404);
    }
    return telephony(c, async () => {
      await hostAnswered({ env: c.env, origin: serverOrigin(c) }, host);
      return c.json({ ok: true });
    });
  })
  /** The report for a call, read by the page the moment its leg drops and handed to its assistant. */
  .get("/conferences/:name/report", async (c) => {
    const name = parse(schemas.conferenceName, c.req.param("name"));
    const username = c.get("user").username;
    return telephony(c, async () => c.json(await callReport(c, username, name)));
  })
  .post("/conferences/participants", async (c) => {
    const ref = await jsonBody(c, schemas.recipient);
    const username = c.get("user").username;
    return telephony(c, async () => {
      const recipient = await recipientOrThrow(c, username, ref);
      return c.json(await addToConference(toolContext(c), username, recipient), 201);
    });
  });

async function recipientOrThrow(
  c: Context<AppEnv>,
  username: string,
  ref: { contact_id?: string; to?: string },
): Promise<Recipient> {
  const resolved = await resolveRecipient(c.env.DB, username, await countryCode(c, username), {
    contact_id: ref.contact_id,
    number: ref.to,
  });
  if (!resolved.ok) {
    throw new TelephonyError("bad_recipient", resolved.error);
  }
  return resolved;
}

/** Preconditions come back as 412 with a code the app can word; Twilio failures as the usual 502. */
async function telephony(c: Context<AppEnv>, action: () => Promise<Response>): Promise<Response> {
  try {
    return await action();
  } catch (err) {
    if (err instanceof TelephonyError) {
      return c.json({ error: err.code, detail: err.message }, err.code === "bad_recipient" ? 400 : 412);
    }
    return providerFailure(c, "twilio", err);
  }
}
