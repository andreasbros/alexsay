/** Worker secrets (wrangler secret put); the rest of Env comes from wrangler types. */
interface Env {
  SECRETS_KEY: string;
  /** Optional: the public address of this server when it differs from the request's (a tunnel to a local server). */
  PUBLIC_URL?: string;
  /** Optional: "closed" stops sign-ups; accounts are then added by an admin (alexsay-server add-user). */
  REGISTRATION?: string;
}
