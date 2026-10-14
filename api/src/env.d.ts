/** Worker secrets (wrangler secret put); the rest of Env comes from wrangler types. */
interface Env {
  SECRETS_KEY: string;
  /** Optional: the public address of this server when it differs from the request's (a tunnel to a local server). */
  PUBLIC_URL?: string;
  /** Optional: "closed" stops sign-ups; accounts are then added by an admin (alexsay-server add-user). */
  REGISTRATION?: string;
  /** Cloudflare only: Email Service, used instead of SMTP when present (needs EMAIL_FROM). */
  EMAIL?: SendEmail;
  /** Optional, all four needed for email without the binding: the SMTP relay (465 is TLS from the start, 587 uses STARTTLS). */
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  /** `alexsay <hello@alexsay.com>`: the sender every email goes out as. */
  EMAIL_FROM?: string;
}
