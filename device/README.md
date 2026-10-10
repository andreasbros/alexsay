# device

The Raspberry Pi side of alexsay, a Rust workspace.

| Crate | What |
|---|---|
| `core` (`alexsay-core`) | No I/O, host-tested: device identity, config, heartbeat contract, GPT-Live event types, session state machine |
| `daemon` (`alexsay`) | The binary: `alexsay id` prints the speaker's UUID, `alexsay run` calls home and keeps the owner's assistant settings |

Audio (ALSA capture and playback, wake word, the GPT-Live socket) lands once the hardware is on the bench; see `docs/software.md`.

## Build and test

Inside `nix develop` from the repo root:

```sh
cd device && cargo test --workspace                                   # host
cd device && cargo build --release --target aarch64-unknown-linux-gnu -p alexsay-daemon
```

The Pi binary is `target/nix/aarch64-unknown-linux-gnu/release/alexsay`.

## Install on the Pi

```sh
scp target/nix/aarch64-unknown-linux-gnu/release/alexsay pi@alexsay.local:/tmp/alexsay
ssh pi@alexsay.local 'sudo install -m 755 /tmp/alexsay /usr/local/bin/alexsay && sudo useradd -r -s /usr/sbin/nologin alexsay 2>/dev/null; sudo install -d -m 755 /etc/alexsay'
scp deploy/alexsay.toml pi@alexsay.local:/tmp/alexsay.toml && ssh pi@alexsay.local 'sudo install -m 644 /tmp/alexsay.toml /etc/alexsay/alexsay.toml'
scp deploy/alexsay.service pi@alexsay.local:/tmp/alexsay.service && ssh pi@alexsay.local 'sudo install -m 644 /tmp/alexsay.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now alexsay'
ssh pi@alexsay.local 'sudo -u alexsay alexsay id'                    # the UUID to add in the app
```

## Config (`/etc/alexsay/alexsay.toml`)

| Key | Default | Meaning |
|---|---|---|
| `api_url` | `https://app.alexsay.com` | The server |
| `state_dir` | `/var/lib/alexsay` | Holds `device-id` (0600, created on first run) |
| `poll_s` | `30` | Heartbeat interval until the server sends its own |

Secrets never live in the config: the server hands the owner's assistant credentials to a claimed speaker in the heartbeat reply, over TLS, and the daemon keeps them in memory only.
