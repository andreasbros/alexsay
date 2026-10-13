# Build manual: Phase 1 bench

Steps run on Andreas's Ubuntu laptop (flashing) and on the Pi over SSH. Record results in [measurements.md](measurements.md).

## 0. Before the parts arrive

1. OpenAI API (GPT-Live needs no waitlist since 10 Sep 2026):
   1. [platform.openai.com](https://platform.openai.com) → Settings → Billing: add prepaid credit (the Free tier can't use `gpt-live-1`).
   2. Settings → Projects → create `alexsay`; Limits: set a monthly budget and alert.
   3. In that project → API keys → create a secret key, owned by the project, named `alexsay-pi`. Copy it once.
   4. Put it only in `.env` (dev) and later `/etc/alexsay/env` (0600) on the Pi as `OPENAI_API_KEY=...`.
   5. Smoke test from the laptop: open a WebSocket to `wss://api.openai.com/v1/live/sessions` with `Authorization: Bearer $OPENAI_API_KEY`, send `session.start` with `"model": "gpt-live-1"`, expect `session.started`.
2. Flex firmware: `just flex-flash` fetches it from Seeed's release (github.com/respeaker/reSpeaker_Flex, v1.0.4) and checks it against a pinned SHA-256 (GitHub "save as" on a single `.bin` from the source tree corrupts it).
3. Install Raspberry Pi Imager on the laptop.

## 1. SD card

1. The card came from a marketplace seller: check it is genuine before trusting it. `sudo apt install f3`, then `f3write /media/$USER/<card>` and `f3read` on the same path (a 256 GB card takes a couple of hours). Any reported corruption or a capacity short of ~238 GB means return it.
2. Imager: Raspberry Pi 5 → Raspberry Pi OS Lite (64-bit). In the OS customisation: hostname `alexsay`, your user, **SSH public key only**, Wi-Fi (country GB), locale Europe/London.

## 2. Pi bring-up

1. Fit the Active Cooler (peel the pads, clip into the two holes, fan lead to the fan header).
2. Insert the card, connect Ethernet if available, power from the 27 W PSU. Monitor + USB 3 Hub + keyboard only if SSH fails.
3. `ssh alexsay.local`, then `sudo apt update && sudo apt full-upgrade -y && sudo rpi-eeprom-update -a && sudo reboot`.
4. `vcgencmd get_throttled` must print `throttled=0x0`. Anything else is a power problem; fix it before continuing.

## 3. Flex: assemble and reflash to USB firmware

1. Power off. Connect the 24-pin FPC between the core board and the circular mic board: keyed, 0.5 mm pitch, contacts facing the same way at both ends. Don't flex it repeatedly.
2. Mount the mic board on M3 nylon standoffs with the **mic ports (the back side) facing up/out**, nothing touching them.
3. On the Pi: `sudo apt install -y dfu-util alsa-utils` (the laptop's `dfu-util` comes from the Nix shell).
4. **Safe Mode:** with the Flex unplugged, hold **Boot**, plug the 15 cm cable into the **XMOS USB-C port next to the RST button** (not the XIAO's port), release.
5. `sudo dfu-util -l` must list `2886:001a` with alt 0 "Factory" and alt 1 "Upgrade". No output means the wrong port or Safe Mode didn't engage.
6. Flash the 6-channel circular image (never a linear `l` image) from the laptop, on the Pi over SSH (or locally without the host):

   ```sh
   just flex-flash c16k6ch <user>@<pi-host>
   ```

7. `arecord -l` now lists the Flex as a capture card; `aplay -l` lists it for playback. Note the card name for the config.
8. udev rule so tools work without sudo (later in `deploy/`): `SUBSYSTEM=="usb", ATTRS{idVendor}=="2886", MODE="0660", TAG+="uaccess"`.

## 4. Capture test

```sh
arecord -D hw:CARD=<name>,DEV=0 --dump-hw-params -d 1 /dev/null   # supported formats
arecord -D plughw:CARD=<name>,DEV=0 -c 6 -r 16000 -f S32_LE -d 10 six.wav
```

Speak from 1 m and 3 m. In Audacity (on the laptop): ch1 (ASR) should be clean and level; ch2 to ch5 raw and quieter.

## 5. Speaker

1. Inspect the Flex speaker connector. If the ordered JST PH "male header" cables don't mate (likely), solder the lead to the **speaker solder pad** instead.
2. Twisted pair, ~20 cm. Red to the R 10 S **5.2 mm (+) tab**, black to the 2.8 mm (−) tab; solder, heat-shrink.
3. **Bench box first:** the R 10 S must not run hard unbaffled. A sealed shoebox-sized temporary box (or the cut-out in a piece of board) is enough for tests.
4. Low level first:

   ```sh
   alsamixer -c <name>            # PCM well below max
   speaker-test -D plughw:CARD=<name>,DEV=0 -r 16000 -c 2 -t sine -f 440 -l 1
   ```

5. Raise the level to normal speech loudness at 1 m; `vcgencmd get_throttled` must stay `0x0`.

## 6. Echo cancellation test

1. Play a speech recording through the Flex at conversation volume while recording all 6 channels; then repeat while also talking over it.
2. Compare ch1 (after AEC) with ch2 (raw): the played speech should be strongly attenuated in ch1, your voice intact. Note the residual in [measurements.md](measurements.md).
3. Seeed's `xvf_host.py` (in the firmware repo; needs `pyusb`) reads `VERSION`, `DOA_VALUE` and the AEC parameters for tuning.

## 7. 16 vs 48 kHz playback

1. Play a 10 kHz tone with the io16-6ch image: it should be silent.
2. `just flex-flash c48k2ch <user>@<pi-host>` (Safe Mode not needed: USB firmware accepts USB DFU directly) and repeat. Audible means the 48 kHz path is full-band.
3. Repeat the AEC test on io48. Flash back to io16-6ch for wake-word recording.

## 8. Home Assistant

```sh
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
sudo mkdir -p /srv/homeassistant
```

`deploy/compose.yaml` (to be committed): `ghcr.io/home-assistant/home-assistant:stable`, `network_mode: host`, `cpuset: "0,1"`, volume `/srv/homeassistant:/config`, `restart: unless-stopped`. Onboard at `http://alexsay.local:8123`, create a long-lived access token for the daemon.

## 9. Daemon

Once `core/` and `daemon/` exist: `just build-device && just deploy-device`, then `just logs`. First milestone: wake → session → "what time is it" → answer → idle, with the latency line logged.
