<div align="center">

# Alexsay

**The open-source voice assistant speaker you build and own.**

[![CI](https://github.com/andreasbros/alexsay/actions/workflows/ci.yml/badge.svg)](https://github.com/andreasbros/alexsay/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/andreasbros/alexsay?display_name=tag&sort=semver)](https://github.com/andreasbros/alexsay/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Rust](https://img.shields.io/badge/rust-stable-orange?logo=rust)
![Platforms](https://img.shields.io/badge/platforms-Linux%20%7C%20Raspberry%20Pi%205%20%7C%20macOS%20%7C%20Windows-lightgrey)
[![App](https://img.shields.io/badge/app-app.alexsay.com-6e56cf)](https://app.alexsay.com)
[![Website](https://img.shields.io/badge/web-alexsay.com-6e56cf)](https://www.alexsay.com)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="website/src/media/home-night-wide-1600.webp">
  <img alt="The Alexsay speaker, a charcoal fabric cylinder, on a wooden side table at home" src="website/src/media/home-day-wide-1600.webp" width="100%">
</picture>

</div>

Say **"Alexsay"** and talk. A full-duplex OpenAI voice conversation answers in about a second, remembers what matters to you, switches your lights, phones your contacts and joins the call with you, all on **your own API keys**.

- 🦀 **One blazing-fast Rust binary.** Static musl on Linux: download, drop it anywhere and run, with no packages, no runtime and no Python. Linux x86_64 and aarch64, macOS, Windows.
- 🏠 **Your own server in one file, too.** `alexsay-server` carries the API, the app, an HTTP server and an embedded SQLite database, and runs the same code as app.alexsay.com.
- 👂 **On-device wake word.** "Alexsay" is spotted locally with a small neural network; train it on your own voice in two minutes.
- 🔇 **Software echo cancellation.** WebRTC's AEC3 in pure Rust removes the speaker's own voice from the microphone, so you can talk over the assistant on any laptop or USB microphone.
- 🍓 **Raspberry Pi 5 stack.** Pi 5, a ReSpeaker XVF3800 four-microphone array with hardware echo cancellation, a 4" driver and a printed cylinder.
- 🧠 **Memory.** Every conversation is summarised and the durable facts are kept, so the assistant knows your people, home and routines next time.
- 📞 **Phone calls.** Call, text and WhatsApp your contacts; the assistant joins the call, presses menu keys, hands you a summary when it ends.

## Quick start

Install the speaker, give it an id, claim it in the app and talk.

```sh
curl -fsSL https://alexsay.com/install.sh | sh     # Linux, Raspberry Pi, macOS
irm https://alexsay.com/install.ps1 | iex          # Windows (PowerShell)

alexsay setup              # prints this speaker's id and checks the microphone and speaker
```

1. Open [app.alexsay.com](https://app.alexsay.com), create an account, and paste your OpenAI API key under **Connections**.
2. Add the id from `alexsay setup` under **Speakers**.
3. Start it and say "Alexsay":

```sh
alexsay run                # listen for the wake word; Ctrl-C stops
alexsay service install    # or run it at boot (systemd, launchd or a Windows task)
```

Prefer to see it first? The **Assistant** tab in the app is the same assistant in your browser.

### Everyday commands

| Command | What it does |
|---|---|
| `alexsay status` | Claimed? Which assistant? Is the service running? |
| `alexsay devices` | Every microphone and speaker, with the exact id to put in the config |
| `alexsay smoke` | Checks every part against the server; `--voice` adds checks you take part in |
| `alexsay wake test --scores` | Live levels and wake word scores, colour coded |
| `alexsay wake record` and `alexsay wake train` | Record your own "Alexsay" and train the wake word on it |
| `alexsay config show`, `alexsay config set audio.volume 0.6` | Read or change the settings |
| `alexsay call status`, `call mute`, `call unmute`, `call hangup` | Control a phone call in progress |
| `alexsay logs -f`, `alexsay update`, `alexsay clean`, `alexsay reset` | Logs, updates (also automatic), housekeeping |

Everything lives under `~/.local/alexsay`: `config.toml` and `data/` (identity, logs, models, recordings). `ALEXSAY_HOME` or `--home` moves it. Releases are checked every six hours, verified against a signing key built into the binary, installed and announced by voice.

## How it works

```
 you ──"Alexsay"──▶ wake word (on device) ──▶ GPT-Live over WebSocket ◀──▶ OpenAI
                                                    │ tool calls
                                                    ▼
                         app.alexsay.com (Cloudflare Worker + D1)
            memory · contacts · lights (Lightwave) · phone (Twilio) · your keys, sealed
```

- **The speaker** captures audio, cancels its own echo, spots the wake word and streams 16 kHz audio to GPT-Live. Every tool the model calls runs on the server as the speaker's owner.
- **The app** at [app.alexsay.com](https://app.alexsay.com) is where you sign in, connect providers, claim speakers, manage contacts and memories, and talk to the assistant in the browser over WebRTC.
- **Your keys** are sealed with AES-GCM in the server's database and handed to a claimed speaker in memory only; nothing secret is written to the speaker's disk.

### How the assistant builds its memory

1. Every conversation, from the speaker or the browser, is recorded turn by turn.
2. When it ends, a backend model reads the transcript with your stored memories and writes a two-sentence summary, then adds, updates or removes memory records: preferences, people, home, routines, reminders and facts.
3. Every new session opens with those memories, the recent summaries, your locale and the time where you are.
4. During a conversation the assistant can `remember`, `forget`, search past conversations and read a transcript back, and you can edit everything under **Memory** in the app.

## Build your own speaker

| Part | Role |
|---|---|
| Raspberry Pi 5 (8 GB) | Runs the `alexsay` binary and, if you like, Home Assistant |
| Seeed ReSpeaker Flex XVF3800 (circular) | Four microphones, beamforming, hardware echo cancellation, amplifier |
| Visaton R 10 S 4 Ω | The 4" driver |
| A printed cylinder, about 150 × 210 mm | The enclosure |

The full parts list, wiring, acoustics and bring-up steps are in [`docs/`](docs/README.md): [build manual](docs/build-manual.md), [device design](docs/device-design.md), [procurement](docs/procurement.md). No hardware yet? Any laptop or a USB microphone and speaker works today.

## Local server or the public one

Run the public app, or your own server with one command. `alexsay-server` is a single binary: static musl on Linux, so it runs on any distribution, Raspberry Pi included, with nothing to install. It is meant for your own machine or home network. Exposing it to the internet is at your own risk. See [`server/README.md`](server/README.md) for its config, data, architecture and providers.

```sh
./alexsay-server-x86_64-linux-musl                   # http://127.0.0.1:8787, data in ~/.local/alexsay-server
./alexsay-server-x86_64-linux-musl add-user me --admin
```

| | Public: `app.alexsay.com` | Your own server |
|---|---|---|
| Setup | None: sign up and go | `alexsay-server` from the [releases](https://github.com/andreasbros/alexsay/releases/latest), or your own Cloudflare account (`just deploy`) |
| Speaker config | Default | `alexsay config set server.url http://localhost:8787` |
| Conversations, memory, tools, lights | ✓ | ✓ |
| Calls opened in the browser | ✓ | ✓ |
| Incoming calls, the assistant joining calls, speaker phone lines | ✓ | Needs a public address: run a tunnel (for example `cloudflared`) and set `public_url` |

Twilio and OpenAI call back into the server for phone calls, so those parts need an address the internet can reach. A local server knows when it has none: it leaves your Twilio number's routing alone, keeps the assistant off calls and says why.

## Providers

Alexsay works with these providers today. You connect each one in the app under **Connections**, with your own account's keys. The keys are sealed with AES-GCM on the server and never written to a speaker's disk.

| Provider | Needed for | What to enter |
|---|---|---|
| [OpenAI](https://platform.openai.com) | Everything: the voice (GPT-Live), memory, spoken notices | An API key from a paid project. For phone calls, also the project id and a webhook secret. |
| [Twilio](https://www.twilio.com) | Calls, conference calls, texts, WhatsApp, menu keys | Account SID, auth token, your Twilio number and your mobile. Saving points the number's webhooks at your server. |
| [Lightwave](https://lightwaverf.com) | Lights and dimmers by room | A refresh token from Lightwave's developer settings |

Each connection has a **Help** button in the app with the exact steps to get its keys.

### Bring your own model, phone or lights

- **Model.** Everything that talks to OpenAI goes through one base URL, which the server also hands to its speakers. Point `openai_base_url` at any server with the same API (GPT-Live, Responses, speech) and the browser and speakers follow.
- **Lights.** The light tools call one provider module. Add a module for Home Assistant, Hue or MQTT with the same list, switch and dim functions, and a connection for it.
- **Phone.** The phone tools sit on a provider client, call staging and webhook routes. A new carrier replaces those three behind the same tools. A Twilio-compatible API needs only `twilio_base_url`.

The [server README](server/README.md#providers) has the endpoints, files and settings for each.

## Development

Everything runs inside the Nix flake: Rust, Node, pnpm, wrangler, Playwright, `just`.

```sh
git clone https://github.com/andreasbros/alexsay.git
cd alexsay
nix develop                 # or: direnv allow
just --list                 # every recipe
```

| Recipe | Does |
|---|---|
| `just test` | Every gate: rustfmt, clippy (pedantic), cargo test, Biome, tsc, Vitest (the API in workerd with a local D1), app and website builds |
| `just dev` | Local server on :8787 with a local database, and the app on :5173 |
| `just build-speaker x86_64-linux` | Static musl build of the speaker; `aarch64-linux` for the Raspberry Pi |
| `just build-server`, `just server` | Static build of `alexsay-server` with its bundle, and running it |
| `just e2e-server` | The compatibility gate: the Playwright suite and the speaker e2e against the built server |
| `just install-speaker` | Debug build into `~/.local/bin` for trying changes |
| `just e2e` and `just e2e-device` | Playwright against the deployed site, and the binary against the deployed server |
| `just deploy` | Tests, D1 migrations, deploy, then the e2e suite |
| `just release patch` | Tag a release; CI builds, signs and publishes every platform |

Hacking on the speaker alone:

```sh
cd device
cargo test --workspace
cargo run -p alexsay-daemon -- devices
cargo run -p alexsay-daemon -- run
```

Self-hosting the server on your own Cloudflare account: create an API token (Workers Scripts, D1, Workers Routes, DNS), `cp .env.example .env`, paste it, `just secrets-key`, `just create-db`, put the id into `api/wrangler.jsonc`, then `just deploy`.

### Repository layout

| Path | What |
|---|---|
| `device/` | Rust workspace: `core` (host-tested logic: config, session rules, wake word, echo rules, signed updates) and `daemon` (the `alexsay` binary) |
| `api/` | Cloudflare Worker (Hono and D1): accounts, speakers, connections, memory, tools, telephony |
| `server/` | `alexsay-server`: the Worker, the app and workerd in one binary, with SQLite |
| `app/` | The web app (Vite, React, Radix Themes) at app.alexsay.com |
| `website/` | The website at alexsay.com, with the install scripts |
| `e2e/` | Playwright suite against the deployed site |
| `docs/` | Hardware and software design, test plans, decisions |

## Contributing

Issues and pull requests are welcome. `just test` must pass, every behaviour change comes with a test, and secrets never enter the repository. [`.claude/CLAUDE.md`](.claude/CLAUDE.md) is the project's working notes: key facts, gotchas and open tasks.

## Credits

Alexsay stands on these projects. Thank you to their authors.

**Rust crates in the speaker**

| Crate | Used for |
|---|---|
| [sonora](https://crates.io/crates/sonora) | WebRTC audio processing in pure Rust: AEC3 echo cancellation |
| [rustpotter](https://crates.io/crates/rustpotter) | The wake word: MFCC features and a small neural network |
| [cpal](https://crates.io/crates/cpal) | Microphone and speaker on ALSA, CoreAudio and WASAPI |
| [rubato](https://crates.io/crates/rubato) | Resampling between the device rate and 16 kHz |
| [hound](https://crates.io/crates/hound) | WAV reading and writing |
| [tokio](https://crates.io/crates/tokio), [futures-util](https://crates.io/crates/futures-util) | The async runtime |
| [tokio-tungstenite](https://crates.io/crates/tokio-tungstenite) | WebSockets to GPT-Live and the phone line |
| [reqwest](https://crates.io/crates/reqwest) | HTTPS to the server, OpenAI and GitHub (rustls) |
| [serde](https://crates.io/crates/serde), [serde_json](https://crates.io/crates/serde_json), [toml](https://crates.io/crates/toml) | Events, API bodies and the config file |
| [clap](https://crates.io/crates/clap) | The command line |
| [ed25519-dalek](https://crates.io/crates/ed25519-dalek), [sha2](https://crates.io/crates/sha2), [semver](https://crates.io/crates/semver) | Signed, verified self-updates |
| [self-replace](https://crates.io/crates/self-replace), [flate2](https://crates.io/crates/flate2), [tar](https://crates.io/crates/tar), [zip](https://crates.io/crates/zip) | Swapping in a downloaded release |
| [base64](https://crates.io/crates/base64), [uuid](https://crates.io/crates/uuid) | Audio framing and the speaker's identity |
| [tracing](https://crates.io/crates/tracing), [tracing-subscriber](https://crates.io/crates/tracing-subscriber), [tracing-appender](https://crates.io/crates/tracing-appender) | Logs to the terminal and daily files |
| [anyhow](https://crates.io/crates/anyhow), [thiserror](https://crates.io/crates/thiserror) | Errors |

**Rust crates in the server**

| Crate | Used for |
|---|---|
| [ruzstd](https://crates.io/crates/ruzstd), [tar](https://crates.io/crates/tar), [sha2](https://crates.io/crates/sha2) | Unpacking the embedded runtime |
| [ureq](https://crates.io/crates/ureq) | The loopback housekeeping calls |
| [clap](https://crates.io/crates/clap), [serde](https://crates.io/crates/serde), [serde_json](https://crates.io/crates/serde_json), [toml](https://crates.io/crates/toml) | The command line and config |
| [ctrlc](https://crates.io/crates/ctrlc), [libc](https://crates.io/crates/libc) | Clean shutdown, and workerd stopping with its launcher |
| [rpassword](https://crates.io/crates/rpassword), [getrandom](https://crates.io/crates/getrandom) | Password prompts and generated secrets |
| [anyhow](https://crates.io/crates/anyhow) | Errors |

**The rest of the stack:** [workerd](https://github.com/cloudflare/workerd) inside `alexsay-server`, [OpenAI GPT-Live](https://platform.openai.com), [Cloudflare Workers and D1](https://developers.cloudflare.com/workers/), [Hono](https://hono.dev), [Zod](https://zod.dev), [React](https://react.dev), [Radix Themes](https://www.radix-ui.com/themes), [Vite](https://vite.dev), [Twilio](https://www.twilio.com), [Lightwave](https://lightwaverf.com), [Playwright](https://playwright.dev), [Nix](https://nixos.org), [just](https://just.systems), and [Seeed Studio](https://www.seeedstudio.com) for the ReSpeaker XVF3800.

## License

[MIT](LICENSE) © 2026 Andreas Abros
