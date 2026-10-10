# alexsay: Claude handover

You are picking up a hardware + software project with a context window that never saw how it started. Read this first, then `docs/` as needed. History is in [`handover.md`](handover.md).

## What we're building

- A free-standing cylinder speaker (≈150 mm Ø × 210 mm, set by the driver's square frame; measure it on arrival) that replaces an Amazon Echo Dot.
- Wake word **"Alex"** opens a full-duplex OpenAI voice session (`gpt-realtime` now, GPT-Live when its API opens). The user can interrupt the assistant mid-sentence (barge-in).
- Home Assistant runs on the same Pi; the assistant controls the home through it via function calls.
- Voice only. Music playback was dropped on 10 Oct 2026 (it may come back cheaply if the Flex 48 kHz firmware turns out full-band; see docs/device-design.md).

Owner:
- Andreas, senior backend engineer: Rust, cloud, APIs. Hardware is new territory.
- Develops on **Ubuntu Linux**. Has the LetterBox project's tools (TS21 soldering iron, PPK2) on hand.
- London, UK suppliers (The Pi Hut, RS, Farnell, Amazon UK).

## Current status (10 Oct 2026)

- **Everything ordered, nothing arrived.** Pi Hut basket (Pi 5 8GB, Flex XVF3800 circular, cooler, PSU, cables), RS (Visaton R 10 S, due 13 Oct), Amazon (SanDisk High Endurance 256 GB, Anker card reader). See `docs/procurement.md`.
- **Phase 1 (bench bring-up):** reflash the Flex to USB firmware, prove capture, playback and AEC on the bench, then the daemon. **Phase 2:** the printed cylinder, acoustics, NVMe.
- **No code yet.** The daemon is designed in `docs/software.md`; the repo layout follows LetterBox (Rust workspace, Nix flake, `just`).
- **GPT-Live API:** waitlist alpha (`gpt-live-1-diamond-alpha`, `wss://api.openai.com/v1/live/sessions`). Build against GA `gpt-realtime` behind a backend trait.

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
- Realtime API audio is PCM16 mono 24 kHz both ways; the device is 16 kHz (or 48 kHz). The daemon resamples.

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
- "Alex" is a substring of "Alexa": the wake-word model needs "Alexa", "Alexander", "Alexis" and TV speech as negatives.

## Open tasks

- [ ] Request GPT-Live API access; create a project-scoped OpenAI API key with a monthly cap.
- [ ] On arrival: `f3` the SD card; flash Raspberry Pi OS Lite 64-bit; check `vcgencmd get_throttled` is `0x0`.
- [ ] Reflash the Flex to `respeaker_flex_ua-io16-6ch-cir.bin`; capture all 6 channels.
- [ ] Inspect the Flex speaker connector against the JST cables; otherwise solder to the pad.
- [ ] Bench test: playback, AEC residual (ch1 vs raw), io48 vs io16 playback bandwidth (10 kHz tone).
- [ ] Measure: XVF3800 + amp current at 5 V, XIAO idle draw, Pi temperature under HA + daemon with the fan held off.
- [ ] Record wake-word positives/negatives on the device; train an openWakeWord "Alex" model.
- [ ] Scaffold the repo: Nix flake, justfile, Rust workspace (`core` host-tested, `daemon`), systemd unit, HA compose file.
- [ ] Enclosure CAD from Seeed's STEP files (circular mic board, core board) + Pi 5 mechanical drawing; get a PETG print quote.
- [ ] Buy the Phase 2 bits in `docs/procurement.md` "Still to buy" once the bench works.
- [ ] Notify-me on The Pi Hut's Raspberry Pi SSD; buy it plus an M.2 HAT+ when back.

## Code rules

- Same as LetterBox. Everything runs inside the Nix flake: `nix develop` (or direnv), then `just <recipe>`. Add tools to `flake.nix`, never ask for global installs.
- `just test` must pass before a task is done: `cargo fmt --check`, `cargo clippy -D warnings` (pedantic), `cargo test`.
- Clean, self-documenting code: descriptive names over comments. Comment only the non-obvious why, one line. No commented-out code.
- No em-dashes anywhere (code, comments, docs).
- Rust: no `unwrap`/`expect`/`panic` outside tests. Protocol, state machine and DSP logic live in a host-tested `core` crate with no I/O; ALSA, WebSocket and HTTP glue lives in `daemon`.
- Secrets (`OPENAI_API_KEY`, `HA_TOKEN`) only in `.env` (dev) or `/etc/alexsay/env` (0600, device). Never in the repo.
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
