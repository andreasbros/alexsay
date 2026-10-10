# Handover: how we got here (9 to 10 Oct 2026)

A condensed history of the design conversation, so a new session understands the reasoning, not just the conclusions.

## Concept: reflash the spare Echo Dot?

- **Brief:** wake word "Alex" launches an OpenAI GPT-Live voice conversation. Andreas has a spare Echo Dot.
- **Echo Dot custom firmware:** only feasible on the 2nd gen (MediaTek bootrom exploit). 3rd gen and later have Amazon's signed boot chain. Even rooted, the old Fire OS and proprietary audio stack make it a poor base. No commercial smart speaker (Echo, Nest, Sonos, HomePod) runs user Linux. Dropped.

## Platform

- Raspberry Pi over ESP32-S3: Linux, easier wake word, AEC handling and WebSocket client, room for Home Assistant.
- Zero 2 W (out of stock) → Pi 4 → **Pi 5 8GB** once Home Assistant joined the same box.
- No Raspberry Pi 6 exists; Raspberry Pi says not before early 2028.

## GPT-Live

- Launched 8 Jul 2026 behind ChatGPT Voice. The 9 Oct design assumed API access was a waitlist alpha (`gpt-live-1-diamond-alpha`) and planned to build on `gpt-realtime` first.
- **Corrected 10 Oct:** `gpt-live-1` has been in the API since 10 Sep 2026 (`wss://api.openai.com/v1/live/sessions`, $0.05/min plus the backend model, any paid tier). It became the primary backend; `gpt-realtime` stays behind the same trait as a fallback.
- Full duplex means the mic hears the speaker constantly, so **hardware AEC is essential**.
- "Alex" is a substring of "Alexa": the wake-word model needs negatives. openWakeWord or microWakeWord.
- **10 Oct:** wake word changed to **"Alexsay"** (three syllables, matches the project name, fewer false wakes than "Alex"). Its nearest confusion is "Alexa, say...".

## First hardware design (superseded)

- ReSpeaker XVF3800 USB 4-mic array + Raspberry Pi DigiAMP+ (2 × 35 W) + passive bookshelf speakers, single 19 V brick powering the Pi through the amp's GPIO feed.
- Music at 48 kHz through the DigiAMP+, a 16 kHz copy fed back to the XVF3800 as the AEC reference (PipeWire combine-sink, adaptive resampling for clock drift), CamillaDSP for EQ.
- Storage: Pimoroni NVMe Base under the Pi (a top M.2 HAT would clash with the DigiAMP+).
- No off-the-shelf case fitted Pi 5 + NVMe Base + DigiAMP+.

## 10 Oct: simplify

- "Can we match an Echo Dot 3 without the amp?" → yes: the XVF3800 has its own DAC, 3.5 mm jack and amp. Playing everything out of the XVF3800 makes the AEC reference sample-exact and deletes the combine-sink, resampling and delay tuning.
- Cost: 16 kHz output, so nothing above ~8 kHz. Speech stays clear (wideband), music sounds muffled. **Andreas dropped music.**
- Mic board went through several options:
  - Standard XVF3800 (USB firmware out of the box, 108 mm square, LED ring, mute button) vs reSpeaker **Flex** (split core + mic boards on a 20 cm FPC, TPA3139D2 amp rated 10 W on 12 V; the XIAO versions ship I2S firmware and need a Safe Mode reflash).
  - Linear Flex for a wall-mounted box → then a free-standing cylinder, so **Circular Flex**. The 12 V / 10 W route was explicitly rejected: USB power only.
  - The Waveshare ESP32-S3 1.85" round LCD board was rejected: one mic, no hardware AEC.
- Enclosure: one box for everything. Buying a broken HomePod as a shell was rejected (glued, no free volume, vibration into the mics). Plan: a 3D-printed PETG cylinder, mics on top, electronics bay, sealed speaker chamber, down-firing driver.
- Speaker: **Visaton R 10 S 4 Ω** (RS), driven by the Flex amp.
- Storage: every official Raspberry Pi SSD option and the NVMe Base turned out sold out or discontinued in the UK; NAND prices made other NVMe drives expensive. **Boot from a SanDisk High Endurance microSD**, move to NVMe (M.2 HAT+ on top, which fits now there's no DigiAMP+) when stock returns.
- Orders placed the same day (see docs/procurement.md). Andreas also bought a micro-HDMI cable and a Raspberry Pi USB 3 Hub for bench work.

## Repo

- This repo mirrors the structure and conventions of `tele1-tech/letterbox`.
- The claude.ai project "Alex Echo" holds the conversation; this repo is the canonical copy. Update here first.
