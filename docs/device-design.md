# Device design: rev A

Concept dated 10 Oct 2026. Nothing here is measured yet; every "estimate" becomes a row in [measurements.md](measurements.md).

## Form factor

Free-standing cylinder, mics on top, 360° pickup and 360° sound.

| | alexsay rev A | Echo Dot 3 (reference) | HomePod mini (reference) |
|---|---|---|---|
| Outer size | ≈ 150 mm Ø × 210 mm (set by the driver frame, see below) | 99 Ø × 43 mm | 98 Ø × 84 mm |
| Driver | Visaton R 10 S, 4", down-firing | 1.6" | ~3" full-range, down-firing |
| Mics | 4, circular, top | 4 | 4 |
| Echo cancellation | XMOS XVF3800 (hardware) | yes | yes |

**The driver frame sets the diameter.** The R 10 S has a 102 × 102 mm square frame, so its diagonal is up to ~144 mm, less if the corners are rounded. Either the inner diameter clears the diagonal (≈ 150 mm outer), or the frame is front-mounted under the bottom baffle so the corners sit in the base gap. **Measure the frame when it arrives (13 Oct) before starting CAD.**

Stack, top to bottom:

| Zone | Height | Contents |
|---|---|---|
| Top cap | ~15 mm | Circular mic board (73 mm Ø, 3 × M3) on standoffs, **ports facing up** against four ~1.5 mm holes, each sealed with a foam gasket; grille cloth over the cap |
| Electronics bay | ~60 mm | Pi 5 + Active Cooler (+ M.2 HAT+ in Phase 2), Flex core board (4 × M3), 15 cm USB-A to USB-C cable, 20 cm FPC up to the mic board. Vents at the rear only |
| Divider | ~5 mm | Solid plate on a foam gasket: blocks air and vibration between the bay and the speaker chamber |
| Speaker chamber | ~110 mm | Sealed, ~1.5 L net at 140 mm inner diameter, loosely filled with polyester wadding |
| Bottom baffle + base gap | ~20 mm | R 10 S firing down onto a low reflector cone, 15 to 20 mm gap, feet. Spreads sound 360° and puts the full chamber height between driver and mics |

Rear panel: one USB-C power inlet (panel-mount extension to the Pi), optional Ethernet.

## Bill of materials

| Ref | Part | Role | Key figure | Status |
|---|---|---|---|---|
| U1 | Raspberry Pi 5 8GB | Daemon, Home Assistant | 4 × A76 2.4 GHz, 1.6 A USB budget on 27 W PSU | Ordered |
| U2 | Seeed reSpeaker Flex XVF3800 circular, with XIAO ESP32-S3 | Mics, AEC, DAC, amp | 4 PDM mics 44 mm spacing; amp rated 10 W at 4 Ω on 12 V | Ordered |
| HS1 | Raspberry Pi Active Cooler | Pi cooling | software fan curve | Ordered |
| LS1 | Visaton R 10 S 4 Ω | Speaker | 92.6 dB/1 W, 100 Hz to 13 kHz, fs 160 Hz, Qts 1.45, Vas 1.9 L, Xmax ±0.5 mm, 93 mm cut-out | Ordered (RS, 13 Oct) |
| PS1 | Raspberry Pi 27 W USB-C PSU | All power | 5 V 5 A | Ordered |
| M1 | SanDisk High Endurance microSD 256 GB | Boot + data (Phase 1) | endurance-rated | Ordered (verify with `f3`) |
| M2 | Raspberry Pi M.2 HAT+ + Raspberry Pi SSD 256 GB | Boot + data (Phase 2) | | HAT in stock; SSD sold out in the UK |
| W1 | USB-A to USB-C 15 cm | Pi ↔ Flex XMOS port | | Ordered |
| W2 | Speaker lead | Flex speaker pad → R 10 S tabs (+ 5.2 mm, − 2.8 mm) | twisted pair, soldered | JST PH cables ordered probably don't mate; solder to the pad |
| ENC | PETG cylinder, gaskets, wadding, grille cloth, inserts | Enclosure | | To design and buy |

Bench-only: micro-HDMI cable, Raspberry Pi USB 3 Hub (keyboard during setup), Anker USB-C card reader.

## Firmware choice

The Flex runs one of Seeed's geometry-specific USB images (`respeaker_flex_usb_<image>_v1.0.4.bin`; circular `c` only, never linear `l`; flashed by `just flex-flash`):

