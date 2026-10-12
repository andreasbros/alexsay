#!/usr/bin/env bash
# Compatibility gate for alexsay-server: start the built binary on a fresh home, create the e2e
# accounts, then run the same Playwright suite and speaker e2e that run against app.alexsay.com.
# Usage: scripts/e2e-server.sh [path/to/alexsay-server] [playwright args...]
set -euo pipefail
cd "$(dirname "$0")/.."

BIN="${1:-server/${CARGO_TARGET_DIR:-target}/release/alexsay-server}"
shift || true
[ -x "$BIN" ] || { echo "no server binary at $BIN (just build-server)" >&2; exit 1; }
BIN="$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")"

HOME_DIR="$(mktemp -d)"
PORT="${E2E_SERVER_PORT:-18877}"
LOG="$HOME_DIR/server.log"
stop() {
  [ -n "${PID:-}" ] && kill -INT "$PID" 2>/dev/null && wait "$PID" 2>/dev/null || true
  [ "${KEEP:-0}" = 1 ] && echo "kept $HOME_DIR" || rm -rf "$HOME_DIR"
}
trap stop EXIT

"$BIN" --home "$HOME_DIR" config set port "$PORT" >/dev/null
"$BIN" --home "$HOME_DIR" config set admin_port "$((PORT + 1))" >/dev/null
"$BIN" --home "$HOME_DIR" run >"$LOG" 2>&1 &
PID=$!
URL="http://127.0.0.1:$PORT"
for _ in $(seq 1 150); do
  grep -q "serving" "$LOG" && break
  kill -0 "$PID" 2>/dev/null || { cat "$LOG"; echo "the server exited" >&2; exit 1; }
  sleep 0.2
done
grep -q "own risk" "$LOG" || { cat "$LOG"; echo "the local-use notice is missing" >&2; exit 1; }

export E2E_APP_URL="$URL"
export E2E_ADMIN_USERNAME=test-admin E2E_USER_USERNAME=test-user
E2E_ADMIN_PASSWORD="$(openssl rand -hex 12)"; export E2E_ADMIN_PASSWORD
E2E_USER_PASSWORD="$(openssl rand -hex 12)"; export E2E_USER_PASSWORD
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  echo "::add-mask::$E2E_ADMIN_PASSWORD"
  echo "::add-mask::$E2E_USER_PASSWORD"
fi
printf '%s\n' "$E2E_ADMIN_PASSWORD" | "$BIN" --home "$HOME_DIR" add-user "$E2E_ADMIN_USERNAME" --admin
printf '%s\n' "$E2E_USER_PASSWORD" | "$BIN" --home "$HOME_DIR" add-user "$E2E_USER_USERNAME"

# Exactly the suite that runs against app.alexsay.com, only the URL differs
pnpm --filter e2e exec playwright test "$@"

if [ "${E2E_SERVER_DEVICE:-1}" = 1 ]; then
  (cd device && ALEXSAY_E2E=1 ALEXSAY_E2E_AUDIO=0 ALEXSAY_E2E_CONFIG="$(printf '[server]\nurl = "%s"\n' "$URL")" \
    cargo test -p alexsay-daemon --test e2e -- --nocapture)
fi
echo "alexsay-server passed the e2e suite at $URL"
