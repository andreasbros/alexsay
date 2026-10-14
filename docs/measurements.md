# Measurements

Each row is an estimate or target from [device-design.md](device-design.md) or [software.md](software.md); fill in the result, date and firmware image. Flex firmware for every result so far: `c16k6ch` v1.0.4 (16 kHz, ch1 to 2 processed, ch3 to 6 raw mics).

## Bench bring-up (13 to 14 Oct 2026)

| Check | How | Result |
|---|---|---|
| SD card genuine | `f3probe --destructive --time-ops` | real: 238.42 GB usable = announced; 81 MB/s sequential write, 0.3 MB/s random write |
| Pi 5 first boot | Raspberry Pi OS Lite 64-bit (Trixie, 6 Oct 2026), cloud-init over Wi-Fi | up headless in ~3 min; bootloader updated 11 May to 25 Sep 2026 |
| Idle temperature | `vcgencmd measure_temp` | 42.8 °C without the cooler, 36.7 °C with it |
| Flex reflash | `just flex-flash c16k6ch <host>` | Safe Mode `2886:801c`, runs as `2886:001e` card `C16K6Ch` |
| Capture, room | 5 s, all 6 channels | all live; raw mics agree within 0.5 dB, ~0.006 % RMS in a quiet room |
| Capture, voice at ~1 m | 12 s | ch1 1.7 to 5 % RMS (peak 37 %, no clipping) over a 0.04 % room: 35 to 40 dB; raw mics peak 0.1 % (about -58 dBFS; no gain on them) |
| Speaker linearity | 440 Hz tone at -40, -30, -20 dB, Visaton unboxed | raw mics rise 10 dB per 10 dB step on all four, no distortion; ch1 stays at the floor |
| Volume | ALSA `PCM` 0 to 60 (default 40 = -20 dB) | set to 60 (0 dB) and stored with `alsactl store`; speech loud enough at the bench |
| First conversation | `alexsay run`, wake word, GPT-Live | fired at 0.79 (threshold 0.60), session open 2.1 s later, transcripts correct, no self-hearing |

## Power and USB

| Test | How | Target | Result | Date |
|---|---|---|---|---|
| Throttle flags, idle | `vcgencmd get_throttled` | `0x0` | `0x0` (also through the tone, echo test and a conversation at 0 dB) | 2026-10-13 |
| Throttle flags, loudest playback for 10 min | same, during `speaker-test` at max chosen volume | `0x0` | | |
| Pi 5 power, idle with HA + daemon | `vcgencmd pmic_read_adc` (sum of rails) | 3 to 4 W | | |
| Flex current, idle | USB inline meter on the 15 cm cable, or PPK2 in ammeter mode | < 300 mA | | |
| Flex current, loud speech | same | < 1 A (Pi USB budget 1.6 A) | | |
| XIAO ESP32-S3 draw | PPK2 on the Flex supply, XIAO firmware as shipped vs deep sleep | < 50 mA after fix | | |

## Audio path

| Test | How | Target | Result | Date |
|---|---|---|---|---|
| Playback bandwidth, io16-6ch | 10 kHz tone, by ear and ch2 spectrum | silent (8 kHz limit) | | |
| Playback bandwidth, io48 | same | audible | | |
| Max clean level at 1 m | raise ALSA volume until the sweep on ch2 shows clipping, back off 3 dB | ≥ 80 dB SPL speech at 1 m | | |
| Box fc (bench box, then cylinder) | impedance peak, or sweep on ch2 / measurement mic in REW | ~240 Hz at 1.5 L | | |
| Rattles and buzzes | slow sine sweep 100 Hz to 2 kHz at max chosen level | none | | |
| AEC residual, far-end only | play speech, compare ch1 vs the raw mics (ch3 to 6) | ≥ 30 dB attenuation | speech reaches the raw mics at -55 to -60 dBFS; ch1 stays at its floor (-65 dBFS) for 14 s; ch1 runs ~30 dB above raw, so ~45 dB removed | 2026-10-14 |
| AEC double-talk | play speech and talk over it; listen to ch1 | user voice intact, echo inaudible | speaker ~25 dB louder than the voice at the raw mics, yet ch1 carries the voice at -22 to -34 dBFS, the same as talking alone (-30 to -32); no ducking | 2026-10-14 |

## Wake word

| Test | How | Target | Result | Date |
|---|---|---|---|---|
| Detection at 1 m | 50 "Alexsay" utterances, two speakers | > 95 % | | |
| Detection at 3 m | same, TV off | > 90 % | | |
| Detection at 3 m, TV on | same, TV at normal level | > 80 % | | |
| Detection during playback | "Alexsay" spoken while the device talks (should not trigger; session already open) | n/a in session | | |
| False accepts, household audio | 24 h of normal household audio, wake events logged | < 1 per 24 h | | |
| False accepts on "Alexa" | 50 "Alexa" utterances and TV ads | 0 | | |
| False accepts on "Alexa, say..." | 50 utterances, two speakers | 0 | | |

## Alarm command words (14 Oct 2026)

- Models: `stop.onnx`, `snooze.onnx`, 3,000 synthetic clips a class, 30,000 steps (stop 87 min, snooze 115 min on the laptop CPU), 156 KB each.
- LiveKit's eval (1,200 positives, 18 h of validation audio, threshold 0.5): stop 56% recall, snooze 28%, 0 false fires an hour.
- Through the speaker's own streaming detector (`alexsay wake test --file`, heard as live), held-out clips:

| Model | Sensitivity | Caught | Fired on near-misses | Fired on the other command |
|---|---|---|---|---|
| stop | 0.5 | 56/60 | 19/78 | 0/60 |
| stop | 1.0 | 59/60 | 29/78 | |
| snooze | 0.5 | 47/60 | 34/78 | 0/60 |
| snooze | 1.0 | 58/60 | 50/78 | |

- Shipped at 0.5. The models listen only in the 3 s after "Alexsay" while something rings, so a near-miss costs a wrong snooze at worst; a miss rings again.

## Latency

| Test | How | Target | Result | Date |
|---|---|---|---|---|
| End of "Alexsay" → detection | daemon log timestamps vs ch1 recording | ≤ 200 ms | | |
| End of user speech → first sound | record room with a second mic, measure gap | ≤ 1.2 s | | |
| Barge-in → playback stops | same | ≤ 300 ms | | |

## Thermal

| Test | How | Target | Result | Date |
|---|---|---|---|---|
| Idle temperature, open bench, fan held off | `vcgencmd measure_temp` after 30 min | < 60 °C | | |
| Idle temperature in the cylinder | same | < 65 °C | | |
| Fan audible at the mics | ch2 noise floor fan on vs off | fan off at idle | | |