| Image | Rate | Channels in | Use |
|---|---|---|---|
| `c16k6ch` | 16 kHz | 6 (processed stereo, 4 raw) | **Bring-up**, wake-word data capture, AEC debugging |
| `c48k2ch` | 48 kHz | 2 (processed stereo) | **In use since 16 Oct 2026**: playback measured full-band to 17 kHz in the room, so music is possible; capture stays a 16 kHz pipeline inside the chip (upsampled with images), so the microphone side gains nothing |
| `c16k2ch` | 16 kHz | 2 | Fallback |

The XVF3800's echo canceller works at 16 kHz internally either way, so the 48 kHz image changes playback fidelity, not AEC. Tested 16 Oct 2026: 10, 14 and 17 kHz tones audible on `c48k2ch` (measurements.md). The card has two playback controls; the mono master `PCM,1` shipped at -20 dB.

## Acoustics

Mental model: **voice intelligibility lives at 300 Hz to 4 kHz, and the echo canceller only removes what is linear.** Clipping, rattles and cabinet buzz are non-linear, so they pass straight through the AEC and into the model.

Sealed-box alignment of the R 10 S (high Qts, built for open baffles):

| Net volume | Qtc | fc | Peak at fc |
|---|---|---|---|
| 1.0 L | 2.47 | 272 Hz | +8.0 dB |
| 1.5 L | 2.18 | 241 Hz | +7.0 dB |
| 2.0 L | 2.02 | 223 Hz | +6.4 dB |
| 3.0 L | 1.85 | 204 Hz | +5.7 dB |

No practical volume fixes it, so the fix is DSP in the daemon, applied **before** playback (the AEC then references what the speaker actually plays):
- 2nd-order high-pass at ~150 Hz: keeps the 0.5 mm Xmax safe and removes the boom.
- Peaking cut of about −6 dB, Q ≈ 2, at the measured fc (impedance peak, or a sweep with REW and a measurement mic).
- Wadding in the chamber lowers Q further and adds ~15 % effective volume.
- Digital headroom: keep peaks ~3 dB under the amp's clipping point at the chosen ALSA volume. A clipping amp is the most common reason "AEC doesn't work".

Mic side:
- One sealed path per mic: hole → gasket → port. A shared cavity under the cap smears the beamformer's timing.
- Mic board fixed to the top cap only; the top cap never touches the speaker chamber except through the shell.
- Keep the cap holes clear of paint and cloth tension; cloth over the whole cap is fine.

## Power budget

| Load | Estimate | Note |
|---|---|---|
| Pi 5, idle with HA + daemon | 3 to 4 W | measure with `vcgencmd pmic_read_adc` |
| Pi 5, busy (HA startup, wake word, resampling) | up to ~8 W | |
| XVF3800 core | unknown | measure at the USB port |
| XIAO ESP32-S3 (still powered, unknown firmware) | 0.1 to 0.5 W | flash a deep-sleep sketch if high |
| Amp + R 10 S at 5 V | < 0.5 W average speech, ~3 W peak | |

Total well under the 27 W supply. The constraint that matters is the Pi's **1.6 A USB budget**: Flex + amp peaks must stay under ~1 A (to verify), and `vcgencmd get_throttled` must stay `0x0` during loud playback.

## Thermal

- The Pi sits in a closed bay. Intake low at the rear, exhaust high at the rear, never toward the mic cap.
- The Active Cooler's blower is ~10 cm from the mics. The XVF3800's noise suppression handles steady fan noise, but it costs wake-word range. Raise the fan thresholds in `config.txt` (`dtparam=fan_temp0=…`) so it stays off at idle, and confirm the idle temperature with the fan held off.
- PETG, not PLA: PLA softens around 55 to 60 °C, which a Pi bay can reach.

## Edge cases

- **No hardware mute.** The Flex has no mute button. Mute is a daemon state (mic stream dropped, earcon, optional GPIO button later). Being honest about privacy: the mics stay powered.
- **No status light** beyond the power LED. Feedback is earcons: wake, end of session, error, muted.
- **Network down:** wake word still works; the daemon plays an error earcon instead of hanging. Home Assistant automations keep running locally.
- **Brown-out at full volume** would reset the XVF3800 mid-session: watch `get_throttled` and the USB current.
- **XIAO interference:** if its Wi-Fi is on, it shares 2.4 GHz with the Pi's Wi-Fi. Prefer Ethernet, or put the Pi on 5 GHz.
- **The speaker chamber must be airtight:** a leak whistles and changes the alignment. Gasket the driver and the divider, seal cable entries.
