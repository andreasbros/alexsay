# Decisions

Newest last. Each entry: what was decided, why, what was rejected.

## 2026-10-09: Build new hardware, don't reflash the Echo Dot

- **Decision:** Replace the Echo Dot with a Raspberry Pi 5 based device.
- **Why:** Echo Dot root exploits only exist for old generations and leave Amazon's closed audio stack; no route to a custom realtime voice model.
- **Rejected:** Jailbreaking the Echo Dot.

## 2026-10-09: Raspberry Pi 5, not an ESP32 satellite

- **Decision:** Pi 5 8GB runs the wake word, the voice session and Home Assistant.
- **Why:** The realtime WebSocket session, resampling, EQ and an ONNX wake word in one Rust process fit easily on a Pi; an ESP32 would need a server elsewhere anyway.
- **Rejected:** ESP32-S3 satellite plus separate server.

## 2026-10-09: OpenAI realtime now, GPT-Live behind a trait

- **Decision:** Build on `gpt-realtime` (GA). The client sits behind a `VoiceBackend` trait so GPT-Live drops in when access arrives.
- **Why:** GPT-Live is a waitlist alpha; the GA API is available today and has the same session shape.
- **Rejected:** Waiting for GPT-Live access before writing code.

## 2026-10-09: Hardware echo cancellation is mandatory

- **Decision:** Use an XMOS XVF3800 mic array.
- **Why:** Full-duplex voice with barge-in needs the device to cancel its own voice; software AEC on a Pi with a separate sound card drifts and needs delay tuning.
- **Rejected:** USB conference mics, plain I2S mic HATs with software AEC.

## 2026-10-10: Voice only; all audio through the XVF3800

- **Decision:** No music. The assistant's voice plays through the Flex's own DAC and amp.
- **Why:** One USB device for capture and playback gives a sample-exact AEC reference with no clock drift. Removes the separate amp, DAC and 12 V supply.
- **Rejected:** Raspberry Pi DigiAMP+ with a separate speaker path; 12 V supply for the Flex amp's 10 W rating (5 V USB power gives ~3 W, enough for speech).

## 2026-10-10: reSpeaker Flex XVF3800 circular with XIAO

- **Decision:** Flex circular, reflashed to a USB `-cir` image.
- **Why:** Circular geometry gives 360° pickup in a free-standing cylinder. The cased XVF3800 4-mic array was sold out.
- **Rejected:** Flex linear (wall-mount geometry, wrong for a cylinder); HA Voice PE as the mic front end (ESP32 firmware, not a USB audio device for the Pi).

## 2026-10-10: Visaton R 10 S, sealed chamber, DSP EQ

- **Decision:** One 4" full-range driver, down-firing, ~1.5 L sealed chamber, high-pass and peaking cut in the daemon.
- **Why:** Best voice quality that runs from the Flex amp on 5 V (92.6 dB/1 W). Its high Qts boosts fc in any practical box, so EQ is mandatory.
- **Rejected:** Small 40 to 50 mm drivers (thin voice, Echo Dot class).

## 2026-10-10: Boot from SD now, NVMe later

- **Decision:** SanDisk High Endurance 256 GB microSD for Phase 1. M.2 HAT+ and Raspberry Pi SSD 256 GB when the SSD is back in stock.
- **Why:** The Raspberry Pi SSD is sold out in the UK (The Pi Hut, Pimoroni, Farnell); the Farnell kit is no longer manufactured. An endurance-rated card is fine for a bench build.
- **Rejected:** NVMe Base (sold out); third-party NVMe drives (unchecked compatibility, not needed yet).

## 2026-10-10: Printed PETG cylinder

- **Decision:** Design and print the enclosure, ≈150 mm Ø × 210 mm, PETG.
- **Why:** The driver's square frame sets the diameter; PETG survives Pi bay temperatures.
- **Rejected:** Gutting a HomePod (glued shell, wrong internal volume, no mic ports where the Flex needs them); Waveshare ESP32-S3 round LCD board (tiny speaker, no XVF3800-class AEC).

## 2026-10-10: Home Assistant in Docker on the same Pi

- **Decision:** HA Container with host networking, pinned to cores 0 and 1; the daemon on cores 2 and 3.
- **Why:** One box. HA OS would take over the Pi; Supervised and Core installs are deprecated.
- **Rejected:** HA OS, separate HA server.

## 2026-10-10: Firmware io16-6ch for bring-up, evaluate io48

- **Decision:** Flash `respeaker_flex_ua-io16-6ch-cir.bin` first; test `respeaker_flex_ua-io48-cir.bin` for production.
- **Why:** 6 channels give raw mics for wake-word data and AEC debugging. io48 may give full-band playback of the 24 kHz API voice.
- **Rejected:** Keeping the shipped I2S firmware.

