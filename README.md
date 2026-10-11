# alexsay

An open-source smart speaker. Say **"Alexsay"** and it opens a full-duplex OpenAI voice conversation (GPT-Live, `gpt-live-1`) with your own API keys, and controls the home through Home Assistant and provider integrations.

- **Hardware:** Raspberry Pi 5 8GB, Seeed reSpeaker Flex XVF3800 (circular 4-mic array, hardware echo cancellation, on-board amp), Visaton R 10 S 4" driver, one 3D-printed cylinder
- **Cloud:** Cloudflare Workers + D1. The app at [app.alexsay.com](https://app.alexsay.com), the website at [www.alexsay.com](https://www.alexsay.com)
- **Status (10 Oct 2026):** hardware ordered, nothing assembled. Software scaffold deployed: accounts, device claiming, provider connections, browser assistant

## Code

| Path | What |
|---|---|
| `device/` | Rust workspace: `core` (host-tested protocol, config, GPT-Live events, session state machine) and `daemon` (the `alexsay` binary: identity, heartbeat; audio comes with the hardware) |
| `api/` | Cloudflare Worker (Hono + D1) at `app.alexsay.com`: accounts, devices, connections, GPT-Live session broker; serves `app/dist` |
| `app/` | The web app (Vite, React, Radix Themes): login, register, devices, assistant sphere, connections, admin users |
| `website/` | The marketing site (Vite, React, prerendered) at `www.alexsay.com` and `alexsay.com`, its own Worker |
| `e2e/` | Playwright suite against the deployed site, with a fake device that calls the real device API |
| `brand/`, `scripts/icons.sh` | The AY mark and the script that renders every icon size for app and website |
| `deploy/` | systemd unit and example config for the Pi |
| `docs/` | Hardware and software design, see [`docs/README.md`](docs/README.md) |

All tooling comes from the Nix flake (`nix develop`, or `direnv allow` once). `just` lists the recipes:

| Recipe | Does |
|---|---|
| `just check` | setup check: Nix shell, toolchain, env vars, Cloudflare token |
| `just test` | fmt, clippy, cargo test, Biome, tsc, Vitest (api runs in workerd with local D1), app and website builds |
| `just dev` | local Worker (:8787) with local D1 + app dev server (:5173); `just dev-website` for the site |
| `just e2e` | Playwright against the deployed site (`E2E_*` in `.env`); `just deploy` runs it last |
| `just deploy` / `just deploy-website` | deploy the app Worker (with D1 migrations) / the website Worker |
| `just build-device` / `just deploy-device` | aarch64 release build of the daemon / install it on the Pi as a systemd service |
| `just add-user <name> [admin]` / `just e2e-users` | create or update an account in D1 / the two e2e accounts from `.env` |
| `just secrets-key` / `just create-db` / `just logs` | one-off Cloudflare setup, Worker logs |
| `just icons` | re-render the icon set from `brand/logo.svg` |

## How it fits together

- Anyone registers with a username and password. Admins (role set in the Users page or with `just add-user <name> admin`) see every account and speaker.
- A speaker identifies itself with the UUID from `alexsay id`. Its owner adds that UUID in the app; from then on the speaker's heartbeat (`POST /v1/device/heartbeat`, header `X-Device-Id`) returns the owner's assistant settings.
- Connections hold provider credentials, AES-GCM sealed under the `SECRETS_KEY` Worker secret: OpenAI (key, live model, backend model, voice, extra instructions), Lightwave (basic + refresh token, rotated on every refresh) and Twilio (account SID + auth token; a number, your mobile, a WhatsApp sender and an optional SIP domain for the speaker).
- Contacts (Memory, Contacts) are imported from the phone or a vCard; the assistant can call, text and WhatsApp them, start group calls, and the speaker can receive calls.
- The Assistant tab opens a WebRTC call straight to GPT-Live: the browser posts its SDP offer to the Worker, the Worker creates the session with the owner's key (`POST /v1/live/sessions`) and returns the answer. Events flow over the `oai-events` data channel; with Lightwave connected, the backend model gets `list_lights` and `set_light` tools that the browser runs against the Worker.

## Cloudflare access

1. Cloudflare dashboard > My Profile > API Tokens > Create token (custom): Account: Workers Scripts Edit, D1 Edit, Account Settings Read, Workers Observability Edit; Zone `alexsay.com`: Workers Routes Edit, DNS Edit, Zone Read.
2. `cp .env.example .env`, paste the token, `just secrets-key`.
3. `just create-db`, copy the id into `api/wrangler.jsonc`, `just deploy`, `just deploy-website`.
4. e2e accounts: set `E2E_ADMIN_PASSWORD` and `E2E_USER_PASSWORD` in `.env`, then `just e2e-users`. The suite creates speakers and `e2e-*` accounts and removes them again.

## For Claude / new contributors

[`.claude/CLAUDE.md`](.claude/CLAUDE.md) holds the project context, key facts, gotchas and open tasks. [`.claude/handover.md`](.claude/handover.md) is the history of how we got here.
