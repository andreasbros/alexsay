set dotenv-load := true

default:
    @just --list

# Install JS dependencies (api, app, website, e2e)
deps:
    pnpm install --frozen-lockfile

# Format everything
fmt:
    cd device && cargo fmt --all
    pnpm exec biome check --write .

# Check the setup: Nix shell, toolchain, env vars, Cloudflare token
check:
    scripts/check-setup.sh

# Every code gate: format, lint, typecheck, tests (device, api, app, website)
test: test-device test-server test-js

test-device:
    cd device && cargo fmt --all --check
    cd device && cargo clippy --workspace --all-targets -- -D warnings
    cd device && cargo test --workspace

test-server:
    cd server && cargo fmt --check
    cd server && cargo clippy --all-targets -- -D warnings
    cd server && cargo test

test-js: deps
    # Local secrets for workerd (the example holds a dummy key); the generated Worker types include them
    [ -f api/.dev.vars ] || cp api/.dev.vars.example api/.dev.vars
    pnpm exec biome check .
    # The app build writes src/build.ts, which the typecheck needs on a fresh checkout
    pnpm --filter app --filter website build
    pnpm -r typecheck
    pnpm --filter api --filter app --filter website test

# Static release build of the speaker: x86_64-linux (any distro) or aarch64-linux (Raspberry Pi 5 with the Flex)
build-speaker target="x86_64-linux":
    nix build .#alexsay-{{target}} --print-build-logs --out-link result-{{target}}
    @ls -l result-{{target}}/bin/alexsay

# Debug build of the speaker for this machine, installed as ~/.local/bin/alexsay
install-speaker:
    cd device && cargo build -p alexsay-daemon
    install -m 755 device/target/nix/debug/alexsay ~/.local/bin/alexsay
    @echo "installed ~/.local/bin/alexsay ($(~/.local/bin/alexsay --version))"

# The speaker binary against the deployed server with the e2e account; audio checks included (ALEXSAY_E2E_AUDIO=0 to skip)
e2e-device:
    cd device && ALEXSAY_E2E=1 ALEXSAY_E2E_AUDIO="${ALEXSAY_E2E_AUDIO:-1}" ALEXSAY_E2E_CONFIG="${ALEXSAY_E2E_CONFIG:-}" cargo test -p alexsay-daemon --test e2e -- --nocapture

# Copy the Pi build to a Raspberry Pi and start it as a service
deploy-device host="pi@alexsay.local": (build-speaker "aarch64-linux")
    scp result-aarch64-linux/bin/alexsay {{host}}:/tmp/alexsay
    ssh {{host}} 'mkdir -p ~/.local/bin && install -m 755 /tmp/alexsay ~/.local/bin/alexsay && ~/.local/bin/alexsay setup && ~/.local/bin/alexsay service install'

# What alexsay-server embeds (workerd, the Worker, the app) for a target: x86_64-linux, aarch64-linux, x86_64-macos, aarch64-macos, x86_64-windows
server-bundle target="": deps
    scripts/server-bundle.sh {{target}}

# The self-hosted server for this machine: static musl on Linux, in server/target/nix/<triple>/release
build-server: server-bundle
    #!/usr/bin/env bash
    set -euo pipefail
    cd server
    case "$(uname -s)-$(uname -m)" in
      Linux-x86_64) cargo build --release --target x86_64-unknown-linux-musl ;;
      Linux-aarch64) cargo build --release --target aarch64-unknown-linux-musl ;;
      *) cargo build --release ;;
    esac
    ls -l target/nix/*/release/alexsay-server target/nix/release/alexsay-server 2>/dev/null || true

# Run the self-hosted server from source on this machine (data in ~/.local/alexsay-server)
server *args: build-server
    server/target/nix/$(uname -m)-unknown-linux-musl/release/alexsay-server {{args}}

# Compatibility gate: the built server must pass the Playwright suite and the speaker e2e, like app.alexsay.com
e2e-server: build-server
    scripts/e2e-server.sh server/target/nix/$(uname -m)-unknown-linux-musl/release/alexsay-server

# The README's hero image: the live website's landscape hero in the day and night themes (docs/media)
readme-screenshot site="https://www.alexsay.com": deps
    node scripts/readme-screenshot.mjs {{site}}

# Cut a release: bumps the version, tags, pushes and creates the GitHub release (CI builds and attaches the binaries)
release bump="patch":
    scripts/release-tag.sh {{bump}}

# Render brand/logo.svg into every icon size the app and website use
icons:
    scripts/icons.sh

# Local API (wrangler, :8787, serves the built app) and the app dev server (vite, :5173, proxies /api)
dev: deps
    [ -f api/.dev.vars ] || cp api/.dev.vars.example api/.dev.vars
    pnpm --filter app build
    pnpm --filter api exec wrangler d1 migrations apply alexsay --local
    (pnpm --filter api dev & pnpm --filter app dev & wait)

# Website dev server (vite, :5174)
dev-website: deps
    pnpm --filter website dev

# Create or update a user with a role (prompts for the password; stored as salted PBKDF2)
add-user username role="user" where="--remote":
    #!/usr/bin/env bash
    set -euo pipefail
    [[ "{{role}}" =~ ^(admin|user)$ ]] || { echo "role must be admin or user"; exit 1; }
    [[ "{{username}}" =~ ^[a-z0-9_.-]{2,32}$ ]] || { echo "username: 2-32 of a-z 0-9 _ . -"; exit 1; }
    if [[ -n "${ALEXSAY_PASSWORD:-}" ]]; then password="$ALEXSAY_PASSWORD"; else
      read -rsp "Password: " password; echo
    fi
    [[ ${#password} -ge 8 ]] || { echo "password: at least 8 characters"; exit 1; }
    hash=$(node scripts/hash-password.mjs "$password")
    unset password
    pnpm --filter api exec wrangler d1 execute alexsay {{where}} --command \
      "INSERT INTO users (username, password_hash, role, created_at) VALUES ('{{username}}', '$hash', '{{role}}', unixepoch() * 1000) ON CONFLICT (username) DO UPDATE SET password_hash = excluded.password_hash, role = excluded.role; INSERT OR IGNORE INTO homes (id, created_at) VALUES ('{{username}}', unixepoch() * 1000); DELETE FROM sessions WHERE username = '{{username}}'"

# Create the two e2e accounts on the deployed site from the passwords in .env
e2e-users:
    ALEXSAY_PASSWORD="$E2E_ADMIN_PASSWORD" just add-user "$E2E_ADMIN_USERNAME" admin
    ALEXSAY_PASSWORD="$E2E_USER_PASSWORD" just add-user "$E2E_USER_USERNAME" user

# Generate SECRETS_KEY (32 random bytes) into .env and the Worker secret
secrets-key:
    #!/usr/bin/env bash
    set -euo pipefail
    if grep -q '^SECRETS_KEY=.\+' .env 2>/dev/null; then
      echo ".env already has SECRETS_KEY; remove that line first to rotate (stored keys become unreadable)"; exit 1
    fi
    key="$(openssl rand -hex 32)"
    if grep -q '^SECRETS_KEY=' .env 2>/dev/null; then sed -i "s/^SECRETS_KEY=.*/SECRETS_KEY=$key/" .env; else printf 'SECRETS_KEY=%s\n' "$key" >> .env; fi
    printf '%s' "$key" | pnpm --filter api exec wrangler secret put SECRETS_KEY
    echo "SECRETS_KEY stored in .env and on the Worker"