## 2026-10-10: GPT-Live is the primary backend

- **Decision:** Build on `gpt-live-1` (Live API, WebSocket, PCM 16 kHz, Responses delegation for tools). `gpt-realtime` stays behind the `VoiceBackend` trait as a fallback.
- **Why:** GPT-Live-1 has been GA in the API since 10 Sep 2026; the 9 Oct entry wrongly assumed a waitlist alpha. It is the model the project was conceived for (true full duplex), costs $0.05/min plus the backend model, and accepts 16 kHz audio, so the io16 firmware needs no resampling.
- **Rejected:** `gpt-realtime` as the primary backend.

## 2026-10-10: Wake word "Alexsay"

- **Decision:** The wake word is "Alexsay", not "Alex".
- **Why:** Three syllables carry more acoustic evidence than two, so fewer false wakes from everyday speech and TV; it matches the project name.
- **Watch:** "Alexa, say..." is nearly the same sound. It goes in the negative set and gets its own false-accept test.
- **Rejected:** "Alex" (substring of "Alexa", common name on TV).

## 2026-10-12: Self-hosted server runs the Worker inside workerd

- **Decision:** `alexsay-server` embeds workerd and runs the unchanged Worker; D1 becomes a SQLite-backed Durable Object behind a D1-compatible shim.
- **Why:** One codebase for Cloudflare and self-hosting, so the same e2e suite gates both. A Rust or Node rewrite of the API would drift.
- **Linux:** workerd is glibc-only, so the bundle carries glibc's loader and libc; the launcher is static musl and the whole thing runs on Alpine.
- **No updates:** the server never checks for or installs updates; users upgrade by hand.
- **Rejected:** Bun or Node with a D1 emulation (a second runtime to keep in step), rewriting the API in Rust.

## 2026-10-14: Bench bring-up choices

- **Flex firmware:** Seeed renamed the images (`respeaker_flex_usb_<image>_v1.0.4.bin`); `c16k6ch` is the old io16-6ch. `just flex-flash` takes it from the GitHub release at a pinned SHA-256 and flashes on the Pi over SSH, so a reflash is one command.
- **Board AEC is enough:** ~45 dB of echo removed and clean double talk on ch1 (measurements.md), so the Flex build keeps hardware echo cancelling and barge-in on.
- **Pi OS by the Imager CLI:** `rpi-imager` from Nix dumps core before drawing its window on Ubuntu; `rpi-imager --cli` with cloud-init `user-data` and `network-config` does the same customisation (key-only SSH, Wi-Fi), with no Wi-Fi password in the repo.
- **Static ALSA:** the release binary found no sound cards off the build machine (alsa-lib's config path is a Nix store path); the daemon now falls back to `/usr/share/alsa`.
- **Service:** a systemd user unit plus `loginctl enable-linger`, so the speaker starts at boot without a login.
- **Rejected:** a USB-C gadget link to the Pi (the Pi 5's USB-C is its 5 A power input), the Flex's 12 V terminal (speech is loud enough on USB 5 V).

## 2026-10-14: Alarm command words

- **Decision:** "stop" and "snooze" are two small LiveKit classifiers (same toolkit as the wake word, 3,000 clips a class), heard only in the 3 s after "Alexsay" while an alarm rings, at sensitivity 0.5.
- **Why:** an alarm has to stop offline; a local word model needs no internet and costs nothing while nothing rings. Held out: stop 93%, snooze 78%, never confused with each other (measurements.md).
- **Rejected:** sensitivity 1.0 (a few more catches, many more near-miss fires), 6,000 clips a class (speech generation at about 2 clips a second made it a day-long run).

## 2026-10-14: Homes and email

- **Decision:** everything belongs to a home; one home per person; a home's id is its creator's username.
- **Why:** sharing the whole household (speakers, memories, contacts, alarms) is the point of a home speaker. Keying homes by the creator's username made the migration a column rename with no data rewritten, and kept every foreign key.
- **Cost:** a home cannot change owner; deleting the creator's account deletes the home.
- **Email:** one SMTP client for Cloudflare (Email Service's relay, from `alexsay.com`, 3,000 a month included in Workers Paid) and self-hosted (any relay). Running our own mail server is not possible on Workers (no listening sockets, port 25 blocked) and a new sending IP would land in spam.
- **Codes:** HMAC-SHA256 under the server's secret instead of the plain SHA-256 used in sxreels (6 digits are trivial to brute-force from a leaked hash); guesses are not reset by a new code.
- **Rejected:** several homes per person with a switcher (asked: one home), per-person data inside a shared home (asked: everything shared), Cloudflare's `send_email` binding (a second code path next to SMTP for self-hosting).

