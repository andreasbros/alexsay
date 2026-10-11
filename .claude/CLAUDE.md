# alexsay: Claude handover

You are picking up a hardware + software project with a context window that never saw how it started. Read this first, then `docs/` as needed. History is in [`handover.md`](handover.md).

## What we're building

- A free-standing cylinder speaker (≈150 mm Ø × 210 mm, set by the driver's square frame; measure it on arrival) that replaces an Amazon Echo Dot.
- Wake word **"Alexsay"** opens a full-duplex OpenAI voice session (`gpt-live-1`, with `gpt-realtime` as a fallback backend). The user can interrupt the assistant mid-sentence (barge-in).
- Home Assistant runs on the same Pi; the assistant controls the home through it via function calls.
- Voice only. Music playback was dropped on 10 Oct 2026 (it may come back cheaply if the Flex 48 kHz firmware turns out full-band; see docs/device-design.md).

Owner:
- Andreas, senior backend engineer: Rust, cloud, APIs. Hardware is new territory.
- Develops on **Ubuntu Linux**. Has the LetterBox project's tools (TS21 soldering iron, PPK2) on hand.
- London, UK suppliers (The Pi Hut, RS, Farnell, Amazon UK).

## Current status (10 Oct 2026)

- **Everything ordered, nothing arrived.** Pi Hut basket (Pi 5 8GB, Flex XVF3800 circular, cooler, PSU, cables), RS (Visaton R 10 S, due 13 Oct), Amazon (SanDisk High Endurance 256 GB, Anker card reader). See `docs/procurement.md`.
- **Phase 1 (bench bring-up):** reflash the Flex to USB firmware, prove capture, playback and AEC on the bench, then the daemon. **Phase 2:** the printed cylinder, acoustics, NVMe.
- **Software scaffold exists (10 Oct 2026):** `device/` (Rust: identity, heartbeat, GPT-Live event types, session state machine; no audio yet), `api/` (Cloudflare Worker, Hono + D1, serves `app/dist` at app.alexsay.com), `app/` (Radix UI: login/register, devices, assistant sphere over WebRTC to GPT-Live, connections for OpenAI and Lightwave, admin users), `website/` (prerendered Vite site, own Worker at www.alexsay.com and alexsay.com), `e2e/` (Playwright with a fake device). Layout and conventions follow LetterBox.
- **GPT-Live API:** available since 10 Sep 2026, no waitlist. `gpt-live-1` at `wss://api.openai.com/v1/live/sessions`, $0.05/min plus the backend model's tokens, any paid tier (not Free). Primary backend; `gpt-realtime` stays behind the same trait as a fallback.

## Where things are

| Need | File |
|---|---|
| System diagram, session flow, AEC model | `docs/architecture.md` |
| BOM, enclosure, acoustics, power, thermal, edge cases | `docs/device-design.md` |
| Daemon design: state machine, audio formats, realtime events, wake word, tools, deployment | `docs/software.md` |
| Step-by-step bring-up | `docs/build-manual.md` |
| What was bought / still to buy | `docs/procurement.md` |
| Test plan and results | `docs/measurements.md` |
| Why decisions were made | `docs/decisions.md` |
| Similar projects, what we reuse | `docs/prior-art.md` |

When results come in, update `docs/measurements.md` and add an entry to `docs/decisions.md`.

## Server and app facts

- Live since 10 Oct 2026: Worker `alexsay-app` (app.alexsay.com, D1 `alexsay`), Worker `alexsay-www` (www.alexsay.com and alexsay.com). Deploy token `alexsay-deploy` and the e2e account passwords are in `.env` only. `just e2e` passes against production.

- Browser assistant: the Worker brokers only the SDP exchange (`POST /v1/live/sessions` with `transport: {type: "webrtc", sdp}`), audio travels WebRTC browser to OpenAI, JSON events over the `oai-events` data channel. Function calls arrive as `response.event` envelopes wrapping `response.output_item.done`; the browser answers with `response.item.create` (`function_call_output`) + `response.create`.
- A speaker's UUID is its identity and its secret: whoever adds it in the app owns it; the heartbeat then returns the owner's OpenAI key and settings to the speaker. Unclaimed call-home rows are capped at 200.
- Provider credentials are AES-GCM sealed in D1 under `SECRETS_KEY` (Worker secret, also in `.env` for `just dev`). Lightwave refresh tokens rotate on every use and are re-sealed.
- Passwords are salted PBKDF2-SHA256 (100k) hashed on the server; `scripts/hash-password.mjs` makes the same format for `just add-user`.
- Both `alexsay.com` and `www.alexsay.com` serve the website (no redirect; canonical is www).
- Telephony (11 Oct 2026): Twilio is a third connection (account SID + auth token sealed; settings: `from_number`, `my_number`, `whatsapp_from`, `sip_domain`, `country_code`). Saving with a number sets that number's Voice/SMS/status webhooks to `/v1/twilio/{voice,messages,status}` on this app; every webhook is checked against the owner's auth token (X-Twilio-Signature). The assistant's phone tools run server-side through `api/src/telephony.ts`: `place_call` rings `my_number` and bridges with `<Dial>`, or reads a message out with `<Say>`; conferences use the Participants API with a friendly name (host leg `EndConferenceOnExit`); texts and WhatsApp go through `Messages.json`. Incoming calls ring every claimed speaker as `sip:{deviceId}@{sip_domain}` plus `my_number` at once; the speaker will register with a SIP client (baresip) using its UUID as the SIP username (credential list still manual). The Twilio MCP server (`mcp.twilio.com/docs`) is docs-only, so there is nothing to wire into the assistant.
- Phone calls from the app (11 Oct 2026): a tool call carries `client.voice = "browser"` when the Assistant page has registered as Twilio Client `alexsay-app` (Voice SDK, token from `/api/twilio/voice-token`, API key created on first use and sealed with the Twilio secret). `place_call` then opens a conference: browser host leg (`client:alexsay-app?conference=...`, `EndConferenceOnExit`), the person, and the assistant as a SIP leg `sip:{project_id}@sip.api.openai.com;transport=tls?X-Alexsay-Conference=...` when the OpenAI connection has `project_id` and a webhook secret. OpenAI's `realtime.call.incoming` webhook hits `/v1/openai/webhook`, is verified Standard-Webhooks style with that user's secret (found through the conference header), and is accepted with the briefing stored on the assistant leg (`calls.brief`, model `call_model`, default `gpt-realtime`). The page mutes its GPT-Live session while a call is connected. The Twilio SDK is built with `window.AudioContext` hidden and `disableAudioContextSounds`, and shares the GPT-Live microphone track through its `getUserMedia` option (no second capture on iPhone). Incoming calls to the number also ring `<Client>alexsay-app</Client>`; the page shows Answer/Decline. The assistant leg has no tools yet (that needs a Durable Object holding the `wss://api.openai.com/v1/realtime?call_id=` socket).
- Contacts live in D1 (`contacts`, unique per user and E.164 number, indexed on `search_name` and favourites; `messages` and `calls` keep the history). The app imports them with the Contact Picker API (Android Chrome, iOS Safari) or a `.vcf` file; numbers are normalised with the user's `country_code` (default +44).
- `@cloudflare/vitest-pool-workers` 0.22 has no `fetchMock`: API tests stub `globalThis.fetch` through `mockUpstream` in `api/test/helpers.ts`.
- Vite 8 (rolldown) rejects object-form `manualChunks`.
- The flake references the aarch64 cross gcc by path (not on PATH) so host C builds keep the host gcc; the Pi binary links against `/lib/ld-linux-aarch64.so.1` (see `device/.cargo/config.toml`).

## Key facts to keep straight

- The **XVF3800 does both capture and playback**, so the AEC reference is the exact signal sent to the speaker. Never route speech output through another sound card: that breaks AEC and brings back the combine-sink/clock-drift problem we designed away.
- Flex firmware is **geometry-specific**: only `*-cir.bin` images for this board. Flashing a `-lin` image is explicitly unsupported by Seeed.
- Flex USB firmware options (Seeed repo, whole-repo download only):
  - `respeaker_flex_ua-io16-6ch-cir.bin`: 16 kHz, 6 ch (0 conference, 1 ASR, 2 to 5 raw mics). Bring-up and wake-word data capture.
  - `respeaker_flex_ua-io48-cir.bin`: 48 kHz, 2 ch. Production candidate if playback proves full-band.
  - `respeaker_flex_ua-io16-cir.bin`: 16 kHz, 2 ch.
- 16 kHz playback cuts everything above ~8 kHz: speech stays clear (wideband, like HD Voice), music sounds muffled.
- Flex amp: rated 10 W at 4 Ω on its 12 V terminal; on USB 5 V expect ~3 W (estimate, to measure). We run it from USB only.
- Visaton R 10 S 4 Ω: fs 160 Hz, Qts 1.45, Vas 1.9 L, Xmax ±0.5 mm, 92.6 dB/1 W, 100 Hz to 13 kHz, 93 mm cut-out. High Qts: any small sealed box peaks 6 to 8 dB around 220 to 270 Hz, so **high-pass ~150 Hz and a peaking cut at fc are mandatory** (applied in the daemon before playback, so AEC still sees the true output).
- Pi 5 on the 27 W PSU allows 1.6 A total on USB. Budget: XVF3800 + amp peak < 1 A.
- GPT-Live takes PCM16 mono at **16 kHz** or 24 kHz, fixed at `session.start` for both directions. With the io16 firmware the daemon runs at 16 kHz end to end, no resampling. (`gpt-realtime` is 24 kHz only and needs a resampler.)
- GPT-Live tools: Responses delegation to a backend text model; custom functions arrive as `response.output_item.done` inside `response.event`, the daemon runs them and returns `function_call_output` + `response.create`.

## Gotchas already discovered

- The Flex with XIAO ships with **I2S firmware**: it does not appear as a sound card. Safe Mode = hold **Boot** while powering on, then `sudo dfu-util -l` shows `2886:001a`. I2S firmware only accepts I2C DFU, so Safe Mode is the only USB route.
- Flash through the **XMOS USB-C port next to the RST button**, not the XIAO's USB-C.
- Download Seeed's firmware by cloning the whole repo; GitHub "save as" corrupts the `.bin`.
- The Flex has **no mute button and no LED ring** (one green power LED). Mic mute and status feedback are software: earcons through the speaker.
- The XIAO ESP32-S3 stays powered after the reflash and runs whatever it shipped with. Check its current draw and RF; flash a deep-sleep sketch if it matters.
- The **JST PH 2-pin "male header" cables** ordered from The Pi Hut mate with *female plug* cables (LiPo style), so they likely do not fit the board's speaker header. The female version is sold out. The Flex has a **solder pad for a hard-wired speaker**: use it.
- R 10 S terminals are tabs: **5.2 mm (+)** and 2.8 mm (−). No standard push-on for 5.2 mm: solder, heat-shrink.
- Never drive the R 10 S hard while unbaffled on the bench: no box means no air load and the cone over-excurses at low frequencies.
- The SanDisk High Endurance card came from a marketplace seller (Electrolyx UK): verify capacity with `f3write`/`f3read` before trusting it.
- Raspberry Pi SSD (all capacities), the SSD Kit and the Pimoroni NVMe Base were **out of stock or discontinued in the UK on 10 Oct 2026**. NAND prices made other NVMe drives £60 to £90+. Start on the SD card.
- Wake word is **"Alexsay"** (changed from "Alexsay" on 10 Oct 2026). "Alexa, say..." sounds almost the same, so it is the most important negative, with "Alexa", "Alexsay", "Alex says", "Alexei" and TV speech.

## Open tasks

- [ ] OpenAI platform: add prepaid credit (Free tier can't use `gpt-live-1`), create project `alexsay` with a monthly budget, create a project API key.
- [ ] On arrival: `f3` the SD card; flash Raspberry Pi OS Lite 64-bit; check `vcgencmd get_throttled` is `0x0`.
- [ ] Reflash the Flex to `respeaker_flex_ua-io16-6ch-cir.bin`; capture all 6 channels.
- [ ] Inspect the Flex speaker connector against the JST cables; otherwise solder to the pad.
- [ ] Bench test: playback, AEC residual (ch1 vs raw), io48 vs io16 playback bandwidth (10 kHz tone).
- [ ] Measure: XVF3800 + amp current at 5 V, XIAO idle draw, Pi temperature under HA + daemon with the fan held off.
- [ ] Record wake-word positives/negatives on the device; train an openWakeWord "Alexsay" model.
- [x] Scaffold the repo: Nix flake, justfile, Rust workspace (`core` host-tested, `daemon`), systemd unit. HA compose file still to do.
- [ ] Daemon audio: ALSA capture/playback through the Flex, GPT-Live WebSocket client in `daemon` on top of `core::live` and `core::session`.
- [ ] Daemon telephony: SIP registration (baresip) against the Twilio SIP domain from the heartbeat's `telephony` block; create the credential list entry per speaker through Twilio's API instead of by hand.
- [ ] WhatsApp templates (Content API) for messages outside the 24 h window; message status callbacks.
- [ ] Phone calls: verify on the iPhone that the Twilio SDK brings no clicks and that the shared microphone track works; give the assistant leg tools over the realtime websocket (Durable Object); let the speaker daemon take the same conference role as the browser.
- [ ] App: email instead of username, password reset, Apple Home / Google Home / Claude / Gemini connections.
- [ ] Enclosure CAD from Seeed's STEP files (circular mic board, core board) + Pi 5 mechanical drawing; get a PETG print quote.
- [ ] Buy the Phase 2 bits in `docs/procurement.md` "Still to buy" once the bench works.
- [ ] Notify-me on The Pi Hut's Raspberry Pi SSD; buy it plus an M.2 HAT+ when back.

## Code rules

- Same as LetterBox. Everything runs inside the Nix flake: `nix develop` (or direnv), then `just <recipe>`. Add tools to `flake.nix`, never ask for global installs.
- `just test` must pass before a task is done: `cargo fmt --check`, `cargo clippy -D warnings` (pedantic), `cargo test`, Biome, `tsc`, Vitest (api in workerd with local D1), app and website builds. `just e2e` runs against the deployed site with the `test-admin` / `test-user` accounts from `.env`; `just deploy` ends with it.
- TypeScript: strict, no `any`, validate input with zod, parameterised D1 queries only.
- Clean, self-documenting code: descriptive names over comments. Comment only the non-obvious why, one line. No commented-out code.
- No em-dashes anywhere (code, comments, docs).
- Rust: no `unwrap`/`expect`/`panic` outside tests. Protocol, state machine and DSP logic live in a host-tested `core` crate with no I/O; ALSA, WebSocket and HTTP glue lives in `daemon`.
- Secrets (`CLOUDFLARE_API_TOKEN`, `SECRETS_KEY`, e2e passwords) only in `.env`; on the device `/etc/alexsay/env` (0600). Never in the repo. Commits go out under Andreas's own account with no Claude co-author line.
- Every behaviour change ships with a test.
- Docs stay lean: bullets and tables, no introductions. Update `docs/` and this file when facts change.

## Working with Andreas

- He prefers **concise, technically precise, direct answers**, minimal hedging, mental models and edge cases, no introductory explanations. When he's frustrated, give the shortest correct answer.
- He wants **links** for anything to buy. Before recommending a part:
  - Verify UK stock **and lead time** on the product page itself, today.
  - Don't mix one supplier's price with another's availability.
  - Flag "out of stock everywhere" early.

  Past mistakes in this project: the Pimoroni NVMe Base and the Farnell Raspberry Pi SSD Kit were recommended while sold out / no longer manufactured; a Pi Hut "Awesome extras" JST cable was assumed to fit the board; a 12 V supply was added to the list without asking whether he wanted the 10 W speaker route (he didn't).
- Don't add parts he hasn't asked for without saying why in one line. Keep Phase 1 (bench) and Phase 2 (enclosure) parts clearly separated.
