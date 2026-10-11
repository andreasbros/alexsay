import type { Context } from "hono";
import { Hono } from "hono";
import { countryCode, twilioConnection } from "../connections";
import { providerFailure } from "../provider_errors";
import { listNumbers } from "../providers/twilio";
import { type Recipient, resolveRecipient } from "../recipients";
import * as schemas from "../schemas";
import { addToConference, placeCall, sendText, startConference, TelephonyError } from "../telephony";
import type { AppEnv } from "../types";
import { jsonBody } from "../validate";

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
  .post("/calls", async (c) => {
    const { message, ...ref } = await jsonBody(c, schemas.placeCall);
    const username = c.get("user").username;
    return telephony(c, async () => {
      const recipient = await recipientOrThrow(c, username, ref);
      return c.json(await placeCall(c, username, recipient, message), 201);
    });
  })
  .post("/messages", async (c) => {
    const { body, channel, ...ref } = await jsonBody(c, schemas.sendMessage);
    const username = c.get("user").username;
    return telephony(c, async () => {
      const recipient = await recipientOrThrow(c, username, ref);
      return c.json(await sendText(c, username, recipient, body, channel), 201);
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
      return c.json(await startConference(c, username, recipients), 201);
    });
  })
  .post("/conferences/participants", async (c) => {
    const ref = await jsonBody(c, schemas.recipient);
    const username = c.get("user").username;
    return telephony(c, async () => {
      const recipient = await recipientOrThrow(c, username, ref);
      return c.json(await addToConference(c, username, recipient), 201);
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
