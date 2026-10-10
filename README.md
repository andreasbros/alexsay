# alexsay

A self-built smart speaker that replaces an Amazon Echo Dot. Say **"Alexsay"** and it opens a full-duplex OpenAI voice conversation (GPT-Live, `gpt-live-1`), with Home Assistant on the same box for home control.

- **Hardware:** Raspberry Pi 5 8GB, Seeed reSpeaker Flex XVF3800 (circular 4-mic array, hardware echo cancellation, on-board amp), Visaton R 10 S 4" driver, one 3D-printed cylinder
- **Target:** voice quality at least an Echo Dot 3; barge-in (interrupt the assistant mid-sentence) works; wake word ignores "Alexa"
- **Status (10 Oct 2026):** parts ordered, nothing assembled. Phase 1 (bench bring-up) starts when the Pi Hut order lands

## Documentation

Everything lives in [`docs/`](docs/README.md):

| Doc | What it covers |
|---|---|
| [Architecture](docs/architecture.md) | End-to-end system: mic array → Pi → OpenAI GPT-Live, Home Assistant, session flow |
| [Device design](docs/device-design.md) | Hardware, BOM, enclosure, acoustics, power and thermal budget |
| [Software](docs/software.md) | The `alexsay` daemon: state machine, audio formats, GPT-Live protocol, wake word, tools |
| [Build manual](docs/build-manual.md) | Phase 1 bench bring-up, step by step |
| [Procurement](docs/procurement.md) | Everything ordered, everything still missing |
| [Measurements](docs/measurements.md) | Test plan and results (AEC, wake word, latency, thermals) |
| [Decisions](docs/decisions.md) | Decision log |
| [Prior art](docs/prior-art.md) | Echo Dot jailbreaks, HA Voice PE, other DIY speakers |

## Code

None yet. The planned layout (Rust workspace, Nix flake, `just` recipes, same conventions as the LetterBox repo) is in [docs/software.md](docs/software.md#repository-layout-planned).

## For Claude / new contributors

[`.claude/CLAUDE.md`](.claude/CLAUDE.md) holds the project context, key facts, gotchas and open tasks. [`.claude/handover.md`](.claude/handover.md) is the history of how we got here.
