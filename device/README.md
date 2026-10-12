# device

The speaker, a Rust workspace. `core` holds everything deterministic and host-tested; `daemon` is the `alexsay` binary.

| Crate | What |
|---|---|
| `core` (`alexsay-core`) | Config and paths, identity, heartbeat and GPT-Live event types, session rules (idle, after-reply, farewell, hard cap), earcons, PCM helpers, the rustpotter wake-word engine and training, signed release verification, persisted state |
| `daemon` (`alexsay`) | cpal audio in and out (any rate and channel count, resampled to 16 kHz mono), the GPT-Live WebSocket, the server's tools and conversation record, speech announcements, self-update, service install, the CLI |

## Commands

`run`, `setup`, `id`, `status`, `devices`, `smoke [--voice] [--json] [--no-audio]`, `config {show|init|path|set}`, `update [--check]`, `service {install|uninstall|status}`, `reset --yes`, `clean`, `logs [-f]`, `wake {record|train|test}`. `--home` or `ALEXSAY_HOME` moves the data root (default `~/.local/alexsay`).

## Build

Inside `nix develop` from the repo root:

```sh
cd device && cargo test --workspace            # host
cargo build -p alexsay-daemon                  # debug binary for this machine (target/nix/debug/alexsay)
just build-speaker x86_64-linux                # static musl release, ALSA compiled in
just build-speaker aarch64-linux               # Raspberry Pi 5 build with the `flex` feature (ReSpeaker Flex: ASR beam channel)
```

macOS and Windows builds run on their own runners in `.github/workflows/release.yml` with plain cargo.

The `flex` feature prefers a ReSpeaker Flex device and its ASR beam (channel 1); without it any USB microphone is used and the channels are averaged.

## Wake word

`models/alexsay.rpw` ships inside the binary: a rustpotter model trained from synthetic takes (`scripts` in the release notes). `alexsay wake record` and `alexsay wake train` make a model from your own voice into `data/models/alexsay.rpw`; point `[wake] model` at it. A missing `models/alexsay.rpw` still builds (empty model, wake word off).

## Releases

`just release patch` bumps the version, tags and creates the release; the workflow builds every target, writes `SHA256SUMS`, signs it with the Ed25519 release key (`ALEXSAY_RELEASE_KEY` secret; public key in `core/src/update.rs`) and attaches everything. The binary checks GitHub every `update.check_hours`, verifies the asset against the signed list, swaps itself and restarts.
