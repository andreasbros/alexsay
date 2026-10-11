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
test: test-device test-js

test-device:
    cd device && cargo fmt --all --check
    cd device && cargo clippy --workspace --all-targets -- -D warnings
    cd device && cargo test --workspace

test-js: deps
    pnpm exec biome check .
    pnpm -r typecheck
    pnpm --filter app --filter website build
    pnpm --filter api --filter app --filter website test

# Release build of the speaker daemon for the Raspberry Pi 5 (aarch64), prints the binary path
build-device:
    cd device && cargo build --release --target aarch64-unknown-linux-gnu -p alexsay-daemon
    @readlink -f device/target/nix/aarch64-unknown-linux-gnu/release/alexsay

# Copy the daemon, unit and example config to the Pi and (re)start the service
deploy-device host="pi@alexsay.local": build-device
    #!/usr/bin/env bash
    set -euo pipefail
    scp device/target/nix/aarch64-unknown-linux-gnu/release/alexsay deploy/alexsay.service deploy/alexsay.toml {{host}}:/tmp/
    ssh {{host}} bash -s <<'REMOTE'
    set -euo pipefail
    sudo install -m 755 /tmp/alexsay /usr/local/bin/alexsay
    id alexsay >/dev/null 2>&1 || sudo useradd -r -s /usr/sbin/nologin -G audio alexsay
    sudo install -d -m 755 /etc/alexsay
    [ -f /etc/alexsay/alexsay.toml ] || sudo install -m 644 /tmp/alexsay.toml /etc/alexsay/alexsay.toml
    sudo install -m 644 /tmp/alexsay.service /etc/systemd/system/alexsay.service
    sudo systemctl daemon-reload
    sudo systemctl enable --now alexsay
    sudo systemctl restart alexsay
    sudo -u alexsay alexsay id
    REMOTE

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
      "INSERT INTO users (username, password_hash, role, created_at) VALUES ('{{username}}', '$hash', '{{role}}', unixepoch() * 1000) ON CONFLICT (username) DO UPDATE SET password_hash = excluded.password_hash, role = excluded.role"

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

# Wait until app.alexsay.com serves the build just uploaded; the first requests after a deploy can still hit the old assets
wait-live:
    #!/usr/bin/env bash
    set -euo pipefail
    want=$(jq -r .build app/public/version.json)
    for _ in $(seq 1 30); do
      got=$(curl -fsS "${E2E_APP_URL:-https://app.alexsay.com}/version.json" | jq -r .build || true)
      [ "$got" = "$want" ] && { echo "live: $want"; exit 0; }
      sleep 2
    done
    echo "still serving $got, wanted $want"; exit 1

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
