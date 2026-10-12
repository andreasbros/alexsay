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
      "INSERT INTO users (username, password_hash, role, created_at) VALUES ('{{username}}', '$hash', '{{role}}', unixepoch() * 1000) ON CONFLICT (username) DO UPDATE SET password_hash = excluded.password_hash, role = excluded.role; DELETE FROM sessions WHERE username = '{{username}}'"

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
