import type { Context } from "hono";
import { Hono } from "hono";
import {
  exchangeLightwave,
  lightwaveToken,
  lightwaveUrls,
  type OpenAiSecret,
  openaiConnection,
  spotifyConnection,
  spotifyToken,
  spotifyUrls,
  twilioConnection,
} from "../connections";
import { connections } from "../db";
import { logFor } from "../log";
import { isPublicOrigin, LOCAL_SERVER_NOTE, serverOrigin } from "../origin";
import { providerFailure } from "../provider_errors";
import { structureIds } from "../providers/lightwave";
import { listModels, ProviderError } from "../providers/openai";
import { authorizeUrl, type SpotifySecret, devices as spotifyDevices, me as spotifyMe } from "../providers/spotify";
import {
  configureNumber,
  listNumbers,
  restoreNumber,
  routedTo,
  routingOf,
  type TwilioClient,
  verifyAccount,
} from "../providers/twilio";
import * as schemas from "../schemas";
import { twilioSettings } from "../schemas";
import { open, seal } from "../secrets";
import { completeLogin, homeOfState, loginState, redirectUri } from "../spotify";
import { webhooks } from "../telephony";
import type { AppEnv } from "../types";

import { jsonBody } from "../validate";

/** Each provider is one card in the app: stored sealed, listed without secrets, testable on demand. */
export const connectionRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const rows = await connections.list(c.env.DB, c.get("user").home);
    return c.json(
      rows.map((row) => ({
        provider: row.provider,
        settings: JSON.parse(row.settings) as Record<string, unknown>,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
    );
  })
  .put("/openai", async (c) => {
    const { api_key, webhook_secret, settings } = await jsonBody(c, schemas.openaiConnection);
    const home = c.get("user").home;
    const existing = await connections.get(c.env.DB, home, "openai");
    const stored = existing ? await open<OpenAiSecret>(c.env.SECRETS_KEY, existing.secret) : null;
    const apiKey = api_key || stored?.api_key;
    if (!apiKey) {
      return c.json({ error: "key_required" }, 400);
    }
    const secret: OpenAiSecret = { api_key: apiKey };
    const webhookSecret = webhook_secret || stored?.webhook_secret;
    if (webhookSecret) {
      secret.webhook_secret = webhookSecret;
    }
    // Only a new key or secret re-seals; a settings-only save leaves the stored ciphertext alone
    const sealed = !api_key && !webhook_secret && existing ? existing.secret : await seal(c.env.SECRETS_KEY, secret);
    await connections.put(c.env.DB, home, "openai", sealed, JSON.stringify(settings));
    return c.json({ provider: "openai", settings, calls: !!(webhookSecret && settings.project_id) });
  })
  .put("/lightwave", async (c) => {
    const pasted = await jsonBody(c, schemas.lightwaveConnection);
    let secret: Awaited<ReturnType<typeof exchangeLightwave>>;
    try {
      secret = await exchangeLightwave(c, pasted);
    } catch (err) {
      if (err instanceof ProviderError) {
        return c.json({ error: "lightwave_rejected", status: err.status, detail: err.detail }, 400);
      }
      throw err;
    }
    const sealed = await seal(c.env.SECRETS_KEY, secret);
    await connections.put(c.env.DB, c.get("user").home, "lightwave", sealed, "{}");
    return c.json({ provider: "lightwave", settings: {} });
  })
  .put("/twilio", async (c) => {
    const { account_sid, auth_token, settings } = await jsonBody(c, schemas.twilioConnection);
    const home = c.get("user").home;
    const existing = await connections.get(c.env.DB, home, "twilio");
    const pasted = account_sid && auth_token ? { account_sid, auth_token } : null;
    if (!pasted && !existing) {
      return c.json({ error: "credentials_required" }, 400);
    }
    const secret = pasted ?? (existing ? await open<TwilioClient["secret"]>(c.env.SECRETS_KEY, existing.secret) : null);
    if (!secret) {
      return c.json({ error: "credentials_required" }, 400);
    }
    const client: TwilioClient = { baseUrl: c.env.TWILIO_BASE_URL, secret };
    const before = existing ? twilioSettings.parse(JSON.parse(existing.settings)) : null;
    // The server owns the backup: the number's routing before this app took it, restored when it lets go
    settings.number_backup = before?.number_backup ?? null;
    let local = false;
    try {
      if (pasted) {
        await verifyAccount(client);
      }
      if (settings.from_number !== (before?.from_number ?? "")) {
        if (settings.number_backup) {
          await restoreNumber(client, settings.number_backup);
          settings.number_backup = null;
        }
        if (settings.from_number) {
          const number = (await listNumbers(client)).find((n) => n.phone_number === settings.from_number);
          if (!number) {
            return c.json({ error: "number_not_found" }, 400);
          }
          if (isPublicOrigin(serverOrigin(c))) {
            const hooks = webhooks(serverOrigin(c));
            settings.number_backup = routedTo(number, hooks) ? null : routingOf(number);
            await configureNumber(client, number.sid, hooks);
          } else {
            // Pointing the number at a private address would break it; callbacks cannot arrive here anyway
            local = true;
          }
        }
      }
    } catch (err) {
      if (err instanceof ProviderError) {
        return c.json({ error: "twilio_rejected", status: err.status, detail: err.detail }, 400);
      }
      throw err;
    }
    const sealed = pasted ? await seal(c.env.SECRETS_KEY, pasted) : (existing?.secret ?? "");
    await connections.put(c.env.DB, home, "twilio", sealed, JSON.stringify(settings));
    return c.json({ provider: "twilio", settings, ...(local ? { local: true, note: LOCAL_SERVER_NOTE } : {}) });
  })
  /** The home's own Spotify app: saving the credentials starts over, the account signs in afterwards. */
  .put("/spotify", async (c) => {
    const { client_id, client_secret } = await jsonBody(c, schemas.spotifyConnection);
    const secret: SpotifySecret = { client_id, client_secret };
    const settings = schemas.spotifySettings.parse({});
    await connections.put(
      c.env.DB,
      c.get("user").home,
      "spotify",
      await seal(c.env.SECRETS_KEY, secret),
      JSON.stringify(settings),
    );
    return c.json({ provider: "spotify", settings, redirect_uri: redirectUri(serverOrigin(c)) });
  })
  /** Sends the browser to Spotify's sign-in page; it comes back to the callback with a code. */
  .get("/spotify/authorize", async (c) => {
    const home = c.get("user").home;
    const connection = await spotifyConnection(c, home);
    if (!connection) {
      return c.json({ error: "not_found" }, 404);
    }
    const state = await loginState(c.env, home, Date.now());
    return c.redirect(authorizeUrl(spotifyUrls(c), connection.secret.client_id, redirectUri(serverOrigin(c)), state));
  })
  .post("/spotify/test", async (c) => {
    try {
      const token = await spotifyToken(c, c.get("user").home);
      if (!token) {
        return c.json({ error: "not_found" }, 404);
      }
      const urls = spotifyUrls(c);
      const [account, all] = await Promise.all([spotifyMe(urls, token), spotifyDevices(urls, token)]);
      return c.json({
        ok: true,
        account: account.display_name,
        premium: account.product === "premium",
        devices: all.length,
      });
    } catch (err) {
      return providerFailure(c, "spotify", err);
    }
  })
  .post("/openai/test", async (c) => {
    const connection = await openaiConnection(c, c.get("user").home);
    if (!connection) {
      return c.json({ error: "not_found" }, 404);
    }
    try {
      const models = await listModels(c.env.OPENAI_BASE_URL, connection.apiKey);
      const { model, backend_model } = connection.settings;
      return c.json({
        ok: true,
        models: models.length,
        live_model: models.includes(model),
        backend_model: models.includes(backend_model),
      });
    } catch (err) {
      return providerFailure(c, "openai", err);
    }
  })
  .post("/lightwave/test", async (c) => {
    try {
      const token = await lightwaveToken(c, c.get("user").home);
      if (!token) {
        return c.json({ error: "not_found" }, 404);
      }
      const structures = await structureIds(lightwaveUrls(c), token);
      return c.json({ ok: true, structures: structures.length });
    } catch (err) {
      return providerFailure(c, "lightwave", err);
    }
  })
  .post("/twilio/test", async (c) => {
    const connection = await twilioConnection(c, c.get("user").home);
    if (!connection) {
      return c.json({ error: "not_found" }, 404);
    }
    try {
      const [account, numbers] = await Promise.all([verifyAccount(connection.client), listNumbers(connection.client)]);
      return c.json({ ok: true, account: account.friendly_name, numbers: numbers.length });
    } catch (err) {
      return providerFailure(c, "twilio", err);
    }
  })
  .delete("/:provider", async (c) => {
    const parsed = schemas.provider.safeParse(c.req.param("provider"));
    if (!parsed.success) {
      return c.json({ error: "not_found" }, 404);
    }
    if (parsed.data === "twilio") {
      await releaseTwilioNumber(c);
    }
    const result = await connections.remove(c.env.DB, c.get("user").home, parsed.data);
    return result.meta.changes ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  });

/** Removing Twilio hands the number's earlier routing back; a failure there must not keep the connection. */
async function releaseTwilioNumber(c: Context<AppEnv>): Promise<void> {
  const connection = await twilioConnection(c, c.get("user").home);
  if (!connection?.settings.number_backup) {
    return;
  }
  try {
    await restoreNumber(connection.client, connection.settings.number_backup);
  } catch (err) {
    console.warn(
      JSON.stringify({ provider: "twilio", restore: "failed", error: err instanceof Error ? err.message : "" }),
    );
  }
}

/**
 * Spotify sends the browser back here from accounts.spotify.com: a cross-site navigation, so the
 * `SameSite=Strict` session cookie is not on it. The home comes from the signed `state` instead,
 * which only a signed-in home admin could have been given, minutes ago.
 */
export const spotifyCallbackRoute = new Hono<AppEnv>().get("/spotify/callback", async (c) => {
  const { code, state, error } = c.req.query();
  const back = `${serverOrigin(c)}/#spotify`;
  const home = state ? await homeOfState(c.env, state, Date.now()) : null;
  if (!home) {
    return c.json({ error: "bad_state" }, 400);
  }
  if (error || !code) {
    await logFor(c, home, "warn", `spotify sign-in did not complete: ${error || "no code"}`);
    return c.redirect(back);
  }
  try {
    const settings = await completeLogin({ env: c.env, origin: serverOrigin(c) }, home, code);
    await logFor(c, home, "info", `spotify signed in as ${settings.account}${settings.premium ? " (Premium)" : ""}`);
  } catch (err) {
    if (err instanceof ProviderError) {
      await logFor(c, home, "error", `spotify sign-in failed: ${err.status} ${err.detail}`);
      return c.redirect(back);
    }
    throw err;
  }
  return c.redirect(back);
});
