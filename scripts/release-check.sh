#!/usr/bin/env bash
# Runs a built release binary on the machine it was built for, before it is published:
#   scripts/release-check.sh <binary> <expected target triple> [version]
# Checks only local behaviour (no server calls, so releases do not register speakers).
set -euo pipefail
bin="$1"; target="$2"; version="${3:-}"
home="$(mktemp -d)"
trap 'rm -rf "$home"' EXIT
run() { "$bin" --home "$home" "$@"; }
fail() { echo "release check FAILED: $*" >&2; exit 1; }

echo "== $bin ($target)"
[ -f "$bin" ] || fail "no binary at $bin"
out="$("$bin" --version)"; echo "$out"
[ -z "$version" ] || [[ "$out" == "alexsay $version" ]] || fail "version is '$out', expected $version"
[ "$("$bin" release target)" = "$target" ] || fail "built for $("$bin" release target), expected $target"

id="$(run id)"
[[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || fail "id '$id' is not a UUID v4"
[ "$(run id)" = "$id" ] || fail "the id changed between runs"

run config init >/dev/null
run config show | grep -q '^\[wake\]' || fail "config show has no [wake]"
run config set audio.volume 0.5 >/dev/null
run config show | grep -q '^volume = 0.5' || fail "config set did not stick"
if run config set audio.volume loud >/dev/null 2>&1; then fail "a bad value was accepted"; fi

# The wake word engine (rustpotter on this architecture) over a generated recording
python="$(command -v python3 || command -v python)"
"$python" - "$home/tone.wav" <<'PY'
import math, struct, sys, wave
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(i * 0.2))) for i in range(16000)))
PY
run wake test --file "$home/tone.wav" | grep -qE 'no detection|detected' || fail "the wake word engine did not run"

case "$target" in
  *linux*) if command -v file >/dev/null; then file "$bin" | grep -qE 'statically linked|static-pie linked' || fail "not static: $(file "$bin")"; fi ;;
esac
echo "release check passed: $target"
