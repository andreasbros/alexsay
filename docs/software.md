# Software

Design only; no code yet. Everything in the conversation path is one Rust daemon, `alexsay`. Home Assistant runs beside it in Docker.

## Repository layout (planned)

Same conventions as LetterBox: Nix flake, `just` recipes, host-tested logic separated from I/O.

| Path | What |
|---|---|
| `core/` | No I/O, host-tested: session state machine, realtime event types (serde), playback EQ (biquads), resampler wrapper, ring buffer, tool schemas and argument validation |
| `daemon/` | The `alexsay` binary: ALSA capture/playback (`alsa`), WebSocket client (`tokio-tungstenite`), Home Assistant client (`reqwest`), wake word (`ort`, ONNX Runtime), systemd notify |
| `deploy/` | `alexsay.service`, Home Assistant `compose.yaml`, udev rule for the Flex (vendor `2886`) |
| `scripts/` | Wake-word recording and dataset tools |
| `flake.nix`, `justfile` | Toolchain incl. `aarch64-unknown-linux-gnu` cross target; `just test`, `just build-device`, `just deploy-device`, `just logs` |

## State machine

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Connecting: wake word
    Idle --> Muted: mute
    Muted --> Idle: unmute
    Connecting --> Listening: session ready (buffered audio flushed)
    Connecting --> Error: connect failed
    Listening --> Responding: first output audio
    Responding --> Listening: response done
    Responding --> Listening: barge-in (speech_started), playback flushed, item truncated
    Listening --> Closing: idle timeout / end_conversation / cap
    Responding --> Closing: end_conversation after this response
    Closing --> Idle
    Error --> Idle: error earcon, backoff
```

- Wake-word detection runs only in `Idle`. In a session "Alex" is an ordinary word.
- Mic audio streams to the backend for the whole session; the server decides turns (semantic VAD).
- `Connecting` never drops audio: capture keeps filling the ring buffer and the whole backlog is sent once the socket is ready.

## Audio

| Path | Format | Notes |
|---|---|---|
| Capture (Flex, 6 ch image) | 16 kHz, 32-bit, 6 ch | use ch1 (ASR beam); ch2 to ch5 only for recording datasets |
| Capture (Flex, 48 kHz image) | 48 kHz, 2 ch | ch1 ASR beam |
| Realtime API in/out | PCM16 mono 24 kHz, base64 in JSON events | |
| Playback (Flex) | 16 kHz or 48 kHz to match the image | exact channel count/format from `aplay --dump-hw-params` on the bench |

- Open ALSA devices **by card name** from config, never by index (indices move with USB order).
- 10 ms periods, 4-period buffer. Audio threads run `SCHED_FIFO`.
- Resampling with `rubato` (fixed ratios 2:3 and 1:2).
- Playback chain: 24 kHz deltas → resample → EQ (high-pass ~150 Hz, peaking cut at the box's fc, see [device-design.md](device-design.md#acoustics)) → limiter at −3 dBFS → ALSA. All of it before the XVF3800, so its AEC reference matches what the speaker plays.
- Playback position = frames written minus `snd_pcm_delay`; it feeds `conversation.item.truncate` on barge-in.
- Ring buffer: 2 s of ASR-beam audio, always running, so "Alex, turn the lights off" spoken in one breath arrives whole.

## Voice backend

```rust
trait VoiceBackend {
    async fn connect(&self, config: &SessionConfig) -> Result<Box<dyn VoiceSession>, BackendError>;
}

trait VoiceSession {
    async fn send_audio(&mut self, pcm16_24k: &[i16]) -> Result<(), BackendError>;
    async fn next_event(&mut self) -> Result<SessionEvent, BackendError>;
    async fn send_tool_result(&mut self, call_id: &str, output: serde_json::Value) -> Result<(), BackendError>;
    async fn interrupt(&mut self, item_id: &str, played_ms: u32) -> Result<(), BackendError>;
    async fn close(self: Box<Self>) -> Result<(), BackendError>;
}
```

| Backend | Endpoint | Model | Status |
|---|---|---|---|
| `Realtime` | `wss://api.openai.com/v1/realtime?model=gpt-realtime` | `gpt-realtime` (GA) | Build first |
| `Live` | `wss://api.openai.com/v1/live/sessions` | `gpt-live-1-diamond-alpha` | Waitlist alpha; fill in when access arrives |

Realtime events the daemon uses (GA names; confirm against the API reference when writing the client):

| Direction | Event | Use |
|---|---|---|
| out | `session.update` | instructions, voice, PCM 24 kHz in/out, `semantic_vad`, tools |
| out | `input_audio_buffer.append` | mic audio |
| out | `conversation.item.create` (`function_call_output`) + `response.create` | tool results |
| out | `response.cancel`, `conversation.item.truncate` | barge-in |
| in | `input_audio_buffer.speech_started` | barge-in trigger while `Responding` |
| in | `response.output_audio.delta` / `.done` | playback |
| in | `response.function_call_arguments.done` | run a tool |
| in | `response.done` | usage (tokens) for the cost log |
| in | `error` | log, earcon, close |

