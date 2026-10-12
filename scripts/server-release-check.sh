#!/usr/bin/env bash
# Runs a built alexsay-server on the machine it was built for, before it is published: starts it on a
# fresh home, creates an account, signs in over HTTP and loads the app, then stops it.
#   scripts/server-release-check.sh <binary> [version]
set -euo pipefail
bin="$1"; version="${2:-}"
home="$(mktemp -d)"
port=18977
fail() { echo "server release check FAILED: $*" >&2; [ -f "$home/log" ] && cat "$home/log" >&2; exit 1; }
cleanup() {
  [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true
  # Windows has no signal for the launcher to pass on, so its workerd is stopped by name
  command -v taskkill >/dev/null && taskkill //F //IM workerd.exe >/dev/null 2>&1 || true
  sleep 1
  rm -rf "$home" || true
}
trap cleanup EXIT
run() { "$bin" --home "$home" "$@"; }

echo "== $bin"
out="$("$bin" --version)"; echo "$out"
[ -z "$version" ] || [ "$out" = "alexsay-server $version" ] || fail "version is '$out', expected $version"
run config set port "$port" >/dev/null
run config set admin_port "$((port + 1))" >/dev/null
run config show | grep -q "^port = $port" || fail "config set did not stick"
if run config set port high >/dev/null 2>&1; then fail "a bad value was accepted"; fi

"$bin" --home "$home" run >"$home/log" 2>&1 &
pid=$!
for _ in $(seq 1 300); do
  grep -q serving "$home/log" && break
  kill -0 "$pid" 2>/dev/null || fail "the server exited"
  sleep 0.2
done
grep -q serving "$home/log" || fail "the server did not start"
grep -q "own risk" "$home/log" || fail "the local-use notice is missing"

printf 'release-check-pw\n' | run add-user checker --admin >/dev/null || fail "add-user"
base="http://127.0.0.1:$port"
jar="$home/jar"
curl -fsS -c "$jar" -H 'content-type: application/json' \
  -d '{"username":"checker","password":"release-check-pw"}' "$base/api/session/login" >/dev/null || fail "login"
curl -fsS -b "$jar" "$base/api/session/me" | grep -q '"role":"admin"' || fail "the session did not stick"
curl -fsS -H 'accept: text/html' "$base/devices" | grep -qi '<!doctype html>' || fail "the app is not served"
echo "server release check passed"
