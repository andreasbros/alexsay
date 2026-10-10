# Measurements

Nothing measured yet. Each row is an estimate or target from [device-design.md](device-design.md) or [software.md](software.md); fill in the result, date and firmware image.

## Power and USB

| Test | How | Target | Result | Date |
|---|---|---|---|---|
| Throttle flags, idle | `vcgencmd get_throttled` | `0x0` | | |
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
| AEC residual, far-end only | play speech, compare ch1 vs ch2 RMS | ≥ 30 dB attenuation | | |
| AEC double-talk | play speech and talk over it; listen to ch1 | user voice intact, echo inaudible | | |

## Wake word

| Test | How | Target | Result | Date |
|---|---|---|---|---|
| Detection at 1 m | 50 "Alex" utterances, two speakers | > 95 % | | |
| Detection at 3 m | same, TV off | > 90 % | | |
| Detection at 3 m, TV on | same, TV at normal level | > 80 % | | |
| Detection during playback | "Alex" spoken while the device talks (should not trigger; session already open) | n/a in session | | |
| False accepts, household audio | 24 h of normal household audio, wake events logged | < 1 per 24 h | | |
| False accepts on "Alexa" | 50 "Alexa" utterances and TV ads | 0 | | |

## Latency

| Test | How | Target | Result | Date |
|---|---|---|---|---|
| End of "Alex" → detection | daemon log timestamps vs ch1 recording | ≤ 200 ms | | |
| End of user speech → first sound | record room with a second mic, measure gap | ≤ 1.2 s | | |
| Barge-in → playback stops | same | ≤ 300 ms | | |

## Thermal

| Test | How | Target | Result | Date |
|---|---|---|---|---|
| Idle temperature, open bench, fan held off | `vcgencmd measure_temp` after 30 min | < 60 °C | | |
| Idle temperature in the cylinder | same | < 65 °C | | |
| Fan audible at the mics | ch2 noise floor fan on vs off | fan off at idle | | |
