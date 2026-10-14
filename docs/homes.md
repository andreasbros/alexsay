# Homes, members, invitations and email login

## Homes

- Every account gets a home called "Home" when it is created; its admin can rename it.
- Everything belongs to the home, not the person: speakers, connections (OpenAI, Lightwave, Twilio), memories, conversations, contacts, messages, calls, alarms, skills, scheduler jobs, the server log, and the home settings (locale, time zone, AI log access, AI call test). Everyone in a home sees and uses all of it.
- A person is in exactly one home at a time (`users.home_id`, `users.home_role`: `admin` or `user`).
- A home's id is its creator's username, so every data table keeps its foreign key to `users` (renamed `home_id`), and deleting the creator's account deletes the home. Ownership cannot move.
- The creator is always an admin of their own home and cannot be removed or demoted.
- Joining another home sets your own home aside, untouched; leaving or being removed brings you back to it. A creator whose home has other members cannot join another home until they remove them.

| | admin | user |
|---|---|---|
| Assistant, memories, contacts, alarms, conversations | yes | yes |
| Speakers, connections, home settings: see | yes | yes |
| Speakers, connections, home settings: change | yes | no |
| Rename the home, invite, change roles, remove members | yes | no |
| Leave the home | yes, unless it is their own | yes |

- The server's own `users.role` (`admin` = manages the server's accounts and server settings) is separate from the home role.

## Email

- Optional per account (`users.email`, unique, lower-case, verified before it is stored). Settings adds or changes it with a code sent to the new address.
- Sending (`api/src/mail.ts`, `mailRoute`): the sender is `EMAIL_FROM` (`Alexsay <hello@alexsay.com>`, a var in `api/wrangler.jsonc`). Subjects start with `alexsay.com:`; the header says Alexsay.com in Inter, the website's font, where the client loads web fonts.
  - Cloudflare: the Email Service binding `EMAIL` (`send_email` in `api/wrangler.jsonc`), used whenever it is bound. Workers cannot open sockets to Cloudflare's own addresses, so its SMTP relay `smtp.mx.cloudflare.net` fails from a Worker ("Stream was cancelled", 14 Oct 2026). The domain is onboarded in Email Service, DKIM and SPF automatic. Included in Workers Paid: 3,000 a month per account, then $0.35 per 1,000.
  - Self-hosted: an SMTP client over `cloudflare:sockets` (implicit TLS on 465 or STARTTLS on 587) to any relay, from `config.toml` (`smtp_host`, `smtp_port`, `smtp_user`, `smtp_password`, `email_from`).
- Templates (`api/src/mail_templates.ts`): one table-layout shell (works in Gmail light and dark), each email HTML plus plain text, every interpolated value HTML-escaped: login code, confirm email, home invitation.
- Server settings (server admins, Users page): **Email login** on or off. It can only be switched on when SMTP is configured; invitations need it on.
- Cloudflare setup (once): onboard `alexsay.com` under Email Service, Email Sending (DNS records added automatically); no API token or SMTP secrets. Turnstile (below) needs a widget for `app.alexsay.com`.

## Email login

- A separate **Email** tab on the sign-in page, shown when email login is on. One email carries a 6-digit code and a link; either signs in.
- Codes and link tokens are stored only as HMAC-SHA256 under a key derived from `SECRETS_KEY` (a leaked table cannot be brute-forced offline), compared in constant time, single use.
- A code lives 10 minutes and allows 5 wrong guesses; a new code does not reset the guesses. At most 5 emails an hour per address and 30 per IP address.
- Bots: with `TURNSTILE_SITE_KEY` (var, public) and `TURNSTILE_SECRET` (secret) set, the Email tab shows Cloudflare Turnstile and `/email/start` refuses (403 `captcha_failed`) unless Cloudflare's siteverify passes the widget's token (`api/src/turnstile.ts`). Unset, the check is off: a self-hosted server sets neither. Invitations and adding an email in Settings come from signed-in admins and need no check.
- The start request always answers the same, whether the address has an account or not.
- An address with no account: with registration open, signing in creates one (username from the address, made unique) with its own home; with registration closed, nothing is sent.
- Links carry their token after `#` (`/sign-in/email#token=...`, `/invite#token=...`): it never reaches a server log or a Referer, and the page posts it, so mail scanners that fetch links cannot use it up.

## Invitations

- Home admins invite by email with a role. The invitation email links to `/api/invites/accept?token=...`, valid for 3 days (`invites`, token stored as an HMAC).
- Opening the link signs the person in: an existing account with that email (or a signed-in session) joins the home; otherwise an account is created with the email already verified. Either way they land in the app, in the new home.
- One live invitation per home and address; inviting again replaces it and sends a new link.
- The **Home** tab (the app's first page, `/`): name, Devices, People, Invitations, Connections. Admins rename, manage members (role, remove), invitations with status (pending, accepted, expired, revoked), resend and delete. Members see the home and can leave it.

## Data model (migration 0012)

- `homes` (id = creator's username, name, locale, timezone, ai_log_access, ai_call_test); `users.home_id` (NULL = own home), `users.home_role`, `users.email` (unique).
- Every per-person table's `username` column became `home_id` (same values, same foreign key to `users`); `devices.owner` became `devices.home_id`.
- `server_settings` (key, value), `email_codes` (one per address and purpose), `invites`.
- The scheduler's Durable Object is still named by the same string; before homes it stored it under `username`, which it still reads.
