# alexsay-server

Your own Alexsay server in one file. It holds the API, the web app, an HTTP server and an embedded SQLite database. It runs the exact Worker that serves app.alexsay.com, inside [workerd](https://github.com/cloudflare/workerd), Cloudflare's open-source runtime.

> **Run it on your own machine or home network.** Exposing it to the internet is at your own risk. If you do, put it behind HTTPS and a tunnel or proxy you trust (see [Public address](#public-address)).

- **Drop and run.** On Linux it is a static musl binary that brings its own runtime, so it runs on any distribution, Alpine included, with nothing to install. macOS and Windows builds need nothing either.
- **Same code as the cloud.** No fork: the TypeScript API is bundled unchanged, and every release passes the same end-to-end suite as app.alexsay.com.
- **Never calls home.** No telemetry, no update checks. You upgrade by downloading a newer release.

## Run it

Download `alexsay-server-<arch>-<os>` from the [latest release](https://github.com/andreasbros/alexsay/releases/latest), then:

```sh
chmod +x alexsay-server-x86_64-linux-musl
./alexsay-server-x86_64-linux-musl                 # serves http://127.0.0.1:8787
./alexsay-server-x86_64-linux-musl add-user me --admin   # in a second terminal
```

Open http://127.0.0.1:8787, sign in, add your OpenAI key under **Connections**, then point a speaker at it:

```sh
alexsay config set server.url http://127.0.0.1:8787     # or this machine's LAN address
```

| Platform | File |
|---|---|
| Linux x86_64 and aarch64 (Raspberry Pi 5), any distro | `alexsay-server-<arch>-linux-musl` |
| macOS, Apple Silicon and Intel | `alexsay-server-<arch>-macos` |
| Windows x86_64, also Windows on Arm through emulation | `alexsay-server-x86_64-windows.zip` |

## Commands

| Command | What it does |
|---|---|
| `alexsay-server` or `alexsay-server run` | Serve the app and the API until Ctrl-C |
| `alexsay-server add-user <name> [--admin]` | Create an account or reset its password. It prompts, or reads one line from stdin. It works whether or not the server is running. |
| `alexsay-server init` | Write `config.toml` and the secrets without starting |
| `alexsay-server config show`, `config path` | Print the settings, or where they are |
| `alexsay-server config set <key> <value>` | Change a setting; restart to apply |
| `alexsay-server paths` | Where the config, secrets, database and runtime live |
| `--home <dir>` or `ALEXSAY_SERVER_HOME` | Use another directory instead of `~/.local/alexsay-server` |

## Configuration

`~/.local/alexsay-server/config.toml`. Every key is optional.

| Key | Default | Meaning |
|---|---|---|
| `host` | `127.0.0.1` | Listen address. `127.0.0.1` is this machine only. `0.0.0.0` is your whole network, and the server warns at start. |
| `port` | `8787` | The app and the API |
| `admin_port` | `8788` | Housekeeping socket for this command. Always bound to 127.0.0.1, guarded by a generated token. |
| `public_url` | empty | The HTTPS address the internet reaches this server at. Only phone calls need it. |
| `registration` | `true` | Anyone who reaches the server may create an account. With `false`, accounts come only from `add-user`. |
| `openai_base_url` | `https://api.openai.com/v1` | The voice and text model provider. Point it at your own OpenAI-compatible server. |
| `lightwave_auth_url`, `lightwave_base_url` | Lightwave's | The lights provider |
| `twilio_base_url` | `https://api.twilio.com` | The phone provider |

Each provider URL can also be overridden for one run with `ALEXSAY_<KEY>`, for example `ALEXSAY_OPENAI_BASE_URL`.

## Data and backups

```
~/.local/alexsay-server/
├── config.toml
└── data/
    ├── secrets.toml      generated once, 0600: the key that seals provider credentials, and the admin token
    ├── storage/          the database: SQLite files, one per Durable Object
    └── runtime/<hash>/   workerd, the Worker and the app, unpacked from the binary
```

- **Backups.** Stop the server and copy `data/secrets.toml` and `data/storage/`.
- **Keep `secrets.toml`.** Without it, the stored OpenAI, Twilio and Lightwave credentials cannot be decrypted. Everything else survives, so you would only re-enter your keys.
- **Schema.** The database schema is the same as Cloudflare D1's. Migrations run on start and are tracked in a `d1_migrations` table, as wrangler does.
- **Upgrades.** A new binary unpacks its own runtime and removes the old one. The database carries over and migrates itself.
- **Housekeeping.** Expired sessions, old logs and stale rows are purged once a day while the server runs.

## Architecture

```
 browser ──HTTP──▶ :8787 ┐
 speaker ──HTTP/WS──▶    ├─ workerd ─ the alexsay Worker (api/, unchanged)
                         │            ├─ D1 binding  → D1Store Durable Object → SQLite in data/storage
                         │            ├─ ASSETS      → the app, from the runtime directory
                         │            └─ CallAgent, LineBridge Durable Objects (phone calls)
 alexsay-server ─:8788 (loopback)─▶ Admin entrypoint: health, add-user, daily purge
```

- **Launcher.** The Rust binary carries a compressed bundle of workerd, the bundled Worker and the built app. It unpacks the bundle, writes workerd's config, keeps the secrets, supervises workerd and restarts it if it dies.
- **D1 shim.** `api/src/selfhost/` gives the Worker the same `DB`, `ASSETS` and secrets bindings as Cloudflare. D1 runs as a Durable Object on its own SQLite, so `prepare`, `bind`, `first`, `all`, `run`, `raw` and atomic `batch` behave as on D1. Nothing else in the API knows which platform it runs on.
- **Static Linux build.** workerd itself only exists as a glibc build. The Linux bundle therefore carries glibc's loader, libc and libm, and the launcher starts workerd through them. That is why it runs on musl distributions too.
- **Compatibility gate.** `just e2e-server` starts the built binary and runs the Playwright suite and the speaker's e2e against it, the same ones that run against app.alexsay.com. CI runs it on every push, and each release starts its own binary on its own architecture.

## Providers

You configure every provider in the app under **Connections**, one set of keys per account. The server only decides where each provider lives.

| Provider | What it gives the assistant | What you enter in Connections |
|---|---|---|
| **OpenAI** (required) | The voice (GPT-Live), the backend model, memory summaries, speech | API key. For phone calls also the project id and a webhook secret. |
| **Lightwave** | Lights: list, switch, dim, rooms | A refresh token from Lightwave's developer settings |
| **Twilio** | Calls, conference calls, texts, WhatsApp, menu keys | Account SID, auth token, your Twilio number, your mobile |

### Your own model

The assistant speaks OpenAI's API. The browser's WebRTC session, the speaker's GPT-Live socket, the backend model for memory, and speech all use `openai_base_url`. The server also hands that URL to every speaker it serves. To use your own model:

1. Run a server that implements the same endpoints:
   - `/live/sessions`, as a WebSocket for speakers and as the WebRTC SDP exchange for the browser.
   - `/responses` for memory and the backend model.
   - `/models` for the connection test.
   - `/audio/speech` for the speaker's spoken notices.
2. Run `alexsay-server config set openai_base_url http://gpu-box.local:9000/v1` and restart.
3. In Connections, enter whatever key your server expects.

Phone calls additionally need a SIP endpoint like `sip.api.openai.com`, `/realtime/calls` and its call webhooks. Without them, calls still open in the browser, but the assistant cannot join them.

### Lights from another system

The lights tools in `api/src/tools.ts` (`list_lights`, `set_light`, `dim_light` and the multi-light variants) call `api/src/providers/lightwave.ts`. To support another system, such as Home Assistant, Hue or MQTT, add a provider module with the same list, set and dim functions, a connection schema in `api/src/schemas.ts`, and route the tools to whichever provider the account has connected. A different Lightwave-compatible endpoint only needs the two `lightwave_*` URLs.

### Phone without Twilio

Telephony is split in three places:

- `api/src/providers/twilio.ts` is the REST client.
- `api/src/telephony.ts` holds call staging: host leg, guests, the assistant's seat, reports.
- `api/src/routes/twilio_webhooks.ts` handles Twilio's callbacks.

A tool call carries the caller's line (`browser`, `speaker` or `mobile`) separately from the provider, so another carrier means a new provider client and webhook routes behind the same tools. A Twilio-compatible API only needs `twilio_base_url`.

### Public address

Everything except phone calls works on a private address. For calls, Twilio and OpenAI must reach the server, so set `public_url` to an HTTPS address that forwards to it, for example a Cloudflare Tunnel (`cloudflared tunnel --url http://127.0.0.1:8787`). These routes are what the internet then calls:

| Route | Called by | For |
|---|---|---|
| `POST /v1/twilio/voice`, `/v1/twilio/voice/outbound` | Twilio | Incoming calls, call legs |
| `POST /v1/twilio/messages` | Twilio | Incoming texts and WhatsApp |
| `POST /v1/twilio/status`, `/v1/twilio/conference` | Twilio | Call and conference progress |
| `GET /v1/twilio/stream/:token` (WebSocket) | Twilio Media Streams | The speaker's phone audio |
| `POST /v1/openai/webhook` | OpenAI | The assistant joining a call over SIP |

- Every Twilio request is checked against your auth token (`X-Twilio-Signature`), and OpenAI's against your webhook secret.
- Without `public_url`, the server leaves your Twilio number's routing alone and keeps the assistant off calls. Calls you place from the browser still work.
- Behind a public address, use strong passwords and close sign-ups with `alexsay-server config set registration false`. The server warns at start while sign-ups are open.
- Without a proxy that sets `CF-Connecting-IP`, the sign-in rate limit counts all clients as one address.

## Build from source

Inside the repository's Nix shell:

```sh
just build-server        # bundle (workerd, Worker, app) + static launcher
just server              # build and run it
just e2e-server          # the compatibility gate
just test-server         # rustfmt, clippy, unit tests
```

`scripts/server-bundle.sh <arch>-<os>` builds the bundle for another platform. workerd is the version wrangler pins, so the server runs the same runtime the API tests ran on.