# Create the D1 database once and print its id for api/wrangler.jsonc
create-db:
    pnpm --filter api exec wrangler d1 create alexsay

# Build the app, apply D1 migrations, deploy the app Worker (app.alexsay.com), then run the e2e suite
deploy: test-js
    pnpm --filter api exec wrangler d1 migrations apply alexsay --remote
    pnpm --filter api exec wrangler deploy
    just wait-live
    just e2e

# Wait until app.alexsay.com serves the build just uploaded, with its scripts and styles, five times in a row:
# right after a deploy some requests still reach the old build, and a page whose assets 404 never starts
wait-live:
    #!/usr/bin/env bash
    set -euo pipefail
    base="${E2E_APP_URL:-https://app.alexsay.com}"
    want=$(jq -r .build app/public/version.json)
    streak=0
    for _ in $(seq 1 60); do
      got=$(curl -fsS "$base/version.json" | jq -r .build || true)
      assets_ok=1
      for asset in $(curl -fsS "$base/" | grep -oE '/assets/[^"]+\.(js|css)' | sort -u); do
        curl -fsS -o /dev/null "$base$asset" || { assets_ok=0; break; }
      done
      if [ "$got" = "$want" ] && [ "$assets_ok" = 1 ]; then
        streak=$((streak + 1))
        [ "$streak" -ge 5 ] && { echo "live: $want"; exit 0; }
      else
        streak=0
      fi
      sleep 1
    done
    echo "not settled: serving $got, wanted $want"; exit 1

# Wake word training for the LiveKit engine: the toolkit, Piper's voice and the data (about 18 GB in
# ~/.cache/alexsay/wake); `just wake-setup small` skips the 16 GB of speech features for a quick run
wake-setup size="":
    scripts/wake-train.sh setup {{size}}

# Train a LiveKit classifier from device/wake/<model>.yaml and install it as device/models/<model>.onnx:
# alexsay (the wake word, default), stop and snooze (the alarm commands); `just wake-train small` checks the
# pipeline end to end in minutes, with a model not worth shipping
wake-train model="alexsay":
    scripts/wake-train.sh train {{model}}

# Copy the takes recorded on a speaker (`alexsay wake record`, as `[alexsay]` or `[none]`) into the training
# takes, device/wake/takes: `just wake-takes-pull user@host`
wake-takes-pull host:
    mkdir -p device/wake/takes
    scp '{{host}}:.local/alexsay/data/recordings/*.wav' device/wake/takes/
    @ls device/wake/takes | sed 's/-[0-9]*\.wav$//' | sort | uniq -c

# Both wake word engines over the owner's takes: caught, false fires, CPU
wake-eval:
    cd device && cargo run --quiet --release -p alexsay-daemon -- wake eval --dir testdata/takes

# Flash the reSpeaker Flex with Seeed's circular USB firmware (pinned release and SHA-256), here or on
# an ssh host the Flex is plugged into: `just flex-flash`, `just flex-flash c16k6ch user@host`
flex-flash image="c16k6ch" host="":
    scripts/flex-flash.sh {{image}} {{host}}

# Build and deploy the website Worker (www.alexsay.com)
deploy-website: test-js
    pnpm --filter website exec wrangler deploy

# End-to-end tests against the deployed site (Playwright, test accounts from .env)
e2e *args: deps
    pnpm --filter e2e test {{args}}

# Open the last e2e report
e2e-report:
    pnpm --filter e2e exec playwright show-report report

# Stream production Worker logs
logs worker="alexsay-app":
    pnpm --filter api exec wrangler tail {{worker}}
