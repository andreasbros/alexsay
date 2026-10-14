const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * The public site key when this server checks for humans before sending sign-in email, else null.
 * Cloudflare only: a self-hosted server sets neither, so the check is off there.
 */
export function captchaSiteKey(env: Env): string | null {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim();
  return siteKey && env.TURNSTILE_SECRET ? siteKey : null;
}

/** Cloudflare's verdict on a widget token; any failure to ask counts as no. */
export async function isHuman(env: Env, token: string, ip: string): Promise<boolean> {
  if (!token || !env.TURNSTILE_SECRET) {
    return false;
  }
  try {
    const res = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, ...(ip ? { remoteip: ip } : {}) }),
    });
    const verdict = (await res.json()) as { success?: boolean };
    return verdict.success === true;
  } catch {
    return false;
  }
}
