const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * The public site key when this server checks for humans before any sign-in or registration, else null.
 * Cloudflare only: a self-hosted server sets neither, so the check is off there.
 */
export function captchaSiteKey(env: Env): string | null {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim();
  return siteKey && env.TURNSTILE_SECRET ? siteKey : null;
}

/** The e2e suite cannot pass a managed widget: it sends the server's bypass secret in this header instead. */
export const BYPASS_HEADER = "x-turnstile-bypass";

/** The request belongs to this server's own test suite: a header equal to `TURNSTILE_BYPASS`. */
export function bypassed(env: Env, header: string | undefined): boolean {
  const secret = env.TURNSTILE_BYPASS;
  if (!secret || !header || header.length !== secret.length) {
    return false;
  }
  let differ = 0;
  for (let i = 0; i < secret.length; i++) {
    differ |= secret.charCodeAt(i) ^ header.charCodeAt(i);
  }
  return differ === 0;
}

type Incoming = { env: Env; req: { header(name: string): string | undefined } };

/** The site key the page must show for this request, or null when no check applies to it. */
export function captchaFor(c: Incoming): string | null {
  return bypassed(c.env, c.req.header(BYPASS_HEADER)) ? null : captchaSiteKey(c.env);
}

/** True when the request may go on: no check applies here, or Cloudflare vouched for the token. */
export async function passedCaptcha(c: Incoming, token: string | undefined): Promise<boolean> {
  return captchaFor(c) === null || isHuman(c.env, token ?? "", c.req.header("cf-connecting-ip") ?? "");
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