Session rules:
- Close after 10 s with no user speech following the last response, on `end_conversation`, or at a 10 min hard cap.
- A short wake earcon (< 150 ms) plays through the Flex, so the AEC removes it from the mic stream.
- Daily budget of session minutes in config; log token usage per session.

## Wake word: "Alex"

- **openWakeWord** pipeline in-process: 16 kHz, 80 ms frames → melspectrogram model → embedding model → custom "alex" classifier, all ONNX through `ort`.
- Fires on score ≥ threshold for 2 consecutive frames; 2 s refractory period.
- **Training:**
  - Positives: openWakeWord's synthetic set (Piper TTS voices) plus ~200 real takes from this device (ASR beam and raw channels, 6 ch image), several speakers and distances.
  - Negatives: "Alexa", "Alexander", "Alexis", "a lexicon", "Alex's" in TV and podcast audio, and 24 h of household audio from the device.
- Targets: < 1 false accept per 24 h of household audio, > 90 % detection at 3 m (see [measurements.md](measurements.md)).
- Phase 1 shortcut if the ONNX port takes time: the `wyoming-openwakeword` container plus a Wyoming client in the daemon.
- Alternative: microWakeWord (TFLite, smaller), if openWakeWord's false-accept rate on "Alexa" can't be trained down.

## Tools (function calling)

| Tool | Arguments | Calls | Guard |
|---|---|---|---|
| `ha_list_entities` | `area?` | `GET /api/states`, filtered | only entities in the exposed list in config |
| `ha_get_state` | `entity_id` | `GET /api/states/{entity_id}` | exposed list |
| `ha_call_service` | `domain`, `service`, `entity_id`, `data?` | `POST /api/services/{domain}/{service}` | allow-listed domains (`light`, `switch`, `climate`, `cover`, `media_player`, `scene`, `script`); `lock` and `alarm_control_panel` need a spoken confirmation turn |
| `get_time` | none | local clock, Europe/London | |
| `end_conversation` | none | closes after the current response | |

- Home Assistant at `http://127.0.0.1:8123` with a long-lived access token.
- Tool arguments are validated in `core` before any HTTP call; the model never gets raw HA errors with tokens or URLs in them.

## Configuration

`/etc/alexsay/config.toml` (no secrets):

```toml
[audio]
card = "<Flex card name from arecord -l>"
firmware = "io16-6ch"          # or "io48"
asr_channel = 1
eq = { highpass_hz = 150, peak_hz = 240, peak_gain_db = -6.0, peak_q = 2.0 }

[wake]
model = "/var/lib/alexsay/alex.onnx"
threshold = 0.5

[session]
backend = "realtime"           # or "live"
voice = "<voice>"
idle_close_s = 10
max_minutes = 10
daily_minutes = 60

[home_assistant]
url = "http://127.0.0.1:8123"
exposed = ["light.kitchen", "light.hallway"]
```

`/etc/alexsay/env` (0600): `OPENAI_API_KEY`, `HA_TOKEN`.

## Deployment

- **OS:** Raspberry Pi OS Lite 64-bit, headless, SSH key only.
- **`alexsay.service`:** `CPUAffinity=2 3`, `LimitRTPRIO=50`, `SupplementaryGroups=audio`, `EnvironmentFile=/etc/alexsay/env`, `StateDirectory=alexsay`, `Restart=always`, `Type=notify`.
- **Home Assistant:** Docker Compose, `network_mode: host`, `cpuset: "0,1"`, `restart: unless-stopped`, config in `/srv/homeassistant`. Not HA OS: the Pi runs our daemon too, and HA Supervised/Core installs are deprecated.
- **Build:** cross-compile to `aarch64-unknown-linux-gnu` in the flake, `just deploy-device` copies the binary and restarts the unit.

## Latency budget

| Step | Target |
|---|---|
| End of "Alex" → detection | ≤ 200 ms |
| WebSocket connect + `session.update` | 300 to 600 ms, overlapped with the user still talking |
| End of user speech → server end-of-turn | 200 to 500 ms (semantic VAD) |
| End-of-turn → first output audio | 300 to 700 ms |
| First delta → sound | ≤ 60 ms |
| **End of user speech → first sound** | **≤ 1.2 s** |

## Testing

- `core`: state-machine transitions (barge-in, network drop mid-response, tool call during barge-in), event parsing against recorded JSON fixtures, EQ coefficients against reference values, resampler latency and level.
- `daemon`: integration test against a fake realtime server (`tokio-tungstenite`) with WAV files standing in for ALSA.
- Bench: the measurement plan in [measurements.md](measurements.md).
